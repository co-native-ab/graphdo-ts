// Sentinel codec for `.collab/project.json` (collab v1 §3.2).
//
// The sentinel is the single OneDrive artefact that names a project's
// authoritative file. Its authority is **first-seen** only: the very first
// `session_open_project` for a given `projectId` records a local pin
// (`pinnedAuthoritativeFileId`, `pinnedSentinelFirstSeenAt`,
// `pinnedAtFirstSeenCTag`) into the local project metadata file. Every
// subsequent open verifies the live sentinel against that pin via
// `verifySentinelAgainstPin` below.
//
// The pin is **rename-tolerant**: a collaborator with folder-write
// permission can rename the authoritative file in OneDrive web (`spec.md`
// → `README.md`) and the session continues to work, because OneDrive
// preserves `driveItem.id` across renames. Only a change to
// `authoritativeFileId` raises `SentinelTamperedError`.
//
// This module owns:
//
// 1. The Zod schema + TypeScript shape of the sentinel JSON document.
// 2. Pure parse / serialise helpers (no Graph dependency).
// 3. The Graph helpers `readSentinel` / `writeSentinel` (single-shot
//    PUT/GET against `/me/drive/items/...`).
// 4. The pin-comparison primitive `verifySentinelAgainstPin`.
//
// W1 Day 2 deliberately stops at plumbing — there is no UI yet. Higher
// layers (`session_init_project`, `session_open_project`) land in W1
// Day 3 and W4 Day 4 and will own pin persistence, recents, and the
// `sentinel_changed` audit entry.

import { z } from "zod";

import type { GraphClient } from "../graph/client.js";
import { GraphRequestError, HttpMethod, parseResponse } from "../graph/client.js";
import type { DriveItem } from "../graph/types.js";
import { DriveItemSchema } from "../graph/types.js";
import { SentinelTamperedError } from "../errors.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Folder name (relative to project root) that holds the sentinel. */
export const SENTINEL_FOLDER_NAME = ".collab";

/** File name of the sentinel within `.collab/`. */
export const SENTINEL_FILE_NAME = "project.json";

/** Schema version this codec emits and accepts. */
export const SENTINEL_SCHEMA_VERSION = 1;

/**
 * Maximum on-the-wire size of a sentinel document. The shape is tiny
 * (well under 1 KiB in practice) — anything noticeably larger is a sign
 * of tampering or schema misuse and is rejected outright before parsing.
 */
const SENTINEL_MAX_BYTES = 16 * 1024;

