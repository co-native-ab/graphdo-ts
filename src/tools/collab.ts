// MCP tools for the collab v1 file/section operations: read, list, write,
// section leases, proposals, etc. (`docs/plans/collab-v1.md` §2.3).
//
// W2 Day 4 lands:
//   - `collab_read` — read any file inside project scope (§2.3).
//   - `collab_list_files` — directory listing with `[authoritative]` marker.
//
// W3 Day 2 lands:
//   - `collab_write` — CAS write to authoritative or project-scoped files
//     with `source` parameter and external-source re-prompt (§2.3, §5.2.4).
//
// Section leases land in W3 Day 4; proposals and destructive apply in
// W4 Days 2–3.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  AuthenticationRequiredError,
  BudgetExhaustedError,
  CollabCTagMismatchError,
  DocIdRecoveryRequiredError,
  ExternalSourceDeclinedError,
  OutOfScopeError,
  UserCancelledError,
} from "../errors.js";
import type { ServerConfig } from "../index.js";
import { logger } from "../logger.js";
import type { ToolDef, ToolEntry } from "../tool-registry.js";
import { defineTool } from "../tool-registry.js";
import { GraphScope } from "../scopes.js";
import { GraphClient, GraphRequestError } from "../graph/client.js";
import { validateGraphId, type ValidatedGraphId } from "../graph/ids.js";
import { MarkdownFileTooLargeError } from "../graph/markdown.js";
import { NoActiveSessionError } from "../collab/session.js";
import { loadProjectMetadata, saveProjectMetadata } from "../collab/projects.js";
import { newUlid } from "../collab/ulid.js";
import {
  getDriveItem,
  getDriveItemContent,
  listChildren,
  findChildFolderByName,
  walkAttachmentsTree,
  createChildFolder,
  writeAuthoritative,
  writeProjectFile,
  ProjectFileAlreadyExistsError,
  COLLAB_CONTENT_TYPE_MARKDOWN,
  COLLAB_CONTENT_TYPE_JSON,
  COLLAB_CONTENT_TYPE_BINARY,
  type WriteProjectFileTarget,
} from "../collab/graph.js";
import { resolveScopedPath, MAX_ANCESTRY_HOPS } from "../collab/scope.js";
import {
  CollabFrontmatterSchema,
  joinFrontmatter,
  readMarkdownFrontmatter,
  serializeFrontmatter,
  splitFrontmatter,
  type CollabFrontmatter,
  type FrontmatterResetAudit,
} from "../collab/frontmatter.js";
import { writeAudit, type AuditInputSummary } from "../collab/audit.js";
import { parse as yamlParseRaw } from "yaml";
import { startBrowserPicker } from "../picker.js";
import { acquireFormSlot } from "./collab-forms.js";
import { formatError } from "./shared.js";
import type { DriveItem } from "../graph/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum total entries returned by `collab_list_files` (§2.3). */
const LIST_FILES_BREADTH_CAP = 500;

