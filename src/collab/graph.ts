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
