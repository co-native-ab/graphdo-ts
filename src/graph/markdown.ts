// OneDrive-backed markdown file operations via Microsoft Graph API.
//
// All operations are scoped to a single "root folder" drive item ID that is
// selected by the user via a browser picker and persisted to config. The
// configured ID is passed in by the caller — this module does not read config.

import type { DriveItem, Drive, DriveItemVersion } from "./types.js";
import {
  DriveItemSchema,
  DriveSchema,
  DriveItemVersionSchema,
  GraphListResponseSchema,
} from "./types.js";
import type { GraphClient } from "./client.js";
import { GraphRequestError, HttpMethod, parseResponse } from "./client.js";
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

/** Maximum accepted file name length (bytes/chars). Matches common filesystem limits. */
export const MAX_MARKDOWN_FILE_NAME_LENGTH = 255;

// Windows reserved device names (case-insensitive, match on the stem before the extension).
const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM0",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT0",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/**
 * Strict set of characters allowed in markdown file names.
 *
 * Only letters (A–Z, a–z), digits, space, dot, underscore, and hyphen are
 * allowed. This is the intersection of what is safe on Linux, macOS, and
 * Windows. The first character must be a letter or digit, which rules out
 * leading dots (hidden files on Unix), leading spaces, and leading hyphens
 * (which can look like CLI flags). The final `.md` is matched separately.
 */
const SAFE_NAME_CHARS_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

/** Description of the strict naming rules, suitable for user-facing error messages and docs. */
export const MARKDOWN_FILE_NAME_RULES =
  "Markdown file names must end in .md (case-insensitive), may only contain " +
  "letters (A-Z, a-z), digits, space, dot (.), underscore (_) and hyphen (-), " +
  "must start with a letter or digit, must not contain path separators (/, \\) " +
  "or any subdirectory segments, must not match a Windows reserved name " +
  "(CON, PRN, AUX, NUL, COM0-COM9, LPT0-LPT9), must not have trailing whitespace " +
  "or a trailing dot, and must be no longer than 255 characters.";

/** Result of validating a markdown file name. */
export type MarkdownNameValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

/**
 * Validate that the given name is a strict, cross-OS-safe markdown file name.
 *
 * The rules are intentionally conservative so that any accepted name is safe
 * on Linux, macOS, and Windows, and so that agents cannot silently create
 * directory structures: a valid name describes exactly one file in the
 * configured root folder — nothing else.
 *
 * See {@link MARKDOWN_FILE_NAME_RULES} for the human-readable rules.
 */
