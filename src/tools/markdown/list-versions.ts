// MCP tool: markdown_list_file_versions — list historical versions of a markdown file.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadAndValidateWorkspaceConfig } from "../../config.js";
import { meDriveScope } from "../../graph/drives.js";
import { validateGraphId } from "../../graph/ids.js";
import {
  MARKDOWN_FILE_NAME_RULES,
  listDriveItemVersions,
  validateMarkdownFileName,
} from "../../graph/markdown.js";
import type { ServerConfig } from "../../index.js";
import { GraphScope } from "../../scopes.js";
import type { Tool, ToolDef } from "../../tool-registry.js";
import { formatError } from "../shared.js";
import { formatSize, idOrNameShape, resolveDriveItem } from "./helpers.js";

const inputSchema = idOrNameShape;

const def: ToolDef = {
  name: "markdown_list_file_versions",
  title: "List Markdown File Versions",
  description:
    "List historical versions of a markdown file in the signed-in user's " +
    "OneDrive. OneDrive retains previous versions automatically whenever a " +
    "file is overwritten; this tool surfaces that history (newest first) " +
    "so the agent can see when the file changed and, together with " +
    "markdown_get_file_version, recover earlier content. Accepts either a " +
    "file ID or a file name. Returns each version's opaque version ID, " +
    "last modified timestamp, size in bytes, and - when available - the " +
    "name of the user who last modified it. " +
    MARKDOWN_FILE_NAME_RULES,
  requiredScopes: [GraphScope.FilesReadWrite],
};

function handler(config: ServerConfig): ToolCallback<typeof inputSchema> {
  return async (args, { signal }) => {
    try {
      if (!args.itemId && !args.fileName) {
        return {
          content: [{ type: "text", text: "Either itemId or fileName must be provided." }],
          isError: true,
        };
      }

      const cfg = await loadAndValidateWorkspaceConfig(config.configDir, signal);
      const client = config.graphClient;
      
      const scope = cfg.workspace.driveId === "me"
        ? meDriveScope
        : { kind: "drive" as const, driveId: cfg.workspace.driveId };
      
      const item = await resolveDriveItem(client, scope, cfg.workspace.itemId, args, signal);

      if (item.folder !== undefined) {
        return {
          content: [
            {
              type: "text",
              text:
                `"${item.name}" is a subdirectory, which is not supported. ` +
                "The markdown tools only operate on files directly in the configured workspace.",
            },
          ],
          isError: true,
        };
      }
      const nameCheck = validateMarkdownFileName(item.name);
      if (!nameCheck.valid) {
        return {
          content: [
            {
              type: "text",
              text:
                `"${item.name}" cannot have its versions listed: ${nameCheck.reason}. ` +
                MARKDOWN_FILE_NAME_RULES,
            },
          ],
          isError: true,
        };
      }

      const versions = await listDriveItemVersions(
        client,
        scope,
        validateGraphId("item.id", item.id),
        signal,
      );

      const header = `Versions of "${item.name}" (${item.id}) — newest first:`;
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
              "Use markdown_get_file_version with the versionId to read a specific prior version.",
          },
        ],
      };
    } catch (err: unknown) {
      return formatError("markdown_list_file_versions", err);
    }
  };
}

export const markdownListFileVersionsTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler,
};
