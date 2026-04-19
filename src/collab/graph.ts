// Graph helpers specific to the collab v1 surface.
//
// W1 Day 3 ships only the helpers that `session_init_project` needs:
//
//   - {@link listRootMarkdownFiles} — enumerate `.md` files at the root of
//     a candidate project folder so the init handler can decide how to
//     proceed (zero → error, one → auto-select, more than one → multi-md
//     picker in W1 Day 4).
//
//   - {@link findChildFolderByName} — used to detect a pre-existing
//     `.collab/` folder so we can re-route to the open-project flow
//     instead of overwriting somebody else's project.
//
//   - {@link createChildFolder} — `POST /me/drive/items/{id}/children`
//     with `@microsoft.graph.conflictBehavior=fail` to create the
//     `.collab/` subfolder.
//
//   - {@link getDriveItem} — single-shot drive item lookup used to
//     resolve the chosen project folder so we can capture
//     `parentReference.path` for the `folderPath` recents entry.
//
// W2 Day 4 adds:
//
//   - {@link getDriveItemContent} — download content as UTF-8 string,
//     with the same 4 MiB markdown guard from `src/graph/markdown.ts`.
//
//   - {@link listChildren} — promoted to export for `collab_list_files`.
//
//   - {@link walkAttachmentsTree} — depth-bounded recursive tree for
//     `attachments/` listing.
//
// W3 Day 1 adds:
//
//   - {@link writeAuthoritative} — overwrite the project's authoritative
//     `.md` file with `If-Match: <cTag>` + `conflictBehavior=replace`.
//
//   - {@link writeProjectFile} — generic CAS write for non-authoritative
//     project files (`/proposals/`, `/drafts/`, `/attachments/`,
//     `.collab/leases.json`). Discriminated `target` selects byPath
//     create (`conflictBehavior=fail`, no `If-Match`) or byId replace
//     (`If-Match` + `conflictBehavior=replace`).
//
// Subsequent milestones will extend this module (read sentinel by path,
// shared-with-me, share URL resolution).

import type { GraphClient } from "../graph/client.js";
import { GraphRequestError, HttpMethod, parseResponse } from "../graph/client.js";
import { validateGraphId, type ValidatedGraphId } from "../graph/ids.js";
import type { DriveItem } from "../graph/types.js";
import { DriveItemSchema, GraphListResponseSchema } from "../graph/types.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Filename extension that identifies a markdown file at the project root. */
export const MARKDOWN_EXTENSION = ".md";

/**
 * Maximum length OneDrive accepts for a folder name. The real limit varies
 * by total path length (~400 chars), but 255 matches the per-segment cap
 * used by `validateMarkdownFileName` and Windows/POSIX in general — well
 * inside what OneDrive will accept and enough to catch a runaway caller.
 */
const MAX_FOLDER_NAME_LENGTH = 255;

const DriveItemListSchema = GraphListResponseSchema(DriveItemSchema);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a single drive item by id. Used by the init flow to resolve the
 * chosen folder so we can record `folderPath` in recents and local
 * metadata.
 */
export async function getDriveItem(
  client: GraphClient,
  itemId: ValidatedGraphId,
  signal: AbortSignal,
): Promise<DriveItem> {
  const path = `/me/drive/items/${encodeURIComponent(itemId)}`;
  const response = await client.request(HttpMethod.GET, path, signal);
  return parseResponse(response, DriveItemSchema, HttpMethod.GET, path);
}

/**
 * List the immediate children of a folder. Mirrors
 * `markdown.listMarkdownFolderEntries` but returns the raw drive items
 * because the init flow has its own classification needs (find `.collab`,
 * find `.md` files at root). Pagination is followed via `@odata.nextLink`.
 *
 * Exported as of W2 Day 4 for use by `collab_list_files`.
 */
export async function listChildren(
  client: GraphClient,
  folderId: ValidatedGraphId,
  signal: AbortSignal,
): Promise<DriveItem[]> {
  const items: DriveItem[] = [];
  let path: string | null = `/me/drive/items/${encodeURIComponent(folderId)}/children?$top=200`;
  while (path !== null) {
    const response = await client.request(HttpMethod.GET, path, signal);
    const page = await parseResponse(response, DriveItemListSchema, HttpMethod.GET, path);
    items.push(...page.value);
    path = nextRelativePath(page["@odata.nextLink"]);
  }
  return items;
}

/**
 * Convert an absolute Graph `@odata.nextLink` into a relative path that
 * `GraphClient.request()` can issue against the same base URL. Returns
 * `null` when there is no next page.
 */