export function validateMarkdownFileName(name: unknown): MarkdownNameValidation {
  if (typeof name !== "string") {
    return { valid: false, reason: "file name must be a string" };
  }
  if (name.length === 0) {
    return { valid: false, reason: "file name must not be empty" };
  }
  if (name.length > MAX_MARKDOWN_FILE_NAME_LENGTH) {
    return {
      valid: false,
      reason: `file name exceeds maximum length of ${String(MAX_MARKDOWN_FILE_NAME_LENGTH)} characters`,
    };
  }
  if (name !== name.trim()) {
    return { valid: false, reason: "file name must not have leading or trailing whitespace" };
  }
  // Path separators — these would introduce subdirectories.
  if (name.includes("/") || name.includes("\\")) {
    return {
      valid: false,
      reason:
        "file name must not contain path separators (/ or \\); only files in the configured root folder are supported",
    };
  }
  // Reject "." and ".." explicitly (relative path components).
  if (name === "." || name === "..") {
    return { valid: false, reason: "file name must not be '.' or '..'" };
  }
  // Must end in .md (case-insensitive).
  if (!name.toLowerCase().endsWith(MARKDOWN_FILE_EXTENSION)) {
    return { valid: false, reason: "file name must end in .md" };
  }
  // Must have a non-empty stem.
  const stem = name.slice(0, -MARKDOWN_FILE_EXTENSION.length);
  if (stem.length === 0) {
    return { valid: false, reason: "file name must have content before the .md extension" };
  }
  // Trailing dot before .md (e.g. "foo..md") is forbidden on Windows.
  if (stem.endsWith(".")) {
    return {
      valid: false,
      reason: "file name must not have a trailing dot before the .md extension",
    };
  }
  // Trailing space anywhere before .md would also be trimmed by Windows.
  if (stem.endsWith(" ")) {
    return {
      valid: false,
      reason: "file name must not have trailing whitespace before the .md extension",
    };
  }
  // Control characters and forbidden special characters are rejected by the
  // allow-list regex below, but it's useful to flag them with a specific
  // message for common cases.
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return { valid: false, reason: "file name must not contain control characters" };
    }
  }
  // Strict allow-list for the entire name. Note the `.md` suffix is allowed
  // because `.` is in the character class.
  if (!SAFE_NAME_CHARS_RE.test(name)) {
    return {
      valid: false,
      reason:
        "file name contains characters that are not portable across operating systems; " +
        "only letters, digits, space, dot, underscore, and hyphen are allowed, and the " +
        "first character must be a letter or digit",
    };
  }
  // Reject Windows reserved device names on the stem.
  if (WINDOWS_RESERVED_NAMES.has(stem.toUpperCase())) {
    return {
      valid: false,
      reason: `"${stem}" is a reserved name on Windows and cannot be used as a file name`,
    };
  }
  return { valid: true };
}

/**
 * Throws a user-friendly {@link Error} when the given name fails
 * {@link validateMarkdownFileName}. Returns the name unchanged on success.
 */
export function assertValidMarkdownFileName(name: string): string {
  const result = validateMarkdownFileName(name);
  if (!result.valid) {
    throw new Error(`Invalid markdown file name "${name}": ${result.reason}`);
  }
  return name;
}

// ---------------------------------------------------------------------------
// Folder listing (used by the folder picker)
// ---------------------------------------------------------------------------

/**
 * Classified entry returned by {@link listMarkdownFolderEntries}.
 *
 * - `supported`: a `.md` file whose name passes {@link validateMarkdownFileName}
 *   and can be operated on by the other markdown tools.
 * - `unsupported`: a child of the configured folder that the markdown tools
 *   cannot work with. Surfaced to callers so agents know the entry exists
 *   but cannot be read/written/deleted via these tools. Always carries a
 *   short, human-readable `reason`.
 */
export type MarkdownFolderEntry =
  | { readonly kind: "supported"; readonly item: DriveItem }
  | { readonly kind: "unsupported"; readonly item: DriveItem; readonly reason: string };

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

/**
 * Fetch the user's default drive metadata (`GET /me/drive`).
 *
 * Exposes the drive's user-facing `webUrl` so the picker can deep-link the
 * user to _their own_ OneDrive UI (which may be a personal account, a
 * business / GCC / sovereign-cloud tenant, etc.) rather than a hardcoded
 * `onedrive.live.com` URL that is wrong for work accounts. See
 * https://learn.microsoft.com/en-us/graph/api/drive-get.
 */
export async function getMyDrive(client: GraphClient, signal: AbortSignal): Promise<Drive> {
  logger.debug("getting /me/drive");
  const path = "/me/drive";
  const response = await client.request(HttpMethod.GET, path, signal);
  return parseResponse(response, DriveSchema, HttpMethod.GET, path);
}

// ---------------------------------------------------------------------------
// File listing / lookup under the configured root folder
// ---------------------------------------------------------------------------

/** Fetch all immediate children of the configured folder, unfiltered. */
async function listFolderChildren(
  client: GraphClient,
  folderId: string,
  signal: AbortSignal,
): Promise<DriveItem[]> {
  if (!folderId) throw new Error("listFolderChildren: folderId must not be empty");
  const path = `/me/drive/items/${encodeURIComponent(folderId)}/children?$top=200`;
  const response = await client.request(HttpMethod.GET, path, signal);
  const data = await parseResponse(
    response,
    GraphListResponseSchema(DriveItemSchema),
    HttpMethod.GET,
    path,
  );
  return data.value;
}

