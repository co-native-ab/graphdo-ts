// Persistence helper for the renewal-counts sidecar
// (`docs/plans/collab-v1.md` §3.5).
//
// On-disk path: `<configDir>/sessions/renewal-counts.json`. Keyed by
// `<userOid>/<projectId>` (full Entra `oid` per §3.6 redaction notes —
// no prefix). Each entry is a sliding window of ISO-8601 timestamps;
// entries older than 24h are pruned on every read and every write.
//
// Used by `session_renew` (W4 Day 5) to enforce the §3.5 cap of
// **6 renewals per user per project per 24h rolling window**. The
// per-session cap (3 renewals) is enforced from in-memory state on the
// `SessionRegistry` snapshot (see `src/collab/session.ts`).
//
// User-editable file; that is acceptable per the §0 threat model
// ("local rate limits are not a security boundary against the human
// user").
//
// Pruning is lazy-on-touch (same pattern as `session-counts.ts` and
// the leases sidecar §3.2.1) — no background housekeeper, no
// migration. An entry whose `renewals` array empties out after pruning
// is dropped from the file so a long-idle key does not accumulate as
// an empty `{}` row forever.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { z } from "zod";

import { logger } from "../logger.js";
import { isNodeError } from "../errors.js";
import { writeJsonAtomic } from "../fs-options.js";

// ---------------------------------------------------------------------------
// Constants & paths
// ---------------------------------------------------------------------------

const SESSIONS_DIR_NAME = "sessions";
const COUNTS_FILE_NAME = "renewal-counts.json";

/** Returns `<configDir>/sessions/renewal-counts.json`. */
export function renewalCountsPath(configDir: string): string {
  return path.join(configDir, SESSIONS_DIR_NAME, COUNTS_FILE_NAME);
}

/** Rolling-window length per `docs/plans/collab-v1.md` §3.5. */
export const RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Maximum renewals per `(userOid, projectId)` key in any rolling 24h window. */
export const MAX_RENEWALS_PER_WINDOW = 6;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** A single sliding-window entry — list of ISO-8601 renewal timestamps. */
export const RenewalWindowEntrySchema = z
  .object({
    renewals: z.array(z.iso.datetime({ offset: true })),
  })
  .strict();

export type RenewalWindowEntry = z.infer<typeof RenewalWindowEntrySchema>;

export const RenewalCountsFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    windows: z.record(z.string().min(1), RenewalWindowEntrySchema),
  })
  .strict();

export type RenewalCountsFile = z.infer<typeof RenewalCountsFileSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised when the counts file fails JSON / Zod parse. */
export class RenewalCountsParseError extends Error {
  constructor(
    public readonly filePath: string,
    public override readonly cause?: unknown,
  ) {
    super(`Failed to parse renewal counts at ${filePath}`);
    this.name = "RenewalCountsParseError";
  }
}

// ---------------------------------------------------------------------------
// Key helper
// ---------------------------------------------------------------------------

