// Conditional CAS write helpers for collab v1 (W3 Day 1).
// Split out from `graph.ts`; re-exported through the barrel.

import type { GraphClient } from "../graph/client.js";
import { GraphRequestError, HttpMethod, parseResponse } from "../graph/client.js";
import { type ValidatedGraphId } from "../graph/ids.js";
import type { DriveItem } from "../graph/types.js";
import { DriveItemSchema } from "../graph/types.js";
import { logger } from "../logger.js";
import { CollabCTagMismatchError } from "../errors.js";
import { MAX_DIRECT_CONTENT_BYTES, MarkdownFileTooLargeError } from "../graph/markdown.js";

import { getDriveItem } from "./graph-items.js";

/**
 * MIME types for the three file categories collab v1 writes. Kept here so
 * callers do not have to remember the exact spelling — `text/markdown` for
 * the authoritative `.md` and proposal/draft `.md` files, `application/json`
 * for `.collab/leases.json` (W3 Day 4) and `.collab/project.json` (the
 * sentinel — already written by `writeSentinel` in `sentinel.ts`),
 * `application/octet-stream` for arbitrary binary attachments.
 */
export const COLLAB_CONTENT_TYPE_MARKDOWN = "text/markdown";
export const COLLAB_CONTENT_TYPE_JSON = "application/json";
export const COLLAB_CONTENT_TYPE_BINARY = "application/octet-stream";

/**
 * Compute the byte length of a content payload regardless of whether the
 * caller passed a UTF-8 string or a raw byte view. Used to enforce the
 * 4 MiB graphdo-ts cap before issuing the upload.
 */
function payloadByteLength(content: string | Uint8Array): number {
  return typeof content === "string" ? Buffer.byteLength(content, "utf-8") : content.byteLength;
}

/**
 * Throw {@link MarkdownFileTooLargeError} when `content` exceeds the
 * 4 MiB graphdo-ts payload cap. Reused by both write helpers so the
 * cap behaves identically regardless of which entry point an agent
 * arrives through. The cap is a graphdo-ts policy limit, not a Graph
 * API limit (see {@link MAX_DIRECT_CONTENT_BYTES}).
 */
function assertWithinPayloadCap(content: string | Uint8Array): void {
  const bytes = payloadByteLength(content);
  if (bytes > MAX_DIRECT_CONTENT_BYTES) {
    throw new MarkdownFileTooLargeError(bytes, MAX_DIRECT_CONTENT_BYTES);
  }
}

/**
 * Re-fetch a drive item after a 412 and translate the response into a
 * {@link CollabCTagMismatchError}. Centralised so every write path
 * surfaces the same error envelope (carrying `currentCTag`,
 * `currentRevision`, `currentItem` per §2.6).
 */
async function buildCTagMismatchError(
  client: GraphClient,
  itemId: ValidatedGraphId,
  suppliedCTag: string,
  signal: AbortSignal,
): Promise<CollabCTagMismatchError> {
  const current = await getDriveItem(client, itemId, signal);
  return new CollabCTagMismatchError(itemId, suppliedCTag, current.cTag, current.version, current);
}

/**
 * Conditionally overwrite the project's authoritative file via byId
 * `PUT /me/drive/items/{itemId}/content?@microsoft.graph.conflictBehavior=replace`
 * with `If-Match: <cTag>`.
 *
 * The authoritative file always exists once the project is initialised,
 * so this helper is byId-only and never falls back to a byPath create.
 * Used by `collab_write` (W3 Day 2) for writes that target the
 * authoritative `.md` and by `collab_apply_proposal` (W4 Day 3) for the
 * second leg of the apply flow.
 *
 * Returns the updated {@link DriveItem} (with bumped `cTag` / `version`)
 * on success. Throws:
 *
 * - {@link MarkdownFileTooLargeError} when `content` exceeds the 4 MiB
 *   graphdo-ts cap (pre-flight; no Graph call issued).
 * - {@link CollabCTagMismatchError} on HTTP 412 — carries the current
 *   `cTag`, `version` (`currentRevision`), and full `currentItem` so
 *   the caller can either re-read + retry (`conflictMode === "fail"`)
 *   or divert to a proposal (`conflictMode === "proposal"`, handled in
 *   the tool layer).
 * - {@link GraphRequestError} on any other Graph failure.
 *
 * `cTag` must be non-empty — empty strings would suppress the
 * conditional and silently overwrite, defeating the §4.2 CAS contract.
 */
