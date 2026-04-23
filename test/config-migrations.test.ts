// Tests for the versioned config pipeline (ADR-0009) and the snake_case
// boundary (ADR-0010). Owns the matrix of "what does v_old on disk become
// after a load → migrate → rewrite cycle".
//
// Adding a new version: add a fixture under test/fixtures/config/vN/, add a
// row to the round-trip describe below, and add semantic checks for the
// fields renamed/dropped in the new migration.

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { testSignal } from "./helpers.js";
import {
  CURRENT_CONFIG_VERSION,
  loadConfig,
  parseConfigFile,
  saveConfig,
  type Config,
} from "../src/config.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "config");

const tempDirs: string[] = [];

function getTempDir(): string {
  const dir = path.join(os.tmpdir(), `graphdo-mig-${crypto.randomUUID()}`);
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {
      /* ignore cleanup errors */
    });
  }
  tempDirs.length = 0;
});

async function seedFixture(version: 1 | 2, name: string): Promise<string> {
  const dir = getTempDir();
  await fs.mkdir(dir, { recursive: true });
  const src = path.join(FIXTURES_DIR, `v${String(version)}`, `${name}.json`);
  const body = await fs.readFile(src, "utf-8");
  await fs.writeFile(path.join(dir, "config.json"), body);
  return dir;
}

// ---------------------------------------------------------------------------

describe("CURRENT_CONFIG_VERSION", () => {
  it("is the highest version with both a schema and (when applicable) a migration into it", () => {
    // Sanity: bumping the constant without registering a schema would break
    // every load. Asserting on the constant value pins the test matrix to
    // the build's notion of "current".
    expect(CURRENT_CONFIG_VERSION).toBe(2);
  });
});

describe("round-trip per version", () => {
  it("loads v1/full.json, migrates to current, and yields current configVersion", async () => {
    const dir = await seedFixture(1, "full");
    const loaded = await loadConfig(dir, testSignal());
    expect(loaded?.configVersion).toBe(CURRENT_CONFIG_VERSION);
    // v1 fields preserved through the rename + nesting.
    expect(loaded?.todo?.listId).toBe("list-abc");
    expect(loaded?.todo?.listName).toBe("Inbox");
    expect(loaded?.markdown?.rootFolderId).toBe("folder-xyz");
    expect(loaded?.markdown?.rootFolderName).toBe("Notes");
    expect(loaded?.markdown?.rootFolderPath).toBe("/Notes");
  });

  it("loads v2/full.json without rewriting (no-op load)", async () => {
    const dir = await seedFixture(2, "full");
    const before = await fs.stat(path.join(dir, "config.json"));
    const loaded = await loadConfig(dir, testSignal());
    const after = await fs.stat(path.join(dir, "config.json"));
    expect(loaded?.configVersion).toBe(2);
    // No migration → no rewrite. mtimeMs identical.
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});

describe("v1 → v2 migration semantics", () => {
  it("preserves todo fields and markdown fields", async () => {
    const dir = await seedFixture(1, "full");
    const loaded = await loadConfig(dir, testSignal());
    expect(loaded).toEqual({
      configVersion: 2,
      todo: { listId: "list-abc", listName: "Inbox" },
      markdown: {
        rootFolderId: "folder-xyz",
        rootFolderName: "Notes",
        rootFolderPath: "/Notes",
      },
    });
  });

  it("migrates a partial v1 file (todo only)", async () => {
    const dir = await seedFixture(1, "todo-only");
    const loaded = await loadConfig(dir, testSignal());
    expect(loaded).toEqual({ configVersion: 2, todo: { listId: "list-only" } });
  });

  it("migrates a partial v1 file (markdown only)", async () => {
    const dir = await seedFixture(1, "markdown-only");
    const loaded = await loadConfig(dir, testSignal());
    expect(loaded).toEqual({
      configVersion: 2,
      markdown: { rootFolderId: "folder-only" },
    });
  });

  it("rewrites the file in snake_case with config_version stamped and todo nested", async () => {
    const dir = await seedFixture(1, "full");
    await loadConfig(dir, testSignal());

    // Read the on-disk bytes directly (NOT through the loader) and assert
    // every key is snake_case and config_version is present.
    const raw = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(raw["config_version"]).toBe(2);
    expect(raw["todo"]).toEqual({ list_id: "list-abc", list_name: "Inbox" });
    expect(raw["markdown"]).toEqual({
      root_folder_id: "folder-xyz",
      root_folder_name: "Notes",
      root_folder_path: "/Notes",
    });
    // Top-level legacy keys are gone (no flat todo_list_id at the top).
    expect(raw["todo_list_id"]).toBeUndefined();
    expect(raw["todo_list_name"]).toBeUndefined();
    // No camelCase leakage at any level.
    for (const key of Object.keys(raw)) {
      expect(key).not.toMatch(/[A-Z]/);
    }
    const md = raw["markdown"] as Record<string, unknown>;
    for (const key of Object.keys(md)) {
      expect(key).not.toMatch(/[A-Z]/);
    }
    const todo = raw["todo"] as Record<string, unknown>;
    for (const key of Object.keys(todo)) {
      expect(key).not.toMatch(/[A-Z]/);
    }
  });
});

describe("forward-compat refusal", () => {
  it("throws when config_version exceeds the current build", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({ config_version: 99, todo: { list_id: "x", list_name: "y" } }),
    );
    const before = await fs.readFile(path.join(dir, "config.json"), "utf-8");
    await expect(loadConfig(dir, testSignal())).rejects.toThrow(
      /newer graphdo-ts.*config_version=99/,
    );
    // File is left untouched — never silently downgraded.
    const after = await fs.readFile(path.join(dir, "config.json"), "utf-8");
    expect(after).toBe(before);
  });
});

