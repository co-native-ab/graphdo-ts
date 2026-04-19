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
// Subsequent milestones will extend this module (read sentinel by path,
// shared-with-me, share URL resolution).

import type { GraphClient } from "../graph/client.js";
import { GraphRequestError, HttpMethod, parseResponse } from "../graph/client.js";
import type { DriveItem } from "../graph/types.js";
import { DriveItemSchema, GraphListResponseSchema } from "../graph/types.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Filename extension that identifies a markdown file at the project root. */
export const MARKDOWN_EXTENSION = ".md";

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
  itemId: string,
  signal: AbortSignal,
): Promise<DriveItem> {
  if (itemId.length === 0) {
    throw new Error("itemId must not be empty");
  }
  const path = `/me/drive/items/${encodeURIComponent(itemId)}`;
  const response = await client.request(HttpMethod.GET, path, signal);
  return parseResponse(response, DriveItemSchema, HttpMethod.GET, path);
}

/**
 * List the immediate children of a folder. Mirrors
 * `markdown.listMarkdownFolderEntries` but returns the raw drive items
 * because the init flow has its own classification needs (find `.collab`,
 * find `.md` files at root). Pagination is followed via `@odata.nextLink`.
 */
async function listChildren(
  client: GraphClient,
  folderId: string,
  signal: AbortSignal,
): Promise<DriveItem[]> {
  if (folderId.length === 0) {
    throw new Error("folderId must not be empty");
  }
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
  folderId: string,
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
  folderId: string,
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
  parentFolderId: string,
  folderName: string,
  signal: AbortSignal,
): Promise<DriveItem> {
  if (parentFolderId.length === 0) {
    throw new Error("parentFolderId must not be empty");
  }
  if (folderName.length === 0) {
    throw new Error("folderName must not be empty");
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