export async function writeAuthoritative(
  client: GraphClient,
  itemId: ValidatedGraphId,
  cTag: string,
  content: string,
  signal: AbortSignal,
): Promise<DriveItem> {
  if (cTag.length === 0) {
    throw new Error("writeAuthoritative: cTag must not be empty");
  }
  assertWithinPayloadCap(content);

  const path =
    `/me/drive/items/${encodeURIComponent(itemId)}/content` +
    `?@microsoft.graph.conflictBehavior=replace`;
  logger.debug("writing authoritative file", { itemId, bytes: payloadByteLength(content) });

  let response: Response;
  try {
    response = await client.requestRaw(
      HttpMethod.PUT,
      path,
      content,
      COLLAB_CONTENT_TYPE_MARKDOWN,
      signal,
      { "If-Match": cTag },
    );
  } catch (err) {
    if (err instanceof GraphRequestError && err.statusCode === 412) {
      throw await buildCTagMismatchError(client, itemId, cTag, signal);
    }
    throw err;
  }
  return parseResponse(response, DriveItemSchema, HttpMethod.PUT, path);
}

/**
 * Discriminated target for {@link writeProjectFile}.
 *
 * - `kind: "create"` — byPath `PUT /me/drive/items/{folderId}:/{fileName}:/content`
 *   with `@microsoft.graph.conflictBehavior=fail`. Used for first writes
 *   to `/proposals/<ulid>.md`, `/drafts/...`, `/attachments/...`, and
 *   the lazy create of `.collab/leases.json` (W3 Day 4) and
 *   `.collab/project.json` (sentinel — already in `sentinel.ts`).
 *   Returns 201 on create, raises {@link ProjectFileAlreadyExistsError}
 *   on 409.
 *
 * - `kind: "replace"` — byId `PUT /me/drive/items/{itemId}/content`
 *   with `@microsoft.graph.conflictBehavior=replace` and
 *   `If-Match: <cTag>`. Used for subsequent CAS writes to a known
 *   project file (e.g. updating `.collab/leases.json` on
 *   `collab_acquire_section` / `collab_release_section`, or replacing
 *   a draft). Returns 200 on success, raises
 *   {@link CollabCTagMismatchError} on 412.
 */
export type WriteProjectFileTarget =
  | {
      kind: "create";
      folderId: ValidatedGraphId;
      fileName: string;
      contentType: string;
    }
  | {
      kind: "replace";
      itemId: ValidatedGraphId;
      cTag: string;
      contentType: string;
    };

/** Same shape and limits as {@link createChildFolder} for `folderName`. */
const MAX_PROJECT_FILE_NAME_LENGTH = 255;

/**
 * Raised by {@link writeProjectFile} when a `kind: "create"` target hits
 * a 409 from `conflictBehavior=fail`. The byPath `create` form is meant
 * for first-write paths (proposal id ULIDs, attachment paths the agent
 * has not used before, lazy lease/sentinel creation); a 409 means
 * another agent or human created the same path between our scope check
 * and the upload. The caller decides how to recover — usually by
 * re-reading and re-routing through the byId `replace` path or, for
 * proposals, by minting a fresh ULID and retrying.
 */
export class ProjectFileAlreadyExistsError extends Error {
  constructor(
    public readonly folderId: string,
    public readonly fileName: string,
  ) {
    super(
      `Project file "${fileName}" already exists in folder ${folderId} ` +
        "(conflictBehavior=fail).",
    );
    this.name = "ProjectFileAlreadyExistsError";
  }
}

