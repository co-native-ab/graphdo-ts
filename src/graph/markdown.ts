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
import { validateGraphId, type ValidatedGraphId } from "./ids.js";
import { logger } from "../logger.js";

/**
 * Client-side cap on the size of a single markdown file payload.
 *
 * This is a graphdo-ts policy limit, NOT a Microsoft Graph API limit.
 * Microsoft Graph's `/content` endpoint accepts simple PUT uploads up to
 * 250 MB (see https://learn.microsoft.com/en-us/graph/api/driveitem-put-content);
 * resumable upload sessions extend that further. We intentionally cap markdown
 * tool payloads at 4 MiB to keep these tools focused on hand-written notes
 * and small documents — the use case the markdown surface is designed for —
 * and to discourage agents from using OneDrive as bulk file storage via this
 * tool. The limit can be raised later if a concrete need appears; until then,
 * comparison is `>` so exactly 4 MiB still succeeds.
 *
 * See ADR-0004 for the full rationale (no upload sessions, scope of the
 * markdown surface).
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
// Opaque Graph identifier validation
// ---------------------------------------------------------------------------
//
// The validator + branded `ValidatedGraphId` type live in `./ids.js` (see
// ADR-0007). This module re-exports the legacy `assertValidGraphId` name
// for back-compat so existing imports keep working; new code should call
// {@link validateGraphId} directly. The two return the same branded
// value — `assertValidGraphId` is now a thin alias.
export { validateGraphId as assertValidGraphId } from "./ids.js";

// ---------------------------------------------------------------------------
// Folder listing (used by the folder picker)
// ---------------------------------------------------------------------------

/**
 * Discriminator for {@link MarkdownFolderEntry}. Modelled as a TypeScript
 * `enum` to match the rest of the codebase (`HttpMethod`, `GraphScope`) and
 * to give callers a single import-able symbol when switching on the kind.
 */
export enum MarkdownFolderEntryKind {
  Supported = "supported",
  Unsupported = "unsupported",
}

/**
 * Classified entry returned by {@link listMarkdownFolderEntries}.
 *
 * - `Supported`: a `.md` file whose name passes {@link validateMarkdownFileName}
 *   and can be operated on by the other markdown tools.
 * - `Unsupported`: a child of the configured folder that the markdown tools
 *   cannot work with. Surfaced to callers so agents know the entry exists
 *   but cannot be read/written/deleted via these tools. Always carries a
 *   short, human-readable `reason`.
 */
export type MarkdownFolderEntry =
  | { readonly kind: MarkdownFolderEntryKind.Supported; readonly item: DriveItem }
  | {
      readonly kind: MarkdownFolderEntryKind.Unsupported;
      readonly item: DriveItem;
      readonly reason: string;
    };

/**
 * List folders directly underneath the user's OneDrive root.
 *
 * Only returns drive items where `folder` is populated. Files are omitted.
 * Follows `@odata.nextLink` to return the full set even when the user has
 * more than one page (Graph caps `$top` at ~200), so a user with thousands
 * of top-level folders still sees them all in the picker. Server-side
 * filtering (`$filter=folder ne null`) is not used because Graph's filter
 * support on driveItem children is inconsistent across personal vs. work
 * accounts; the client-side filter is reliable everywhere.
 */
