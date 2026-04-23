import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { z } from "zod";

import { isNodeError } from "./errors.js";
import { validateGraphId, type ValidatedGraphId } from "./graph/ids.js";
import { logger } from "./logger.js";
import { writeJsonAtomic, mkdirOptions, writeFileOptions } from "./fs-options.js";

// ---------------------------------------------------------------------------
// In-memory shape (camelCase) — used by the rest of the codebase.
// ---------------------------------------------------------------------------

export interface TodoConfig {
  listId?: string;
  listName?: string;
}

export interface MarkdownConfig {
  rootFolderId?: string;
  rootFolderName?: string;
  rootFolderPath?: string;
}

export interface Config {
  /**
   * Schema version of the on-disk file this config was loaded from. Always
   * equal to {@link CURRENT_CONFIG_VERSION} after `loadConfig` returns —
   * older files are migrated transparently. Stamped onto every save.
   */
  configVersion?: number;
  /**
   * Per-subsystem configuration. Each top-level key here mirrors a
   * corresponding object on disk (`todo`, `markdown`, …) so the in-memory
   * and persisted shapes have the same structure modulo casing.
   */
  todo?: TodoConfig;
  markdown?: MarkdownConfig;
}

// ---------------------------------------------------------------------------
// On-disk versioning
//
// See ADR-0009 (Versioned Config with Forward-Only Migrations) and
// ADR-0010 (snake_case for All Persisted Config) for the rationale.
//
// Adding a new version (vN+1):
//   1. Bump CURRENT_CONFIG_VERSION.
//   2. Add ConfigFileSchemaVN+1 (the new on-disk Zod schema, snake_case).
//   3. Add an entry to MIGRATIONS that takes vN parsed output and returns
//      vN+1 input. The pipeline re-validates against the next schema after
//      each step, so migrations can stay small.
//   4. Update `serialiseConfigFile` if the in-memory → disk mapping changed.
//   5. Add fixtures under `test/fixtures/config/vN+1/` and a row to the
//      round-trip matrix in `test/config-migrations.test.ts`.
// ---------------------------------------------------------------------------

/** Current on-disk config schema version. */
export const CURRENT_CONFIG_VERSION = 2;

/**
 * Public, version-pinned URL of the JSON Schema describing the current
 * on-disk shape. Embedded as the `$schema` field of every saved
 * `config.json` so editors (VS Code, JetBrains, …) pick it up automatically
 * for completion and validation when the user hand-edits the file.
 *
 * Pinned to `main` (not a release tag) on purpose: bug-fix updates to the
 * schema (tighter patterns, better descriptions) should reach existing
 * users without a graphdo-ts upgrade. Breaking shape changes get a new
 * `config-v{N+1}.json` file and a new `config_version` literal — the URL
 * here is then bumped to the new file, but the old file stays in the repo
 * so already-written `config.json`s keep validating.
 *
 * See `schemas/README.md` for the full version table and the rules for
 * adding a new version.
 */
export const CONFIG_SCHEMA_URL = configSchemaUrl(CURRENT_CONFIG_VERSION);

/**
 * Build the canonical raw.githubusercontent.com URL for the JSON Schema
 * file describing on-disk version `v`. Centralising the URL shape here
 * keeps {@link CONFIG_SCHEMA_URL}, the per-version `$id` metadata and the
 * generator script ({@link ../scripts/generate-schemas.ts}) in lockstep.
 */
export function configSchemaUrl(v: number): string {
  return `https://raw.githubusercontent.com/co-native-ab/graphdo-ts/main/schemas/config-v${String(v)}.json`;
}

/**
 * v1 — legacy camelCase, no explicit `config_version` field.
 *
 * This schema only exists to read pre-versioning files written by older
 * graphdo-ts builds. New code should never produce v1 output. The
 * generator emits a corresponding `schemas/config-v1.json` so older
 * files still validate against a public, version-pinned JSON Schema even
 * though the loader auto-migrates them on next launch.
 */
