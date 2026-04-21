// Content download + recursive `attachments/` walker for collab v1
// (W2 Day 4). Split out from `graph.ts`; re-exported through the barrel.

import type { GraphClient } from "../graph/client.js";
import { GraphRequestError } from "../graph/client.js";
import { validateGraphId, type ValidatedGraphId } from "../graph/ids.js";
import type { DriveItem } from "../graph/types.js";
import { downloadMarkdownContent } from "../graph/markdown.js";

import { listChildren } from "./graph-items.js";
import { MAX_ANCESTRY_HOPS } from "./scope.js";

/**
 * Download a drive item's content as a UTF-8 string.
 *
 * Thin re-export of {@link downloadMarkdownContent} — the body was
 * previously duplicated here under a collab-specific name. Both share
 * the 4 MiB cap ({@link MAX_DIRECT_CONTENT_BYTES}) and
 * {@link MarkdownFileTooLargeError}. Kept separately exported so the
 * collab-side call sites don't have to reach into `graph/markdown.ts`
 * for a helper that is conceptually about any drive item.
 */
export const getDriveItemContent = downloadMarkdownContent;

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
