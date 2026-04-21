// `session_recover_doc_id` runner. Split out from `./session.ts`.

import { DocIdAlreadyKnownError, DocIdUnrecoverableError } from "../errors.js";
import type { ServerConfig } from "../index.js";
import { validateGraphId } from "../graph/ids.js";
import { downloadMarkdownContent } from "../graph/markdown.js";

import { walkVersionsForDocId, MAX_RECOVERY_VERSIONS } from "../collab/doc-id-recovery.js";
import { readMarkdownFrontmatter } from "../collab/frontmatter.js";
import { loadProjectMetadata, saveProjectMetadata } from "../collab/projects.js";
import { writeAudit, AuditResult } from "../collab/audit.js";
import { NoActiveSessionError } from "../collab/session.js";

export async function runSessionRecoverDocId(
  config: ServerConfig,
  signal: AbortSignal,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const snap = config.sessionRegistry.snapshot();
  if (snap === null) {
    throw new NoActiveSessionError();
  }
  if (config.sessionRegistry.isExpired()) {
    // Mirror the typed error other collab tools surface so the agent
    // gets a uniform "renew first" experience.
    throw new Error(
      "The active collab session has expired. " +
        "Call session_renew to extend the TTL, or start a new session.",
    );
  }

  const metadata = await loadProjectMetadata(config.configDir, snap.projectId, signal);
  if (metadata === null) {
    throw new Error(
      `Project metadata not found for projectId ${snap.projectId}. ` +
        "This is unexpected — the session was started without persisting metadata.",
    );
  }

  const client = config.graphClient;
  const authoritativeItemId = validateGraphId(
    "pinnedAuthoritativeFileId",
    metadata.pinnedAuthoritativeFileId,
  );

  // Read the live content so we can short-circuit the no-op case
  // (live frontmatter parses + cache already has the same docId)
  // before spending any version GETs.
  const liveContent = await downloadMarkdownContent(client, authoritativeItemId, signal);
  const liveRead = readMarkdownFrontmatter(liveContent);
  if (
    liveRead.kind === "parsed" &&
    metadata.docId !== null &&
    metadata.docId === liveRead.frontmatter.collab.doc_id
  ) {
    throw new DocIdAlreadyKnownError(metadata.docId);
  }

  // Walk newest-first looking for a parseable historical version.
  const result = await walkVersionsForDocId(client, authoritativeItemId, signal);
  if (result.kind === "exhausted") {
    throw new DocIdUnrecoverableError(metadata.projectId, result.versionsInspected);
  }

  // Persist the recovered docId. No other field changes — the live
  // file's body, cTag, and revision are untouched.
  await saveProjectMetadata(config.configDir, { ...metadata, docId: result.docId }, signal);

  // §3.6 audit. Best-effort — the writer swallows failures.
  await writeAudit(
    config,
    {
      sessionId: snap.sessionId,
      agentId: snap.agentId,
      userOid: snap.userOid,
      projectId: snap.projectId,
      tool: "session_recover_doc_id",
      result: AuditResult.Success,
      type: "doc_id_recovered",
      details: {
        recoveredFrom: result.recoveredFrom,
        versionsInspected: result.versionsInspected,
      },
    },
    signal,
  );

  const lines = [
    "doc_id recovered.",
    `  doc_id: ${result.docId}`,
    `  recoveredFrom: version ${result.recoveredFrom}`,
    `  versionsInspected: ${result.versionsInspected} (cap ${MAX_RECOVERY_VERSIONS})`,
    "",
    "Local project metadata updated. The next collab_write to the " +
      "authoritative file will re-inject this doc_id into the emitted " +
      "frontmatter envelope.",
  ];
  return { content: [{ type: "text", text: lines.join("\n") }] };
}