/**
 * List all immediate children of the given folder, classified into supported
 * markdown files and unsupported entries (subdirectories, non-.md files,
 * and .md files with names that fail {@link validateMarkdownFileName}).
 *
 * Entries whose filename is neither a folder nor has a `.md` suffix are
 * omitted entirely — they are clearly not markdown and not relevant to the
 * markdown tools.
 */
export async function listMarkdownFolderEntries(
  client: GraphClient,
  folderId: string,
  signal: AbortSignal,
): Promise<MarkdownFolderEntry[]> {
  logger.debug("listing markdown folder entries", { folderId });
  const children = await listFolderChildren(client, folderId, signal);
  const entries: MarkdownFolderEntry[] = [];

  for (const item of children) {
    if (item.folder !== undefined) {
      entries.push({
        kind: "unsupported",
        item,
        reason:
          "subdirectory — only files directly inside the configured root folder are supported",
      });
      continue;
    }
    if (item.file === undefined) {
      // Unknown drive item type (e.g. remoteItem, package). Skip.
      continue;
    }
    const isMarkdown = item.name.toLowerCase().endsWith(MARKDOWN_FILE_EXTENSION);
    if (!isMarkdown) {
      // Non-markdown files are not exposed by the markdown tools at all.
      continue;
    }
    const validation = validateMarkdownFileName(item.name);
    if (!validation.valid) {
      entries.push({
        kind: "unsupported",
        item,
        reason: `unsupported file name: ${validation.reason}`,
      });
      continue;
    }
    entries.push({ kind: "supported", item });
  }
  return entries;
}

/**
 * List `.md` files directly under the given folder whose names pass
 * {@link validateMarkdownFileName}. Thin wrapper over
 * {@link listMarkdownFolderEntries} that returns only the usable files.
 */
export async function listMarkdownFiles(
  client: GraphClient,
  folderId: string,
  signal: AbortSignal,
): Promise<DriveItem[]> {
  const entries = await listMarkdownFolderEntries(client, folderId, signal);
  return entries.filter((e) => e.kind === "supported").map((e) => e.item);
}

/**
 * Find a markdown file by exact-match, case-insensitive name within the given
 * folder. The provided name must already pass
 * {@link validateMarkdownFileName} — callers should call that first so the
 * error message reflects the name they supplied rather than whatever the
 * remote side stores.
 */
