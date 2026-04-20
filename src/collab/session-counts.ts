// Persistence helper for the destructive-counter sidecar
// (`docs/plans/collab-v1.md` §3.7).
//
// On-disk path: `<configDir>/sessions/destructive-counts.json`. Persisted to
// disk so a crash-and-restart agent within the same session window does not
// get a fresh budget when a future `session_open_project` rebinds by
// `sessionId`. Removed on `session_end`.
//
// **Stale-session pruning.** Sessions are not always cleanly ended (process
// kill, OS reboot, transport drop without process exit), so the `sessions`
// object would otherwise accumulate orphan entries. On every read and every
// write, entries with `expiresAt < now - 24h` are dropped from the in-memory
// view and the next persisted write omits them. The 24h grace window covers
// the maximum TTL (8h) plus a safety margin so a session paused mid-flight
// is not pruned. Same lazy-cleanup-on-touch pattern as the leases sidecar
// (§3.2.1) — no background housekeeper, no migration.
//
// User-editable file; that is acceptable per the §0 threat model.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { z } from "zod";

import { logger } from "../logger.js";
import { isNodeError } from "../errors.js";
import { mkdirOptions, writeFileOptions } from "../fs-options.js";

// ---------------------------------------------------------------------------
// Constants & paths
// ---------------------------------------------------------------------------

const SESSIONS_DIR_NAME = "sessions";
const COUNTS_FILE_NAME = "destructive-counts.json";

/** Returns `<configDir>/sessions`. */
export function sessionsDir(configDir: string): string {
  return path.join(configDir, SESSIONS_DIR_NAME);
}

/** Returns the on-disk path for the destructive-counts sidecar. */
export function destructiveCountsPath(configDir: string): string {
  return path.join(sessionsDir(configDir), COUNTS_FILE_NAME);
}

/** Grace window beyond `expiresAt` before an orphan session is pruned. */
export const STALE_GRACE_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Per-session counter snapshot — see §3.7 of the plan. */
export const DestructiveCountEntrySchema = z
  .object({
    projectId: z.string().min(1),
    destructiveBudgetTotal: z.number().int().nonnegative(),
    destructiveUsed: z.number().int().nonnegative(),
    writeBudgetTotal: z.number().int().nonnegative(),
    writesUsed: z.number().int().nonnegative(),
    expiresAt: z.iso.datetime({ offset: true }),
    renewalsUsed: z.number().int().nonnegative(),
  })
  .strict();

export type DestructiveCountEntry = z.infer<typeof DestructiveCountEntrySchema>;

export const DestructiveCountsFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessions: z.record(z.string().min(1), DestructiveCountEntrySchema),
  })
  .strict();

export type DestructiveCountsFile = z.infer<typeof DestructiveCountsFileSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised when the counts file fails JSON / Zod parse. */
export class DestructiveCountsParseError extends Error {
  constructor(
    public readonly filePath: string,
    public override readonly cause?: unknown,
  ) {
    super(`Failed to parse destructive counts at ${filePath}`);
    this.name = "DestructiveCountsParseError";
  }
}

// ---------------------------------------------------------------------------
// Atomic writer
// ---------------------------------------------------------------------------