/** Compose the `(userOid, projectId)` window key (`"<oid>/<projectId>"`). */
export function renewalKey(userOid: string, projectId: string): string {
  if (userOid.length === 0) throw new Error("renewalKey: userOid must be non-empty");
  if (projectId.length === 0) throw new Error("renewalKey: projectId must be non-empty");
  return `${userOid}/${projectId}`;
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/**
 * Drop renewal timestamps older than `now - RENEWAL_WINDOW_MS` from every
 * entry, and drop entries whose `renewals` array is empty after pruning.
 * Pure helper — returns a new file value with `schemaVersion` preserved.
 *
 * Timestamps that fail `Date.parse` (NaN) are also dropped — the strict
 * Zod schema rejects them up-front, but the helper is defensive against
 * a future schema relaxation.
 */
export function pruneStale(file: RenewalCountsFile, now: Date): RenewalCountsFile {
  const cutoffMs = now.getTime() - RENEWAL_WINDOW_MS;
  const next: RenewalCountsFile = { schemaVersion: 1, windows: {} };
  for (const [key, entry] of Object.entries(file.windows)) {
    const fresh = entry.renewals.filter((iso) => {
      const ms = Date.parse(iso);
      return Number.isFinite(ms) && ms > cutoffMs;
    });
    if (fresh.length > 0) {
      next.windows[key] = { renewals: fresh };
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/**
 * Read the renewal-counts sidecar. Returns an empty file when the path
 * does not exist; throws {@link RenewalCountsParseError} on JSON / Zod
 * failure so a corrupted file does not silently lose window state.
 *
 * Stale entries (`ts <= now - 24h`) are dropped from the returned value.
 * Callers that mutate the file should pass the pruned value back to
 * {@link saveRenewalCounts}, which prunes again on write — that is the
 * single point at which the on-disk file is rewritten.
 */
export async function loadRenewalCounts(
  configDir: string,
  now: Date,
  signal: AbortSignal,
): Promise<RenewalCountsFile> {
  const filePath = renewalCountsPath(configDir);
  let content: string;
  try {
    content = await fs.readFile(filePath, { encoding: "utf-8", signal });
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return { schemaVersion: 1, windows: {} };
    }
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new RenewalCountsParseError(filePath, err);
  }
  const parsed = RenewalCountsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RenewalCountsParseError(filePath, parsed.error);
  }
  return pruneStale(parsed.data, now);
}

/**
 * Persist the renewal-counts sidecar. Validates with Zod and prunes
 * stale entries on the way out so the file on disk is always tidy.
 */
export async function saveRenewalCounts(
  configDir: string,
  file: RenewalCountsFile,
  now: Date,
  signal: AbortSignal,
): Promise<RenewalCountsFile> {
  const pruned = pruneStale(file, now);
  const validated = RenewalCountsFileSchema.parse(pruned);
  const filePath = renewalCountsPath(configDir);
  logger.debug("saving renewal counts", {
    path: filePath,
    keyCount: Object.keys(validated.windows).length,
  });
  await writeJsonAtomic(filePath, validated, signal);
  return validated;
}

/**
 * Count of fresh renewals in the rolling 24h window for the given key.
 * Reads the file (which prunes stale entries) and returns the array
 * length. Returns `0` when the key is absent.
 */
export async function windowCount(
  configDir: string,
  key: string,
  now: Date,
  signal: AbortSignal,
): Promise<number> {
  const file = await loadRenewalCounts(configDir, now, signal);
  return file.windows[key]?.renewals.length ?? 0;
}

/** Result of {@link recordRenewal} — counts before and after the new entry. */
export interface RenewalRecordResult {
  windowCountBefore: number;
  windowCountAfter: number;
  /** ISO-8601 timestamp written for this renewal (== `now.toISOString()`). */
  ts: string;
}

/**
 * Append a fresh renewal timestamp for `key` and persist. Returns the
 * window counts before and after the append (post-pruning) so the
 * caller can populate the §3.6 `renewal` audit envelope without an
 * extra read.
 *
 * Does **not** enforce the cap — that is the caller's responsibility
 * (they must check `windowCount` first and refuse with
 * `RenewalCapPerWindowError` when at the limit). Persisting the entry
 * unconditionally would let an over-cap renewal silently land if a
 * future caller forgot the pre-check.
 */
export async function recordRenewal(
  configDir: string,
  key: string,
  now: Date,
  signal: AbortSignal,
): Promise<RenewalRecordResult> {
  const current = await loadRenewalCounts(configDir, now, signal);
  const existing = current.windows[key]?.renewals ?? [];
  const ts = now.toISOString();
  const next: RenewalCountsFile = {
    schemaVersion: 1,
    windows: { ...current.windows, [key]: { renewals: [...existing, ts] } },
  };
  const saved = await saveRenewalCounts(configDir, next, now, signal);
  return {
    windowCountBefore: existing.length,
    windowCountAfter: saved.windows[key]?.renewals.length ?? existing.length + 1,
    ts,
  };
}