export async function findMarkdownFileByName(
  client: GraphClient,
  folderId: string,
  name: string,
  signal: AbortSignal,
): Promise<DriveItem | null> {
  if (!folderId) throw new Error("findMarkdownFileByName: folderId must not be empty");
  assertValidMarkdownFileName(name);

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

// ---------------------------------------------------------------------------
// Create-only / conditional-update (etag-protected)
// ---------------------------------------------------------------------------

/**
 * Error raised when {@link createMarkdownFile} encounters an existing file
 * with the same name in the target folder. Allows callers to render a clear
 * "use update instead" message to the agent.
 */
export class MarkdownFileAlreadyExistsError extends Error {
  constructor(
    public readonly folderId: string,
    public readonly fileName: string,
  ) {
    super(`Markdown file "${fileName}" already exists in folder ${folderId}.`);
    this.name = "MarkdownFileAlreadyExistsError";
  }
}

/**
 * Error raised when {@link updateMarkdownFile} fails because the supplied
 * etag does not match the file's current etag (HTTP 412). Carries the
 * file's current metadata so callers can report it back to the agent and
 * trigger a reconcile-and-retry workflow.
 */
export class MarkdownEtagMismatchError extends Error {
  constructor(
    public readonly itemId: string,
    public readonly suppliedEtag: string,
    public readonly currentItem: DriveItem,
  ) {
    super(
      `etag mismatch for item ${itemId}: supplied ${suppliedEtag}, ` +
        `current ${currentItem.eTag ?? "(unknown)"}`,
    );
    this.name = "MarkdownEtagMismatchError";
  }
}

/**
 * Create a new markdown file under the given folder. Fails with
 * {@link MarkdownFileAlreadyExistsError} if a file with the same name
 * already exists.
 *
 * Uses OneDrive's `@microsoft.graph.conflictBehavior=fail` query parameter
 * so the create-vs-update distinction is enforced server-side, not just by a
 * client-side existence check (which would race).
 *
 * See https://learn.microsoft.com/en-us/onedrive/developer/rest-api/api/driveitem_put_content.
 */
export async function createMarkdownFile(
  client: GraphClient,
  folderId: string,
  fileName: string,
  content: string,
  signal: AbortSignal,
): Promise<DriveItem> {
  if (!folderId) throw new Error("createMarkdownFile: folderId must not be empty");
  assertValidMarkdownFileName(fileName);

  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_DIRECT_CONTENT_BYTES) {
    throw new MarkdownFileTooLargeError(bytes, MAX_DIRECT_CONTENT_BYTES);
  }

  const path =
    `/me/drive/items/${encodeURIComponent(folderId)}:/` +
    `${encodeURIComponent(fileName)}:/content` +
    `?@microsoft.graph.conflictBehavior=fail`;
  logger.debug("creating markdown file", { folderId, fileName, bytes });

  let response: Response;
  try {
    response = await client.requestRaw(HttpMethod.PUT, path, content, "text/markdown", signal);
  } catch (err: unknown) {
    if (err instanceof GraphRequestError && err.statusCode === 409) {
      throw new MarkdownFileAlreadyExistsError(folderId, fileName);
    }
    throw err;
  }
  return parseResponse(response, DriveItemSchema, HttpMethod.PUT, path);
}

/**
 * Conditionally overwrite the content of an existing markdown file using an
 * `If-Match` header. Fails with {@link MarkdownEtagMismatchError} when the
 * supplied etag does not match the file's current etag (HTTP 412). On
 * mismatch the error carries the current drive item (with the new etag) so
 * callers can guide the agent to re-fetch, reconcile, and retry.
 *
 * See https://learn.microsoft.com/en-us/graph/api/driveitem-put-content.
 */
export async function updateMarkdownFile(
  client: GraphClient,
  itemId: string,
  etag: string,
  content: string,
  signal: AbortSignal,
): Promise<DriveItem> {
  if (!itemId) throw new Error("updateMarkdownFile: itemId must not be empty");
  if (!etag) throw new Error("updateMarkdownFile: etag must not be empty");

  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_DIRECT_CONTENT_BYTES) {
    throw new MarkdownFileTooLargeError(bytes, MAX_DIRECT_CONTENT_BYTES);
  }

  const path = `/me/drive/items/${encodeURIComponent(itemId)}/content`;
  logger.debug("updating markdown file", { itemId, bytes });

  let response: Response;
  try {
    response = await client.requestRaw(HttpMethod.PUT, path, content, "text/markdown", signal, {
      "If-Match": etag,
    });
  } catch (err: unknown) {
    if (err instanceof GraphRequestError && err.statusCode === 412) {
      // Fetch the latest item so callers can show the agent the current etag /
      // size / timestamp and explain how to reconcile.
      const current = await getDriveItem(client, itemId, signal);
      throw new MarkdownEtagMismatchError(itemId, etag, current);
    }
    throw err;
  }
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

// ---------------------------------------------------------------------------
// Version history (read-only)
// ---------------------------------------------------------------------------