function nextRelativePath(absoluteUrl: string | undefined): string | null {
  if (absoluteUrl === undefined || absoluteUrl.length === 0) return null;
  try {
    const u = new URL(absoluteUrl);
    return `${u.pathname}${u.search}`;
  } catch (err) {
    logger.debug("ignored malformed @odata.nextLink", {
      url: absoluteUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Return every `.md` file at the immediate root of `folderId`. Folders
 * and non-markdown files are filtered out — name matching is
 * case-insensitive on the extension to match how OneDrive/Windows
 * behave when the user creates `Spec.MD`.
 */
export async function listRootMarkdownFiles(
  client: GraphClient,
  folderId: ValidatedGraphId,
  signal: AbortSignal,
): Promise<DriveItem[]> {
  logger.debug("listing root markdown files", { folderId });
  const children = await listChildren(client, folderId, signal);
  return children.filter((item) => {
    if (item.file === undefined) return false;
    return item.name.toLowerCase().endsWith(MARKDOWN_EXTENSION);
  });
}

/**
 * Return the immediate child folder with the given name, or `null` when
 * no such folder exists. Name comparison is case-insensitive to match
 * OneDrive's behaviour. Used by the init flow to detect a pre-existing
 * `.collab/` folder.
 */
export async function findChildFolderByName(
  client: GraphClient,
  folderId: ValidatedGraphId,
  name: string,
  signal: AbortSignal,
): Promise<DriveItem | null> {
  const children = await listChildren(client, folderId, signal);
  const lower = name.toLowerCase();
  const match = children.find(
    (item) => item.folder !== undefined && item.name.toLowerCase() === lower,
  );
  return match ?? null;
}

const CreateFolderResponseSchema = DriveItemSchema;

/** Raised when {@link createChildFolder} hits a 409 from `conflictBehavior=fail`. */
export class FolderAlreadyExistsError extends Error {
  constructor(
    public readonly parentFolderId: string,
    public readonly folderName: string,
  ) {
    super(
      `A folder named "${folderName}" already exists under ${parentFolderId} ` +
        "(conflictBehavior=fail)",
    );
    this.name = "FolderAlreadyExistsError";
  }
}

/**
 * Create a child folder via `POST /me/drive/items/{parentId}/children`
 * with `@microsoft.graph.conflictBehavior=fail`. Used by the init flow
 * to create the `.collab/` subfolder of the chosen project folder.
 *
 * Throws {@link FolderAlreadyExistsError} on a 409 response so the
 * caller can re-route through the open-project flow instead of
 * overwriting an existing project.
 */
export async function createChildFolder(
  client: GraphClient,
  parentFolderId: ValidatedGraphId,
  folderName: string,
  signal: AbortSignal,
): Promise<DriveItem> {
  // `folderName` is sent as JSON in the request body (not the URL), so the
  // primary risk is not URL injection but a name OneDrive itself rejects
  // — or a future caller supplying user-controlled input. Apply the same
  // baseline checks `validateMarkdownFileName` does for files: non-empty,
  // bounded length, no path separators, no control characters, not the
  // relative-path components `.` / `..`. Allowed characters otherwise
  // mirror what OneDrive accepts so the actual server-side rules
  // (e.g. trailing dot, reserved names) still apply.
  if (folderName.length === 0) {
    throw new Error("folderName must not be empty");
  }
  if (folderName.length > MAX_FOLDER_NAME_LENGTH) {
    throw new Error(
      `folderName exceeds maximum length of ${String(MAX_FOLDER_NAME_LENGTH)} characters`,
    );
  }
  if (folderName.includes("/") || folderName.includes("\\")) {
    throw new Error("folderName must not contain path separators (/ or \\)");
  }
  if (folderName === "." || folderName === "..") {
    throw new Error("folderName must not be '.' or '..'");
  }
  if (/[\x00-\x1f\x7f]/u.test(folderName)) {
    throw new Error("folderName must not contain control characters");
  }
  const path = `/me/drive/items/${encodeURIComponent(parentFolderId)}/children`;
  const body = {
    name: folderName,
    folder: {},
    "@microsoft.graph.conflictBehavior": "fail",
  };
  logger.debug("creating child folder", { parentFolderId, folderName });

  let response: Response;
  try {
    response = await client.request(HttpMethod.POST, path, body, signal);
  } catch (err) {
    if (err instanceof GraphRequestError && err.statusCode === 409) {
      throw new FolderAlreadyExistsError(parentFolderId, folderName);
    }
    throw err;
  }
  return parseResponse(response, CreateFolderResponseSchema, HttpMethod.POST, path);
}

// ---------------------------------------------------------------------------
// W2 Day 4: Content download + tree walker for collab_read / collab_list_files
// ---------------------------------------------------------------------------

import { CollabCTagMismatchError } from "../errors.js";
import { MAX_DIRECT_CONTENT_BYTES, MarkdownFileTooLargeError } from "../graph/markdown.js";
import { MAX_ANCESTRY_HOPS } from "./scope.js";

/**
 * Download a drive item's content as a UTF-8 string.
 *
 * Uses the same 4 MiB cap as `downloadMarkdownContent` in `src/graph/markdown.ts`
 * (re-uses {@link MAX_DIRECT_CONTENT_BYTES} and {@link MarkdownFileTooLargeError}
 * from that module). The cap is a graphdo-ts policy limit, not a Graph API limit.
 *
 * Used by `collab_read` for both the authoritative file and other in-scope files.
 */
export async function getDriveItemContent(
  client: GraphClient,
  itemId: ValidatedGraphId,
  signal: AbortSignal,
): Promise<string> {
  // Pre-flight size check via metadata fetch to fail fast on oversized files.
  const item = await getDriveItem(client, itemId, signal);
  if (item.size !== undefined && item.size > MAX_DIRECT_CONTENT_BYTES) {
    throw new MarkdownFileTooLargeError(item.size, MAX_DIRECT_CONTENT_BYTES);
  }

  const path = `/me/drive/items/${encodeURIComponent(itemId)}/content`;
  logger.debug("downloading drive item content", { itemId });
  const response = await client.request(HttpMethod.GET, path, signal);
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.byteLength > MAX_DIRECT_CONTENT_BYTES) {
    throw new MarkdownFileTooLargeError(buf.byteLength, MAX_DIRECT_CONTENT_BYTES);
  }
  return buf.toString("utf-8");
}

/**
 * Represents a single entry in the recursive attachment tree returned by
 * {@link walkAttachmentsTree}.
 */
export interface AttachmentEntry {
  /** Drive item metadata (id, name, size, cTag, lastModifiedDateTime, etc). */
  item: DriveItem;
  /** Slash-separated path relative to `attachments/`, e.g. `"diagrams/arch.png"`. */
  relativePath: string;
}

/**
 * Recursively enumerate the contents of the `attachments/` folder.
 *
 * Per `docs/plans/collab-v1.md` §4.6 step 5, the attachments group allows
 * arbitrary nesting up to {@link MAX_ANCESTRY_HOPS} depth (= 8). The walker
 * performs breadth-first traversal and collects files at every level. If
 * the folder does not exist (404), returns an empty array — the folder is
 * created on-demand by `collab_write`.
 *
 * The caller is responsible for enforcing the 500-entry breadth cap (done
 * in `collab_list_files`). The walker stops early when the provided
 * `budget` is exhausted and sets `truncated` in the result.
 *
 * Newest-first ordering within each folder is **not** guaranteed by this
 * helper (Graph returns children in an undefined order). The tool layer
 * sorts by `lastModifiedDateTime` descending if the spec requires it;
 * the walker simply returns entries in traversal order.
 */
export async function walkAttachmentsTree(
  client: GraphClient,
  attachmentsFolderId: ValidatedGraphId,
  signal: AbortSignal,
  budget: number,
): Promise<{ entries: AttachmentEntry[]; truncated: boolean }> {
  const entries: AttachmentEntry[] = [];
  let truncated = false;

  // Queue entries are (folderId, pathPrefix). pathPrefix is the relative
  // path to that folder from the attachments root, e.g. "" for the root,
  // "diagrams/" for a direct child folder, "diagrams/v2/" for deeper.
  interface QueueEntry {
    folderId: ValidatedGraphId;
    pathPrefix: string;
    depth: number;
  }
  const queue: QueueEntry[] = [{ folderId: attachmentsFolderId, pathPrefix: "", depth: 0 }];

  while (queue.length > 0 && entries.length < budget) {
    const current = queue.shift();
    if (current === undefined) break;
    if (current.depth >= MAX_ANCESTRY_HOPS) {
      // Depth cap reached — skip this folder's children.
      continue;
    }

    let children: DriveItem[];
    try {
      children = await listChildren(client, current.folderId, signal);
    } catch (err) {
      // 404 means the folder doesn't exist — stop walking this branch.
      if (err instanceof GraphRequestError && err.statusCode === 404) {
        continue;
      }
      throw err;
    }

    for (const child of children) {
      if (entries.length >= budget) {
        truncated = true;
        break;
      }

      const childPath = `${current.pathPrefix}${child.name}`;

      if (child.folder !== undefined) {
        // It's a subfolder — enqueue for recursive traversal.
        const childId = validateGraphId("attachmentChildFolderId", child.id);
        queue.push({
          folderId: childId,
          pathPrefix: `${childPath}/`,
          depth: current.depth + 1,
        });
      } else {
        // It's a file — add to entries.
        entries.push({ item: child, relativePath: childPath });
      }
    }

    if (truncated) break;
  }

  // If there are still queued folders after hitting the budget, mark truncated.
  if (queue.length > 0 && entries.length >= budget) {
    truncated = true;
  }

  return { entries, truncated };
}

// ---------------------------------------------------------------------------
// W3 Day 1: Conditional writes (cTag + If-Match, conflictBehavior)
// ---------------------------------------------------------------------------

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