export const ConfigFileSchemaV1 = z
  .object({
    todoListId: z
      .string()
      .min(1)
      .describe(
        "Microsoft Graph todoTaskList id (legacy flat key, renamed to `todo.list_id` in v2).",
      )
      .optional(),
    todoListName: z
      .string()
      .min(1)
      .describe(
        "Display name of the selected todo list (legacy flat key, renamed to `todo.list_name` in v2).",
      )
      .optional(),
    markdown: z
      .object({
        rootFolderId: z
          .string()
          .min(1)
          .describe("OneDrive driveItem id of the markdown workspace folder.")
          .optional(),
        rootFolderName: z.string().min(1).optional(),
        rootFolderPath: z.string().min(1).optional(),
      })
      .strip()
      .optional(),
  })
  .strip()
  .meta({
    $id: configSchemaUrl(1),
    title: "graphdo-ts config (v1, legacy)",
    description:
      "Pre-versioning on-disk shape of `config.json`. New builds never write this shape; it is documented here so editors and external tools can validate legacy files that have not yet been auto-migrated to v2 by the next graphdo-ts launch.",
  });

/**
 * v2 — snake_case keys with an explicit `config_version: 2` discriminator.
 * Per-subsystem nested objects (`todo`, `markdown`) mirror the in-memory
 * structure so disk and code agree on shape modulo casing.
 *
 * The generator (`scripts/generate-schemas.ts`) emits this Zod schema as
 * `schemas/config-v2.json`. The published JSON Schema file is therefore
 * always derivable from this single source of truth — see ADR-0010.
 */
export const ConfigFileSchemaV2 = z
  .object({
    config_version: z
      .literal(2)
      .describe(
        "On-disk schema version discriminator. Files with a higher value than the running build supports are rejected (never silently downgraded).",
      ),
    todo: z
      .object({
        list_id: z
          .string()
          .min(1)
          .describe(
            "Microsoft Graph todoTaskList id. Opaque token: must not contain `/`, `\\`, or whitespace.",
          )
          .optional(),
        list_name: z
          .string()
          .min(1)
          .describe(
            "Display name of the selected list. Cached so `auth_status` can show it without an extra Graph round-trip.",
          )
          .optional(),
      })
      .strip()
      .describe("Selection persisted by the `todo_select_list` tool.")
      .optional(),
    markdown: z
      .object({
        root_folder_id: z
          .string()
          .min(1)
          .describe(
            "OneDrive driveItem id of a single top-level workspace folder. Opaque token: must not equal `/`, contain `/`, `\\`, or whitespace.",
          )
          .optional(),
        root_folder_name: z.string().min(1).optional(),
        root_folder_path: z
          .string()
          .min(1)
          .describe(
            "Display-only path (e.g. `/Notes`). Never used to address the folder; the `root_folder_id` is the source of truth.",
          )
          .optional(),
      })
      .strip()
      .describe("Selection persisted by the `markdown_select_root_folder` tool.")
      .optional(),
  })
  .strip()
  .meta({
    $id: configSchemaUrl(2),
    title: "graphdo-ts config (v2)",
    description:
      "Versioned snake_case on-disk shape of `config.json`. Written by graphdo-ts ≥ the release that introduced ADR-0009 / ADR-0010. Generated from the Zod source of truth in `src/config.ts` by `scripts/generate-schemas.ts`; do not edit by hand.",
  });

type ConfigFileV2 = z.infer<typeof ConfigFileSchemaV2>;

interface Migration {
  from: number;
  to: number;
  /** Pure transform: parsed input from version `from`, returns input for version `to`. */
  migrate: (input: unknown) => unknown;
}

