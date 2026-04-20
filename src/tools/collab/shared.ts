// Shared helpers for the collab MCP tool family. Pure code-organisation
// extract from `src/tools/collab.ts` (W4 buffer refactor — see
// `docs/plans/collab-v1-progress.md`); no behaviour change.
//
// This module owns the lightweight pieces that every collab tool
// touches: the static {@link ToolDef} entries (re-exported from
// `./index.ts` as `COLLAB_TOOL_DEFS`), the cross-tool errors
// ({@link SessionExpiredError}, {@link FileNotFoundError},
// {@link PathLayoutViolationError}), the §3.6 audit-enum mapping
// helpers, the session/scope plumbing
// ({@link requireActiveSession}, {@link scopeCheckedResolve}), the
// output formatters, and the path/MIME helpers. The heavier
// orchestration helpers (re-prompt forms, authoritative-write
// surgery, the proposal-write helper) live in `./ops.ts`.

import type { ServerConfig } from "../../index.js";
import type { ToolDef } from "../../tool-registry.js";
import { GraphScope } from "../../scopes.js";
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum total entries returned by `collab_list_files` (§2.3). */
export const LIST_FILES_BREADTH_CAP = 500;

/** Sentinel folder name, excluded from ROOT listing. */
export const SENTINEL_FOLDER_NAME = ".collab";

/** Folder name used by the proposal-write helpers (matches §4.6 layout). */
export const PROPOSALS_FOLDER_NAME = "proposals";

/**
 * Maximum attempts to mint a non-colliding proposal id before raising
 * `ProposalIdCollisionError`. ULIDs are 80 bits of randomness, so one
 * attempt is overwhelmingly enough; the retry budget exists for
 * defence in depth (e.g. a misbehaving cooperator pre-creating files
 * matching newly-minted ids) and for telemetry.
 */
