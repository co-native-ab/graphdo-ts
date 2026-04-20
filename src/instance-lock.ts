// Per-config-dir instance lock for graphdo-ts.
//
// Two MCP server processes pointing at the same `<configDir>` would
// race on the MSAL token cache, the destructive-counts sidecar, the
// project metadata files, and the audit JSONL appenders (the latter is
// safe per POSIX `O_APPEND` ≤ PIPE_BUF, but the others are not).
//
// To prevent that, every server writes a lock file to
// `<configDir>/instance.lock` on startup. If the file already exists
// **and** the recorded PID is still alive, startup fails with a clear
// error naming the conflict. A stale lock (PID gone) is silently
// recovered.
//
// The lock is released on `SIGINT` / `SIGTERM` and on normal process
// exit via the `release()` returned from {@link acquireInstanceLock}.
//
// This is **not** a security boundary. A malicious peer process could
// trivially delete the file or forge a PID. The lock exists to catch
// the common operator misconfiguration where the same `GRAPHDO_CONFIG_DIR`
// is wired into two MCP server entries in a Copilot CLI / Claude
// Desktop config — see `docs/plans/two-instance-e2e.md`.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { mkdirOptions, writeFileOptions } from "./fs-options.js";
import { logger } from "./logger.js";

/** File name used inside `<configDir>` for the lock. */
export const INSTANCE_LOCK_FILE = "instance.lock";

/** On-disk shape of the lock file. JSON, one line, atomic write. */
export interface InstanceLockData {
  pid: number;
  startedAt: string;
  configDir: string;
}

/** Raised when `<configDir>` is already held by a live peer process. */
export class InstanceLockHeldError extends Error {
  constructor(
    public readonly configDir: string,
    public readonly heldByPid: number,
    public readonly heldSince: string,
  ) {
    super(
      `Another graphdo-ts process (pid ${String(heldByPid)}, started ${heldSince}) ` +
        `already holds the config directory ${configDir}. ` +
        "Two MCP servers cannot share one config dir — the MSAL token cache, " +
        "destructive-counts sidecar, and project metadata files would race. " +
        "Either stop the other process, or set GRAPHDO_CONFIG_DIR to a separate " +
        "directory for this instance (see docs/plans/two-instance-e2e.md).",
    );
    this.name = "InstanceLockHeldError";
  }
}

/** Returned from {@link acquireInstanceLock}; call to delete the lock file. */
export interface InstanceLockHandle {
  /** Absolute path of the lock file. */
  readonly path: string;
  /**
   * Best-effort delete of the lock file. Idempotent; never throws.
   * `signal` is forwarded to the read-back step so a shutdown that
   * times out can still cancel the release cleanly.
   */
  release(signal: AbortSignal): Promise<void>;
}

/**
 * Process-liveness probe used by {@link acquireInstanceLock} to detect
 * stale locks. Returns `true` when a process with the given PID exists
 * (regardless of whether the current user can signal it). Injected for
 * testability.
 *
 * Default implementation uses `process.kill(pid, 0)`:
 *   - `pid` exists, signal allowed → returns `true`.
 *   - `pid` exists, EPERM (different user) → returns `true` (conservative).
 *   - `pid` does not exist (ESRCH) → returns `false`.
 */
export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (err !== null && typeof err === "object" && "code" in err) {
      const code = (err as { code: unknown }).code;
      if (code === "EPERM") return true;
      if (code === "ESRCH") return false;
    }
    // Unknown error — fail safe (treat as alive so we don't blow past
    // a real conflict on an unusual platform).
    return true;
  }
}

/**
 * Try to acquire the per-`configDir` instance lock.
 *
 * On success returns an {@link InstanceLockHandle} the caller must
 * `release()` on shutdown. On a live conflict throws
 * {@link InstanceLockHeldError}. A stale lock (PID gone) is silently
 * overwritten and the call succeeds.
 *
 * `now` and `isPidAlive` are injected for tests.
 */
export async function acquireInstanceLock(
  configDir: string,
  signal: AbortSignal,
  options: {
    now?: () => Date;
    isPidAlive?: (pid: number) => boolean;
    pid?: number;
  } = {},
): Promise<InstanceLockHandle> {
  const now = options.now ?? ((): Date => new Date());
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const myPid = options.pid ?? process.pid;
  const lockPath = path.join(configDir, INSTANCE_LOCK_FILE);

  signal.throwIfAborted();
  // `fs.mkdir` does not accept an AbortSignal in current Node typings;
  // the abort-check above plus the cancellable I/O on read/write below
  // give the same effective semantics — a signal aborted at any point
  // during acquisition surfaces as either an immediate throw here or
  // an `AbortError` from the next signal-aware syscall.
  await fs.mkdir(configDir, mkdirOptions());

  // Read any existing lock and refuse if it looks live.
  const existing = await readLockFile(lockPath, signal);
  if (existing !== null) {
    if (existing.pid !== myPid && isPidAlive(existing.pid)) {
      throw new InstanceLockHeldError(configDir, existing.pid, existing.startedAt);
    }
    if (existing.pid !== myPid) {
      logger.warn("instance lock: recovering stale lock", {
        configDir,
        previousPid: existing.pid,
        previousStartedAt: existing.startedAt,
      });
    }
  }

  const data: InstanceLockData = {
    pid: myPid,
    startedAt: now().toISOString(),
    configDir,
  };

  // Atomic write via temp+rename so a crashed mid-write never leaves a
  // partial line on disk.
  signal.throwIfAborted();
  const tempPath = `${lockPath}.${String(myPid)}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(data), writeFileOptions(signal));
  try {
    signal.throwIfAborted();
    await fs.rename(tempPath, lockPath);
  } catch (err: unknown) {
    // Best-effort cleanup of the temp file on rename failure (or abort).
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }

  let released = false;
  return {
    path: lockPath,
    release: async (releaseSignal: AbortSignal): Promise<void> => {
      if (released) return;
      released = true;
      try {
        // Only delete if the file still claims us — defensive against a
        // peer process that overwrote our lock after acquiring it
        // legitimately (would be a bug, but cheap to guard).
        const current = await readLockFile(lockPath, releaseSignal);
        if (current?.pid === myPid) {
          await fs.rm(lockPath, { force: true });
        }
      } catch (err: unknown) {
        logger.warn("instance lock: release failed (best-effort)", {
          configDir,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

async function readLockFile(
  lockPath: string,
  signal: AbortSignal,
): Promise<InstanceLockData | null> {
  let content: string;
  try {
    content = await fs.readFile(lockPath, { encoding: "utf-8", signal });
  } catch (err: unknown) {
    if (
      err !== null &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "pid" in parsed &&
      typeof (parsed as { pid: unknown }).pid === "number" &&
      "startedAt" in parsed &&
      typeof (parsed as { startedAt: unknown }).startedAt === "string" &&
      "configDir" in parsed &&
      typeof (parsed as { configDir: unknown }).configDir === "string"
    ) {
      return parsed as InstanceLockData;
    }
    return null;
  } catch {
    // Corrupt lock file — treat as stale.
    return null;
  }
}
