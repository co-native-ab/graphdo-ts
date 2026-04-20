// `session_recover_doc_id` (W5 Day 1) — pure recovery walker.
//
// Walks `/me/drive/items/{authoritativeFileId}/versions` newest-first
// looking for a historical version whose YAML frontmatter parses
// cleanly and carries a `doc_id`. The first hit wins (we stop
// immediately — see `docs/plans/collab-v1.md` §2.2 step 4).
//
// The walk is bounded at {@link MAX_RECOVERY_VERSIONS} (50) so a
// pathological history can never blow our request budget. OneDrive's
// default version retention is 25; 50 is a comfortable safety margin.
//
// This module owns no Graph state of its own — the authoritative item
// id is resolved by the caller (the tool layer). The walker is pure
// I/O orchestration: list versions, fetch each version's content
// sequentially (do not parallelise — the typical case is 1–2 GETs),
// parse with the read-path codec.

import type { GraphClient } from "../graph/client.js";
import { GraphRequestError } from "../graph/client.js";
import type { ValidatedGraphId } from "../graph/ids.js";
import { validateGraphId } from "../graph/ids.js";
import {
  downloadDriveItemVersionContent,
  listDriveItemVersions,
  MarkdownFileTooLargeError,
} from "../graph/markdown.js";
import { logger } from "../logger.js";

import { readMarkdownFrontmatter } from "./frontmatter.js";

/**
 * Hard cap on the number of historical versions inspected during
 * recovery. OneDrive's default retention is 25; 50 is a safety margin
 * matching `docs/plans/collab-v1.md` §2.2.
 */
export const MAX_RECOVERY_VERSIONS = 50;

/**
 * Discriminated union returned by {@link walkVersionsForDocId}. The
 * `versionsInspected` count is included on both branches so the audit
 * envelope (`doc_id_recovered`) and the unrecoverable error message
 * can both surface the actual walk depth without re-counting.
 */
export type DocIdRecoveryResult =
  | {
      kind: "found";
      docId: string;
      recoveredFrom: string;
      versionsInspected: number;
    }
  | {
      kind: "exhausted";
      versionsInspected: number;
    };

/**
 * Walk the `/versions` history of an authoritative file looking for
 * the most recent version whose collab frontmatter parses cleanly and
 * carries a `doc_id`.
 *
 * The walk is sequential by design — the typical case is 1–2 GETs (the
 * most recent version usually still has frontmatter). Parallelising
 * would spend bandwidth on versions we never read.
 *
 * Per-version errors (4 MiB cap, 404 for a vanished version, malformed
 * frontmatter) are logged and skipped — recovery is best-effort across
 * the history. The signal is checked at the top of every iteration so
 * an aborted walk surfaces immediately rather than completing the
 * current GET first.
 */
export async function walkVersionsForDocId(
  client: GraphClient,
  itemId: ValidatedGraphId,
  signal: AbortSignal,
): Promise<DocIdRecoveryResult> {
  const versions = await listDriveItemVersions(client, itemId, signal);
  const slice = versions.slice(0, MAX_RECOVERY_VERSIONS);
  let inspected = 0;
  for (const version of slice) {
    if (signal.aborted) throw signal.reason as Error;
    inspected++;
    let validatedVersionId: ValidatedGraphId;
    try {
      validatedVersionId = validateGraphId("version.id", version.id);
    } catch (err) {
      logger.debug("doc_id recovery: skipping malformed version id", {
        itemId,
        versionId: version.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    let content: string;
    try {
      content = await downloadDriveItemVersionContent(client, itemId, validatedVersionId, signal);
    } catch (err: unknown) {
      // Real OneDrive returns 400 for the current version's content
      // endpoint and 404 if the version vanished between list and
      // fetch. The 4 MiB cap throws `MarkdownFileTooLargeError`. All
      // are non-fatal for the walk — try the next version.
      if (err instanceof GraphRequestError && (err.statusCode === 400 || err.statusCode === 404)) {
        logger.debug("doc_id recovery: version content unavailable", {
          itemId,
          versionId: version.id,
          status: err.statusCode,
        });
        continue;
      }
      if (err instanceof MarkdownFileTooLargeError) {
        logger.debug("doc_id recovery: version exceeds size cap", {
          itemId,
          versionId: version.id,
          bytes: err.sizeBytes,
        });
        continue;
      }
      throw err;
    }

    const result = readMarkdownFrontmatter(content);
    if (result.kind === "parsed" && result.frontmatter.collab.doc_id.length > 0) {
      return {
        kind: "found",
        docId: result.frontmatter.collab.doc_id,
        recoveredFrom: version.id,
        versionsInspected: inspected,
      };
    }
  }
  return { kind: "exhausted", versionsInspected: inspected };
}
