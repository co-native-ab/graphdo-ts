// OneDrive-backed markdown file operations via Microsoft Graph API.
//
// All operations are scoped to a single "root folder" drive item ID that is
// selected by the user via a browser picker and persisted to config. The
// configured ID is passed in by the caller — this module does not read config.

import type { DriveItem } from "./types.js";
import { DriveItemSchema, GraphListResponseSchema } from "./types.js";
import type { GraphClient } from "./client.js";
import { HttpMethod, parseResponse } from "./client.js";
import { logger } from "../logger.js";

/**
 * Maximum content size for a single direct GET/PUT to `/content`.
 *
 * Microsoft Graph enforces a 4 MB limit per request on the `content` endpoint.
 * Larger files require a resumable upload session; we deliberately do not
 * support that — see ADR-0004.
 */
export const MAX_DIRECT_CONTENT_BYTES = 4 * 1024 * 1024; // 4 MiB = 4_194_304

/** Filename extension (lowercase, with leading dot) used to identify markdown files. */
export const MARKDOWN_FILE_EXTENSION = ".md";

// ---------------------------------------------------------------------------
// Folder listing (used by the folder picker)
// ---------------------------------------------------------------------------

/**
 * List folders directly underneath the user's OneDrive root.
 *
 * Only returns drive items where `folder` is populated. Files are omitted. A
 * flat top-level listing matches the simplicity of the existing todo list
 * picker — no recursive navigation is implemented.
 */
export async function listRootFolders(
  client: GraphClient,
  signal: AbortSignal,
): Promise<DriveItem[]> {
  logger.debug("listing onedrive root folders");
  const path = "/me/drive/root/children?$top=200";
  const response = await client.request(HttpMethod.GET, path, signal);
  const data = await parseResponse(
    response,
    GraphListResponseSchema(DriveItemSchema),
    HttpMethod.GET,
    path,
  );
  return data.value.filter((item) => item.folder !== undefined);
}

// ---------------------------------------------------------------------------
// File listing / lookup under the configured root folder
// ---------------------------------------------------------------------------

/**
 * List `.md` files immediately under the given folder.
 *
 * Graph's `$filter` on drive items does not reliably support the string
 * functions needed to match a file extension, so filtering is done
 * client-side after requesting files only. Folders are excluded via the
 * server-side filter where supported.
 */
export async function listMarkdownFiles(
  client: GraphClient,
  folderId: string,
  signal: AbortSignal,
): Promise<DriveItem[]> {
  if (!folderId) throw new Error("listMarkdownFiles: folderId must not be empty");
  logger.debug("listing markdown files", { folderId });

  const path = `/me/drive/items/${encodeURIComponent(folderId)}/children?$top=200`;
  const response = await client.request(HttpMethod.GET, path, signal);
  const data = await parseResponse(
    response,
    GraphListResponseSchema(DriveItemSchema),
    HttpMethod.GET,
    path,
  );
  return data.value.filter(
    (item) => item.file !== undefined && item.name.toLowerCase().endsWith(MARKDOWN_FILE_EXTENSION),
  );
}

/**
 * Find a markdown file by case-insensitive name within the given folder.
 * Returns `null` when no file matches.
 */
export async function findMarkdownFileByName(
  client: GraphClient,
  folderId: string,
  name: string,
  signal: AbortSignal,
): Promise<DriveItem | null> {
  if (!folderId) throw new Error("findMarkdownFileByName: folderId must not be empty");
  if (!name) throw new Error("findMarkdownFileByName: name must not be empty");

  const files = await listMarkdownFiles(client, folderId, signal);
  const lower = name.toLowerCase();
  return files.find((f) => f.name.toLowerCase() === lower) ?? null;
}

/** Fetch a drive item's metadata (without downloading content). */
export async function getDriveItem(
  client: GraphClient,
  itemId: string,
  signal: AbortSignal,
): Promise<DriveItem> {
  if (!itemId) throw new Error("getDriveItem: itemId must not be empty");
  logger.debug("getting drive item", { itemId });

  const path = `/me/drive/items/${encodeURIComponent(itemId)}`;
  const response = await client.request(HttpMethod.GET, path, signal);
  return parseResponse(response, DriveItemSchema, HttpMethod.GET, path);
}

// ---------------------------------------------------------------------------
// Download / upload / delete
// ---------------------------------------------------------------------------

/** Error raised when a file exceeds the direct GET/PUT size limit. */
export class MarkdownFileTooLargeError extends Error {
  constructor(
    public readonly sizeBytes: number,
    public readonly limitBytes: number,
  ) {
    super(
      `Markdown file is ${String(sizeBytes)} bytes, which exceeds the ${String(limitBytes)}-byte ` +
        "direct transfer limit (4 MB). Upload sessions are not supported.",
    );
    this.name = "MarkdownFileTooLargeError";
  }
}

/**
 * Download a drive item's content as a UTF-8 string.
 *
 * Enforces the 4 MB limit by checking the reported item size first; if the
 * size is unknown it falls back to measuring the response body. Throws
 * {@link MarkdownFileTooLargeError} when the limit is exceeded.
 */
export async function downloadMarkdownContent(
  client: GraphClient,
  itemId: string,
  signal: AbortSignal,
): Promise<string> {
  if (!itemId) throw new Error("downloadMarkdownContent: itemId must not be empty");

  const item = await getDriveItem(client, itemId, signal);
  if (item.size !== undefined && item.size > MAX_DIRECT_CONTENT_BYTES) {
    throw new MarkdownFileTooLargeError(item.size, MAX_DIRECT_CONTENT_BYTES);
  }

  const path = `/me/drive/items/${encodeURIComponent(itemId)}/content`;
  logger.debug("downloading markdown content", { itemId });
  const response = await client.request(HttpMethod.GET, path, signal);
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.byteLength > MAX_DIRECT_CONTENT_BYTES) {
    throw new MarkdownFileTooLargeError(buf.byteLength, MAX_DIRECT_CONTENT_BYTES);
  }
  return buf.toString("utf-8");
}

/**
 * Upload (or overwrite) a markdown file under the given folder via a direct
 * PUT to `/content`. Returns the resulting drive item. Throws
 * {@link MarkdownFileTooLargeError} when the payload exceeds 4 MB.
 */
export async function uploadMarkdownContent(
  client: GraphClient,
  folderId: string,
  fileName: string,
  content: string,
  signal: AbortSignal,
): Promise<DriveItem> {
  if (!folderId) throw new Error("uploadMarkdownContent: folderId must not be empty");
  if (!fileName) throw new Error("uploadMarkdownContent: fileName must not be empty");

  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_DIRECT_CONTENT_BYTES) {
    throw new MarkdownFileTooLargeError(bytes, MAX_DIRECT_CONTENT_BYTES);
  }

  const path =
    `/me/drive/items/${encodeURIComponent(folderId)}:/` +
    `${encodeURIComponent(fileName)}:/content`;
  logger.debug("uploading markdown content", { folderId, fileName, bytes });

  const response = await client.requestRaw(HttpMethod.PUT, path, content, "text/markdown", signal);
  return parseResponse(response, DriveItemSchema, HttpMethod.PUT, path);
}

/** Permanently delete a drive item. */
export async function deleteDriveItem(
  client: GraphClient,
  itemId: string,
  signal: AbortSignal,
): Promise<void> {
  if (!itemId) throw new Error("deleteDriveItem: itemId must not be empty");
  logger.debug("deleting drive item", { itemId });
  await client.request(HttpMethod.DELETE, `/me/drive/items/${encodeURIComponent(itemId)}`, signal);
}
