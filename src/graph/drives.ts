// Drive scope abstraction for Microsoft Graph drive operations.
//
// `DriveScope` discriminates between the two ways graphdo can address a
// drive: `/me/drive` (the signed-in user's own OneDrive) and
// `/drives/{driveId}` (an explicit drive id, used by the workspace picker
// when the user pastes a share link to a folder on another drive).
// Centralising the URL building here keeps every Graph helper free of
// hard-coded `/me/drive…` strings.

import { HttpMethod, parseResponse, type GraphClient } from "./client.js";
import { validateGraphId, type ValidatedGraphId } from "./ids.js";
import { DriveItemSchema } from "./types.js";

/**
 * Identifies the drive a Graph operation should target.
 *
 * - `{ kind: "me" }` resolves to `/me/drive…` and is the default for the
 *   user's own OneDrive (we read it from the `"me"` sentinel stored in
 *   `workspace.driveId`).
 * - `{ kind: "drive"; driveId }` resolves to `/drives/{driveId}…` and is
 *   constructed when the user pastes a share link in the workspace
 *   picker (the resolved share's `driveId` is persisted to
 *   `workspace.driveId`). The `driveId` must be a {@link ValidatedGraphId}
 *   so it cannot smuggle a path segment into the Graph URL.
 */
export type DriveScope =
  | { readonly kind: "me" }
  | { readonly kind: "drive"; readonly driveId: ValidatedGraphId };

/** Build a `DriveScope` for the signed-in user's own OneDrive. */
export const meDriveScope: DriveScope = { kind: "me" };

/**
 * Base path of the drive itself (`/me/drive` or `/drives/{driveId}`).
 *
 * Used for endpoints like `GET /me/drive` (drive metadata) — the equivalent
 * for an explicit drive id is `GET /drives/{driveId}`.
 */
export function driveMetadataPath(scope: DriveScope): string {
  if (scope.kind === "me") return "/me/drive";
  return `/drives/${encodeURIComponent(scope.driveId)}`;
}

/**
 * Children of the drive's root folder (`/me/drive/root/children` or
 * `/drives/{driveId}/root/children`).
 *
 * Suffix is appended verbatim — callers pass `?$top=200` etc. directly so
 * they don't pay an extra string concat on the hot path.
 */
export function driveRootChildrenPath(scope: DriveScope, suffix = ""): string {
  return `${driveMetadataPath(scope)}/root/children${suffix}`;
}

/**
 * Path to a drive item by id (`/me/drive/items/{id}` or
 * `/drives/{driveId}/items/{itemId}`), with an optional suffix appended
 * verbatim (e.g. `/content`, `/children`, `/versions`,
 * `/versions/{versionId}/content`).
 *
 * `itemId` is a {@link ValidatedGraphId}, so it cannot smuggle additional
 * path segments. The drive id (when present) is also validated. The suffix
 * is the caller's responsibility — if it contains user-supplied data, the
 * caller must `encodeURIComponent` it.
 */
export function driveItemPath(scope: DriveScope, itemId: ValidatedGraphId, suffix = ""): string {
  return `${driveMetadataPath(scope)}/items/${encodeURIComponent(itemId)}${suffix}`;
}

/** Resolved drive item from a share link. */
export interface ResolvedShare {
  readonly driveId: ValidatedGraphId;
  readonly itemId: ValidatedGraphId;
  readonly name: string;
  readonly webUrl?: string;
}

/**
 * Encode a sharing URL into the Graph `u!{base64url}` share id used in
 * `/shares/{id}/driveItem` requests. RFC 4648 §5: base64url uses `-` and
 * `_` instead of `+` and `/`, and strips `=` padding.
 */
export function encodeShareId(sharingUrl: string): string {
  const utf8Bytes = new TextEncoder().encode(sharingUrl);
  // Buffer is available everywhere Node 22+ runs and avoids the
  // `String.fromCharCode(...utf8Bytes)` call that blows the stack on
  // very long URLs.
  const base64 = Buffer.from(utf8Bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `u!${base64}`;
}

/**
 * Resolve a OneDrive or SharePoint sharing link to a drive item via
 * `GET /shares/{share-id}/driveItem`.
 *
 * Encodes the URL using the Graph share id format (`u!` + base64url of the
 * UTF-8 bytes; see {@link encodeShareId}) and then fetches the underlying
 * drive item. Returns the validated `driveId` and `itemId` that subsequent
 * Graph calls should be addressed to (the `driveId` may be different from
 * the user's own — that is the whole point of pasting a share link), plus
 * the item's display name and optional `webUrl` for the picker UI.
 *
 * See https://learn.microsoft.com/en-us/graph/api/shares-get.
 *
 * @throws GraphRequestError on 404 (link expired or not accessible),
 *   403 (permission denied), or any other Graph API error. `GraphClient`
 *   already throws on non-2xx — this wrapper does not need to second-guess.
 */
export async function resolveShareLink(
  client: GraphClient,
  sharingUrl: string,
  signal: AbortSignal,
): Promise<ResolvedShare> {
  const shareId = encodeShareId(sharingUrl);
  const path = `/shares/${encodeURIComponent(shareId)}/driveItem`;
  const response = await client.request(HttpMethod.GET, path, signal);
  const item = await parseResponse(response, DriveItemSchema, HttpMethod.GET, path);

  // Defence in depth: re-validate IDs even though they came from Graph.
  // The driveId lives on the parentReference; if it's missing we cannot
  // address the resolved item via /drives/{id}/items/{id}, so fail loudly.
  const parentDriveId = item.parentReference?.driveId;
  if (parentDriveId === undefined) {
    throw new Error(
      `Graph /shares response did not include parentReference.driveId for ${sharingUrl}`,
    );
  }
  const driveId = validateGraphId("parentReference.driveId", parentDriveId);
  const itemId = validateGraphId("item.id", item.id);

  return {
    driveId,
    itemId,
    name: item.name,
    ...(item.webUrl !== undefined ? { webUrl: item.webUrl } : {}),
  };
}
