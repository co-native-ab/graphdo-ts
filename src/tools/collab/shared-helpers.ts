// Audit-enum mapping helpers, cTag → revision, session/scope plumbing,
// output formatters, path/MIME helpers, and `resolveTargetItem` /
// `uniqueAuthorLabels`. Split out from `./shared.ts`; re-exported
// through the barrel.

import type { ServerConfig } from "../../index.js";
import { GraphClient } from "../../graph/client.js";
import { validateGraphId, type ValidatedGraphId } from "../../graph/ids.js";
import type { DriveItem } from "../../graph/types.js";
import { OutOfScopeError } from "../../errors.js";
import { NoActiveSessionError } from "../../collab/session.js";
import { loadProjectMetadata } from "../../collab/projects.js";
import {
  COLLAB_CONTENT_TYPE_BINARY,
  COLLAB_CONTENT_TYPE_JSON,
  COLLAB_CONTENT_TYPE_MARKDOWN,
  createChildFolder,
  findChildFolderByName,
  getDriveItem,
} from "../../collab/graph.js";
import { MAX_ANCESTRY_HOPS, resolveScopedPath } from "../../collab/scope.js";
import {
  AuditConflictMode,
  AuditFrontmatterResetReason,
  AuditWriteSource,
} from "../../collab/audit.js";
import type { CollabFrontmatter, FrontmatterResetReason } from "../../collab/frontmatter.js";

import { SessionExpiredError } from "./shared-errors.js";

/**
 * Map the canonical {@link FrontmatterResetReason} string union onto the
 * audit enum so the writer's discriminated-union schema accepts the
 * value without losing the string-equality contract.
 */
export function toAuditResetReason(reason: FrontmatterResetReason): AuditFrontmatterResetReason {
  return reason === "missing"
    ? AuditFrontmatterResetReason.Missing
    : AuditFrontmatterResetReason.Malformed;
}

/** Map the zod-typed `source` literal onto the audit enum. */
export function toAuditWriteSource(source: "chat" | "project" | "external"): AuditWriteSource {
  switch (source) {
    case "chat":
      return AuditWriteSource.Chat;
    case "project":
      return AuditWriteSource.Project;
    case "external":
      return AuditWriteSource.External;
  }
}

/** Map the zod-typed `conflictMode` literal onto the audit enum. */
export function toAuditConflictMode(mode: "fail" | "proposal"): AuditConflictMode {
  return mode === "fail" ? AuditConflictMode.Fail : AuditConflictMode.Proposal;
}

// ---------------------------------------------------------------------------
// cTag → revision
// ---------------------------------------------------------------------------

/**
 * Extract the integer revision number from a OneDrive cTag.
 *
 * OneDrive cTags have the shape `"{<guid>,<revision>}"` (quoted), e.g.
 * `"{8B6E5C0E-1234-...,17}"`. The revision suffix increments on every
 * content write. We surface it in the `collab_read` envelope (§2.3) as
 * `revision: <n>` so the agent can correlate reads with later
 * `collab_write` cTag-mismatch errors. Returns `0` when the cTag is
 * missing or doesn't match the expected shape (defensive — the value
 * is informational, not load-bearing).
 */
export function extractRevisionFromCTag(cTag: string | undefined): number {
  if (cTag === undefined) return 0;
  const match = /,(\d+)"/.exec(cTag);
  if (match?.[1] === undefined) return 0;
  return parseInt(match[1], 10);
}

// ---------------------------------------------------------------------------
// Session + scope plumbing
// ---------------------------------------------------------------------------

/** Convenience type alias for the in-memory session snapshot. */
export type SessionSnapshot = NonNullable<ReturnType<ServerConfig["sessionRegistry"]["snapshot"]>>;

/** Convenience type alias for project metadata loaded off disk. */
export type ProjectMetadata = NonNullable<Awaited<ReturnType<typeof loadProjectMetadata>>>;

/**
 * Require an active, non-expired session. Returns the session snapshot and
 * the project metadata. Throws `NoActiveSessionError` or `SessionExpiredError`.
 */
