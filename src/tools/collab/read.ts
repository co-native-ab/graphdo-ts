// `collab_read` MCP tool registration.
//
// Pure code-organisation extract from `src/tools/collab.ts` (W4 buffer
// refactor); no behaviour change. See `./shared.ts` for the helpers
// that back this module.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { OutOfScopeError } from "../../errors.js";
import type { ServerConfig } from "../../index.js";
import type { ToolEntry } from "../../tool-registry.js";
import { defineTool } from "../../tool-registry.js";
import { GraphClient, GraphRequestError } from "../../graph/client.js";
import { validateGraphId } from "../../graph/ids.js";
import { MarkdownFileTooLargeError } from "../../graph/markdown.js";
import { getDriveItem, getDriveItemContent } from "../../collab/graph.js";
import { MAX_ANCESTRY_HOPS } from "../../collab/scope.js";
import { readMarkdownFrontmatter } from "../../collab/frontmatter.js";
import { writeAudit, AuditResult } from "../../collab/audit.js";
import { formatError } from "../shared.js";
import type { DriveItem } from "../../graph/types.js";

import {
  COLLAB_READ_DEF,
  FileNotFoundError,
  extractRevisionFromCTag,
  formatAuthoritativeRead,
  formatNonAuthoritativeRead,
  requireActiveSession,
  scopeCheckedResolve,
  toAuditResetReason,
} from "./shared.js";

export function registerCollabRead(server: McpServer, config: ServerConfig): ToolEntry {
  return defineTool(
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
                  result: AuditResult.Success,
                  type: "frontmatter_reset",
                  details: {
                    reason: toAuditResetReason(readResult.reason),
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
  );
}
