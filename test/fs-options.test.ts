import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import { testSignal } from "./helpers.js";
import {
  POSIX_DIR_MODE,
  POSIX_FILE_MODE,
  mkdirOptions,
  writeFileOptions,
  writeJsonAtomic,
} from "../src/fs-options.js";

function makeTempDir(): string {
  return path.join(os.tmpdir(), `graphdo-fs-test-${crypto.randomUUID()}`);
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

describe("mkdirOptions", () => {
  it("returns recursive true with mode on POSIX", () => {
    const platform = os.platform();
    const opts = mkdirOptions();
    if (platform !== "win32") {
      expect(opts).toEqual({ recursive: true, mode: POSIX_DIR_MODE });
    } else {
      expect(opts).toEqual({ recursive: true });
    }
  });
});

describe("writeFileOptions", () => {
  it("returns utf-8 encoding with mode on POSIX when no signal", () => {
    const platform = os.platform();
    const opts = writeFileOptions();
    if (platform !== "win32") {
      expect(opts).toEqual({
        encoding: "utf-8" as const,
        mode: POSIX_FILE_MODE,
        signal: undefined,
      });
    } else {
      expect(opts).toEqual({ encoding: "utf-8" as const, signal: undefined });
    }
  });

  it("forwards signal when provided", () => {
    const signal = testSignal();
    const opts = writeFileOptions(signal);
    expect(opts).toHaveProperty("signal", signal);
    const platform = os.platform();
    if (platform !== "win32") {
      expect(opts).toHaveProperty("mode", POSIX_FILE_MODE);
    }
  });
});

describe("appendFileOptions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("returns utf-8 with flag a and mode on POSIX", async () => {
    const { appendFileOptions } = await import("../src/fs-options.js");
    const platform = os.platform();
    const opts = appendFileOptions();
    if (platform !== "win32") {
      expect(opts).toEqual({ encoding: "utf-8" as const, flag: "a", mode: POSIX_FILE_MODE });
    } else {
      expect(opts).toEqual({ encoding: "utf-8" as const, flag: "a" });
    }
  });

  it("Windows branch has flag a without mode", async () => {
    // Mock os.platform() to return "win32"
    vi.doMock("node:os", () => ({
      platform: () => "win32",
    }));

    try {
      const { appendFileOptions: appendFileOptionsWin } = await import("../src/fs-options.js");
      const opts = appendFileOptionsWin();
      expect(opts).toEqual({ encoding: "utf-8" as const, flag: "a" });
      // @ts-expect-error - mode should not exist on Windows
      expect(opts.mode).toBeUndefined();
    } finally {
      vi.doUnmock("node:os");
    }
  });

  it("POSIX branch has flag a with mode", async () => {
    // Mock os.platform() to return "linux"
    vi.doMock("node:os", () => ({
      platform: () => "linux",
    }));

    try {
      const { appendFileOptions: appendFileOptionsPosix } = await import("../src/fs-options.js");
      const opts = appendFileOptionsPosix();
      expect(opts).toEqual({ encoding: "utf-8" as const, flag: "a", mode: POSIX_FILE_MODE });
      expect(opts).toHaveProperty("mode", POSIX_FILE_MODE);
    } finally {
      vi.doUnmock("node:os");
    }
  });
});

describe("writeJsonAtomic", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("writes json file atomically to disk", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "test.json");
    const data = { foo: "bar", nested: { baz: 123 } };

    await writeJsonAtomic(filePath, data, testSignal());

    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content) as typeof data;
    expect(parsed).toEqual(data);
  });

  it("creates parent directory if it doesn't exist", async () => {
    const dir = getTempDir();
    const nested = path.join(dir, "a", "b", "c");
    const filePath = path.join(nested, "test.json");
    const data = { test: true };

    await writeJsonAtomic(filePath, data, testSignal());

    const content = await fs.readFile(filePath, "utf-8");
    expect(JSON.parse(content)).toEqual(data);
  });

  it("throws if signal is already aborted", async () => {
    const dir = getTempDir();
    const filePath = path.join(dir, "test.json");
    const controller = new AbortController();
    const reason = new Error("Aborted");
    controller.abort(reason);

    await expect(writeJsonAtomic(filePath, {}, controller.signal)).rejects.toBe(reason);
  });

  it("cleans up temp file on writeFile failure and re-throws original error", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "test.json");
    const data = { test: true };

    const writeFileError = new Error("writeFile failed");

    // Mock writeFile to fail
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        writeFile: vi.fn().mockRejectedValue(writeFileError),
      };
    });

    try {
      const { writeJsonAtomic: writeJsonAtomicMocked } = await import("../src/fs-options.js");
      await writeJsonAtomicMocked(filePath, data, testSignal());
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBe(writeFileError);
    }

    // Verify that no temp files were left behind
    const files = await fs.readdir(dir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);

    vi.doUnmock("node:fs/promises");
  });

  it("cleans up temp file on rename failure and re-throws original error", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "test.json");
    const data = { test: true };

    const renameError = new Error("rename failed");

    // Mock rename to fail
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        rename: vi.fn().mockRejectedValue(renameError),
      };
    });

    try {
      const { writeJsonAtomic: writeJsonAtomicMocked } = await import("../src/fs-options.js");
      await writeJsonAtomicMocked(filePath, data, testSignal());
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBe(renameError);
    }

    // Verify that no temp files were left behind in the directory
    const files = await fs.readdir(dir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);

    vi.doUnmock("node:fs/promises");
  });

  it("re-throws original error even when cleanup fails", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "test.json");
    const data = { test: true };

    const writeFileError = new Error("original writeFile error");
    const cleanupError = new Error("unlink failed");

    // Mock writeFile to fail and unlink to also fail
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        writeFile: vi.fn().mockRejectedValue(writeFileError),
        unlink: vi.fn().mockRejectedValue(cleanupError),
      };
    });

    try {
      const { writeJsonAtomic: writeJsonAtomicMocked } = await import("../src/fs-options.js");
      await writeJsonAtomicMocked(filePath, data, testSignal());
      expect.fail("Should have thrown");
    } catch (err) {
      // The original error should be what propagates, not the cleanup error
      expect(err).toBe(writeFileError);
      expect(err).not.toBe(cleanupError);
    }

    vi.doUnmock("node:fs/promises");
  });

  it("writes with correct file mode on POSIX", async () => {
    const platform = os.platform();
    if (platform === "win32") {
      // Skip on Windows
      return;
    }

    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "test.json");
    const data = { test: true };

    await writeJsonAtomic(filePath, data, testSignal());

    // Check that file mode is restrictive
    const stats = await fs.stat(filePath);
    // Mode should have 0o600 bits set (owner read+write only)
    const modeOctal = (stats.mode & 0o777).toString(8);
    expect(parseInt(modeOctal, 8)).toBe(POSIX_FILE_MODE);
  });

  it("writes valid JSON with pretty printing", async () => {
    const dir = getTempDir();
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "test.json");
    const data = { foo: "bar", nested: { baz: [1, 2, 3] } };

    await writeJsonAtomic(filePath, data, testSignal());

    const content = await fs.readFile(filePath, "utf-8");
    // Check that content is properly indented (JSON.stringify with 2-space indent)
    expect(content).toContain("  ");
    // Check that it ends with newline
    expect(content).toMatch(/\n$/);
    // Check that it parses back correctly
    expect(JSON.parse(content)).toEqual(data);
  });
});