export async function requireActiveSession(
  config: ServerConfig,
  signal: AbortSignal,
): Promise<{
  session: SessionSnapshot;
  metadata: ProjectMetadata;
}> {
  const session = config.sessionRegistry.snapshot();
  if (session === null) {
    throw new NoActiveSessionError();
  }
  if (config.sessionRegistry.isExpired()) {
    throw new SessionExpiredError();
  }

  const metadata = await loadProjectMetadata(config.configDir, session.projectId, signal);
  if (metadata === null) {
    throw new Error(
      `Project metadata not found for projectId ${session.projectId}. ` +
        "This is unexpected — the session was started without persisting metadata.",
    );
  }

  return { session, metadata };
}

/**
 * Wrap `resolveScopedPath` and convert errors into the standard tool error envelope.
 * Used by tool handlers to enforce scope before proceeding with Graph operations.
 */
export async function scopeCheckedResolve(
  config: ServerConfig,
  metadata: ProjectMetadata,
  path: string,
  signal: AbortSignal,
): Promise<DriveItem> {
  const client = config.graphClient;

  const result = await resolveScopedPath(
    client,
    {
      projectFolderId: validateGraphId("projectFolderId", metadata.folderId),
      driveId: metadata.driveId,
      authoritativeFileName: metadata.displayAuthoritativeFileName,
      path,
    },
    signal,
  );
  return result.item;
}

// ---------------------------------------------------------------------------
// Output formatters
// ---------------------------------------------------------------------------

/**
 * Format a DriveItem into the non-authoritative read output shape,
 * mirroring `markdown_get_file` output.
 */
export function formatNonAuthoritativeRead(item: DriveItem, content: string): string {
  const lines = [
    `file: ${item.name} (${item.id})`,
    `size: ${item.size ?? Buffer.byteLength(content, "utf-8")} bytes`,
    `modified: ${item.lastModifiedDateTime ?? "unknown"}`,
    `cTag: ${item.cTag ?? "unknown"}`,
    `---BODY---`,
    content,
  ];
  return lines.join("\n");
}

/**
 * Format a DriveItem + parsed frontmatter into the authoritative read output shape.
 */
export function formatAuthoritativeRead(
  item: DriveItem,
  frontmatter: CollabFrontmatter | null,
  body: string,
  revision: number,
): string {
  const lines = [
    `file: ${item.name} (${item.id})`,
    `size: ${item.size ?? Buffer.byteLength(body, "utf-8")} bytes`,
    `modified: ${item.lastModifiedDateTime ?? "unknown"}`,
    `revision: ${revision}`,
    `cTag: ${item.cTag ?? "unknown"}`,
    `isAuthoritative: true`,
    `---FRONTMATTER (parsed)---`,
    frontmatter !== null ? JSON.stringify(frontmatter, null, 2) : "null (not parsed / reset)",
    `---BODY---`,
    body,
  ];
  return lines.join("\n");
}