/** Explicit `Content-Type` for sentinel writes (per §4 in the plan). */
const SENTINEL_CONTENT_TYPE = "application/json";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for `.collab/project.json`.
 *
 * `.strict()` rejects unknown keys per §2.5 ("schema bumps via
 * `schemaVersion`") — silent extra fields would let a cooperator smuggle
 * data past every consumer that does not happen to read them.
 */
export const ProjectSentinelSchema = z
  .object({
    schemaVersion: z.literal(SENTINEL_SCHEMA_VERSION),
    /**
     * Stable identifier of the project. Generated as a ULID by
     * `session_init_project` (W1 Day 3); validated here only as a
     * non-empty string so the codec does not couple to the ULID library
     * before that lands.
     */
    projectId: z.string().min(1),
    authoritativeFileId: z.string().min(1),
    authoritativeFileName: z.string().min(1),
    /**
     * Display-only metadata. Carries `displayName` and **never** an
     * `oid`/`username` — the sentinel is writable by any cooperator
     * (§0 trust boundary 3) so identity claims would be misleading.
     */
    createdBy: z
      .object({
        displayName: z.string().min(1),
      })
      .strict(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

/** TypeScript view of {@link ProjectSentinelSchema}. */
export type ProjectSentinel = z.infer<typeof ProjectSentinelSchema>;

/**
 * Local pin recorded on the **first** `session_open_project` for a given
 * `projectId`. Persisted in `<configDir>/projects/<projectId>.json`
 * (§3.3); declared here as the input shape consumed by
 * {@link verifySentinelAgainstPin}.
 *
 * `pinnedAtFirstSeenCTag` is the sentinel's `cTag` when it was first
 * seen — recorded for audit correlation only; not used by the
 * comparator (the §3.2 model is id-based, not cTag-based).
 */
export interface SentinelPin {
  pinnedAuthoritativeFileId: string;
  pinnedSentinelFirstSeenAt: string;
  pinnedAtFirstSeenCTag: string;
  /** Last-seen value of `authoritativeFileName`; refreshed on every successful open. */
  displayAuthoritativeFileName: string;
}

// ---------------------------------------------------------------------------
// Codec — pure functions
// ---------------------------------------------------------------------------

/** Error raised when a sentinel response body is malformed JSON or fails Zod validation. */
export class SentinelParseError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(`Sentinel parse failed: ${message}`);
    this.name = "SentinelParseError";
  }
}

/**
 * Parse a raw sentinel byte/string body into a validated
 * {@link ProjectSentinel}. Throws {@link SentinelParseError} on any
 * decoding or validation failure.
 */
export function parseSentinel(raw: string): ProjectSentinel {
  if (raw.length > SENTINEL_MAX_BYTES) {
    throw new SentinelParseError(
      `body length ${String(raw.length)} exceeds ${String(SENTINEL_MAX_BYTES)} bytes`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new SentinelParseError("body is not valid JSON", err);
  }
  const result = ProjectSentinelSchema.safeParse(json);
  if (!result.success) {
    throw new SentinelParseError(result.error.message, result.error);
  }
  return result.data;
}

/**
 * Serialise a {@link ProjectSentinel} to a canonical JSON string suitable
 * for writing to OneDrive. Uses two-space indentation and a trailing
 * newline to match how a human-edited file would look in the OneDrive
 * web preview.
 */
export function serializeSentinel(sentinel: ProjectSentinel): string {
  // Validate on the way out so a hand-constructed object cannot smuggle
  // an invalid schema past the codec.
  const parsed = ProjectSentinelSchema.parse(sentinel);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Pin verification
// ---------------------------------------------------------------------------

/** Result of {@link verifySentinelAgainstPin} for the non-tamper paths. */
export type SentinelVerifyResult =
  | { kind: "match" }
  | { kind: "renamed"; refreshedDisplayAuthoritativeFileName: string };

/**
 * Compare a freshly-read sentinel against the locally pinned values.
 *
 * - Same `authoritativeFileId` and same `authoritativeFileName` ⇒
 *   `{ kind: "match" }`.
 * - Same `authoritativeFileId` but different `authoritativeFileName` ⇒
 *   `{ kind: "renamed", refreshedDisplayAuthoritativeFileName }`. Callers
 *   silently update local `displayAuthoritativeFileName` and recents;
 *   no audit entry is written (§3.2 step 3).
 * - Different `authoritativeFileId` ⇒ throws {@link SentinelTamperedError}.
 *   The future `session_open_project` writes a `sentinel_changed` audit
 *   entry **before** propagating the throw (§3.2 step 5).
 */
export function verifySentinelAgainstPin(
  current: ProjectSentinel,
  pin: SentinelPin,
): SentinelVerifyResult {
  if (current.authoritativeFileId !== pin.pinnedAuthoritativeFileId) {
    throw new SentinelTamperedError(
      pin.pinnedAuthoritativeFileId,
      current.authoritativeFileId,
      pin.pinnedSentinelFirstSeenAt,
    );
  }
  if (current.authoritativeFileName !== pin.displayAuthoritativeFileName) {
    return {
      kind: "renamed",
      refreshedDisplayAuthoritativeFileName: current.authoritativeFileName,
    };
  }
  return { kind: "match" };
}

// ---------------------------------------------------------------------------
// Graph I/O
// ---------------------------------------------------------------------------

/** Error raised when no sentinel exists at the expected path. */
export class SentinelMissingError extends Error {
  constructor(public readonly projectFolderId: string) {
    super(
      `No ${SENTINEL_FOLDER_NAME}/${SENTINEL_FILE_NAME} sentinel found ` +
        `at folder ${projectFolderId}`,
    );
    this.name = "SentinelMissingError";
  }
}

/** Error raised when {@link writeSentinel} hits a 409 from `conflictBehavior=fail`. */
export class SentinelAlreadyExistsError extends Error {
  constructor(public readonly collabFolderId: string) {
    super(
      `${SENTINEL_FILE_NAME} already exists in ${SENTINEL_FOLDER_NAME} ` +
        `folder ${collabFolderId} — refusing to overwrite`,
    );
    this.name = "SentinelAlreadyExistsError";
  }
}

/**
 * Read `.collab/project.json` from the given **project root** folder.
 *
 * Uses the path-addressed Graph endpoint
 * `GET /me/drive/items/{projectFolderId}:/.collab/project.json:/content`
 * (§4 read-path table). Throws {@link SentinelMissingError} on 404 and
 * {@link SentinelParseError} when the body is malformed.
 */
export async function readSentinel(
  client: GraphClient,
  projectFolderId: string,
  signal: AbortSignal,
): Promise<{ sentinel: ProjectSentinel; item: DriveItem }> {
  if (projectFolderId.length === 0) {
    throw new Error("projectFolderId must not be empty");
  }

  const folderPart = encodeURIComponent(projectFolderId);
  const filePath = encodeURI(`${SENTINEL_FOLDER_NAME}/${SENTINEL_FILE_NAME}`);
  const itemPath = `/me/drive/items/${folderPart}:/${filePath}`;
  const contentPath = `${itemPath}:/content`;

  logger.debug("reading sentinel", { projectFolderId });

  let item: DriveItem;
  try {
    const itemResponse = await client.request(HttpMethod.GET, itemPath, signal);
    item = await parseResponse(itemResponse, DriveItemSchema, HttpMethod.GET, itemPath);
  } catch (err) {
    if (err instanceof GraphRequestError && err.statusCode === 404) {
      throw new SentinelMissingError(projectFolderId);
    }
    throw err;
  }

  let raw: string;
  try {
    const contentResponse = await client.request(HttpMethod.GET, contentPath, signal);
    raw = await contentResponse.text();
  } catch (err) {
    if (err instanceof GraphRequestError && err.statusCode === 404) {
      throw new SentinelMissingError(projectFolderId);
    }
    throw err;
  }

  const sentinel = parseSentinel(raw);
  return { sentinel, item };
}

/**
 * Write a brand-new sentinel into a `.collab/` folder. Uses
 * `@microsoft.graph.conflictBehavior=fail` so a concurrent first
 * initialiser races deterministically (§4 write-path table) — the
 * loser sees {@link SentinelAlreadyExistsError} and `session_init_project`
 * (W1 Day 3) will turn that into the standard "project already
 * initialised — use `session_open_project`" message.
 *
 * `collabFolderId` is the drive id of the `.collab/` folder, **not** the
 * project root. The caller is responsible for ensuring `.collab/` exists.
 */
export async function writeSentinel(
  client: GraphClient,
  collabFolderId: string,
  sentinel: ProjectSentinel,
  signal: AbortSignal,
): Promise<DriveItem> {
  if (collabFolderId.length === 0) {
    throw new Error("collabFolderId must not be empty");
  }

  const body = serializeSentinel(sentinel);
  const path =
    `/me/drive/items/${encodeURIComponent(collabFolderId)}:/` +
    `${encodeURIComponent(SENTINEL_FILE_NAME)}:/content` +
    `?@microsoft.graph.conflictBehavior=fail`;

  logger.debug("writing sentinel", {
    collabFolderId,
    projectId: sentinel.projectId,
    bytes: body.length,
  });

  let response: Response;
  try {
    response = await client.requestRaw(HttpMethod.PUT, path, body, SENTINEL_CONTENT_TYPE, signal);
  } catch (err) {
    if (err instanceof GraphRequestError && err.statusCode === 409) {
      throw new SentinelAlreadyExistsError(collabFolderId);
    }
    throw err;
  }
  return parseResponse(response, DriveItemSchema, HttpMethod.PUT, path);
}
