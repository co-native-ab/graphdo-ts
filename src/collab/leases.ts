// Leases sidecar codec for `.collab/leases.json` (collab v1 §3.2.1).
//
// Section leases are stored in a small (< 4 KB typical, hard cap 64 KB)
// JSON file separate from the authoritative-file frontmatter so a
// lease cycle does not have to ship the full body of a 4 MiB markdown
// file (Appendix B risk 2). The file is **lazy-created** by the first
// `collab_acquire_section` (byPath PUT with `conflictBehavior=fail`).
// Subsequent acquires/releases use byId CAS via `If-Match` on the
// leases-file `cTag`.
//
// The codec mirrors the sentinel codec's posture: strict Zod schema,
// pure parse/serialise helpers, and a thin Graph wrapper. Per §3.2.1
// the file is "untrusted, like the sentinel" — a cooperator can edit
// it directly. Lease integrity is coordination, not authentication;
// the audit log records who actually called `collab_acquire_section`.
//
// Expired leases are pruned on read (the in-memory view filters them
// out); the next acquire/release CAS persists the cleanup.
//
// W3 Day 4 ships:
//
//   - `LeasesFile` strict Zod schema + `parseLeases`/`serializeLeases`
//     pure codec.
//   - `pruneExpiredLeases` — drops entries with `expiresAt < now`.
//   - `readLeases` — Graph helper, returns `{ file, item }` or throws
//     `LeasesFileMissingError` on 404.
//   - `writeLeasesFresh` — byPath PUT with `conflictBehavior=fail` for
//     the lazy-create on first acquire.
//   - `writeLeasesUpdate` — byId PUT with `If-Match` for subsequent CAS
//     replaces. Reuses `CollabCTagMismatchError` (412) and the 64 KB
//     cap (`LeasesFileTooLargeError`).

import { z } from "zod";

import type { GraphClient } from "../graph/client.js";
import { GraphRequestError, HttpMethod, parseResponse } from "../graph/client.js";
import type { ValidatedGraphId } from "../graph/ids.js";
import type { DriveItem } from "../graph/types.js";
import { DriveItemSchema } from "../graph/types.js";
import { logger } from "../logger.js";

import { CollabCTagMismatchError } from "../errors.js";
import { SENTINEL_FOLDER_NAME } from "./sentinel.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** File name of the leases sidecar within `.collab/`. */
export const LEASES_FILE_NAME = "leases.json";

/** Schema version this codec emits and accepts. */
export const LEASES_SCHEMA_VERSION = 1;

/**
 * Hard upper bound on the on-the-wire size of `.collab/leases.json`
 * (§3.2.1: 64 KB allows ~600 active leases, two orders of magnitude
 * beyond any realistic workload). Writes that would exceed this cap
 * raise {@link LeasesFileTooLargeError}; reads that exceed it are
 * rejected before parsing to keep the schema-validation pass cheap.
 */
export const LEASES_MAX_BYTES = 64 * 1024;

/** Default lease TTL: 600 s (§2.3 `collab_acquire_section`). */
export const DEFAULT_LEASE_TTL_SECONDS = 600;

/** Hard upper bound on a single lease TTL: 3600 s (§2.3). */
export const MAX_LEASE_TTL_SECONDS = 3600;

/** Hard lower bound on a single lease TTL: 1 s (defensive — caller still has to pass a positive number). */
export const MIN_LEASE_TTL_SECONDS = 1;

/** Explicit `Content-Type` for leases writes. */
const LEASES_CONTENT_TYPE = "application/json";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * A single lease entry. Per §3.2.1 the field is named `sectionSlug`
 * (no `target_` prefix) — different from the `target_section_slug`
 * used in the authoritative-file frontmatter, on purpose: a lease entry
 * **is** the section being held, not a record describing an operation
 * that targets one.
 */
export const LeaseEntrySchema = z
  .object({
    sectionSlug: z.string().min(1),
    /** `<oidPrefix>-<clientSlug>-<sessionPrefix>` per §B6.17. */
    agentId: z.string().min(1),
    /** Display-only — same UNTRUSTED posture as the sentinel's `createdBy.displayName`. */
    agentDisplayName: z.string().min(1),
    acquiredAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

/** TypeScript view of {@link LeaseEntrySchema}. */
export type LeaseEntry = z.infer<typeof LeaseEntrySchema>;

/**
 * Strict schema for `.collab/leases.json`. Top-level `.strict()` rejects
 * unknown keys per §3.2.1 ("Schema sealed. Zod-validated on read;
 * unknown top-level keys rejected. Schema bumps via `schemaVersion`.").
 */
export const LeasesFileSchema = z
  .object({
    schemaVersion: z.literal(LEASES_SCHEMA_VERSION),
    leases: z.array(LeaseEntrySchema),
  })
  .strict();

/** TypeScript view of {@link LeasesFileSchema}. */
export type LeasesFile = z.infer<typeof LeasesFileSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Error raised when a leases response body is malformed JSON or fails Zod validation. */
export class LeasesParseError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(`Leases parse failed: ${message}`);
    this.name = "LeasesParseError";
  }
}

