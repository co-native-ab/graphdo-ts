// `collab_list_files` MCP tool registration.
//
// Pure code-organisation extract from `src/tools/collab.ts` (W4 buffer
// refactor); no behaviour change.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ServerConfig } from "../../index.js";
import type { ToolEntry } from "../../tool-registry.js";
import { defineTool } from "../../tool-registry.js";
import { GraphClient, GraphRequestError } from "../../graph/client.js";
import { validateGraphId } from "../../graph/ids.js";
import { findChildFolderByName, listChildren, walkAttachmentsTree } from "../../collab/graph.js";
import { formatError } from "../shared.js";

import {
  COLLAB_LIST_FILES_DEF,
  LIST_FILES_BREADTH_CAP,
  SENTINEL_FOLDER_NAME,
  formatSize,
  requireActiveSession,
} from "./shared.js";

export function registerCollabListFiles(server: McpServer, config: ServerConfig): ToolEntry {
  return defineTool(
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
  );
}
