// Sharing-related Graph helpers for `session_open_project` (W4 Day 4).
// Split out from `graph.ts`; re-exported through the barrel.

import type { GraphClient } from "../graph/client.js";
import { GraphRequestError, HttpMethod, parseResponse } from "../graph/client.js";
import { type ValidatedGraphId } from "../graph/ids.js";
import type { DriveItem, SharedWithMeEntry, Permission } from "../graph/types.js";
import {
  DriveItemSchema,
  GraphListResponseSchema,
  SharedWithMeEntrySchema,
  PermissionSchema,
} from "../graph/types.js";
import { logger } from "../logger.js";
import { ShareNotFoundError, ShareAccessDeniedError } from "../errors.js";

import type { EncodedShareId } from "./share-url.js";

const SharedWithMeListSchema = GraphListResponseSchema(SharedWithMeEntrySchema);
const PermissionListSchema = GraphListResponseSchema(PermissionSchema);

/**
 * Fetch the "Shared with me" list and return only folder entries (per
 * §4.3), deduplicated by `remoteItem.id`.
 */
export async function listSharedWithMe(
  client: GraphClient,
  signal: AbortSignal,
): Promise<SharedWithMeEntry[]> {
  const path = "/me/drive/sharedWithMe?$select=id,name,remoteItem,lastModifiedDateTime";
  logger.debug("listing shared-with-me entries");
  const response = await client.request(HttpMethod.GET, path, signal);
  const data = await parseResponse(response, SharedWithMeListSchema, HttpMethod.GET, path);

  // Filter to entries with remoteItem.folder
  const folders = data.value.filter(
    (entry) => entry.remoteItem?.folder !== undefined && entry.remoteItem.id !== undefined,
  );

  // Dedupe by remoteItem.id
  const seen = new Set<string>();
  const deduped: SharedWithMeEntry[] = [];
  for (const entry of folders) {
    const remoteId = entry.remoteItem?.id;
    if (remoteId && !seen.has(remoteId)) {
      seen.add(remoteId);
      deduped.push(entry);
    }
  }

  logger.debug("shared-with-me folders", { count: deduped.length });
  return deduped;
}

/**
 * Fetch permissions for a drive item. Used by `session_open_project` to
 * verify the user has write access.
 */
export async function getDriveItemPermissions(
  client: GraphClient,
  driveId: ValidatedGraphId,
  itemId: ValidatedGraphId,
  signal: AbortSignal,
): Promise<Permission[]> {
  const path = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/permissions`;
  logger.debug("fetching drive item permissions", { driveId, itemId });
  const response = await client.request(HttpMethod.GET, path, signal);
  const data = await parseResponse(response, PermissionListSchema, HttpMethod.GET, path);
  return data.value;
}

/**
 * Resolve a OneDrive sharing URL to a drive item. The `encodedShareId`
 * must be an {@link EncodedShareId} produced by {@link encodeShareUrl}
 * (which only runs after the host allow-list check in
 * {@link validateShareUrl} has passed). Maps 404 → ShareNotFoundError,
 * 403 → ShareAccessDeniedError.
 *
 * Note: `EncodedShareId` is a separate brand from `ValidatedGraphId`
 * (per ADR-0007 "Out of scope"). A share token is a `u!<base64url>`
 * value with characters (`!`, `-`, `_`) that `validateGraphId` rejects,
 * so they cannot share a brand. The wire-layer `encodeURIComponent`
 * remains as defence in depth.
 */
export async function resolveShareUrl(
  client: GraphClient,
  encodedShareId: EncodedShareId,
  signal: AbortSignal,
): Promise<DriveItem> {
  const path = `/shares/${encodeURIComponent(encodedShareId)}/driveItem?$select=id,parentReference,folder,name,remoteItem`;
  logger.debug("resolving share URL", { encodedShareId });
  try {
    const response = await client.request(HttpMethod.GET, path, signal);
    return await parseResponse(response, DriveItemSchema, HttpMethod.GET, path);
  } catch (err) {
    if (err instanceof GraphRequestError) {
      if (err.statusCode === 404) {
        throw new ShareNotFoundError(encodedShareId);
      }
      if (err.statusCode === 403) {
        throw new ShareAccessDeniedError(encodedShareId);
      }
    }
    throw err;
  }
}

/**
 * Refresh folder metadata (name + path) for a given folder. Used by the
 * silent folder-path refresh on every `session_open_project` (§3.4 lines
 * 1521–1529).
 */
export async function refreshFolderMetadata(
  client: GraphClient,
  driveId: ValidatedGraphId,
  folderId: ValidatedGraphId,
  signal: AbortSignal,
): Promise<{ name: string; folderPath: string }> {
  const path = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(folderId)}?$select=parentReference,name`;
  logger.debug("refreshing folder metadata", { driveId, folderId });
  const response = await client.request(HttpMethod.GET, path, signal);
  const item = await parseResponse(response, DriveItemSchema, HttpMethod.GET, path);

  const parentPath = item.parentReference?.path ?? "";
  const folderPath = parentPath.replace(/^\/drive\/root:/, "") + `/${item.name}`;

  return { name: item.name, folderPath };
}
