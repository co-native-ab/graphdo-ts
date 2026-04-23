// Drive scope abstraction for Microsoft Graph drive operations.
//
// `DriveScope` discriminates between the two ways graphdo can address a
// drive: `/me/drive` (the signed-in user's own OneDrive) and
// `/drives/{driveId}` (an explicit drive id). Centralising the URL
// building here keeps every Graph helper free of hard-coded `/me/drive…`
// strings. The current build only ever constructs `{ kind: "me" }` — the
// `kind: "drive"` branch is retained as a defensive fallback for a
// hand-edited `config.json` and is the seam a future cross-drive
// workspace feature would target.

import type { ValidatedGraphId } from "./ids.js";

/**
 * Identifies the drive a Graph operation should target.
 *
 * - `{ kind: "me" }` resolves to `/me/drive…` and is the default for the
 *   user's own OneDrive (we read it from the `"me"` sentinel stored in
 *   `workspace.driveId`).
 * - `{ kind: "drive"; driveId }` resolves to `/drives/{driveId}…`. The
 *   `driveId` must be a {@link ValidatedGraphId} so it cannot smuggle a
 *   path segment into the Graph URL.
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
