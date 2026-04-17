import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import { testSignal } from "./helpers.js";
import {
  configDir,
  configPath,
  loadConfig,
  saveConfig,
  hasTodoConfig,
  loadAndValidateConfig,
  type Config,
} from "../src/config.js";

function makeTempDir(): string {
  return path.join(os.tmpdir(), `graphdo-test-${crypto.randomUUID()}`);
}

const tempDirs: string[] = [];

function getTempDir(): string {
  const dir = makeTempDir();
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

const validConfig: Config = {
  todoListId: "list-123",
  todoListName: "My Tasks",
};

describe("configDir", () => {
  it("returns override path when provided", () => {
    const result = configDir("/some/override/path");
    expect(result).toBe(path.resolve("/some/override/path"));
  });

  it("returns OS-appropriate default when no override", () => {
    const result = configDir();
    const platform = os.platform();
    const home = os.homedir();

    if (platform === "win32") {
      const appData = process.env["APPDATA"];
      const base = appData ?? path.join(home, "AppData", "Roaming");
      expect(result).toBe(path.join(base, "graphdo-ts"));
    } else if (platform === "darwin") {
      expect(result).toBe(path.join(home, "Library", "Application Support", "graphdo-ts"));
    } else {
      const xdg = process.env["XDG_CONFIG_HOME"];
      const base = xdg ?? path.join(home, ".config");
      expect(result).toBe(path.join(base, "graphdo-ts"));
    }
  });

  it("resolves relative override path to absolute", () => {
    const result = configDir("relative/dir");
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toBe(path.resolve("relative/dir"));
  });
});

describe("configPath", () => {
  it("returns config.json within the given directory", () => {
    expect(configPath("/my/dir")).toBe(path.join("/my/dir", "config.json"));
  });
});

describe("loadConfig", () => {
  it("returns null when file doesn't exist", async () => {
    const dir = getTempDir();
    const result = await loadConfig(dir, testSignal());
    expect(result).toBeNull();
  });

  it("returns parsed Config when valid file exists", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify(validConfig));

    const result = await loadConfig(dir, testSignal());
    expect(result).toEqual(validConfig);
  });

  it("throws when JSON is invalid", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "config.json"), "{not valid json!!!");

    await expect(loadConfig(dir, testSignal())).rejects.toThrow("failed to parse config");
  });

  it("strips extra fields and returns empty config for unknown shape", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ foo: 123 }));

    const result = await loadConfig(dir, testSignal());
    expect(result).toEqual({});
  });

  it("returns null for valid JSON with empty required fields", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({ todoListId: "", todoListName: "" }),
    );

    // Empty strings fail min(1) validation
    const result = await loadConfig(dir, testSignal());
    expect(result).toBeNull();
  });

  it("returns config with only partial todo fields", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ todoListId: "list-1" }));

    const result = await loadConfig(dir, testSignal());
    expect(result).toEqual({ todoListId: "list-1" });
  });

  it("strips extra fields and returns valid config", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({ ...validConfig, extraField: "ignored" }),
    );

    const result = await loadConfig(dir, testSignal());
    expect(result).toEqual(validConfig);
  });
});

describe("saveConfig", () => {
  it("creates directory if it doesn't exist", async () => {
    const dir = getTempDir();
    const nested = path.join(dir, "nested", "deep");

    await saveConfig(validConfig, nested, testSignal());

    const stat = await fs.stat(nested);
    expect(stat.isDirectory()).toBe(true);
  });

  it("writes valid JSON that can be read back", async () => {
    const dir = getTempDir();
    await saveConfig(validConfig, dir, testSignal());

    const content = await fs.readFile(path.join(dir, "config.json"), "utf-8");
    const parsed = JSON.parse(content) as Config;
    expect(parsed).toEqual(validConfig);
  });

  it("file exists after save (atomic write)", async () => {
    const dir = getTempDir();
    await saveConfig(validConfig, dir, testSignal());

    const filePath = path.join(dir, "config.json");
    const stat = await fs.stat(filePath);
    expect(stat.isFile()).toBe(true);

    // No leftover temp files
    const files = await fs.readdir(dir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });
});

describe("hasTodoConfig", () => {
  it("returns false for null", () => {
    expect(hasTodoConfig(null)).toBe(false);
  });

  it("returns false for config without todo fields", () => {
    expect(hasTodoConfig({})).toBe(false);
  });

  it("returns true for config with todo fields", () => {
    expect(hasTodoConfig(validConfig)).toBe(true);
  });
});

describe("loadAndValidateConfig", () => {
  it("throws helpful error when config file missing", async () => {
    const dir = getTempDir();
    await expect(loadAndValidateConfig(dir, testSignal())).rejects.toThrow(/not configured/);
  });

  it("throws helpful error when config invalid", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({ todoListId: "", todoListName: "" }),
    );

    await expect(loadAndValidateConfig(dir, testSignal())).rejects.toThrow(/not configured/);
  });

  it("returns config when valid", async () => {
    const dir = getTempDir();
    await saveConfig(validConfig, dir, testSignal());

    const result = await loadAndValidateConfig(dir, testSignal());
    expect(result).toEqual(validConfig);
  });
});

