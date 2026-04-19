import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import { z } from "zod";

import { isNodeError } from "./errors.js";
import { validateGraphId, type ValidatedGraphId } from "./graph/ids.js";
import { logger } from "./logger.js";

export interface MarkdownConfig {
  rootFolderId?: string;
  rootFolderName?: string;
  rootFolderPath?: string;
}

export interface Config {
  todoListId?: string;
  todoListName?: string;
  markdown?: MarkdownConfig;
}

/** Zod schema for runtime validation of config.json content. */
const ConfigSchema = z.object({
  todoListId: z.string().min(1).optional(),
  todoListName: z.string().min(1).optional(),
  markdown: z
    .object({
      rootFolderId: z.string().min(1).optional(),
      rootFolderName: z.string().min(1).optional(),
      rootFolderPath: z.string().min(1).optional(),
    })
    .optional(),
});

/**
 * Returns the configuration directory path.
 * Uses an override if provided, otherwise falls back to OS-appropriate defaults.
 */
export function configDir(overrideDir?: string): string {
  if (overrideDir !== undefined) {
    const resolved = path.resolve(overrideDir);
    logger.debug("config directory (override)", { path: resolved });
    return resolved;
  }

  const platform = os.platform();
  const home = os.homedir();
  let dir: string;

  if (platform === "win32") {
    const appData = process.env["APPDATA"];
    const base = appData ?? path.join(home, "AppData", "Roaming");
    dir = path.join(base, "graphdo-ts");
  } else if (platform === "darwin") {
    dir = path.join(home, "Library", "Application Support", "graphdo-ts");
  } else {
    const xdg = process.env["XDG_CONFIG_HOME"];
    const base = xdg ?? path.join(home, ".config");
    dir = path.join(base, "graphdo-ts");
  }

  logger.debug("config directory", { path: dir });
  return dir;
}

/** Returns the full path to config.json within the given directory. */
export function configPath(dir: string): string {
  return path.join(dir, "config.json");
}

/** Reads and parses config.json from the given directory. Returns null if the file does not exist. */
export async function loadConfig(dir: string, signal: AbortSignal): Promise<Config | null> {
  const filePath = configPath(dir);
  logger.debug("loading config", { path: filePath });

  let content: string;
  try {
    content = await fs.readFile(filePath, { encoding: "utf-8", signal });
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      logger.debug("config file not found", { path: filePath });
      return null;
    }
    throw err;
  }

  try {
    const raw: unknown = JSON.parse(content);
    const result = ConfigSchema.safeParse(raw);
    if (!result.success) {
      logger.warn("config file failed validation", {
        path: filePath,
        error: z.prettifyError(result.error),
      });
      return null;
    }
    return result.data;
  } catch (cause: unknown) {
    throw new Error(`failed to parse config at ${filePath}`, { cause });
  }
}

