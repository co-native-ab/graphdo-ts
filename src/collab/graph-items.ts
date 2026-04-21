// Drive item lookup, listing, and folder creation helpers for collab v1.
// Split out from `graph.ts`; re-exported through the barrel.

import type { GraphClient } from "../graph/client.js";
import { GraphRequestError, HttpMethod, parseResponse } from "../graph/client.js";
import { type ValidatedGraphId } from "../graph/ids.js";
import type { DriveItem } from "../graph/types.js";
import { DriveItemSchema, GraphListResponseSchema } from "../graph/types.js";
import { logger } from "../logger.js";

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