/**
 * List historical versions of a drive item, newest first.
 *
 * OneDrive automatically retains previous versions whenever a file is
 * overwritten. This surfaces that history so a user can see "what was the
 * file like last Tuesday?" and (via {@link downloadDriveItemVersionContent})
 * read the content of a specific prior version.
 *
 * See https://learn.microsoft.com/en-us/graph/api/driveitem-list-versions.
 */
export async function listDriveItemVersions(
  client: GraphClient,
  itemId: string,
  signal: AbortSignal,
): Promise<DriveItemVersion[]> {
  if (!itemId) throw new Error("listDriveItemVersions: itemId must not be empty");
  logger.debug("listing drive item versions", { itemId });

  const path = `/me/drive/items/${encodeURIComponent(itemId)}/versions`;
  const response = await client.request(HttpMethod.GET, path, signal);
  const data = await parseResponse(
    response,
    GraphListResponseSchema(DriveItemVersionSchema),
    HttpMethod.GET,
    path,
  );
  return data.value;
}

/**
 * Download the UTF-8 content of a specific historical version of a drive
 * item. Enforces the same 4 MB direct-transfer limit as
 * {@link downloadMarkdownContent}. Throws {@link MarkdownFileTooLargeError}
 * when the limit is exceeded.
 *
 * See https://learn.microsoft.com/en-us/graph/api/driveitemversion-get-contents.
 */
export async function downloadDriveItemVersionContent(
  client: GraphClient,
  itemId: string,
  versionId: string,
  signal: AbortSignal,
): Promise<string> {
  if (!itemId) throw new Error("downloadDriveItemVersionContent: itemId must not be empty");
  if (!versionId) throw new Error("downloadDriveItemVersionContent: versionId must not be empty");

  const path =
    `/me/drive/items/${encodeURIComponent(itemId)}` +
    `/versions/${encodeURIComponent(versionId)}/content`;
  logger.debug("downloading drive item version content", { itemId, versionId });

  const response = await client.request(HttpMethod.GET, path, signal);
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.byteLength > MAX_DIRECT_CONTENT_BYTES) {
    throw new MarkdownFileTooLargeError(buf.byteLength, MAX_DIRECT_CONTENT_BYTES);
  }
  return buf.toString("utf-8");
}

/**
 * Error raised when a caller references a revision that does not exist for
 * the given file — neither as the current `version` nor in the `/versions`
 * history list. Distinct from `GraphRequestError` so tool handlers can
 * render a clear, actionable message.
 */
export class MarkdownUnknownVersionError extends Error {
  constructor(
    public readonly itemId: string,
    public readonly versionId: string,
    public readonly availableVersionIds: readonly string[],
  ) {
    super(
      `Version ${versionId} not found for item ${itemId}. ` +
        `Known version IDs: ${availableVersionIds.length === 0 ? "(none)" : availableVersionIds.join(", ")}`,
    );
    this.name = "MarkdownUnknownVersionError";
  }
}

/**
 * Fetch the UTF-8 content of a specific revision — either the current
 * revision (matched by the drive item's `version` field) or any historical
 * version from `/versions`. Throws {@link MarkdownUnknownVersionError} when
 * the ID matches neither.
 *
 * Pre-fetches the item and version list once so the caller can diff two
 * revisions with a single pair of resolution calls, and so the error message
 * can enumerate the known IDs.
 */
export async function getRevisionContent(
  client: GraphClient,
  item: DriveItem,
  versionId: string,
  signal: AbortSignal,
): Promise<string> {
  if (!versionId) throw new Error("getRevisionContent: versionId must not be empty");

  if (item.version === versionId) {
    return downloadMarkdownContent(client, item.id, signal);
  }

  const history = await listDriveItemVersions(client, item.id, signal);
  const match = history.find((v) => v.id === versionId);
  if (!match) {
    const known = item.version
      ? [item.version, ...history.map((v) => v.id)]
      : history.map((v) => v.id);
    throw new MarkdownUnknownVersionError(item.id, versionId, known);
  }

  return downloadDriveItemVersionContent(client, item.id, versionId, signal);
}
