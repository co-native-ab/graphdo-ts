// MCP tools for the collab v1 file/section operations: read, list, write,
// section leases, proposals, etc. (`docs/plans/collab-v1.md` §2.3).
//
// W2 Day 4 lands:
//   - `collab_read` — read any file inside project scope (§2.3).
//   - `collab_list_files` — directory listing with `[authoritative]` marker.
//
// `collab_write` lands in W3 Day 2; section leases in W3 Day 4; proposals
// and destructive apply in W4 Days 2–3.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { OutOfScopeError } from "../errors.js";
import type { ServerConfig } from "../index.js";
import type { ToolDef, ToolEntry } from "../tool-registry.js";
import { defineTool } from "../tool-registry.js";
import { GraphScope } from "../scopes.js";
import { GraphRequestError } from "../graph/client.js";
import { validateGraphId } from "../graph/ids.js";
import { MarkdownFileTooLargeError } from "../graph/markdown.js";
import { NoActiveSessionError } from "../collab/session.js";
import { loadProjectMetadata } from "../collab/projects.js";
import {
  getDriveItem,
  getDriveItemContent,
  listChildren,
  findChildFolderByName,
  walkAttachmentsTree,
} from "../collab/graph.js";
import { resolveScopedPath, MAX_ANCESTRY_HOPS } from "../collab/scope.js";
import { readMarkdownFrontmatter, type CollabFrontmatter } from "../collab/frontmatter.js";
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

/** Static tool metadata for collab tools. */
export const COLLAB_TOOL_DEFS: readonly ToolDef[] = [COLLAB_READ_DEF, COLLAB_LIST_FILES_DEF];

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
  const { GraphClient } = await import("../graph/client.js");
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
          const { GraphClient } = await import("../graph/client.js");
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

            // Note: audit emission (`frontmatter_reset`) is W3 Day 3; deferred.
            const revision = extractRevisionFromCTag(resolvedItem.cTag);

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
          const { GraphClient } = await import("../graph/client.js");
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

  return entries;
}
