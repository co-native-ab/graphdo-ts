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
  ConfigMigrationStatus,
  CURRENT_CONFIG_VERSION,
  loadConfig,
  migrateConfig,
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

async function seedFixture(version: 1 | 2 | 3, name: string): Promise<string> {
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
    expect(CURRENT_CONFIG_VERSION).toBe(3);
  });
});

describe("round-trip per version", () => {
  it("loads v1/full.json, migrates to current, and yields current configVersion", async () => {
    const dir = await seedFixture(1, "full");
    const loaded = await loadConfig(dir, testSignal());
    expect(loaded?.configVersion).toBe(CURRENT_CONFIG_VERSION);
    // v1 fields preserved through the rename + nesting + workspace migration.
    expect(loaded?.todo?.listId).toBe("list-abc");
    expect(loaded?.todo?.listName).toBe("Inbox");
    expect(loaded?.workspace?.driveId).toBe("me");
    expect(loaded?.workspace?.itemId).toBe("folder-xyz");
    expect(loaded?.workspace?.itemName).toBe("Notes");
  });

  it("loads v2/full.json and migrates to v3 (workspace replaces markdown)", async () => {
    const dir = await seedFixture(2, "full");
    const loaded = await loadConfig(dir, testSignal());
    expect(loaded?.configVersion).toBe(CURRENT_CONFIG_VERSION);
    expect(loaded?.workspace?.driveId).toBe("me");
    expect(loaded?.workspace?.itemId).toBe("folder-xyz");
    expect(loaded?.workspace?.itemName).toBe("Notes");
    expect(loaded?.workspace?.driveName).toBe("OneDrive");
    // Display-only path is intentionally dropped by the v2→v3 migration.
    expect(loaded?.workspace?.itemPath).toBeUndefined();
  });

  it("loads v3/full.json without rewriting (no-op load)", async () => {
    const dir = await seedFixture(3, "full");
    const before = await fs.stat(path.join(dir, "config.json"));
    const loaded = await loadConfig(dir, testSignal());
    const after = await fs.stat(path.join(dir, "config.json"));
    expect(loaded?.configVersion).toBe(3);
    // No migration → no rewrite. mtimeMs identical.
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});

describe("v1 → v2 → v3 migration semantics", () => {
  it("preserves todo fields and maps markdown to workspace", async () => {
    const dir = await seedFixture(1, "full");
    const loaded = await loadConfig(dir, testSignal());
    expect(loaded).toEqual({
      configVersion: 3,
      todo: { listId: "list-abc", listName: "Inbox" },
      workspace: {
        driveId: "me",
        driveName: "OneDrive",
        itemId: "folder-xyz",
        itemName: "Notes",
      },
    });
  });

  it("migrates a partial v1 file (todo only)", async () => {
    const dir = await seedFixture(1, "todo-only");
    const loaded = await loadConfig(dir, testSignal());
    expect(loaded).toEqual({ configVersion: 3, todo: { listId: "list-only" } });
  });

  it("migrates a partial v1 file (markdown only) into workspace", async () => {
    const dir = await seedFixture(1, "markdown-only");
    const loaded = await loadConfig(dir, testSignal());
    expect(loaded).toEqual({
      configVersion: 3,
      workspace: { driveId: "me", driveName: "OneDrive", itemId: "folder-only" },
    });
  });

  it("rewrites the file in snake_case with config_version=3 and workspace nested", async () => {
    const dir = await seedFixture(1, "full");
    await loadConfig(dir, testSignal());

    // Read the on-disk bytes directly (NOT through the loader) and assert
    // every key is snake_case and config_version is present.
    const raw = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(raw["config_version"]).toBe(3);
    expect(raw["todo"]).toEqual({ list_id: "list-abc", list_name: "Inbox" });
    expect(raw["workspace"]).toEqual({
      drive_id: "me",
      drive_name: "OneDrive",
      item_id: "folder-xyz",
      item_name: "Notes",
    });
    // Top-level legacy keys are gone.
    expect(raw["todo_list_id"]).toBeUndefined();
    expect(raw["todo_list_name"]).toBeUndefined();
    expect(raw["markdown"]).toBeUndefined();
    // No camelCase leakage at any level.
    for (const key of Object.keys(raw)) {
      expect(key).not.toMatch(/[A-Z]/);
    }
    const ws = raw["workspace"] as Record<string, unknown>;
    for (const key of Object.keys(ws)) {
      expect(key).not.toMatch(/[A-Z]/);
    }
    const todo = raw["todo"] as Record<string, unknown>;
    for (const key of Object.keys(todo)) {
      expect(key).not.toMatch(/[A-Z]/);
    }
  });
});

describe("$schema editor hint", () => {
  it("v1 → current migration writes a $schema URL pointing at the version-pinned schema on main", async () => {
    const dir = await seedFixture(1, "full");
    await loadConfig(dir, testSignal());
    const raw = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(raw["$schema"]).toBe(
      "https://raw.githubusercontent.com/co-native-ab/graphdo-ts/main/schemas/config-v3.json",
    );
    // Ordering: editors look at the very first key; assert it is $schema.
    expect(Object.keys(raw)[0]).toBe("$schema");
  });

  it("strips $schema on load (it never leaks into the in-memory Config)", () => {
    const { config } = parseConfigFile({
      $schema: "https://example.invalid/anything.json",
      config_version: 3,
      todo: { list_id: "x", list_name: "y" },
    });
    expect(config).toEqual({
      configVersion: 3,
      todo: { listId: "x", listName: "y" },
    });
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
      workspace: {
        driveId: "me",
        driveName: "OneDrive",
        itemId: "f1",
        itemName: "Notes",
        itemPath: "/Notes",
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

describe("migrateConfig", () => {
  it("returns 'absent' when config.json does not exist and creates no file", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    expect(await migrateConfig(dir, testSignal())).toBe(ConfigMigrationStatus.Absent);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("returns 'current' for a v3 file and leaves the bytes untouched", async () => {
    const dir = await seedFixture(3, "full");
    const filePath = path.join(dir, "config.json");
    const before = await fs.readFile(filePath, "utf-8");
    const beforeMtime = (await fs.stat(filePath)).mtimeMs;

    expect(await migrateConfig(dir, testSignal())).toBe(ConfigMigrationStatus.Current);

    const after = await fs.readFile(filePath, "utf-8");
    expect(after).toBe(before);
    // mtime stable too — proves no rewrite happened
    expect((await fs.stat(filePath)).mtimeMs).toBe(beforeMtime);
  });

  it("returns 'migrated' for a v2 file and rewrites it to v3 with the current $schema URL", async () => {
    const dir = await seedFixture(2, "full");
    expect(await migrateConfig(dir, testSignal())).toBe(ConfigMigrationStatus.Migrated);

    const raw = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(raw["config_version"]).toBe(CURRENT_CONFIG_VERSION);
    expect(raw["$schema"]).toBe(
      `https://raw.githubusercontent.com/co-native-ab/graphdo-ts/main/schemas/config-v${String(CURRENT_CONFIG_VERSION)}.json`,
    );
    // v2 'markdown' is gone; replaced by 'workspace'.
    expect(raw["markdown"]).toBeUndefined();
    expect(raw["workspace"]).toBeDefined();
  });

  it("returns 'invalid' and backs up an unparseable file", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    const original = "not json {";
    await fs.writeFile(path.join(dir, "config.json"), original);

    expect(await migrateConfig(dir, testSignal())).toBe(ConfigMigrationStatus.Invalid);

    const files = await fs.readdir(dir);
    const backups = files.filter((f) => f.startsWith("config.json.invalid-"));
    expect(backups).toHaveLength(1);
  });

  it("returns 'invalid' for a parseable file that fails schema validation and leaves it untouched", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    // Valid JSON, valid version discriminator, but list_id violates min(1).
    const body = JSON.stringify({ config_version: 3, todo: { list_id: "" } });
    const filePath = path.join(dir, "config.json");
    await fs.writeFile(filePath, body);

    expect(await migrateConfig(dir, testSignal())).toBe(ConfigMigrationStatus.Invalid);

    // No backup — bytes left as-is, no rewrite.
    expect(await fs.readFile(filePath, "utf-8")).toBe(body);
    const files = await fs.readdir(dir);
    expect(files.filter((f) => f.startsWith("config.json.invalid-"))).toHaveLength(0);
  });

  it("is idempotent: running it twice on a v2 file yields 'migrated' then 'current'", async () => {
    const dir = await seedFixture(2, "full");
    expect(await migrateConfig(dir, testSignal())).toBe(ConfigMigrationStatus.Migrated);
    expect(await migrateConfig(dir, testSignal())).toBe(ConfigMigrationStatus.Current);
  });
});

describe("unknown keys are stripped", () => {
  it("strips unknown top-level keys", () => {
    const { config } = parseConfigFile({
      config_version: 3,
      todo: { list_id: "x", list_name: "y" },
      whatever: "ignored",
    });
    expect(config).toEqual({
      configVersion: 3,
      todo: { listId: "x", listName: "y" },
    });
  });

  it("strips unknown nested keys", () => {
    const { config } = parseConfigFile({
      config_version: 3,
      todo: { list_id: "x", noise: "drop me" },
      workspace: { drive_id: "me", item_id: "f1", noise: "drop me" },
    });
    expect(config).toEqual({
      configVersion: 3,
      todo: { listId: "x" },
      workspace: { driveId: "me", itemId: "f1" },
    });
  });
});

describe("parseConfigFile is pure (no I/O)", () => {
  it("returns migrated=true for a v1 input and migrated=false for a current-version input", () => {
    const v1 = parseConfigFile({ todoListId: "x", todoListName: "y" });
    expect(v1.migrated).toBe(true);
    expect(v1.config?.configVersion).toBe(3);
    expect(v1.config?.todo).toEqual({ listId: "x", listName: "y" });

    const current = parseConfigFile({
      config_version: 3,
      todo: { list_id: "x", list_name: "y" },
    });
    expect(current.migrated).toBe(false);
    expect(current.config?.configVersion).toBe(3);
    expect(current.config?.todo).toEqual({ listId: "x", listName: "y" });
  });
});
