// `collab_list_versions` MCP tool registration (W5 Day 1).
//
// Wraps `GET /me/drive/items/{itemId}/versions` for any file inside
// the active project's scope. Read-only and free — no write- or
// destructive-budget cost. Defaults to the authoritative file when
// neither `path` nor `itemId` is provided. Output mirrors
// `markdown_list_file_versions` so an agent already comfortable with
// the markdown tools can pivot here without learning a new envelope.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { OutOfScopeError } from "../../errors.js";
import type { ServerConfig } from "../../index.js";
import type { ToolEntry } from "../../tool-registry.js";
import { defineTool } from "../../tool-registry.js";
import { GraphClient, GraphRequestError } from "../../graph/client.js";
import { validateGraphId } from "../../graph/ids.js";
import { listDriveItemVersions } from "../../graph/markdown.js";
import { formatError } from "../shared.js";

import {
  COLLAB_LIST_VERSIONS_DEF,
  FileNotFoundError,
  formatSize,
  requireActiveSession,
  resolveTargetItem,
} from "./shared.js";

export function registerCollabListVersions(server: McpServer, config: ServerConfig): ToolEntry {
  return defineTool(
    server,
    COLLAB_LIST_VERSIONS_DEF,
    {
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Scope-relative path. Defaults to the authoritative file when " +
              "both `path` and `itemId` are omitted.",
          ),
        itemId: z.string().optional().describe("Drive item ID (alternative to `path`)."),
      },
      annotations: {
        title: COLLAB_LIST_VERSIONS_DEF.title,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, itemId }, { signal }) => {
      try {
        const { metadata } = await requireActiveSession(config, signal);

        let resolved;
        try {
          resolved = await resolveTargetItem(config, metadata, { path, itemId }, signal);
        } catch (err) {
          if (err instanceof OutOfScopeError) {
            return formatError("collab_list_versions", err);
          }
          if (err instanceof GraphRequestError && err.statusCode === 404) {
            return formatError(
              "collab_list_versions",
              new FileNotFoundError(path ?? `itemId:${itemId ?? ""}`),
            );
          }
          throw err;
        }

        const item = resolved.item;
        const token = await config.authenticator.token(signal);
        const client = new GraphClient(config.graphBaseUrl, {
          getToken: () => Promise.resolve(token),
        });

        const versions = await listDriveItemVersions(
          client,
          validateGraphId("resolvedItemId", item.id),
          signal,
        );

        const header =
          `Versions of ${item.name} (${item.id})` +
          (resolved.isAuthoritative ? " [authoritative]" : "") +
          " — newest first:";
        if (versions.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `${header}\n\nNo prior versions are available for this file.`,
              },
            ],
          };
        }

        const lines = versions.map((v, i) => {
          const modified = v.lastModifiedDateTime ?? "unknown";
          const size = formatSize(v.size);
          const by = v.lastModifiedBy?.user?.displayName;
          const byPart = by !== undefined && by.length > 0 ? `, by ${by}` : "";
          return `${String(i + 1)}. ${v.id} — ${size}, modified ${modified}${byPart}`;
        });

        return {
          content: [
            {
              type: "text",
              text:
                `${header}\n${lines.join("\n")}\n\n` +
                `Total: ${String(versions.length)} version(s). ` +
                "Pass a versionId to collab_restore_version to roll the file back.",
            },
          ],
        };
      } catch (err) {
        return formatError("collab_list_versions", err);
      }
    },
  );
}