describe("round-trip", () => {
  it("save then load returns identical data", async () => {
    const dir = getTempDir();
    const config: Config = {
      todoListId: "abc-456",
      todoListName: "Work Items",
    };

    await saveConfig(config, dir, testSignal());
    const loaded = await loadConfig(dir, testSignal());

    expect(loaded).toEqual(config);
  });
});

// ---------------------------------------------------------------------------
// Strict markdown root folder validation
// ---------------------------------------------------------------------------

import {
  hasMarkdownConfig,
  loadAndValidateMarkdownConfig,
  markdownRootFolderIdError,
} from "../src/config.js";

describe("markdownRootFolderIdError", () => {
  it("accepts a plausible opaque drive item ID", () => {
    expect(markdownRootFolderIdError("01ABCDEF1234567890ABCDEF")).toBeNull();
    expect(markdownRootFolderIdError("folder-1")).toBeNull();
  });
  it("rejects non-strings", () => {
    expect(markdownRootFolderIdError(undefined)).toBe("missing");
    expect(markdownRootFolderIdError(null)).toBe("missing");
    expect(markdownRootFolderIdError(42)).toBe("missing");
  });
  it("rejects the empty string", () => {
    expect(markdownRootFolderIdError("")).toBe("empty");
  });
  it("rejects values equal to / or \\", () => {
    expect(markdownRootFolderIdError("/")).toContain("drive root");
    expect(markdownRootFolderIdError("\\")).toContain("drive root");
  });
  it("rejects values containing path separators (subpaths)", () => {
    expect(markdownRootFolderIdError("foo/bar")).toContain("path separator");
    expect(markdownRootFolderIdError("foo\\bar")).toContain("path separator");
    expect(markdownRootFolderIdError("/foo")).toContain("path separator");
  });
  it("rejects values with whitespace", () => {
    expect(markdownRootFolderIdError("foo bar")).toContain("whitespace");
    expect(markdownRootFolderIdError("foo\tbar")).toContain("whitespace");
  });
});

describe("hasMarkdownConfig", () => {
  it("returns false for null, undefined, and empty configs", () => {
    expect(hasMarkdownConfig(null)).toBe(false);
    expect(hasMarkdownConfig({})).toBe(false);
    expect(hasMarkdownConfig({ markdown: {} })).toBe(false);
  });
  it("returns false for invalid IDs", () => {
    expect(hasMarkdownConfig({ markdown: { rootFolderId: "/" } })).toBe(false);
    expect(hasMarkdownConfig({ markdown: { rootFolderId: "sub/dir" } })).toBe(false);
    expect(hasMarkdownConfig({ markdown: { rootFolderId: "with space" } })).toBe(false);
  });
  it("returns true for valid IDs", () => {
    expect(hasMarkdownConfig({ markdown: { rootFolderId: "folder-1" } })).toBe(true);
  });
});

describe("loadAndValidateMarkdownConfig", () => {
  it("throws a helpful error when not configured", async () => {
    const dir = getTempDir();
    await expect(loadAndValidateMarkdownConfig(dir, testSignal())).rejects.toThrow(
      /not configured.*markdown_select_root_folder/,
    );
  });

  it("throws when rootFolderId contains a path separator", async () => {
    const dir = getTempDir();
    await saveConfig({ markdown: { rootFolderId: "sub/dir" } } as Config, dir, testSignal());
    await expect(loadAndValidateMarkdownConfig(dir, testSignal())).rejects.toThrow(
      /invalid.*path separator.*markdown_select_root_folder/,
    );
  });

  it("throws when rootFolderId is /", async () => {
    const dir = getTempDir();
    // Bypass zod validation by writing the file directly.
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({ markdown: { rootFolderId: "/" } }),
    );
    await expect(loadAndValidateMarkdownConfig(dir, testSignal())).rejects.toThrow(
      /invalid.*drive root.*markdown_select_root_folder/,
    );
  });

  it("returns the config when valid", async () => {
    const dir = getTempDir();
    await saveConfig(
      { markdown: { rootFolderId: "folder-1", rootFolderName: "Notes" } } as Config,
      dir,
      testSignal(),
    );
    const loaded = await loadAndValidateMarkdownConfig(dir, testSignal());
    expect(loaded.markdown.rootFolderId).toBe("folder-1");
  });
});
