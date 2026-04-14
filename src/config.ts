import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import { z } from "zod";

import { isNodeError } from "./errors.js";
import { logger } from "./logger.js";

export interface Config {
  todoListId?: string;
  todoListName?: string;
}

/** Zod schema for runtime validation of config.json content. */
const ConfigSchema = z.object({
  todoListId: z.string().min(1).optional(),
  todoListName: z.string().min(1).optional(),
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
export async function loadConfig(dir: string): Promise<Config | null> {
  const filePath = configPath(dir);
  logger.debug("loading config", { path: filePath });

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
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
export async function saveConfig(config: Config, dir: string): Promise<void> {
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
      ? { encoding: "utf-8" }
      : { encoding: "utf-8", mode: 0o600 };
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

/** Loads config from disk and validates it has todo list fields. Throws a user-friendly error if missing or invalid. */
export async function loadAndValidateConfig(
  dir: string,
): Promise<Config & { todoListId: string; todoListName: string }> {
  const config = await loadConfig(dir);
  if (!hasTodoConfig(config)) {
    throw new Error("todo list not configured - use the todo_config tool to select one");
  }
  return config;
}