/**
 * Ordered list of migrations. Each entry takes the validated output of
 * version `from` and produces input that must validate against version
 * `to`'s schema. Migrations are pure: no I/O, no clocks, no Graph calls.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    from: 1,
    to: 2,
    migrate: (input) => {
      // Input is validated against ConfigFileSchemaV1, so we can narrow safely.
      const v1 = input as z.infer<typeof ConfigFileSchemaV1>;
      const out: Record<string, unknown> = { config_version: 2 };
      // Nest legacy flat todoListId/todoListName under the new `todo` object.
      const todo: Record<string, unknown> = {};
      if (v1.todoListId !== undefined) todo["list_id"] = v1.todoListId;
      if (v1.todoListName !== undefined) todo["list_name"] = v1.todoListName;
      if (Object.keys(todo).length > 0) out["todo"] = todo;
      if (v1.markdown !== undefined) {
        const md: Record<string, unknown> = {};
        if (v1.markdown.rootFolderId !== undefined) md["root_folder_id"] = v1.markdown.rootFolderId;
        if (v1.markdown.rootFolderName !== undefined)
          md["root_folder_name"] = v1.markdown.rootFolderName;
        if (v1.markdown.rootFolderPath !== undefined)
          md["root_folder_path"] = v1.markdown.rootFolderPath;
        if (Object.keys(md).length > 0) out["markdown"] = md;
      }
      return out;
    },
  },
];

/** Per-version Zod schemas, indexed by version number. */
/**
 * Per-version Zod schemas, indexed by version number. Public so the
 * generator script (`scripts/generate-schemas.ts`) can iterate it to emit
 * one `schemas/config-vN.json` per version. **Adding a new version means
 * exactly one place to update.**
 */
export const SCHEMAS: Readonly<Record<number, z.ZodType>> = {
  1: ConfigFileSchemaV1,
  2: ConfigFileSchemaV2,
};

/**
 * Detect the on-disk schema version of a parsed JSON value. Files written
 * before v2 have no `config_version` field, so we treat them as v1.
 */
function detectVersion(raw: unknown): number {
  if (raw !== null && typeof raw === "object" && "config_version" in raw) {
    const v = (raw as { config_version: unknown }).config_version;
    if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  }
  return 1;
}

/**
 * Apply every applicable migration to bring `parsed` (already validated as
 * `from`) up to {@link CURRENT_CONFIG_VERSION}. Each step's output is
 * validated against the next version's schema, which gives us a safety net
 * if a migration ever produces malformed data.
 */
function applyMigrations(parsed: unknown, from: number): ConfigFileV2 {
  let current: unknown = parsed;
  let currentVersion = from;
  while (currentVersion < CURRENT_CONFIG_VERSION) {
    const step = MIGRATIONS.find((m) => m.from === currentVersion);
    if (step === undefined) {
      throw new Error(
        `no migration registered from config version ${String(currentVersion)} to ${String(currentVersion + 1)}`,
      );
    }
    logger.info("migrating config", { from: step.from, to: step.to });
    const next: unknown = step.migrate(current);
    const nextSchema = SCHEMAS[step.to];
    if (nextSchema === undefined) {
      throw new Error(`no schema registered for config version ${String(step.to)}`);
    }
    const validated = nextSchema.safeParse(next);
    if (!validated.success) {
      throw new Error(
        `config migration ${String(step.from)} → ${String(step.to)} produced invalid output: ${z.prettifyError(validated.error)}`,
      );
    }
    current = validated.data;
    currentVersion = step.to;
  }
  return current as ConfigFileV2;
}

/**
 * Map the on-disk v2 (snake_case) shape into the in-memory `Config`
 * (camelCase). This is the single (de)serialisation boundary on the read
 * side — see ADR-0010.
 */
function toInMemory(file: ConfigFileV2): Config {
  const out: Config = { configVersion: file.config_version };
  if (file.todo !== undefined) {
    const todo: TodoConfig = {};
    if (file.todo.list_id !== undefined) todo.listId = file.todo.list_id;
    if (file.todo.list_name !== undefined) todo.listName = file.todo.list_name;
    out.todo = todo;
  }
  if (file.markdown !== undefined) {
    const md: MarkdownConfig = {};
    if (file.markdown.root_folder_id !== undefined) md.rootFolderId = file.markdown.root_folder_id;
    if (file.markdown.root_folder_name !== undefined)
      md.rootFolderName = file.markdown.root_folder_name;
    if (file.markdown.root_folder_path !== undefined)
      md.rootFolderPath = file.markdown.root_folder_path;
    out.markdown = md;
  }
  return out;
}