/**
 * Raised by {@link readLeases} when `.collab/leases.json` returns 404
 * **and** the caller wants to treat that as a hard error. The lease
 * tools handle the "missing → empty in-memory view" graceful-
 * degradation case at the tool layer (§2.3 release graceful degradation)
 * by catching this error and substituting an empty leases file.
 */
export class LeasesFileMissingError extends Error {
  constructor(public readonly projectFolderId: string) {
    super(
      `No ${SENTINEL_FOLDER_NAME}/${LEASES_FILE_NAME} sidecar found ` +
        `at folder ${projectFolderId}`,
    );
    this.name = "LeasesFileMissingError";
  }
}

/**
 * Raised by {@link writeLeasesFresh}/{@link writeLeasesUpdate} (and
 * {@link assertLeasesWithinCap}) when a serialised leases file would
 * exceed {@link LEASES_MAX_BYTES}. The cap is well above any realistic
 * workload (~600 active leases); hitting it indicates a leak —
 * something is acquiring leases without releasing them.
 */
export class LeasesFileTooLargeError extends Error {
  constructor(
    public readonly bytes: number,
    public readonly limit: number,
  ) {
    super(
      `Leases sidecar size ${String(bytes)} bytes exceeds ${String(limit)}-byte cap. ` +
        "Releasing expired or stale leases will reduce the file; if the cap is hit during normal use, an agent is leaking acquires.",
    );
    this.name = "LeasesFileTooLargeError";
  }
}

// ---------------------------------------------------------------------------
// Pure codec
// ---------------------------------------------------------------------------

/**
 * Parse a raw leases body into a validated {@link LeasesFile}. Throws
 * {@link LeasesParseError} on byte-cap violation, malformed JSON, or
 * Zod validation failure.
 */