describe("corrupt-file backup", () => {
  it("returns null and writes a config.json.invalid-<ts> backup containing the original bytes", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    const original = "{this is not json";
    await fs.writeFile(path.join(dir, "config.json"), original);

    const result = await loadConfig(dir, testSignal());
    expect(result).toBeNull();

    const files = await fs.readdir(dir);
    const backups = files.filter((f) => f.startsWith("config.json.invalid-"));
    expect(backups).toHaveLength(1);
    const backupName = backups[0];
    if (backupName === undefined) throw new Error("missing backup");
    const backedUp = await fs.readFile(path.join(dir, backupName), "utf-8");
    expect(backedUp).toBe(original);
  });
});

describe("byte-stable round-trip", () => {
  it("load → save → load yields a byte-identical config.json", async () => {
    const dir = getTempDir();
    const config: Config = {
      todo: { listId: "abc", listName: "Tasks" },
      markdown: {
        rootFolderId: "f1",
        rootFolderName: "Notes",
        rootFolderPath: "/Notes",
      },
    };

    await saveConfig(config, dir, testSignal());
    const first = await fs.readFile(path.join(dir, "config.json"), "utf-8");

    const reloaded = await loadConfig(dir, testSignal());
    if (reloaded === null) throw new Error("reload returned null");
    await saveConfig(reloaded, dir, testSignal());
    const second = await fs.readFile(path.join(dir, "config.json"), "utf-8");

    expect(second).toBe(first);
  });
});

describe("unknown keys are stripped", () => {
  it("strips unknown top-level keys", () => {
    const { config } = parseConfigFile({
      config_version: 2,
      todo: { list_id: "x", list_name: "y" },
      whatever: "ignored",
    });
    expect(config).toEqual({
      configVersion: 2,
      todo: { listId: "x", listName: "y" },
    });
  });

  it("strips unknown nested keys", () => {
    const { config } = parseConfigFile({
      config_version: 2,
      todo: { list_id: "x", noise: "drop me" },
      markdown: { root_folder_id: "f1", noise: "drop me" },
    });
    expect(config).toEqual({
      configVersion: 2,
      todo: { listId: "x" },
      markdown: { rootFolderId: "f1" },
    });
  });
});

describe("parseConfigFile is pure (no I/O)", () => {
  it("returns migrated=true for a v1 input and migrated=false for a v2 input", () => {
    const v1 = parseConfigFile({ todoListId: "x", todoListName: "y" });
    expect(v1.migrated).toBe(true);
    expect(v1.config?.configVersion).toBe(2);
    expect(v1.config?.todo).toEqual({ listId: "x", listName: "y" });

    const v2 = parseConfigFile({
      config_version: 2,
      todo: { list_id: "x", list_name: "y" },
    });
    expect(v2.migrated).toBe(false);
    expect(v2.config?.configVersion).toBe(2);
    expect(v2.config?.todo).toEqual({ listId: "x", listName: "y" });
  });
});