/**
 * Map an in-memory `Config` into its on-disk v2 (snake_case) shape with a
 * stable key order: `$schema` first (editor hint), then `config_version`,
 * then remaining top-level keys in alphabetical order. The stable order
 * keeps round-tripping byte-identical so a no-op load → save doesn't churn
 * the file.
 */
function serialiseConfigFile(config: Config): Record<string, unknown> {
  const todo: Record<string, string> = {};
  if (config.todo?.listId !== undefined) todo["list_id"] = config.todo.listId;
  if (config.todo?.listName !== undefined) todo["list_name"] = config.todo.listName;

  const md: Record<string, string> = {};
  if (config.markdown?.rootFolderId !== undefined)
    md["root_folder_id"] = config.markdown.rootFolderId;
  if (config.markdown?.rootFolderName !== undefined)
    md["root_folder_name"] = config.markdown.rootFolderName;
  if (config.markdown?.rootFolderPath !== undefined)
    md["root_folder_path"] = config.markdown.rootFolderPath;

  // Re-validate the snake_case payload so we can never silently write
  // malformed data. `$schema` is not part of the Zod schema (it's
  // `.strip()`ed on load), so it's not validated here — but it's a fixed
  // string constant under our control, so that's fine.
  const validated = ConfigFileSchemaV2.parse({
    config_version: CURRENT_CONFIG_VERSION,
    ...(Object.keys(md).length > 0 ? { markdown: md } : {}),
    ...(Object.keys(todo).length > 0 ? { todo: todo } : {}),
  });

  // Build the on-disk object with deterministic key order:
  //   $schema, config_version, then remaining keys alphabetically.
  // `$schema` is emitted first so editors (VS Code, JetBrains, …) pick it
  // up immediately when the file is opened. It's stripped on load by the
  // Zod `.strip()` on `ConfigFileSchemaV2`, then re-added here on save, so
  // a no-op load → save round-trip stays byte-identical.
  const ordered: Record<string, unknown> = {};
  ordered["$schema"] = CONFIG_SCHEMA_URL;
  ordered["config_version"] = validated.config_version;
  if (validated.markdown !== undefined) ordered["markdown"] = sortKeys(validated.markdown);
  if (validated.todo !== undefined) ordered["todo"] = sortKeys(validated.todo);
  return ordered;
}

/**
 * Return a new object with keys in alphabetical order. Used by
 * `serialiseConfigFile` to keep a no-op load → save byte-identical so a
 * fresh build doesn't churn the user's `config.json` on every start.
 */
function sortKeys<T extends Record<string, unknown>>(obj: T): T {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted as T;
}

/**
 * Parse a raw JSON value into the in-memory `Config`. Detects the on-disk
 * version, validates against that version's schema, runs migrations to
 * bring it to {@link CURRENT_CONFIG_VERSION}, and maps to camelCase.
 *
 * Returns `{ config, migrated }`:
 * - `config` is `null` when the value fails schema validation (e.g. a
 *   hand-edit produced empty strings or wrong types). Callers can decide
 *   to treat this as "no config" without crashing.
 * - `migrated === true` means the file should be rewritten in the new
 *   format; only set when `config` is non-null.
 *
 * Throws only when `config_version` exceeds the current build — we never
 * silently downgrade.
 */