export function parseLeases(raw: string): LeasesFile {
  if (raw.length > LEASES_MAX_BYTES) {
    throw new LeasesParseError(
      `body length ${String(raw.length)} exceeds ${String(LEASES_MAX_BYTES)} bytes`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new LeasesParseError("body is not valid JSON", err);
  }
  const result = LeasesFileSchema.safeParse(json);
  if (!result.success) {
    throw new LeasesParseError(result.error.message, result.error);
  }
  return result.data;
}

/**
 * Serialise a {@link LeasesFile} to a canonical JSON string suitable
 * for writing to OneDrive. Uses two-space indentation and a trailing
 * newline (matches the sentinel codec).
 */
export function serializeLeases(file: LeasesFile): string {
  // Validate on the way out so a hand-constructed object cannot smuggle
  // an invalid schema past the codec.
  const parsed = LeasesFileSchema.parse(file);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/**
 * Drop entries whose `expiresAt` is at or before `now`. Pure — does not
 * mutate `file.leases`. Per §3.2.1: "On every read, entries with
 * `expiresAt < now` are dropped from the in-memory view. The next
 * acquire/release CAS persists the cleanup. No background housekeeper."
 */
export function pruneExpiredLeases(file: LeasesFile, now: Date): LeasesFile {
  const cutoff = now.getTime();
  const kept = file.leases.filter((entry) => Date.parse(entry.expiresAt) > cutoff);
  if (kept.length === file.leases.length) return file;
  return { schemaVersion: file.schemaVersion, leases: kept };
}

/**
 * Throw {@link LeasesFileTooLargeError} when the serialised body would
 * exceed the 64 KB cap. Reused by both write helpers so the cap behaves
 * identically regardless of the entry point.
 */
export function assertLeasesWithinCap(serialised: string): void {
  const bytes = Buffer.byteLength(serialised, "utf-8");
  if (bytes > LEASES_MAX_BYTES) {
    throw new LeasesFileTooLargeError(bytes, LEASES_MAX_BYTES);
  }
}

/** Convenience: return an empty (`schemaVersion:1, leases:[]`) leases doc. */
export function emptyLeases(): LeasesFile {
  return { schemaVersion: LEASES_SCHEMA_VERSION, leases: [] };
}

// ---------------------------------------------------------------------------
// Graph I/O
// ---------------------------------------------------------------------------

/**
 * Read `.collab/leases.json` from the given **project root** folder.
 *
 * Uses byPath GETs against `/me/drive/items/{projectFolderId}:/.collab/leases.json`
 * for the item metadata and `:/content` for the body. Throws
 * {@link LeasesFileMissingError} on 404 (caller can treat as
 * "no active leases" per §2.3 graceful-degradation note) and
 * {@link LeasesParseError} on malformed JSON / schema mismatch.
 */
export async function readLeases(
  client: GraphClient,
  projectFolderId: ValidatedGraphId,
  signal: AbortSignal,
): Promise<{ file: LeasesFile; item: DriveItem }> {
  const folderPart = encodeURIComponent(projectFolderId);
  const filePath = encodeURI(`${SENTINEL_FOLDER_NAME}/${LEASES_FILE_NAME}`);
  const itemPath = `/me/drive/items/${folderPart}:/${filePath}`;
  const contentPath = `${itemPath}:/content`;

  logger.debug("reading leases sidecar", { projectFolderId });

  let item: DriveItem;
  try {
    const itemResponse = await client.request(HttpMethod.GET, itemPath, signal);
    item = await parseResponse(itemResponse, DriveItemSchema, HttpMethod.GET, itemPath);
  } catch (err) {
    if (err instanceof GraphRequestError && err.statusCode === 404) {
      throw new LeasesFileMissingError(projectFolderId);
    }
    throw err;
  }

  let raw: string;
  try {
    const contentResponse = await client.request(HttpMethod.GET, contentPath, signal);
    raw = await contentResponse.text();
  } catch (err) {
    if (err instanceof GraphRequestError && err.statusCode === 404) {
      throw new LeasesFileMissingError(projectFolderId);
    }
    throw err;
  }

  const file = parseLeases(raw);
  return { file, item };
}

/**
 * Lazy-create the leases sidecar. byPath PUT with
 * `@microsoft.graph.conflictBehavior=fail` so concurrent first
 * acquires race deterministically (the loser sees a 409 and retries
 * via {@link readLeases} + {@link writeLeasesUpdate}).
 *
 * Throws on 409 with a `LeasesRaceError`-equivalent so the caller can
 * decide to retry. We surface the raw {@link GraphRequestError} (HTTP
 * 409) rather than introduce a new class — the caller's flow is "catch
 * 409, re-read, retry once" which is short enough to keep inline.
 */
export async function writeLeasesFresh(
  client: GraphClient,
  collabFolderId: ValidatedGraphId,
  file: LeasesFile,
  signal: AbortSignal,
): Promise<DriveItem> {
  const body = serializeLeases(file);
  assertLeasesWithinCap(body);

  const path =
    `/me/drive/items/${encodeURIComponent(collabFolderId)}:/` +
    `${encodeURIComponent(LEASES_FILE_NAME)}:/content` +
    `?@microsoft.graph.conflictBehavior=fail`;

  logger.debug("writing fresh leases sidecar", {
    collabFolderId,
    leases: file.leases.length,
    bytes: body.length,
  });

  const response = await client.requestRaw(HttpMethod.PUT, path, body, LEASES_CONTENT_TYPE, signal);
  return parseResponse(response, DriveItemSchema, HttpMethod.PUT, path);
}

/**
 * CAS-replace an existing leases sidecar. byId PUT with
 * `@microsoft.graph.conflictBehavior=replace` and `If-Match: <cTag>`.
 *
 * Throws {@link CollabCTagMismatchError} on HTTP 412 (carries
 * `currentCTag`/`currentRevision`/`currentItem` so the caller can
 * re-read and retry, mirroring the §4.2 contract used for content
 * writes). All other Graph failures bubble as {@link GraphRequestError}.
 */
export async function writeLeasesUpdate(
  client: GraphClient,
  itemId: ValidatedGraphId,
  cTag: string,
  file: LeasesFile,
  signal: AbortSignal,
): Promise<DriveItem> {
  if (cTag.length === 0) {
    throw new Error("writeLeasesUpdate: cTag must not be empty");
  }
  const body = serializeLeases(file);
  assertLeasesWithinCap(body);

  const path =
    `/me/drive/items/${encodeURIComponent(itemId)}/content` +
    `?@microsoft.graph.conflictBehavior=replace`;

  logger.debug("updating leases sidecar", {
    itemId,
    leases: file.leases.length,
    bytes: body.length,
  });

  let response: Response;
  try {
    response = await client.requestRaw(HttpMethod.PUT, path, body, LEASES_CONTENT_TYPE, signal, {
      "If-Match": cTag,
    });
  } catch (err) {
    if (err instanceof GraphRequestError && err.statusCode === 412) {
      // Re-fetch the live item so the error envelope carries
      // `currentCTag`/`currentRevision`/`currentItem` per §2.6.
      const folderPart = encodeURIComponent(itemId);
      const itemPath = `/me/drive/items/${folderPart}`;
      const itemResponse = await client.request(HttpMethod.GET, itemPath, signal);
      const current = await parseResponse(itemResponse, DriveItemSchema, HttpMethod.GET, itemPath);
      throw new CollabCTagMismatchError(itemId, cTag, current.cTag, current.version, current);
    }
    throw err;
  }
  return parseResponse(response, DriveItemSchema, HttpMethod.PUT, path);
}