/** Format a file size for display (KB or bytes). */
export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "? KB";
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} bytes`;
}

// ---------------------------------------------------------------------------
// Path / MIME helpers
// ---------------------------------------------------------------------------

/**
 * Pick a Content-Type for a project file based on its leaf name. Used by
 * the non-authoritative `collab_write` path so .md / .json / image /
 * binary attachments all carry the right MIME on PUT. Authoritative
 * writes are always `text/markdown` (`writeAuthoritative` hard-codes it).
 *
 * Common image extensions are recognised explicitly so OneDrive previews
 * (and any downstream tool that reads `file.mimeType`) work without an
 * extra round-trip. Anything unknown falls through to
 * `application/octet-stream` — Graph re-detects from the bytes anyway,
 * but a generic MIME is safer than guessing.
 */
export function contentTypeForFileName(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return COLLAB_CONTENT_TYPE_MARKDOWN;
  }
  if (lower.endsWith(".json")) {
    return COLLAB_CONTENT_TYPE_JSON;
  }
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return COLLAB_CONTENT_TYPE_BINARY;
}

/**
 * Split a scope-relative path into its parent folder segments and leaf
 * name. The leading `/` (if any) is stripped first. Used by the
 * non-authoritative `collab_write` path to locate the parent folder for
 * a byPath create.
 */
export function splitScopedPath(path: string): { parentSegments: string[]; leafName: string } {
  const trimmed = path.startsWith("/") ? path.slice(1) : path;
  const segments = trimmed.split("/").filter((s) => s.length > 0);
  const leafName = segments.pop() ?? "";
  return { parentSegments: segments, leafName };
}

/**
 * Resolve (or lazily create) the parent folder for a non-authoritative
 * write under one of the well-known group folders (`proposals`,
 * `drafts`, `attachments`). The §4.6 scope resolver has already
 * validated that the path's first segment is one of those names, so we
 * walk a bounded number of levels and `mkdir -p` along the way.
 *
 * Returns the parent folder's drive id ready for a byPath
 * `writeProjectFile({ kind: "create" })`.
 */
export async function ensureParentFolder(
  client: GraphClient,
  rootFolderId: ValidatedGraphId,
  parentSegments: string[],
  signal: AbortSignal,
): Promise<ValidatedGraphId> {
  let cursor: ValidatedGraphId = rootFolderId;
  for (const segment of parentSegments) {
    const existing = await findChildFolderByName(client, cursor, segment, signal);
    const child = existing ?? (await createChildFolder(client, cursor, segment, signal));
    cursor = validateGraphId(`folder:${segment}`, child.id);
  }
  return cursor;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a `path` / `itemId` argument pair to a {@link DriveItem}.
 *
 * Used by the version tools (`collab_list_versions`,
 * `collab_restore_version`) where addressing is interchangeable and
 * defaults to the authoritative file when both are omitted. The return
 * value carries `isAuthoritative` so the caller can apply the
 * destructive-budget rules without a second comparison.
 *
 * `path` runs the full §4.6 scope algorithm via
 * {@link scopeCheckedResolve}. `itemId` runs a lightweight ancestry
 * walk capped at {@link import("../../collab/scope.js").MAX_ANCESTRY_HOPS}
 * (matches the in-line check in `collab_read`). When both are
 * undefined / empty the authoritative file is fetched directly via
 * `getDriveItem` against the pinned id in the project metadata.
 */
export async function resolveTargetItem(
  config: ServerConfig,
  metadata: ProjectMetadata,
  args: { path?: string; itemId?: string },
  signal: AbortSignal,
): Promise<{ item: DriveItem; isAuthoritative: boolean }> {
  const { path, itemId } = args;
  const hasPath = path !== undefined && path !== "";
  const hasItemId = itemId !== undefined && itemId !== "";
  if (hasPath && hasItemId) {
    throw new Error("Provide either 'path' or 'itemId', not both.");
  }

  if (hasPath) {
    const item = await scopeCheckedResolve(config, metadata, path, signal);
    return { item, isAuthoritative: item.id === metadata.pinnedAuthoritativeFileId };
  }

  const client = config.graphClient;

  if (!hasItemId) {
    // Default to the authoritative file.
    const validatedAuthoritative = validateGraphId(
      "pinnedAuthoritativeFileId",
      metadata.pinnedAuthoritativeFileId,
    );
    const item = await getDriveItem(client, validatedAuthoritative, signal);
    return { item, isAuthoritative: true };
  }

  // itemId path — walk parentReference up to the project folder so the
  // §4.6 scope guarantee holds even when the agent skips the path
  // resolver. Hop cap matches `collab_read`'s in-line walk.
  const validatedItemId = validateGraphId("itemId", itemId);
  const item = await getDriveItem(client, validatedItemId, signal);
  const projectFolderId = metadata.folderId;
  let cursorParentId: string | undefined = item.parentReference?.id;
  let foundAncestor = false;
  for (let hop = 0; hop < MAX_ANCESTRY_HOPS && cursorParentId !== undefined; hop++) {
    if (cursorParentId === projectFolderId) {
      foundAncestor = true;
      break;
    }
    const parent = await getDriveItem(client, validateGraphId("parentId", cursorParentId), signal);
    cursorParentId = parent.parentReference?.id;
  }
  if (!foundAncestor) {
    throw new OutOfScopeError(`itemId:${itemId}`, "ancestry_escape", item.id);
  }
  return { item, isAuthoritative: item.id === metadata.pinnedAuthoritativeFileId };
}

/**
 * Build a deduplicated list of human-readable labels for the prior
 * authors that triggered a destructive classification. Used by the
 * destructive re-prompt form in `./ops.ts` so the form summary tells
 * the human who last touched the section. The label format is
 * `<kind>:<display_name>` (e.g. `human:alice@example.com`,
 * `agent:graphdo-ts-anthropic-12345`); we keep the kind so a human
 * reviewer can spot agent-vs-human authorship at a glance.
 */
export function uniqueAuthorLabels(
  authors: readonly { author_kind: string; author_display_name: string }[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of authors) {
    const label = `${a.author_kind}:${a.author_display_name}`;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}