async function writeJsonAtomic(
  filePath: string,
  data: unknown,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason;

  const dir = path.dirname(filePath);
  await fs.mkdir(dir, mkdirOptions());

  const body = JSON.stringify(data, null, 2) + "\n";
  const tmpFile = path.join(dir, `.${path.basename(filePath)}-${crypto.randomUUID()}.tmp`);

  try {
    await fs.writeFile(tmpFile, body, writeFileOptions(signal));
    await fs.rename(tmpFile, filePath);
  } catch (err) {
    try {
      await fs.unlink(tmpFile);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/**
 * Drop entries whose `expiresAt` is older than `now - STALE_GRACE_MS`.
 * Pure helper — returns a new file with the same `schemaVersion` and only
 * the non-stale entries.
 */
export function pruneStale(file: DestructiveCountsFile, now: Date): DestructiveCountsFile {
  const cutoff = now.getTime() - STALE_GRACE_MS;
  const next: DestructiveCountsFile = {
    schemaVersion: 1,
    sessions: {},
  };
  for (const [sessionId, entry] of Object.entries(file.sessions)) {
    const expiresMs = Date.parse(entry.expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs >= cutoff) {
      next.sessions[sessionId] = entry;
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/**
 * Read the destructive-counts sidecar. Returns an empty file when the path
 * does not exist; throws {@link DestructiveCountsParseError} on JSON / Zod
 * failure so a corrupted file does not silently lose budget state.
 *
 * Stale entries (`expiresAt < now - 24h`) are dropped from the returned
 * value. Callers that mutate the file should pass the pruned value back to
 * {@link saveDestructiveCounts}, which prunes again on write — that is the
 * single point at which the on-disk file is rewritten.
 */
export async function loadDestructiveCounts(
  configDir: string,
  now: Date,
  signal: AbortSignal,
): Promise<DestructiveCountsFile> {
  const filePath = destructiveCountsPath(configDir);
  let content: string;
  try {
    content = await fs.readFile(filePath, { encoding: "utf-8", signal });
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return { schemaVersion: 1, sessions: {} };
    }
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new DestructiveCountsParseError(filePath, err);
  }
  const parsed = DestructiveCountsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DestructiveCountsParseError(filePath, parsed.error);
  }
  return pruneStale(parsed.data, now);
}

/**
 * Persist the destructive-counts sidecar. Validates with Zod and prunes
 * stale entries on the way out so the file on disk is always tidy.
 */
export async function saveDestructiveCounts(
  configDir: string,
  file: DestructiveCountsFile,
  now: Date,
  signal: AbortSignal,
): Promise<DestructiveCountsFile> {
  const pruned = pruneStale(file, now);
  const validated = DestructiveCountsFileSchema.parse(pruned);
  const filePath = destructiveCountsPath(configDir);
  logger.debug("saving destructive counts", {
    path: filePath,
    sessionCount: Object.keys(validated.sessions).length,
  });
  await writeJsonAtomic(filePath, validated, signal);
  return validated;
}

/**
 * Insert or overwrite the entry for a single sessionId, then persist.
 * Convenience wrapper used by the session registry on every counter
 * mutation so the on-disk view never lags behind in-memory state.
 */
export async function upsertDestructiveCount(
  configDir: string,
  sessionId: string,
  entry: DestructiveCountEntry,
  now: Date,
  signal: AbortSignal,
): Promise<DestructiveCountsFile> {
  const current = await loadDestructiveCounts(configDir, now, signal);
  const next: DestructiveCountsFile = {
    schemaVersion: 1,
    sessions: { ...current.sessions, [sessionId]: entry },
  };
  return saveDestructiveCounts(configDir, next, now, signal);
}

/**
 * Drop a single sessionId from the sidecar (called on `session_end`).
 * Does nothing if the sessionId is not present. Always rewrites the file
 * so stale sibling entries get pruned at the same time.
 */
export async function removeDestructiveCount(
  configDir: string,
  sessionId: string,
  now: Date,
  signal: AbortSignal,
): Promise<DestructiveCountsFile> {
  const current = await loadDestructiveCounts(configDir, now, signal);
  if (!(sessionId in current.sessions)) {
    return saveDestructiveCounts(configDir, current, now, signal);
  }
  const nextSessions: Record<string, DestructiveCountEntry> = {};
  for (const [id, entry] of Object.entries(current.sessions)) {
    if (id !== sessionId) {
      nextSessions[id] = entry;
    }
  }
  return saveDestructiveCounts(
    configDir,
    { schemaVersion: 1, sessions: nextSessions },
    now,
    signal,
  );
}