/** Sentinel folder name, excluded from ROOT listing. */
const SENTINEL_FOLDER_NAME = ".collab";

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
function extractRevisionFromCTag(cTag: string | undefined): number {
  if (cTag === undefined) return 0;
  const match = /,(\d+)"/.exec(cTag);
  if (match?.[1] === undefined) return 0;
  return parseInt(match[1], 10);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const COLLAB_READ_DEF: ToolDef = {
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

const COLLAB_LIST_FILES_DEF: ToolDef = {
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

const COLLAB_WRITE_DEF: ToolDef = {
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

/** Static tool metadata for collab tools. */
export const COLLAB_TOOL_DEFS: readonly ToolDef[] = [
  COLLAB_READ_DEF,
  COLLAB_LIST_FILES_DEF,
  COLLAB_WRITE_DEF,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Require an active, non-expired session. Returns the session snapshot and
 * the project metadata. Throws `NoActiveSessionError` or `SessionExpiredError`.
 */
async function requireActiveSession(
  config: ServerConfig,
  signal: AbortSignal,
): Promise<{
  session: NonNullable<ReturnType<typeof config.sessionRegistry.snapshot>>;
  metadata: NonNullable<Awaited<ReturnType<typeof loadProjectMetadata>>>;
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
async function scopeCheckedResolve(
  config: ServerConfig,
  metadata: NonNullable<Awaited<ReturnType<typeof loadProjectMetadata>>>,
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

/**
 * Format a DriveItem into the non-authoritative read output shape,
 * mirroring `markdown_get_file` output.
 */
function formatNonAuthoritativeRead(item: DriveItem, content: string): string {
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
function formatAuthoritativeRead(
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
function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "? KB";
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} bytes`;
}

// ---------------------------------------------------------------------------
// collab_write helpers
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
function contentTypeForFileName(fileName: string): string {
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
function splitScopedPath(path: string): { parentSegments: string[]; leafName: string } {
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
async function ensureParentFolder(
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

/**
 * Open the §5.2.4 external-source re-approval form. Acquires the
 * single-in-flight form-factory slot for the duration; resolves on
 * approve, throws {@link ExternalSourceDeclinedError} on cancel /
 * timeout / browser close.
 */
async function runExternalSourceReprompt(
  config: ServerConfig,
  args: {
    path: string;
    intent: string | undefined;
    sourceCounters: { external: number };
    isCreate: boolean;
    bytes: number;
  },
  signal: AbortSignal,
): Promise<void> {
  const slot = acquireFormSlot("collab_write_external");
  try {
    const summaryLines = [
      `path: ${args.path}`,
      `intent: ${args.intent ?? "(not provided)"}`,
      `kind: ${args.isCreate ? "first write (new file)" : "update existing file"}`,
      `bytes: ${args.bytes}`,
      `external-source writes used this session: ${args.sourceCounters.external}`,
    ];
    const handle = await startBrowserPicker(
      {
        title: "Approve External-Source Write",
        subtitle:
          "An MCP tool wants to write content that did NOT come from this " +
          "chat or from a prior `collab_read`. Click Approve to allow the " +
          "write, or Cancel to refuse it.\n\n" +
          summaryLines.join("\n"),
        options: [{ id: "approve", label: "Approve external-source write" }],
        onSelect: async () => {
          // Approval is recorded by the tool layer once the picker
          // resolves; nothing to do here.
        },
      },
      signal,
    );
    slot.setUrl(handle.url);
    let browserOpened = false;
    try {
      await config.openBrowser(handle.url);
      browserOpened = true;
    } catch (err: unknown) {
      logger.warn("could not open browser for external-source re-prompt", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!browserOpened) {
      logger.info("external-source re-prompt awaiting manual visit", { url: handle.url });
    }

    try {
      await handle.waitForSelection;
    } catch (err: unknown) {
      if (err instanceof UserCancelledError) {
        throw new ExternalSourceDeclinedError(args.path);
      }
      throw err;
    }
  } finally {
    slot.release();
  }
}

/**
 * Pick (or mint) the canonical {@link CollabFrontmatter} block for a
 * write to the authoritative file. Encodes the §3.1 doc_id stability
 * rules:
 *
 * - Agent-supplied content already carries parseable frontmatter →
 *   that frontmatter wins. Validates against the schema; a malformed
 *   inner block falls through to the recovery path so the agent can
 *   never sneak past the schema by attaching a broken envelope.
 * - Otherwise look at the file's current live frontmatter:
 *   - parses → reuse `{doc_id, created_at}` and reset the lists.
 *   - reset (missing/malformed) → fall through to local cache.
 * - Otherwise local cache `docId` is non-null → reuse it,
 *   `created_at` defaults to `now()`.
 * - Otherwise → throw {@link DocIdRecoveryRequiredError} so the agent
 *   is directed at `session_recover_doc_id` (W5 Day 1).
 *
 * The returned `body` is the markdown body the caller should join the
 * canonical frontmatter back onto (always LF-normalised).
 *
 * Note: this milestone (W3 Day 2) does not preserve the
 * `sections`/`proposals`/`authorship` collections when the agent
 * supplied content without a frontmatter envelope — those fields
 * default to empty arrays. The fields are still preserved when the
 * agent's own frontmatter carries them. Section-aware writes land with
 * `collab_acquire_section` / `collab_create_proposal` in W3 Day 4 + W4.
 */
/**
 * Where the `doc_id` for an authoritative write came from. Returned by
 * {@link resolveAuthoritativeFrontmatter} so the W3 Day 3 audit writer
 * can record the recovery path that fired (parsed → no audit, anything
 * else → `frontmatter_reset` audit entry with `recoveredDocId: true`
 * for `Cache` / `Live` / `Fresh`).
 *
 * A real enum (vs. a string union) keeps the comparator readable and
 * matches the codebase convention set by {@link GraphScope},
 * {@link import("../graph/client.js").HttpMethod}, and
 * {@link import("../graph/markdown.js").MarkdownFolderEntryKind}.
 */
export enum DocIdSource {
  /** Agent supplied a parseable `collab:` frontmatter envelope. */
  Agent = "agent",
  /** Live file's frontmatter parsed cleanly. */
  Live = "live",
  /** Live frontmatter was missing/malformed; recovered from local pin block. */
  Cache = "cache",
  /** No agent / live / cache value — fresh ULID minted (originator first-write). */
  Fresh = "fresh",
}

function resolveAuthoritativeFrontmatter(args: {
  agentContent: string;
  liveContent: string;
  cachedDocId: string | null;
  projectId: string;
  now: () => Date;
}): {
  frontmatter: CollabFrontmatter;
  body: string;
  docIdSource: DocIdSource;
} {
  const split = splitFrontmatter(args.agentContent);
  if (split !== null) {
    const parseAttempt = CollabFrontmatterSchema.safeParse(parseYamlForFrontmatter(split.yaml));
    if (parseAttempt.success) {
      return {
        frontmatter: parseAttempt.data,
        body: split.body,
        docIdSource: DocIdSource.Agent,
      };
    }
    // Fall through — agent's envelope was unparseable; treat the body
    // alone as the new content and recover the doc_id from elsewhere.
    logger.warn("agent supplied unparseable frontmatter; falling back to recovery", {
      error: parseAttempt.error.message,
    });
  }
  const body = split !== null ? split.body : args.agentContent.replace(/\r\n/g, "\n");

  const liveRead = readMarkdownFrontmatter(args.liveContent);
  if (liveRead.kind === "parsed") {
    return {
      frontmatter: {
        collab: {
          version: liveRead.frontmatter.collab.version,
          doc_id: liveRead.frontmatter.collab.doc_id,
          created_at: liveRead.frontmatter.collab.created_at,
          sections: [],
          proposals: [],
          authorship: [],
        },
      },
      body,
      docIdSource: DocIdSource.Live,
    };
  }

  if (args.cachedDocId !== null) {
    return {
      frontmatter: buildFreshCollabFrontmatter(args.cachedDocId, args.now()),
      body,
      docIdSource: DocIdSource.Cache,
    };
  }

  // Originator's first write to a brand-new project: mint a fresh
  // doc_id and persist it so subsequent writes resolve via cache.
  // The §10 row-04 "fresh machine + wiped frontmatter + wiped cache"
  // variant is differentiated by the presence of /versions history
  // and is handled by `session_recover_doc_id` (W5 Day 1) — the
  // helper above always treats no-history as first-write here.
  const freshDocId = newUlid(() => args.now().getTime());
  return {
    frontmatter: buildFreshCollabFrontmatter(freshDocId, args.now()),
    body,
    docIdSource: DocIdSource.Fresh,
  };
}

/**
 * Mint a fresh canonical {@link CollabFrontmatter} for a brand-new
 * doc_id. Used by the recovery path and by first-write where neither
 * the agent nor the live file carry one.
 */
function buildFreshCollabFrontmatter(docId: string, now: Date): CollabFrontmatter {
  return {
    collab: {
      version: 1,
      doc_id: docId,
      created_at: now.toISOString(),
      sections: [],
      proposals: [],
      authorship: [],
    },
  };
}

/**
 * Lightweight YAML parse for the agent-supplied frontmatter envelope.
 * Returns `null` (so {@link CollabFrontmatterSchema.safeParse} fails)
 * when the YAML cannot be parsed at all. The hardened parser used by
 * `readMarkdownFrontmatter` is too strict for this path — it throws on
 * malformed input — and we want to silently recover instead of
 * surfacing a noisy parse error to the agent.
 */
function parseYamlForFrontmatter(yamlBody: string): unknown {
  try {
    return yamlParseRaw(yamlBody);
  } catch {
    return null;
  }
}

/**
 * Execute the authoritative-file write path: fetch the live content
 * (so we can recover `doc_id` / `created_at` if the agent's content
 * lacks frontmatter), build the canonical frontmatter envelope per
 * §3.1, and CAS-write via {@link writeAuthoritative}. Returns the
 * updated DriveItem so the caller can record the new cTag/revision.
 *
 * The local cache `docId` (when non-null) is the authoritative source
 * for recovery; the live file is consulted only as a secondary path
 * (the cache is updated on every successful write so it should never
 * be more stale than one write old).
 */
async function runAuthoritativeWrite(
  config: ServerConfig,
  client: GraphClient,
  metadata: NonNullable<Awaited<ReturnType<typeof loadProjectMetadata>>>,
  resolvedItem: DriveItem,
  cTag: string,
  agentContent: string,
  signal: AbortSignal,
): Promise<{
  updated: DriveItem;
  writtenDocId: string;
  frontmatterReset: FrontmatterResetAudit | null;
}> {
  const validatedItemId = validateGraphId("authoritativeItemId", resolvedItem.id);

  // Read live content for doc_id/created_at recovery. A 404 here is a
  // server-side race (the file vanished between scope resolution and
  // this fetch); surface it as a Graph error so the caller's error
  // formatter does the right thing.
  const liveContent = await getDriveItemContent(client, validatedItemId, signal);

  const now = config.now ?? ((): Date => new Date());
  const { frontmatter, body, docIdSource } = resolveAuthoritativeFrontmatter({
    agentContent,
    liveContent,
    cachedDocId: metadata.docId,
    projectId: metadata.projectId,
    now,
  });

  // Detect whether the live file's frontmatter was reset (missing /
  // malformed) so the §3.6 audit writer can record one
  // `frontmatter_reset` per write that recovered from the wipe. We
  // only re-read once — `readMarkdownFrontmatter` is pure — to keep
  // the helper's contract intact while still surfacing the reason.
  let frontmatterReset: FrontmatterResetAudit | null = null;
  if (docIdSource === DocIdSource.Cache || docIdSource === DocIdSource.Fresh) {
    const liveRead = readMarkdownFrontmatter(liveContent);
    if (liveRead.kind === "reset") {
      frontmatterReset = {
        reason: liveRead.reason,
        previousRevision: resolvedItem.cTag ?? null,
        recoveredDocId: metadata.docId !== null,
      };
    }
  }

  const yaml = serializeFrontmatter(frontmatter);
  const newContent = joinFrontmatter(yaml, body);
  const updated = await writeAuthoritative(client, validatedItemId, cTag, newContent, signal);
  return { updated, writtenDocId: frontmatter.collab.doc_id, frontmatterReset };
}

/**
 * After a successful authoritative write, refresh the local pin block
 * with the new cTag/revision and (if not already cached) the doc_id.
 * Atomic via {@link saveProjectMetadata}'s temp+rename pattern; a
 * crash here leaves the previous metadata intact so the next session
 * can still resolve the project.
 *
 * `freshDocId` carries the doc_id we just wrote into the file so the
 * cache always matches the live frontmatter — never re-reads from
 * Graph (avoids an extra round-trip and a race with concurrent
 * writers).
 */
async function persistAuthoritativeMetadata(
  config: ServerConfig,
  metadata: NonNullable<Awaited<ReturnType<typeof loadProjectMetadata>>>,
  updated: DriveItem,
  writtenDocId: string,
  signal: AbortSignal,
): Promise<void> {
  await saveProjectMetadata(
    config.configDir,
    {
      ...metadata,
      docId: writtenDocId,
      lastSeenAuthoritativeCTag: updated.cTag ?? metadata.lastSeenAuthoritativeCTag,
      lastSeenAuthoritativeRevision: updated.version ?? metadata.lastSeenAuthoritativeRevision,
    },
    signal,
  );
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register collab tools on the given MCP server.
 */
export function registerCollabTools(server: McpServer, config: ServerConfig): ToolEntry[] {
  const entries: ToolEntry[] = [];

  // -------------------------------------------------------------------------
  // collab_read
  // -------------------------------------------------------------------------
  entries.push(
    defineTool(
      server,
      COLLAB_READ_DEF,
      {
        inputSchema: {
          path: z
            .string()
            .optional()
            .describe("Scope-relative path, e.g. 'spec.md' or 'proposals/foo.md'"),
          itemId: z
            .string()
            .optional()
            .describe("Drive item ID from collab_list_files (alternative to path)"),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ path, itemId }, { signal }) => {
        try {
          // Validate exactly one of path/itemId
          if ((path === undefined || path === "") && (itemId === undefined || itemId === "")) {
            return {
              isError: true,
              content: [
                { type: "text", text: "Error: Exactly one of 'path' or 'itemId' is required." },
              ],
            };
          }
          if (path !== undefined && path !== "" && itemId !== undefined && itemId !== "") {
            return {
              isError: true,
              content: [
                { type: "text", text: "Error: Provide either 'path' or 'itemId', not both." },
              ],
            };
          }

          const { metadata } = await requireActiveSession(config, signal);

          const token = await config.authenticator.token(signal);
          const client = new GraphClient(config.graphBaseUrl, {
            getToken: () => Promise.resolve(token),
          });

          let resolvedItem: DriveItem;
          let isAuthoritative = false;

          if (path !== undefined && path !== "") {
            // Resolve via scope algorithm
            try {
              resolvedItem = await scopeCheckedResolve(config, metadata, path, signal);
            } catch (err) {
              if (err instanceof OutOfScopeError) {
                return formatError("collab_read", err);
              }
              if (err instanceof GraphRequestError && err.statusCode === 404) {
                return formatError("collab_read", new FileNotFoundError(path));
              }
              throw err;
            }

            // Check if this is the authoritative file
            if (resolvedItem.id === metadata.pinnedAuthoritativeFileId) {
              isAuthoritative = true;
            }
          } else {
            // itemId provided — need to verify it's in scope by checking ancestry
            const validatedItemId = validateGraphId("itemId", itemId ?? "");
            try {
              resolvedItem = await getDriveItem(client, validatedItemId, signal);
            } catch (err) {
              if (err instanceof GraphRequestError && err.statusCode === 404) {
                return formatError("collab_read", new FileNotFoundError(`itemId:${itemId ?? ""}`));
              }
              throw err;
            }

            // Ancestry check for itemId: walk parentReference.id up to the project folder
            // This is a simplified scope check — the full algorithm is applied when path is used.
            // The hop cap matches scope.ts MAX_ANCESTRY_HOPS so behaviour is uniform across
            // both code paths.
            const projectFolderId = metadata.folderId;
            let cursorParentId: string | undefined = resolvedItem.parentReference?.id;
            let foundAncestor = false;
            for (let hop = 0; hop < MAX_ANCESTRY_HOPS && cursorParentId !== undefined; hop++) {
              if (cursorParentId === projectFolderId) {
                foundAncestor = true;
                break;
              }
              // Fetch the parent to continue walking
              try {
                const parent = await getDriveItem(
                  client,
                  validateGraphId("parentId", cursorParentId),
                  signal,
                );
                cursorParentId = parent.parentReference?.id;
              } catch (err) {
                if (err instanceof GraphRequestError && err.statusCode === 404) {
                  break;
                }
                throw err;
              }
            }

            if (!foundAncestor) {
              return formatError(
                "collab_read",
                new OutOfScopeError(`itemId:${itemId ?? ""}`, "ancestry_escape", resolvedItem.id),
              );
            }

            // Check if this is the authoritative file
            if (resolvedItem.id === metadata.pinnedAuthoritativeFileId) {
              isAuthoritative = true;
            }
          }

          // Download the content
          const validatedResolvedId = validateGraphId("resolvedItemId", resolvedItem.id);
          let content: string;
          try {
            content = await getDriveItemContent(client, validatedResolvedId, signal);
          } catch (err) {
            if (err instanceof MarkdownFileTooLargeError) {
              return formatError("collab_read", err);
            }
            if (err instanceof GraphRequestError && err.statusCode === 404) {
              return formatError(
                "collab_read",
                new FileNotFoundError(path ?? `itemId:${itemId ?? ""}`, resolvedItem.id),
              );
            }
            throw err;
          }

          // Format output
          if (isAuthoritative) {
            // Parse frontmatter for authoritative file
            const readResult = readMarkdownFrontmatter(content);
            const frontmatter = readResult.kind === "parsed" ? readResult.frontmatter : null;
            const body = readResult.body;

            const revision = extractRevisionFromCTag(resolvedItem.cTag);

            // §3.6 audit: when the live frontmatter is missing or
            // malformed, emit a `frontmatter_reset` entry so the
            // post-hoc reviewer can see the OneDrive UI stripped the
            // envelope. `recoveredDocId: true` when the local pin
            // block still carries the project's `docId` (the
            // recovery path for the next write).
            if (readResult.kind === "reset") {
              const session = config.sessionRegistry.snapshot();
              if (session !== null) {
                await writeAudit(
                  config,
                  {
                    sessionId: session.sessionId,
                    agentId: session.agentId,
                    userOid: session.userOid,
                    projectId: metadata.projectId,
                    tool: "collab_read",
                    result: "success",
                    type: "frontmatter_reset",
                    details: {
                      reason: readResult.reason,
                      previousRevision: resolvedItem.cTag ?? null,
                      recoveredDocId: metadata.docId !== null,
                    },
                  },
                  signal,
                );
              }
            }

            const output = formatAuthoritativeRead(resolvedItem, frontmatter, body, revision);
            return { content: [{ type: "text", text: output }] };
          } else {
            const output = formatNonAuthoritativeRead(resolvedItem, content);
            return { content: [{ type: "text", text: output }] };
          }
        } catch (err) {
          return formatError("collab_read", err);
        }
      },
    ),
  );

  // -------------------------------------------------------------------------
  // collab_list_files
  // -------------------------------------------------------------------------
  entries.push(
    defineTool(
      server,
      COLLAB_LIST_FILES_DEF,
      {
        inputSchema: {
          prefix: z
            .enum(["/", "/proposals", "/drafts", "/attachments"])
            .optional()
            .describe("Filter to a specific group (default: all)"),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ prefix }, { signal }) => {
        try {
          const { metadata } = await requireActiveSession(config, signal);

          const token = await config.authenticator.token(signal);
          const client = new GraphClient(config.graphBaseUrl, {
            getToken: () => Promise.resolve(token),
          });

          const projectFolderId = validateGraphId("projectFolderId", metadata.folderId);
          const showAll = prefix === undefined || prefix === "/";
          const showRoot = showAll;
          const showProposals = showAll || prefix === "/proposals";
          const showDrafts = showAll || prefix === "/drafts";
          const showAttachments = showAll || prefix === "/attachments";

          let totalCount = 0;
          const omitted: Record<string, number> = {};
          let truncated = false;

          // ---------------------------------------------------------------
          // ROOT group
          // ---------------------------------------------------------------
          interface ListEntry {
            name: string;
            id: string;
            size?: number;
            cTag?: string;
            isAuthoritative: boolean;
            relativePath?: string;
          }
          const rootEntries: ListEntry[] = [];
          if (showRoot) {
            const rootChildren = await listChildren(client, projectFolderId, signal);
            for (const child of rootChildren) {
              // Exclude .collab/ and any subfolders
              if (child.name.toLowerCase() === SENTINEL_FOLDER_NAME.toLowerCase()) continue;
              if (child.folder !== undefined) continue; // Only files in ROOT

              if (totalCount >= LIST_FILES_BREADTH_CAP) {
                truncated = true;
                omitted["root"] = (omitted["root"] ?? 0) + 1;
                continue;
              }

              const isAuth = child.id === metadata.pinnedAuthoritativeFileId;
              rootEntries.push({
                name: child.name,
                id: child.id,
                size: child.size,
                cTag: child.cTag,
                isAuthoritative: isAuth,
              });
              totalCount++;
            }
          }

          // ---------------------------------------------------------------
          // PROPOSALS group
          // ---------------------------------------------------------------
          const proposalEntries: ListEntry[] = [];
          if (showProposals && !truncated) {
            const proposalsFolder = await findChildFolderByName(
              client,
              projectFolderId,
              "proposals",
              signal,
            );
            if (proposalsFolder !== null) {
              const proposalsFolderId = validateGraphId("proposalsFolderId", proposalsFolder.id);
              try {
                const proposalsChildren = await listChildren(client, proposalsFolderId, signal);
                for (const child of proposalsChildren) {
                  if (child.folder !== undefined) continue; // Flat group — files only

                  if (totalCount >= LIST_FILES_BREADTH_CAP) {
                    truncated = true;
                    omitted["proposals"] = (omitted["proposals"] ?? 0) + 1;
                    continue;
                  }

                  proposalEntries.push({
                    name: child.name,
                    id: child.id,
                    size: child.size,
                    cTag: child.cTag,
                    isAuthoritative: false,
                  });
                  totalCount++;
                }
              } catch (err) {
                // 404 means folder doesn't exist — created on-demand
                if (!(err instanceof GraphRequestError && err.statusCode === 404)) {
                  throw err;
                }
              }
            }
          }

          // ---------------------------------------------------------------
          // DRAFTS group
          // ---------------------------------------------------------------
          const draftEntries: ListEntry[] = [];
          if (showDrafts && !truncated) {
            const draftsFolder = await findChildFolderByName(
              client,
              projectFolderId,
              "drafts",
              signal,
            );
            if (draftsFolder !== null) {
              const draftsFolderId = validateGraphId("draftsFolderId", draftsFolder.id);
              try {
                const draftsChildren = await listChildren(client, draftsFolderId, signal);
                for (const child of draftsChildren) {
                  if (child.folder !== undefined) continue; // Flat group — files only

                  if (totalCount >= LIST_FILES_BREADTH_CAP) {
                    truncated = true;
                    omitted["drafts"] = (omitted["drafts"] ?? 0) + 1;
                    continue;
                  }

                  draftEntries.push({
                    name: child.name,
                    id: child.id,
                    size: child.size,
                    cTag: child.cTag,
                    isAuthoritative: false,
                  });
                  totalCount++;
                }
              } catch (err) {
                if (!(err instanceof GraphRequestError && err.statusCode === 404)) {
                  throw err;
                }
              }
            }
          }

          // ---------------------------------------------------------------
          // ATTACHMENTS group (recursive)
          // ---------------------------------------------------------------
          const attachmentEntries: ListEntry[] = [];
          if (showAttachments && !truncated) {
            const attachmentsFolder = await findChildFolderByName(
              client,
              projectFolderId,
              "attachments",
              signal,
            );
            if (attachmentsFolder !== null) {
              const attachmentsFolderId = validateGraphId(
                "attachmentsFolderId",
                attachmentsFolder.id,
              );
              const remainingBudget = LIST_FILES_BREADTH_CAP - totalCount;
              const walkResult = await walkAttachmentsTree(
                client,
                attachmentsFolderId,
                signal,
                remainingBudget,
              );

              // Sort by lastModifiedDateTime descending (newest first)
              walkResult.entries.sort((a, b) => {
                const dateA = a.item.lastModifiedDateTime ?? "";
                const dateB = b.item.lastModifiedDateTime ?? "";
                return dateB.localeCompare(dateA);
              });

              for (const entry of walkResult.entries) {
                attachmentEntries.push({
                  name: entry.item.name,
                  id: entry.item.id,
                  size: entry.item.size,
                  cTag: entry.item.cTag,
                  isAuthoritative: false,
                  relativePath: entry.relativePath,
                });
                totalCount++;
              }

              if (walkResult.truncated) {
                truncated = true;
                omitted["attachments"] = (omitted["attachments"] ?? 0) + 1;
              }
            }
          }

          // ---------------------------------------------------------------
          // Format output
          // ---------------------------------------------------------------
          const lines: string[] = [];

          if (showRoot || rootEntries.length > 0) {
            lines.push(
              `ROOT (${rootEntries.length} ${rootEntries.length === 1 ? "entry" : "entries"})`,
            );
            for (const entry of rootEntries) {
              const marker = entry.isAuthoritative ? "  [authoritative]" : "";
              lines.push(
                `  ${entry.name.padEnd(30)} ${formatSize(entry.size).padStart(10)}  cTag=${entry.cTag ?? "?"}${marker}`,
              );
            }
            lines.push("");
          }

          if (showProposals || proposalEntries.length > 0) {
            lines.push(
              `PROPOSALS (${proposalEntries.length} ${proposalEntries.length === 1 ? "entry" : "entries"})`,
            );
            for (const entry of proposalEntries) {
              lines.push(
                `  ${entry.name.padEnd(30)} ${formatSize(entry.size).padStart(10)}  cTag=${entry.cTag ?? "?"}`,
              );
            }
            lines.push("");
          }

          if (showDrafts || draftEntries.length > 0) {
            lines.push(
              `DRAFTS (${draftEntries.length} ${draftEntries.length === 1 ? "entry" : "entries"})`,
            );
            for (const entry of draftEntries) {
              lines.push(
                `  ${entry.name.padEnd(30)} ${formatSize(entry.size).padStart(10)}  cTag=${entry.cTag ?? "?"}`,
              );
            }
            lines.push("");
          }

          if (showAttachments || attachmentEntries.length > 0) {
            lines.push(
              `ATTACHMENTS (${attachmentEntries.length} ${attachmentEntries.length === 1 ? "entry" : "entries"})`,
            );
            for (const entry of attachmentEntries) {
              const displayPath = entry.relativePath ?? entry.name;
              lines.push(
                `  ${displayPath.padEnd(40)} ${formatSize(entry.size).padStart(10)}  cTag=${entry.cTag ?? "?"}`,
              );
            }
            lines.push("");
          }

          if (truncated) {
            lines.push(`truncated: true`);
            lines.push(`omitted: ${JSON.stringify(omitted)}`);
          }

          const output = lines.join("\n").trim();
          return { content: [{ type: "text", text: output }] };
        } catch (err) {
          return formatError("collab_list_files", err);
        }
      },
    ),
  );

  // -------------------------------------------------------------------------
  // collab_write
  // -------------------------------------------------------------------------
  entries.push(
    defineTool(
      server,
      COLLAB_WRITE_DEF,
      {
        inputSchema: {
          path: z
            .string()
            .min(1)
            .describe(
              "Scope-relative path inside the active project, e.g. " +
                "'<authoritativeFile>.md' for the authoritative file, " +
                "'proposals/p-foo.md', 'drafts/scratch.md', or " +
                "'attachments/diagram.png'.",
            ),
          content: z.string().describe("UTF-8 file content. Must be ≤ 4 MiB after encoding."),
          cTag: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Opaque cTag previously returned by collab_read or another " +
                "collab write. Required for updates to existing files; " +
                "omit only when creating a new non-authoritative file " +
                "(`/proposals/`, `/drafts/`, `/attachments/`).",
            ),
          source: z
            .enum(["chat", "project", "external"])
            .describe(
              "Where this content originated. 'chat' = the human typed it " +
                "this turn; 'project' = read via collab_read in this session; " +
                "'external' = anything else (web fetch, prior session, " +
                "generated). Writes with source='external' trigger a browser " +
                "re-approval before the write is issued.",
            ),
          conflictMode: z
            .enum(["fail", "proposal"])
            .default("fail")
            .describe(
              "Behaviour on cTag mismatch (HTTP 412). 'fail' returns an " +
                "error with the current cTag and revision so the agent can " +
                "re-read and reconcile. 'proposal' diverts the new content " +
                "to /proposals/<ulid>.md (lands with collab_create_proposal " +
                "in W4 Day 2 — currently rejected with a clear message).",
            ),
          intent: z
            .string()
            .max(2048)
            .optional()
            .describe(
              "Free-text intent shown in re-prompt forms (external-source). " +
                "Helps the human decide whether to approve.",
            ),
        },
        annotations: {
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ path, content, cTag, source, conflictMode, intent }, { signal }) => {
        try {
          if (conflictMode === "proposal") {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text:
                    "conflictMode='proposal' is not yet supported in this " +
                    "milestone (W3 Day 2). Use collab_create_proposal " +
                    "directly once W4 Day 2 ships, or retry with " +
                    "conflictMode='fail' to surface the cTag mismatch and " +
                    "reconcile manually.",
                },
              ],
            };
          }

          const { session, metadata } = await requireActiveSession(config, signal);

          // Pre-check the write budget so external-source writes never
          // open a browser tab the agent has no budget to honour. The
          // §5.2 contract: writes count toward the budget on success or
          // diversion; we surface BudgetExhaustedError before the
          // re-prompt to keep the human's time uncontested.
          if (session.writesUsed >= session.writeBudgetTotal) {
            return formatError(
              "collab_write",
              new BudgetExhaustedError(session.writesUsed, session.writeBudgetTotal),
            );
          }

          const token = await config.authenticator.token(signal);
          const client = new GraphClient(config.graphBaseUrl, {
            getToken: () => Promise.resolve(token),
          });

          // Resolve the target — this also enforces §4.6 scope before
          // any external re-prompt opens or any write is issued.
          let resolvedItem: DriveItem | null = null;
          let isAuthoritative = false;
          let writeIsCreate = false;
          let parentFolderId: ValidatedGraphId | null = null;
          let leafName = "";
          try {
            resolvedItem = await scopeCheckedResolve(config, metadata, path, signal);
            isAuthoritative = resolvedItem.id === metadata.pinnedAuthoritativeFileId;
          } catch (err) {
            if (err instanceof OutOfScopeError) {
              return formatError("collab_write", err);
            }
            // 404 from the scope resolver means the path-name does not
            // exist yet. That's only legal for non-authoritative files
            // (the authoritative file always exists post-init); the
            // resolver itself rejects authoritative-name creates because
            // the resolved item id wouldn't match the pinned id, but we
            // double-check below by inspecting the path layout.
            if (!(err instanceof GraphRequestError && err.statusCode === 404)) {
              throw err;
            }
            writeIsCreate = true;
            const split = splitScopedPath(path);
            leafName = split.leafName;
            if (leafName.length === 0) {
              return formatError("collab_write", new Error(`Path "${path}" has no file name.`));
            }
            // The §4.6 scope resolver already validated the layout for
            // resolvable paths; for create paths we re-derive the parent
            // folder under the project root using the same group names
            // the layout enforces.
            const projectFolderId = validateGraphId("projectFolderId", metadata.folderId);
            try {
              parentFolderId = await ensureParentFolder(
                client,
                projectFolderId,
                split.parentSegments,
                signal,
              );
            } catch (parentErr) {
              return formatError("collab_write", parentErr);
            }
          }

          // Authoritative writes require a cTag — the file always
          // exists, so omitting cTag would be a CAS-bypass attempt.
          if (isAuthoritative && (cTag === undefined || cTag.length === 0)) {
            return formatError(
              "collab_write",
              new Error(
                "cTag is required when writing the authoritative file. " +
                  "Re-read with collab_read to fetch the current cTag.",
              ),
            );
          }
          // Updates to non-authoritative files also require a cTag (the
          // CAS contract). Only first-write byPath creates may skip it.
          if (!isAuthoritative && !writeIsCreate && (cTag === undefined || cTag.length === 0)) {
            return formatError(
              "collab_write",
              new Error(
                `cTag is required when updating "${path}" (file already exists). ` +
                  "Re-read with collab_read to fetch the current cTag.",
              ),
            );
          }

          // Pre-flight payload size guard so we surface a clear error
          // before any external re-prompt asks the human about a write
          // we know will fail.
          const bytes = Buffer.byteLength(content, "utf-8");

          // Open the external-source re-approval form before doing any
          // Graph write so a "Cancel" returns ExternalSourceDeclinedError
          // without side-effects (per §5.2.4).
          if (source === "external") {
            try {
              await runExternalSourceReprompt(
                config,
                {
                  path,
                  intent,
                  sourceCounters: session.sourceCounters,
                  isCreate: writeIsCreate,
                  bytes,
                },
                signal,
              );
            } catch (err) {
              if (err instanceof ExternalSourceDeclinedError) {
                // §3.6 audit: record the declined external-source
                // approval so post-hoc review sees the human said no
                // and no Graph write was issued.
                await writeAudit(
                  config,
                  {
                    sessionId: session.sessionId,
                    agentId: session.agentId,
                    userOid: session.userOid,
                    projectId: metadata.projectId,
                    tool: "collab_write",
                    result: "failure",
                    intent,
                    type: "external_source_approval",
                    details: {
                      tool: "collab_write",
                      path,
                      outcome: "declined",
                      csrfTokenMatched: true,
                    },
                  },
                  signal,
                );
                return formatError("collab_write", err);
              }
              throw err;
            }
            // Approval succeeded — record the audit before the write
            // so the order in the JSONL matches the order of events.
            await writeAudit(
              config,
              {
                sessionId: session.sessionId,
                agentId: session.agentId,
                userOid: session.userOid,
                projectId: metadata.projectId,
                tool: "collab_write",
                result: "success",
                intent,
                type: "external_source_approval",
                details: {
                  tool: "collab_write",
                  path,
                  outcome: "approved",
                  csrfTokenMatched: true,
                },
              },
              signal,
            );
          }

          const cTagBefore = resolvedItem?.cTag ?? null;
          let updated: DriveItem;
          let writtenDocId: string | null = null;
          let frontmatterReset: FrontmatterResetAudit | null = null;
          try {
            if (isAuthoritative) {
              if (resolvedItem === null) {
                throw new Error("internal: resolvedItem missing for authoritative write");
              }
              if (cTag === undefined) {
                throw new Error("internal: cTag missing for authoritative write");
              }
              const auth = await runAuthoritativeWrite(
                config,
                client,
                metadata,
                resolvedItem,
                cTag,
                content,
                signal,
              );
              updated = auth.updated;
              writtenDocId = auth.writtenDocId;
              frontmatterReset = auth.frontmatterReset;
            } else if (writeIsCreate) {
              if (parentFolderId === null) {
                throw new Error("internal: parentFolderId missing for byPath create");
              }
              const target: WriteProjectFileTarget = {
                kind: "create",
                folderId: parentFolderId,
                fileName: leafName,
                contentType: contentTypeForFileName(leafName),
              };
              updated = await writeProjectFile(client, target, content, signal);
            } else {
              if (resolvedItem === null) {
                throw new Error("internal: resolvedItem missing for byId replace");
              }
              if (cTag === undefined) {
                throw new Error("internal: cTag missing for byId replace");
              }
              const validatedItemId = validateGraphId("resolvedItemId", resolvedItem.id);
              const target: WriteProjectFileTarget = {
                kind: "replace",
                itemId: validatedItemId,
                cTag: cTag,
                contentType: contentTypeForFileName(resolvedItem.name),
              };
              updated = await writeProjectFile(client, target, content, signal);
            }
          } catch (err) {
            if (
              err instanceof MarkdownFileTooLargeError ||
              err instanceof CollabCTagMismatchError ||
              err instanceof ProjectFileAlreadyExistsError ||
              err instanceof DocIdRecoveryRequiredError
            ) {
              return formatError("collab_write", err);
            }
            throw err;
          }

          // Persist counters + per-write cache updates atomically with
          // each step so a crash mid-flow leaves a coherent state.
          await config.sessionRegistry.incrementWrites(signal);
          await config.sessionRegistry.incrementSource(source, signal);

          if (isAuthoritative && writtenDocId !== null) {
            await persistAuthoritativeMetadata(config, metadata, updated, writtenDocId, signal);
          }

          // §3.6 audit: when the live frontmatter was missing /
          // malformed, emit a single `frontmatter_reset` for the write
          // that recovered the doc_id. The next read sees the
          // re-injected envelope and does not duplicate the entry.
          if (frontmatterReset !== null) {
            await writeAudit(
              config,
              {
                sessionId: session.sessionId,
                agentId: session.agentId,
                userOid: session.userOid,
                projectId: metadata.projectId,
                tool: "collab_write",
                result: "success",
                type: "frontmatter_reset",
                details: frontmatterReset,
              },
              signal,
            );
          }

          // §3.6 audit: record the successful write. inputSummary
          // carries only allow-listed fields (the writer enforces this
          // again); content / body / rationale never reach disk.
          const inputSummary: AuditInputSummary = {
            path,
            source,
            conflictMode,
            contentSizeBytes: bytes,
          };
          await writeAudit(
            config,
            {
              sessionId: session.sessionId,
              agentId: session.agentId,
              userOid: session.userOid,
              projectId: metadata.projectId,
              tool: "collab_write",
              result: "success",
              intent,
              type: "tool_call",
              details: {
                inputSummary,
                cTagBefore,
                cTagAfter: updated.cTag ?? null,
                revisionAfter: updated.version ?? null,
                bytes,
                source,
                resolvedItemId: updated.id,
              },
            },
            signal,
          );

          const lines = [
            `wrote: ${updated.name} (${updated.id})`,
            `bytes: ${updated.size ?? bytes}`,
            `cTag: ${updated.cTag ?? "unknown"}`,
            updated.version !== undefined ? `revision: ${updated.version}` : "revision: (unknown)",
            `kind: ${writeIsCreate ? "created" : "replaced"}`,
            `isAuthoritative: ${isAuthoritative ? "true" : "false"}`,
            `source: ${source}`,
          ];
          const refreshed = config.sessionRegistry.snapshot();
          if (refreshed !== null) {
            lines.push(`writes: ${refreshed.writesUsed} / ${refreshed.writeBudgetTotal}`);
            lines.push(
              `source counters: chat=${refreshed.sourceCounters.chat} ` +
                `project=${refreshed.sourceCounters.project} ` +
                `external=${refreshed.sourceCounters.external}`,
            );
          }

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (err) {
          if (err instanceof AuthenticationRequiredError) {
            return formatError("collab_write", err);
          }
          return formatError("collab_write", err);
        }
      },
    ),
  );

  return entries;
}