export async function listRootFolders(
  client: GraphClient,
  signal: AbortSignal,
): Promise<DriveItem[]> {
  logger.debug("listing onedrive root folders");
  const items = await listAllPages(client, "/me/drive/root/children?$top=200", signal);
  return items.filter((item) => item.folder !== undefined);
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
// Preview URL construction
// ---------------------------------------------------------------------------

/**
 * Build a SharePoint OneDrive web preview URL for a markdown file.
 *
 * The returned URL uses SharePoint's `/my?id=<server-relative path>&parent=<parent path>`
 * deep-link, which renders the file in the browser-based viewer rather than
 * triggering a download. The plain `DriveItem.webUrl` returned by Graph
 * frequently points at the download endpoint instead, which is why we
 * construct the URL manually.
 *
 * Algorithm:
 *   - origin     = scheme://host of the drive's `webUrl`
 *   - drivePath  = pathname of the drive's `webUrl` (e.g. /personal/.../Documents)
 *   - relFolder  = item.parentReference.path with the `/drive/root:` prefix removed
 *   - parentPath = drivePath + relFolder
 *   - itemPath   = parentPath + "/" + item.name
 *   - url        = `${origin}/my?id=${enc(itemPath)}&parent=${enc(parentPath)}`
 *
 * Throws when `drive.webUrl` is missing or unparseable, when
 * `item.parentReference.path` is missing or in an unexpected shape, or when
 * the drive is hosted on consumer OneDrive (`onedrive.live.com`), which uses
 * a different URL scheme that this helper does not implement.
 */
export function buildMarkdownPreviewUrl(drive: Drive, item: DriveItem): string {
  const driveWebUrl = drive.webUrl;
  if (typeof driveWebUrl !== "string" || driveWebUrl.length === 0) {
    throw new Error(
      "Cannot build preview URL: the drive has no webUrl. " +
        "This typically means /me/drive returned no webUrl (rare for OneDrive for Business / SharePoint).",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(driveWebUrl);
  } catch {
    throw new Error(`Cannot build preview URL: drive webUrl is not a valid URL (${driveWebUrl}).`);
  }

  if (parsed.hostname === "onedrive.live.com" || parsed.hostname.endsWith(".onedrive.live.com")) {
    throw new Error(
      "Cannot build preview URL: consumer OneDrive (onedrive.live.com) uses a different " +
        "URL scheme that the markdown_preview_file tool does not implement. " +
        "Open the file from onedrive.live.com directly.",
    );
  }

  const parentRefPath = item.parentReference?.path;
  if (typeof parentRefPath !== "string" || parentRefPath.length === 0) {
    throw new Error(
      `Cannot build preview URL: item "${item.name}" has no parentReference.path from Graph.`,
    );
  }

  // parentReference.path looks like `/drive/root:/Folder Name` or
  // `/drives/{driveId}/root:/Folder Name`. Strip everything up to and
  // including `root:`. After stripping, an item directly inside the drive
  // root yields the empty string, which is fine — we just join with the
  // drive's pathname.
  const rootMarker = "root:";
  const idx = parentRefPath.indexOf(rootMarker);
  if (idx === -1) {
    throw new Error(
      `Cannot build preview URL: item "${item.name}" has an unexpected parentReference.path ` +
        `(${parentRefPath}); expected it to contain "root:".`,
    );
  }
  const relFolder = parentRefPath.slice(idx + rootMarker.length);

  const drivePath = parsed.pathname.replace(/\/+$/u, "");
  const parentPath = `${drivePath}${relFolder}`.replace(/\/+$/u, "");
  const itemPath = `${parentPath}/${item.name}`;

  const url = new URL("/my", parsed.origin);
  // Use encodeURIComponent + manual query construction (rather than
  // URLSearchParams) so spaces are encoded as `%20` — SharePoint's web
  // viewer expects RFC 3986 percent-encoding here, not the
  // application/x-www-form-urlencoded `+` substitution that URLSearchParams
  // would emit.
  url.search = `?id=${encodeURIComponent(itemPath)}&parent=${encodeURIComponent(parentPath)}`;
  return url.toString();
}

// ---------------------------------------------------------------------------
// File listing / lookup under the configured root folder
// ---------------------------------------------------------------------------

/** Fetch all immediate children of the configured folder, unfiltered. */
async function listFolderChildren(
  client: GraphClient,
  folderId: ValidatedGraphId,
  signal: AbortSignal,
): Promise<DriveItem[]> {
  return listAllPages(
    client,
    `/me/drive/items/${encodeURIComponent(folderId)}/children?$top=200`,
    signal,
  );
}

/**
 * Internal helper: GET a Graph collection endpoint and follow
 * `@odata.nextLink` until the full result set has been retrieved.
 *
 * Graph caps `$top` at ~200 for drive item children, so pagination is
 * required for users with more than 200 folders or files. We schema-validate
 * the next link is an `https://graph.*` URL we can safely re-issue: any
 * other shape is dropped to avoid being redirected to an arbitrary URL.
 */
async function listAllPages(
  client: GraphClient,
  initialPath: string,
  signal: AbortSignal,
): Promise<DriveItem[]> {
  const all: DriveItem[] = [];
  let nextPath: string | null = initialPath;
  let pageCount = 0;
  // Defensive cap so a runaway nextLink chain (or a misbehaving server)
  // can't loop forever. 200 pages × 200 items = 40 000 entries — far more
  // than any realistic OneDrive folder.
  const MAX_PAGES = 200;
  while (nextPath !== null) {
    pageCount += 1;
    if (pageCount > MAX_PAGES) {
      throw new Error(
        `listAllPages: refusing to follow more than ${String(MAX_PAGES)} pages of @odata.nextLink`,
      );
    }
    const response = await client.request(HttpMethod.GET, nextPath, signal);
    const data = await parseResponse(
      response,
      GraphListResponseSchema(DriveItemSchema),
      HttpMethod.GET,
      nextPath,
    );
    all.push(...data.value);
    nextPath = extractNextPath(data["@odata.nextLink"]);
  }
  return all;
}

/**
 * Convert a Graph `@odata.nextLink` (an absolute URL) into a path we can
 * pass straight back to {@link GraphClient.request}. Returns `null` when
 * absent, malformed, or pointing somewhere other than the Graph host.
 */
function extractNextPath(nextLink: unknown): string | null {
  if (typeof nextLink !== "string" || nextLink.length === 0) return null;
  let url: URL;
  try {
    url = new URL(nextLink);
  } catch {
    return null;
  }
  // Graph nextLink hosts: graph.microsoft.com, graph.microsoft.us, etc.
  // We only follow https:// links to a graph.microsoft.* host.
  if (url.protocol !== "https:") return null;
  if (!/^graph\.microsoft\.[a-z.]+$/i.test(url.hostname)) return null;
  // Strip the /v1.0 prefix if present so the resulting path matches the
  // shape GraphClient already prepends.
  const versioned = url.pathname.replace(/^\/v1\.0/, "");
  return `${versioned}${url.search}`;
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
  folderId: ValidatedGraphId,
  signal: AbortSignal,
): Promise<MarkdownFolderEntry[]> {
  logger.debug("listing markdown folder entries", { folderId });
  const children = await listFolderChildren(client, folderId, signal);
  const entries: MarkdownFolderEntry[] = [];

  for (const item of children) {
    if (item.folder !== undefined) {
      entries.push({
        kind: MarkdownFolderEntryKind.Unsupported,
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
        kind: MarkdownFolderEntryKind.Unsupported,
        item,
        reason: `unsupported file name: ${validation.reason}`,
      });
      continue;
    }
    entries.push({ kind: MarkdownFolderEntryKind.Supported, item });
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
  folderId: ValidatedGraphId,
  signal: AbortSignal,
): Promise<DriveItem[]> {
  const entries = await listMarkdownFolderEntries(client, folderId, signal);
  return entries.filter((e) => e.kind === MarkdownFolderEntryKind.Supported).map((e) => e.item);
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
  folderId: ValidatedGraphId,
  name: string,
  signal: AbortSignal,
): Promise<DriveItem | null> {
  assertValidMarkdownFileName(name);

  const files = await listMarkdownFiles(client, folderId, signal);
  const lower = name.toLowerCase();
  return files.find((f) => f.name.toLowerCase() === lower) ?? null;
}

/** Fetch a drive item's metadata (without downloading content). */
export async function getDriveItem(
  client: GraphClient,
  itemId: ValidatedGraphId,
  signal: AbortSignal,
): Promise<DriveItem> {
  logger.debug("getting drive item", { itemId });

  const path = `/me/drive/items/${encodeURIComponent(itemId)}`;
  const response = await client.request(HttpMethod.GET, path, signal);
  return parseResponse(response, DriveItemSchema, HttpMethod.GET, path);
}

// ---------------------------------------------------------------------------
// Download / upload / delete
// ---------------------------------------------------------------------------

/** Error raised when a file exceeds the client-side markdown size cap. */
export class MarkdownFileTooLargeError extends Error {
  constructor(
    public readonly sizeBytes: number,
    public readonly limitBytes: number,
  ) {
    super(
      `Markdown file is ${String(sizeBytes)} bytes, which exceeds the ${String(limitBytes)}-byte ` +
        "graphdo-ts markdown size cap (tool-side limit, not a Microsoft Graph API limit).",
    );
    this.name = "MarkdownFileTooLargeError";
  }
}

/**
 * Download a drive item's content as a UTF-8 string.
 *
 * Enforces the 4 MiB graphdo-ts markdown cap by checking the reported item
 * size first; if the size is unknown it falls back to measuring the response
 * body. Throws {@link MarkdownFileTooLargeError} when the limit is exceeded.
 * The cap is a tool-side policy, not a Graph API limit (see
 * {@link MAX_DIRECT_CONTENT_BYTES}).
 */
export async function downloadMarkdownContent(
  client: GraphClient,
  itemId: ValidatedGraphId,
  signal: AbortSignal,
): Promise<string> {
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
// Create-only / conditional-update (cTag-protected)
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
 * cTag does not match the file's current cTag (HTTP 412). Carries the
 * file's current metadata so callers can report it back to the agent and
 * trigger a reconcile-and-retry workflow.
 */
export class MarkdownCTagMismatchError extends Error {
  constructor(
    public readonly itemId: string,
    public readonly suppliedCTag: string,
    public readonly currentItem: DriveItem,
  ) {
    super(
      `cTag mismatch for item ${itemId}: supplied ${suppliedCTag}, ` +
        `current ${currentItem.cTag ?? "(unknown)"}`,
    );
    this.name = "MarkdownCTagMismatchError";
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
  folderId: ValidatedGraphId,
  fileName: string,
  content: string,
  signal: AbortSignal,
): Promise<DriveItem> {
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
 * `If-Match` header carrying the file's `cTag`. Fails with
 * {@link MarkdownCTagMismatchError} when the supplied cTag does not match
 * the file's current cTag (HTTP 412). On mismatch the error carries the
 * current drive item (with the new cTag) so callers can guide the agent to
 * re-fetch, reconcile, and retry.
 *
 * `cTag` is OneDrive's content-only entity tag and is unaffected by
 * metadata-only changes (rename, share, indexing, preview generation), so
 * using it here avoids the spurious 412s that would result from sending
 * `eTag` instead.
 *
 * See https://learn.microsoft.com/en-us/graph/api/driveitem-put-content.
 */
export async function updateMarkdownFile(
  client: GraphClient,
  itemId: ValidatedGraphId,
  cTag: string,
  content: string,
  signal: AbortSignal,
): Promise<DriveItem> {
  if (!cTag) throw new Error("updateMarkdownFile: cTag must not be empty");

  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_DIRECT_CONTENT_BYTES) {
    throw new MarkdownFileTooLargeError(bytes, MAX_DIRECT_CONTENT_BYTES);
  }

  const path = `/me/drive/items/${encodeURIComponent(itemId)}/content`;
  logger.debug("updating markdown file", { itemId, bytes });

  let response: Response;
  try {
    response = await client.requestRaw(HttpMethod.PUT, path, content, "text/markdown", signal, {
      "If-Match": cTag,
    });
  } catch (err: unknown) {
    if (err instanceof GraphRequestError && err.statusCode === 412) {
      // Fetch the latest item so callers can show the agent the current cTag /
      // size / timestamp and explain how to reconcile.
      const current = await getDriveItem(client, itemId, signal);
      throw new MarkdownCTagMismatchError(itemId, cTag, current);
    }
    throw err;
  }
  return parseResponse(response, DriveItemSchema, HttpMethod.PUT, path);
}

/** Permanently delete a drive item. */
export async function deleteDriveItem(
  client: GraphClient,
  itemId: ValidatedGraphId,
  signal: AbortSignal,
): Promise<void> {
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
  itemId: ValidatedGraphId,
  signal: AbortSignal,
): Promise<DriveItemVersion[]> {
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
 * Resolve the current revision ID of a drive item.
 *
 * Real OneDrive does not always populate `version` on the drive item returned
 * from `GET /me/drive/items/{id}` (or from a content upload), even though the
 * `/versions` sub-resource lists proper IDs. This helper prefers the inline
 * `version` field when present, and otherwise falls back to the newest entry
 * of `/versions` so the caller can always surface a usable Revision to the
 * agent (matching the IDs accepted by `markdown_diff_file_versions` and
 * `markdown_get_file_version`).
 *
 * Returns `undefined` only when neither source yields a version (an empty
 * `/versions` response or a transient absence). Errors from the fallback call
 * are swallowed so the primary operation isn't failed by a best-effort
 * lookup; callers should treat `undefined` as "not currently known" and may
 * direct the agent to `markdown_list_file_versions`.
 */
export async function resolveCurrentRevision(
  client: GraphClient,
  item: DriveItem,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (item.version !== undefined) return item.version;
  // `item.id` is sourced from a Zod-parsed Graph response; re-validate
  // before splicing into a Graph URL (defence in depth — a buggy mock
  // server or a future schema change should not silently send a
  // malformed value through encodeURIComponent).
  const itemId = validateGraphId("item.id", item.id);
  try {
    const history = await listDriveItemVersions(client, itemId, signal);
    return history[0]?.id;
  } catch (err: unknown) {
    if (signal.aborted) throw err;
    logger.debug("resolveCurrentRevision: /versions fallback failed", {
      itemId: item.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Download the UTF-8 content of a specific historical version of a drive
 * item. Enforces the same 4 MiB graphdo-ts markdown cap as
 * {@link downloadMarkdownContent} (a tool-side policy, not a Graph API
 * limit). Throws {@link MarkdownFileTooLargeError} when the limit is
 * exceeded.
 *
 * See https://learn.microsoft.com/en-us/graph/api/driveitemversion-get-contents.
 */
export async function downloadDriveItemVersionContent(
  client: GraphClient,
  itemId: ValidatedGraphId,
  versionId: ValidatedGraphId,
  signal: AbortSignal,
): Promise<string> {
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

export interface RevisionContent {
  content: string;
  isCurrent: boolean;
}

/**
 * Fetch the UTF-8 content of a specific revision — either the current
 * revision (matched by the drive item's `version` field or by being the first
 * entry in `/versions`) or any historical version. Throws
 * {@link MarkdownUnknownVersionError} when the ID matches neither. Returns the
 * content along with `isCurrent` so callers can label the result accurately
 * even when `item.version` is absent (which is common in real OneDrive
 * responses).
 *
 * Pre-fetches the item and version list once so the caller can diff two
 * revisions with a single pair of resolution calls, and so the error message
 * can enumerate the known IDs.
 */
export async function getRevisionContent(
  client: GraphClient,
  item: DriveItem,
  versionId: ValidatedGraphId,
  signal: AbortSignal,
): Promise<RevisionContent> {
  const itemIdValidated = validateGraphId("item.id", item.id);

  // Fast path: item.version is populated (sometimes returned by Graph; with
  // our mock and many real OneDrive responses the field is omitted, in
  // which case we fall through to the /versions-driven lookup below).
  if (item.version === versionId) {
    const content = await downloadMarkdownContent(client, itemIdValidated, signal);
    return { content, isCurrent: true };
  }

  const history = await listDriveItemVersions(client, itemIdValidated, signal);

  // The versions list is returned newest-first. OneDrive includes the current
  // version as the first entry but rejects GET /versions/{id}/content for it
  // (HTTP 400 "invalidRequest: You cannot get the content of the current
  // version"). When item.version is unavailable (real OneDrive does not always
  // surface it), detect the current version by its position at history[0].
  if (history[0]?.id === versionId) {
    const content = await downloadMarkdownContent(client, itemIdValidated, signal);
    return { content, isCurrent: true };
  }

  const match = history.find((v) => v.id === versionId);
  if (!match) {
    const known = Array.from(
      new Set(
        item.version ? [item.version, ...history.map((v) => v.id)] : history.map((v) => v.id),
      ),
    );
    throw new MarkdownUnknownVersionError(item.id, versionId, known);
  }

  const content = await downloadDriveItemVersionContent(client, itemIdValidated, versionId, signal);
  return { content, isCurrent: false };
}
