// Drive scope abstraction for Microsoft Graph drive operations.
//
// `DriveScope` discriminates between the two ways graphdo can address a
// drive: `/me/drive` (the signed-in user's own OneDrive) and
// `/drives/{driveId}` (an explicit drive id, used today only by the
// generalised abstraction itself; production tools currently always
// construct `{ kind: "me" }`). Centralising the URL building here keeps
// every Graph helper free of hard-coded `/me/drive…` strings and makes the
// future cross-drive PR a localised change.

import type { ValidatedGraphId } from "./ids.js";

/**
 * Identifies the drive a Graph operation should target.
 *
 * - `{ kind: "me" }` resolves to `/me/drive…` and is the only variant
 *   constructed by current tools (we read it from the `"me"` sentinel
 *   stored in `workspace.driveId`).
 * - `{ kind: "drive"; driveId }` resolves to `/drives/{driveId}…` and is
 *   reserved for the future cross-drive PR (shared drives, SharePoint
 *   document libraries). The `driveId` must be a {@link ValidatedGraphId}
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
export function driveItemPath(
  scope: DriveScope,
  itemId: ValidatedGraphId,
  suffix = "",
): string {
  return `${driveMetadataPath(scope)}/items/${encodeURIComponent(itemId)}${suffix}`;
}

/**
 * Resolve a OneDrive or SharePoint sharing link to a drive item.
 *
 * Takes a public or tenant-scoped share URL (from the "Share" button in
 * OneDrive / SharePoint) and returns the drive item metadata. Uses the
 * `/shares/{encoded-sharing-url}/driveItem` endpoint.
 *
 * The `sharingUrl` is encoded using Graph's share id format: `u!` + base64url
 * (without padding) of the UTF-8 bytes of the URL. See
 * https://learn.microsoft.com/en-us/graph/api/shares-get
 *
 * @returns The resolved drive item with `driveId`, `itemId`, `name`, and
 *   optional `webUrl`. Both IDs are validated before returning (defence in
 *   depth — Graph occasionally returns weird shapes in edge cases).
 * @throws GraphRequestError on 404 (link expired, not accessible, or invalid),
 *   403 (permission denied), or any other Graph API error.
 */
export async function resolveShareLink(
  client: { request: (method: import("./client.js").HttpMethod, path: string, signal: AbortSignal) => Promise<Response> },
  sharingUrl: string,
  signal: AbortSignal,
): Promise<{
  driveId: ValidatedGraphId;
  itemId: ValidatedGraphId;
  name: string;
  webUrl?: string;
}> {
  // Encode the sharing URL using the Graph share id format: u! + base64url without padding.
  // RFC 4648 §5: base64url uses - and _ instead of + and /, and strips = padding.
  const utf8Bytes = new TextEncoder().encode(sharingUrl);
  const base64 = btoa(String.fromCharCode(...utf8Bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  const shareId = `u!${base64}`;

  const path = `/shares/${encodeURIComponent(shareId)}/driveItem`;
  
  const { HttpMethod, parseResponse, GraphRequestError } = await import("./client.js");
  const { DriveItemSchema } = await import("./types.js");
  const { validateGraphId } = await import("./ids.js");

  const res = await client.request(HttpMethod.GET, path, signal);
  if (!res.ok) {
    const err = await GraphRequestError.fromResponse(res, HttpMethod.GET, path);
    throw err;
  }

  const item = await parseResponse(res, DriveItemSchema, signal);

  // Defence in depth: validate both IDs even though they came from Graph.
  const driveId = validateGraphId(
    "driveId",
    item.parentReference?.driveId ?? item.id, // fallback to itemId if driveId missing (shouldn't happen)
  );
  const itemId = validateGraphId("itemId", item.id);

  return {
    driveId,
    itemId,
    name: item.name,
    webUrl: item.webUrl,
  };
}