/**
 * Validate a project-file leaf name on its way to the byPath `create`
 * URL. Mirrors the {@link createChildFolder} guard: we trust §4.6 scope
 * resolution to have already filtered most pathologicals, but the
 * helper keeps an independent baseline so a future caller bypassing the
 * scope wrapper still cannot smuggle path separators or control bytes
 * into the byPath URL.
 */
function assertValidProjectFileName(fileName: string): void {
  if (fileName.length === 0) {
    throw new Error("fileName must not be empty");
  }
  if (fileName.length > MAX_PROJECT_FILE_NAME_LENGTH) {
    throw new Error(
      `fileName exceeds maximum length of ${String(MAX_PROJECT_FILE_NAME_LENGTH)} characters`,
    );
  }
  if (fileName.includes("/") || fileName.includes("\\")) {
    throw new Error("fileName must not contain path separators (/ or \\)");
  }
  if (fileName === "." || fileName === "..") {
    throw new Error("fileName must not be '.' or '..'");
  }
  if (/[\x00-\x1f\x7f]/u.test(fileName)) {
    throw new Error("fileName must not contain control characters");
  }
}

/**
 * Conditional CAS write for non-authoritative project files
 * (`/proposals/`, `/drafts/`, `/attachments/`, `.collab/leases.json`).
 *
 * The discriminated `target` selects the byPath create or byId replace
 * shape per §4.2. Content type is caller-supplied so the same helper
 * serves markdown proposals/drafts (`text/markdown`), JSON sidecars
 * (`application/json`), and binary attachments
 * (`application/octet-stream`). All payloads share the 4 MiB
 * graphdo-ts cap.
 *
 * Throws:
 *
 * - {@link MarkdownFileTooLargeError} when `content` exceeds 4 MiB.
 * - {@link ProjectFileAlreadyExistsError} on 409 from a
 *   `kind: "create"` write.
 * - {@link CollabCTagMismatchError} on 412 from a `kind: "replace"`
 *   write.
 * - {@link GraphRequestError} on any other Graph failure.
 *
 * Returns the resulting {@link DriveItem} so the caller can capture the
 * new `cTag` / `version` for follow-up CAS rounds.
 */
export async function writeProjectFile(
  client: GraphClient,
  target: WriteProjectFileTarget,
  content: string | Uint8Array,
  signal: AbortSignal,
): Promise<DriveItem> {
  assertWithinPayloadCap(content);

  if (target.kind === "create") {
    assertValidProjectFileName(target.fileName);

    const path =
      `/me/drive/items/${encodeURIComponent(target.folderId)}:/` +
      `${encodeURIComponent(target.fileName)}:/content` +
      `?@microsoft.graph.conflictBehavior=fail`;
    logger.debug("creating project file", {
      folderId: target.folderId,
      fileName: target.fileName,
      bytes: payloadByteLength(content),
    });

    let response: Response;
    try {
      response = await client.requestRaw(HttpMethod.PUT, path, content, target.contentType, signal);
    } catch (err) {
      if (err instanceof GraphRequestError && err.statusCode === 409) {
        throw new ProjectFileAlreadyExistsError(target.folderId, target.fileName);
      }
      throw err;
    }
    return parseResponse(response, DriveItemSchema, HttpMethod.PUT, path);
  }

  // kind: "replace"
  if (target.cTag.length === 0) {
    throw new Error("writeProjectFile: cTag must not be empty for kind=replace");
  }
  const path =
    `/me/drive/items/${encodeURIComponent(target.itemId)}/content` +
    `?@microsoft.graph.conflictBehavior=replace`;
  logger.debug("replacing project file", {
    itemId: target.itemId,
    bytes: payloadByteLength(content),
  });

  let response: Response;
  try {
    response = await client.requestRaw(HttpMethod.PUT, path, content, target.contentType, signal, {
      "If-Match": target.cTag,
    });
  } catch (err) {
    if (err instanceof GraphRequestError && err.statusCode === 412) {
      throw await buildCTagMismatchError(client, target.itemId, target.cTag, signal);
    }
    throw err;
  }
  return parseResponse(response, DriveItemSchema, HttpMethod.PUT, path);
}