export const PROPOSAL_ID_RETRY_LIMIT = 3;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const COLLAB_READ_DEF: ToolDef = {
  name: "collab_read",
  title: "Read Collab File",
  description:
    "Read any file inside the active project's scope. Provide either `path` " +
    "(scope-relative, e.g. 'spec.md', 'proposals/foo.md', 'attachments/img.png') " +
    "or `itemId` (from a previous collab_list_files). Exactly one is required. " +
    "For the authoritative markdown file, the response includes parsed frontmatter " +
    "and body separately. For other files, returns raw content with cTag/size/modified. " +
    "Files larger than 4 MiB return an error (graphdo-ts tool-side limit).",
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const COLLAB_LIST_FILES_DEF: ToolDef = {
  name: "collab_list_files",
  title: "List Collab Project Files",
  description:
    "List files in the active project folder, grouped into ROOT, PROPOSALS, " +
    "DRAFTS, and ATTACHMENTS. The authoritative markdown file is marked with " +
    "[authoritative]. The .collab/ sentinel folder is excluded. Accepts an " +
    "optional prefix filter: '/' (all), '/proposals', '/drafts', '/attachments'. " +
    "Total entries are capped at 500; on overflow the response shows which " +
    "groups were truncated.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const COLLAB_WRITE_DEF: ToolDef = {
  name: "collab_write",
  title: "Write Collab File",
  description:
    "Create or update a file inside the active project's scope. Provide " +
    "`path` (scope-relative — `<authoritativeFile>.md` for the authoritative " +
    "file, `proposals/foo.md`, `drafts/scratch.md`, `attachments/img.png`), " +
    "`content` (UTF-8 text, ≤ 4 MiB), and `source` (where the content came " +
    "from: 'chat' = the human typed it this turn; 'project' = read via " +
    "collab_read in this session; 'external' = anything else, which triggers " +
    "a browser re-approval before the write is issued). For existing files " +
    "supply the `cTag` returned by collab_read for optimistic concurrency. " +
    "On the authoritative file the canonical YAML `collab:` frontmatter " +
    "block is re-injected (recovering `doc_id` from local cache when the " +
    "human stripped it); the body is taken from the supplied content (with " +
    "the agent-supplied frontmatter winning when present and parseable).",
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const COLLAB_CREATE_PROPOSAL_DEF: ToolDef = {
  name: "collab_create_proposal",
  title: "Create Section Proposal",
  description:
    "Propose a replacement body for one section of the authoritative file " +
    "without overwriting it. Writes the proposed body to " +
    "`/proposals/<ulid>.md` and records a `proposals[]` entry in the " +
    "authoritative frontmatter (target_section_slug + " +
    "target_section_content_hash_at_create — the latter survives heading " +
    "renames between create and apply). Counts as 1 write toward the " +
    "session budget. Provide `targetSectionId` (raw heading text or " +
    "pre-computed slug), `body` (proposed section markdown), `source` " +
    "(same enum as collab_write — 'external' triggers a browser " +
    "re-approval), and `authoritativeCTag` (from collab_read). Errors: " +
    "SectionAnchorLostError (target slug does not match any current " +
    "heading), CollabCTagMismatchError, BudgetExhaustedError, " +
    "ExternalSourceDeclinedError, ProposalIdCollisionError.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const COLLAB_APPLY_PROPOSAL_DEF: ToolDef = {
  name: "collab_apply_proposal",
  title: "Apply Section Proposal",
  description:
    "Merge a previously-created proposal into the authoritative file. " +
    "Locates the target section by slug first, falling back to the " +
    "content hash recorded at create time (so a rename between create " +
    "and apply is recovered automatically and audited as " +
    "slug_drift_resolved). The §3.1 authorship trail is consulted to " +
    "decide whether the apply is destructive — if any prior author of " +
    "the target section is a human or a different agent, a browser " +
    "re-approval form is opened showing a unified diff of the change. " +
    "On approve, the section body is replaced, an `authorship[]` entry " +
    "is appended, and the matching `proposals[]` entry is marked " +
    "`applied`; the file is CAS-written with the supplied " +
    "`authoritativeCTag`. Counts toward the write budget always and " +
    "toward the destructive-approval budget when the apply was " +
    "destructive. Errors: ProposalNotFoundError, " +
    "ProposalAlreadyAppliedError, SectionAnchorLostError, " +
    "CollabCTagMismatchError, BudgetExhaustedError, " +
    "DestructiveBudgetExhaustedError, DestructiveApprovalDeclinedError.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const COLLAB_ACQUIRE_SECTION_DEF: ToolDef = {
  name: "collab_acquire_section",
  title: "Acquire Section Lease",
  description:
    "Lease a section of the authoritative file so cooperating agents avoid " +
    "concurrent writes to the same heading. Free — does not count toward the " +
    "session write budget. Section identity is the GitHub-flavored heading " +
    "slug; pass either the raw heading text ('## Introduction') or a " +
    "pre-computed slug ('introduction'). The leases sidecar lives at " +
    "`.collab/leases.json` and is created lazily on first acquire. Supply " +
    "`leasesCTag` (from session_status). Returns the slug, lease expiry, " +
    "and the new leases-file cTag for the next acquire/release. Errors: " +
    "SectionNotFoundError, SectionAlreadyLeasedError (carries holder + " +
    "expiresAt), CollabCTagMismatchError (re-read leasesCTag and retry).",
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const COLLAB_RELEASE_SECTION_DEF: ToolDef = {
  name: "collab_release_section",
  title: "Release Section Lease",
  description:
    "Release a previously-acquired section lease. Free. No-op when the lease " +
    "is already absent (gracefully degraded — the leases sidecar may have " +
    "been deleted or expired). Refuses with LeaseNotHeldError when the lease " +
    "exists but is held by a different agent — releasing somebody else's " +
    "lease is rejected. Supply `leasesCTag` (from session_status) for the " +
    "byId CAS replace.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const COLLAB_LIST_VERSIONS_DEF: ToolDef = {
  name: "collab_list_versions",
  title: "List Collab File Versions",
  description:
    "List historical versions of a file in the active project's scope, " +
    "newest first. Provide either `path` (scope-relative) or `itemId` " +
    "(from collab_list_files); when both are omitted the authoritative " +
    "file is used. Read-only — does not count toward the write or " +
    "destructive-approval budget. Each entry reports the opaque versionId, " +
    "size, and last-modified timestamp; pass the versionId to " +
    "collab_restore_version to roll the file back to that revision.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const COLLAB_RESTORE_VERSION_DEF: ToolDef = {
  name: "collab_restore_version",
  title: "Restore Collab File Version",
  description:
    "Roll a file in the active project back to a previous revision via " +
    "OneDrive's restoreVersion API. Provide `versionId` (from " +
    "collab_list_versions) plus either `path` (scope-relative) or " +
    "`itemId`; defaults to the authoritative file when both are omitted. " +
    "When the target is the authoritative file the restore is destructive: " +
    "a browser re-approval form is opened showing a unified diff between " +
    "the current and the target revision; on approve the destructive " +
    "budget is decremented. Counts as 1 write toward the session budget " +
    "always. The authoritative file also requires `authoritativeCTag` " +
    "(from collab_read) for optimistic-concurrency safety: a stale cTag " +
    "raises CollabCTagMismatchError before the restore is issued.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const COLLAB_DELETE_FILE_DEF: ToolDef = {
  name: "collab_delete_file",
  title: "Delete Collab File",
  description:
    "Permanently delete a non-authoritative file inside the active " +
    "project's scope. Always destructive: a browser re-approval form is " +
    "opened for every call and the destructive-approval budget is " +
    "decremented on approve. Counts as 1 write toward the session " +
    "budget. Accepts `path` (scope-relative — `proposals/<...>.md`, " +
    "`drafts/<...>.md`, `attachments/<...>`); the authoritative `.md` " +
    "file and the `.collab/` sentinel folder are always refused. " +
    "Errors: RefuseDeleteAuthoritativeError, RefuseDeleteSentinelError, " +
    "OutOfScopeError, FileNotFoundError, BudgetExhaustedError, " +
    "DestructiveBudgetExhaustedError, DestructiveApprovalDeclinedError.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

/** Static tool metadata for collab tools. */
export const COLLAB_TOOL_DEFS: readonly ToolDef[] = [
  COLLAB_READ_DEF,
  COLLAB_LIST_FILES_DEF,
  COLLAB_WRITE_DEF,
  COLLAB_CREATE_PROPOSAL_DEF,
  COLLAB_APPLY_PROPOSAL_DEF,
  COLLAB_ACQUIRE_SECTION_DEF,
  COLLAB_RELEASE_SECTION_DEF,
  COLLAB_LIST_VERSIONS_DEF,
  COLLAB_RESTORE_VERSION_DEF,
  COLLAB_DELETE_FILE_DEF,
];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Error raised when session TTL has expired. */
export class SessionExpiredError extends Error {
  constructor() {
    super(
      "The active collab session has expired. " +
        "Call session_renew to extend the TTL, or start a new session.",
    );
    this.name = "SessionExpiredError";
  }
}

/** Error raised when a file is not found (404 from Graph). */
export class FileNotFoundError extends Error {
  constructor(
    public readonly path: string,
    public readonly itemId?: string,
  ) {
    super(`File not found: ${path}${itemId ? ` (itemId: ${itemId})` : ""}`);
    this.name = "FileNotFoundError";
  }
}

/** Error raised when path lands somewhere other than the allowed locations. */
export class PathLayoutViolationError extends Error {
  constructor(public readonly path: string) {
    super(
      `Path "${path}" does not match the allowed layout (root .md, proposals/, drafts/, attachments/).`,
    );
    this.name = "PathLayoutViolationError";
  }
}

/**
 * Raised by `collab_delete_file` when the caller targets the pinned
 * authoritative markdown file. The authoritative file is the
 * project's identity — deletion is never allowed, even with an
 * explicit destructive approval. Plain `Error` per §2.5.
 */
export class RefuseDeleteAuthoritativeError extends Error {
  constructor(public readonly path: string) {
    super(
      `Refusing to delete the authoritative file "${path}". The authoritative file ` +
        "is the project's identity and cannot be removed via collab_delete_file.",
    );
    this.name = "RefuseDeleteAuthoritativeError";
  }
}

/**
 * Raised by `collab_delete_file` when the caller targets the
 * `.collab/` sentinel folder or anything inside it. The sentinel
 * carries `project.json` and `leases.json`; removing either would
 * invalidate every active session. Plain `Error` per §2.5.
 */
export class RefuseDeleteSentinelError extends Error {
  constructor(public readonly path: string) {
    super(
      `Refusing to delete "${path}" — paths inside the .collab/ sentinel folder ` +
        "are protected. Use session_open_project on a fresh folder if the project is abandoned.",
    );
    this.name = "RefuseDeleteSentinelError";
  }
}

// ---------------------------------------------------------------------------
// Audit-enum mapping helpers
// ---------------------------------------------------------------------------

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
  const token = await config.authenticator.token(signal);
  const client = new GraphClient(config.graphBaseUrl, {
    getToken: () => Promise.resolve(token),
  });

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

  const token = await config.authenticator.token(signal);
  const client = new GraphClient(config.graphBaseUrl, {
    getToken: () => Promise.resolve(token),
  });

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