/** Writes config atomically: writes to a temp file then renames into place. */
export async function saveConfig(config: Config, dir: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  const filePath = configPath(dir);
  logger.debug("saving config", { path: filePath });

  const isWindows = os.platform() === "win32";
  const mkdirOptions: Parameters<typeof fs.mkdir>[1] = isWindows
    ? { recursive: true }
    : { recursive: true, mode: 0o700 };
  await fs.mkdir(dir, mkdirOptions);

  const data = JSON.stringify(config, null, 2) + "\n";
  const tmpFile = path.join(dir, `.config-${crypto.randomUUID()}.tmp`);

  try {
    const writeOptions: Parameters<typeof fs.writeFile>[2] = isWindows
      ? { encoding: "utf-8" as const, signal }
      : { encoding: "utf-8" as const, mode: 0o600, signal };
    await fs.writeFile(tmpFile, data, writeOptions);
    await fs.rename(tmpFile, filePath);
    logger.debug("config saved", { path: filePath });
  } catch (err: unknown) {
    // Best-effort cleanup of the temp file
    try {
      await fs.unlink(tmpFile);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Type guard that checks whether a loaded config has todo list fields set.
 */
export function hasTodoConfig(
  config: Config | null,
): config is Config & { todoListId: string; todoListName: string } {
  return (
    config !== null &&
    typeof config.todoListId === "string" &&
    config.todoListId.length > 0 &&
    typeof config.todoListName === "string" &&
    config.todoListName.length > 0
  );
}

/**
 * Validate that a value is a well-formed markdown root folder ID.
 *
 * The root folder must always be a single existing top-level folder in the
 * user's OneDrive. A valid drive item ID is an opaque token — it never
 * contains path separators, whitespace, or the literal `/`. Rejecting
 * anything else here is a last line of defence against a hand-edited or
 * corrupted `config.json` silently turning "the configured root" into
 * "the drive root" or a subdirectory.
 *
 * Returns `null` when valid, or a short reason string when invalid.
 */
export function markdownRootFolderIdError(rootFolderId: unknown): string | null {
  if (typeof rootFolderId !== "string") return "missing";
  if (rootFolderId.length === 0) return "empty";
  if (rootFolderId === "/" || rootFolderId === "\\") return "set to the drive root";
  if (rootFolderId.includes("/") || rootFolderId.includes("\\")) {
    return "contains a path separator (subdirectories are not supported)";
  }
  if (/\s/.test(rootFolderId)) return "contains whitespace";
  return null;
}

/**
 * Type guard that checks whether a loaded config has a markdown root folder set.
 *
 * A root folder ID that is missing, empty, equal to `/`, or contains path
 * separators is treated as _not configured_ — tools that rely on it will
 * fail with a user-friendly error directing the user to re-run the picker.
 */
export function hasMarkdownConfig(
  config: Config | null,
): config is Config & { markdown: { rootFolderId: string } & MarkdownConfig } {
  if (config === null) return false;
  const rootFolderId = config.markdown?.rootFolderId;
  return markdownRootFolderIdError(rootFolderId) === null;
}

/**
 * Loads config from disk and validates that a todo list is configured.
 * Throws a user-friendly error if missing or invalid (e.g. picker has not
 * been run yet — in which case the user is directed to re-run the picker).
 *
 * Returns the validated config with `todoListId` re-typed as
 * {@link ValidatedGraphId} so it can be passed straight to Graph helpers
 * without an additional validation step. A persisted-but-corrupted
 * `todoListId` (hand-edited config.json) fails loudly here rather than
 * splicing into a Graph URL downstream.
 */
export async function loadAndValidateTodoConfig(
  dir: string,
  signal: AbortSignal,
): Promise<Config & { todoListId: ValidatedGraphId; todoListName: string }> {
  const config = await loadConfig(dir, signal);
  if (!hasTodoConfig(config)) {
    throw new Error("todo list not configured - use the todo_select_list tool to select one");
  }
  let validatedListId: ValidatedGraphId;
  try {
    validatedListId = validateGraphId("todoListId", config.todoListId);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `todo list configuration is corrupted (${reason}) - use the todo_select_list tool to re-select one`,
    );
  }
  return { ...config, todoListId: validatedListId };
}

/**
 * Loads config from disk and validates that a markdown root folder is configured.
 * Throws a user-friendly error if missing or invalid (e.g. empty, `/`, or
 * containing path separators — in which case the user is directed to re-run
 * the picker, which always writes a single-folder opaque ID).
 *
 * Re-types `markdown.rootFolderId` as {@link ValidatedGraphId} so callers
 * can pass it straight into Graph helpers without re-validating. A
 * persisted value that fails {@link validateGraphId} (a hand-edited
 * config.json) raises the same "use the picker" error as the missing
 * case, rather than splicing into a Graph URL downstream.
 */
export async function loadAndValidateMarkdownConfig(
  dir: string,
  signal: AbortSignal,
): Promise<Config & { markdown: { rootFolderId: ValidatedGraphId } & MarkdownConfig }> {
  const config = await loadConfig(dir, signal);
  const rootFolderId = config?.markdown?.rootFolderId;
  const err = markdownRootFolderIdError(rootFolderId);
  if (err !== null || !hasMarkdownConfig(config)) {
    const detail =
      err === "missing"
        ? "not configured"
        : `invalid (${err ?? "not configured"}) — only a single OneDrive folder is allowed, never the drive root or a subdirectory`;
    throw new Error(
      `markdown root folder ${detail} - use the markdown_select_root_folder tool to choose one`,
    );
  }
  let validatedRootId: ValidatedGraphId;
  try {
    validatedRootId = validateGraphId("markdown.rootFolderId", config.markdown.rootFolderId);
  } catch (cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `markdown root folder is corrupted (${reason}) - use the markdown_select_root_folder tool to re-select one`,
    );
  }
  return {
    ...config,
    markdown: { ...config.markdown, rootFolderId: validatedRootId },
  };
}

/**
 * Load the current config, apply a partial update, and save. Preserves fields
 * for other subsystems (e.g. saving markdown config does not wipe todo config).
 */
export async function updateConfig(
  partial: Partial<Config>,
  dir: string,
  signal: AbortSignal,
): Promise<Config> {
  const existing = (await loadConfig(dir, signal)) ?? {};
  const merged: Config = {
    ...existing,
    ...partial,
    markdown:
      partial.markdown !== undefined
        ? { ...(existing.markdown ?? {}), ...partial.markdown }
        : existing.markdown,
  };
  await saveConfig(merged, dir, signal);
  return merged;
}