export function parseConfigFile(raw: unknown): { config: Config | null; migrated: boolean } {
  const version = detectVersion(raw);
  if (version > CURRENT_CONFIG_VERSION) {
    throw new Error(
      `config.json was written by a newer graphdo-ts (config_version=${String(version)}, this build supports up to ${String(CURRENT_CONFIG_VERSION)}); upgrade graphdo-ts or remove the file`,
    );
  }
  const schema = SCHEMAS[version];
  if (schema === undefined) {
    throw new Error(`no schema registered for config version ${String(version)}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    logger.warn("config.json failed schema validation", {
      version,
      error: z.prettifyError(parsed.error),
    });
    return { config: null, migrated: false };
  }
  const upgraded = applyMigrations(parsed.data, version);
  return { config: toInMemory(upgraded), migrated: version !== CURRENT_CONFIG_VERSION };
}

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

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (cause: unknown) {
    // Unparseable file: back up the original bytes so the user can recover
    // anything they hand-edited, then treat as "no config" rather than
    // crashing every tool that needs it.
    await backupCorruptConfig(filePath, content, signal).catch((backupErr: unknown) => {
      logger.warn("failed to back up corrupt config.json", {
        path: filePath,
        error: backupErr instanceof Error ? backupErr.message : String(backupErr),
      });
    });
    logger.warn("config.json is not valid JSON; backed up and ignored", {
      path: filePath,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return null;
  }

  const { config, migrated } = parseConfigFile(raw);
  if (config === null) return null;
  if (migrated) {
    logger.info("rewriting config.json after migration", {
      path: filePath,
      to: CURRENT_CONFIG_VERSION,
    });
    await writeJsonAtomic(filePath, serialiseConfigFile(config), signal);
  }
  return config;
}

/**
 * Move an unparseable `config.json` aside to `config.json.invalid-<ts>` so
 * the user can inspect what they had before. Best-effort: failures are
 * logged but never bubble up to the caller (we still want tools to return
 * the helpful "not configured" error rather than crash).
 */
async function backupCorruptConfig(
  filePath: string,
  originalBytes: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.invalid-${ts}`;
  await writeJsonRawAtomic(backupPath, originalBytes, signal);
  logger.info("corrupt config.json backed up", { path: backupPath });
}

/** Like `writeJsonAtomic` but writes a raw string verbatim (used for the corruption backup). */
async function writeJsonRawAtomic(
  filePath: string,
  body: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason;
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, mkdirOptions());
  await fs.writeFile(filePath, body, writeFileOptions(signal));
}

/** Writes config atomically: writes to a temp file then renames into place. */
export async function saveConfig(config: Config, dir: string, signal: AbortSignal): Promise<void> {
  const filePath = configPath(dir);
  logger.debug("saving config", { path: filePath });
  await writeJsonAtomic(filePath, serialiseConfigFile(config), signal);
  logger.debug("config saved", { path: filePath });
}

/**
 * Type guard that checks whether a loaded config has todo list fields set.
 */
export function hasTodoConfig(
  config: Config | null,
): config is Config & { todo: { listId: string; listName: string } & TodoConfig } {
  if (config === null) return false;
  const listId = config.todo?.listId;
  const listName = config.todo?.listName;
  return (
    typeof listId === "string" &&
    listId.length > 0 &&
    typeof listName === "string" &&
    listName.length > 0
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
 * Returns the validated config with `todo.listId` re-typed as
 * {@link ValidatedGraphId} so it can be passed straight to Graph helpers
 * without an additional validation step. A persisted-but-corrupted
 * `todo.listId` (hand-edited config.json) fails loudly here rather than
 * splicing into a Graph URL downstream.
 */
export async function loadAndValidateTodoConfig(
  dir: string,
  signal: AbortSignal,
): Promise<Config & { todo: { listId: ValidatedGraphId; listName: string } & TodoConfig }> {
  const config = await loadConfig(dir, signal);
  if (!hasTodoConfig(config)) {
    throw new Error("todo list not configured - use the todo_select_list tool to select one");
  }
  let validatedListId: ValidatedGraphId;
  try {
    validatedListId = validateGraphId("todo.listId", config.todo.listId);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `todo list configuration is corrupted (${reason}) - use the todo_select_list tool to re-select one`,
    );
  }
  return {
    ...config,
    todo: { ...config.todo, listId: validatedListId },
  };
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
    todo:
      partial.todo !== undefined ? { ...(existing.todo ?? {}), ...partial.todo } : existing.todo,
    markdown:
      partial.markdown !== undefined
        ? { ...(existing.markdown ?? {}), ...partial.markdown }
        : existing.markdown,
  };
  await saveConfig(merged, dir, signal);
  return merged;
}
