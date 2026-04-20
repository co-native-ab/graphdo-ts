// Unit tests for src/instance-lock.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  INSTANCE_LOCK_FILE,
  InstanceLockHeldError,
  acquireInstanceLock,
  defaultIsPidAlive,
} from "../src/instance-lock.js";
import { testSignal } from "./helpers.js";

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), "graphdo-lock-test-"));
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

describe("acquireInstanceLock", () => {
  it("creates the lock file with this process's pid", async () => {
    const handle = await acquireInstanceLock(configDir, testSignal(), { pid: 12345 });
    const stats = await stat(handle.path);
    expect(stats.isFile()).toBe(true);
    expect(handle.path).toBe(path.join(configDir, INSTANCE_LOCK_FILE));
    const data = JSON.parse(await readFile(handle.path, "utf-8")) as Record<string, unknown>;
    expect(data["pid"]).toBe(12345);
    expect(typeof data["startedAt"]).toBe("string");
    expect(data["configDir"]).toBe(configDir);
    await handle.release(testSignal());
  });

  it("release() deletes the lock file", async () => {
    const handle = await acquireInstanceLock(configDir, testSignal(), { pid: 555 });
    await handle.release(testSignal());
    await expect(stat(handle.path)).rejects.toThrow();
  });

  it("release() is idempotent (calling twice is a no-op)", async () => {
    const handle = await acquireInstanceLock(configDir, testSignal(), { pid: 777 });
    await handle.release(testSignal());
    await handle.release(testSignal());
  });

  it("refuses when an existing lock points at a live peer pid", async () => {
    await acquireInstanceLock(configDir, testSignal(), {
      pid: 1001,
      isPidAlive: () => true,
    });
    await expect(
      acquireInstanceLock(configDir, testSignal(), {
        pid: 1002,
        isPidAlive: () => true,
      }),
    ).rejects.toBeInstanceOf(InstanceLockHeldError);
  });

  it("recovers a stale lock whose pid is gone", async () => {
    await acquireInstanceLock(configDir, testSignal(), {
      pid: 1003,
      isPidAlive: () => true,
    });
    // Simulate a fresh process whose isPidAlive reports the previous
    // pid as gone.
    const handle = await acquireInstanceLock(configDir, testSignal(), {
      pid: 1004,
      isPidAlive: (pid) => pid === 1004,
    });
    const data = JSON.parse(await readFile(handle.path, "utf-8")) as Record<string, unknown>;
    expect(data["pid"]).toBe(1004);
    await handle.release(testSignal());
  });

  it("recovers from a corrupt lock file", async () => {
    await writeFile(path.join(configDir, INSTANCE_LOCK_FILE), "not-json{{{");
    const handle = await acquireInstanceLock(configDir, testSignal(), { pid: 2002 });
    const data = JSON.parse(await readFile(handle.path, "utf-8")) as Record<string, unknown>;
    expect(data["pid"]).toBe(2002);
    await handle.release(testSignal());
  });

  it("recovers when the same pid re-acquires (e.g. test re-run within the same vitest worker)", async () => {
    await acquireInstanceLock(configDir, testSignal(), { pid: 3001, isPidAlive: () => true });
    // Same pid should be allowed to re-take the lock.
    const handle = await acquireInstanceLock(configDir, testSignal(), {
      pid: 3001,
      isPidAlive: () => true,
    });
    await handle.release(testSignal());
  });

  it("InstanceLockHeldError carries the conflicting pid + configDir + startedAt", async () => {
    await acquireInstanceLock(configDir, testSignal(), { pid: 4001, isPidAlive: () => true });
    try {
      await acquireInstanceLock(configDir, testSignal(), {
        pid: 4002,
        isPidAlive: () => true,
      });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InstanceLockHeldError);
      const e = err as InstanceLockHeldError;
      expect(e.heldByPid).toBe(4001);
      expect(e.configDir).toBe(configDir);
      expect(e.heldSince).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(e.message).toContain(configDir);
    }
  });

  it("creates the configDir if missing", async () => {
    const child = path.join(configDir, "nested", "alice");
    const handle = await acquireInstanceLock(child, testSignal(), { pid: 5001 });
    const stats = await stat(handle.path);
    expect(stats.isFile()).toBe(true);
    await handle.release(testSignal());
  });

  it("aborts when the signal is already cancelled", async () => {
    const ac = new AbortController();
    ac.abort(new Error("cancelled before call"));
    await expect(acquireInstanceLock(configDir, ac.signal, { pid: 6001 })).rejects.toThrow();
    // No lock file should have been created.
    await expect(stat(path.join(configDir, INSTANCE_LOCK_FILE))).rejects.toThrow();
  });
});

describe("defaultIsPidAlive", () => {
  it("returns true for the current process", () => {
    expect(defaultIsPidAlive(process.pid)).toBe(true);
  });

  it("returns false for an obviously dead pid (negative)", () => {
    expect(defaultIsPidAlive(-1)).toBe(false);
  });

  it("returns false for pid 0", () => {
    expect(defaultIsPidAlive(0)).toBe(false);
  });

  it("returns false for a non-integer pid", () => {
    expect(defaultIsPidAlive(1.5)).toBe(false);
  });

  it("returns false for a very large pid that is unlikely to exist", () => {
    // 2^31 - 1 is the conventional max pid on Linux; practically never
    // assigned. This is a heuristic test — flaky in theory, never in
    // practice.
    expect(defaultIsPidAlive(2_147_483_640)).toBe(false);
  });
});
