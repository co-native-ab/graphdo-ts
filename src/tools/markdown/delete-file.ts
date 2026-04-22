// MCP tool: markdown_delete_file — permanently delete a markdown file.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadAndValidateMarkdownConfig } from "../../config.js";
import { validateGraphId } from "../../graph/ids.js";
import {
  MARKDOWN_FILE_NAME_RULES,
  deleteDriveItem,
  validateMarkdownFileName,
} from "../../graph/markdown.js";
import type { ServerConfig } from "../../index.js";
import { GraphScope } from "../../scopes.js";
import type { Tool, ToolDef } from "../../tool-registry.js";
import { formatError } from "../shared.js";
import { idOrNameShape, resolveDriveItem } from "./helpers.js";

const inputSchema = idOrNameShape;

const def: ToolDef = {
  name: "markdown_delete_file",
  title: "Delete Markdown File",
  description:
    "Permanently delete a markdown file from the configured root folder of " +
    "the signed-in user's OneDrive. Accepts either a file ID or a file " +
    "name. File names must follow the strict naming rules and are rejected " +
    "otherwise. " +
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

      const cfg = await loadAndValidateMarkdownConfig(config.configDir, signal);
      const client = config.graphClient;
      const item = await resolveDriveItem(client, cfg.markdown.rootFolderId, args, signal);

      if (item.folder !== undefined) {
        return {
          content: [
            {
              type: "text",
              text:
                `"${item.name}" is a subdirectory and cannot be deleted by the markdown tools. ` +
                "The markdown tools only operate on files directly in the configured root folder.",
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
              text: `"${item.name}" cannot be deleted: ${nameCheck.reason}. ${MARKDOWN_FILE_NAME_RULES}`,
            },
          ],
          isError: true,
        };
      }

      await deleteDriveItem(client, validateGraphId("item.id", item.id), signal);

      return {
        content: [{ type: "text", text: `Deleted "${item.name}" (${item.id}).` }],
      };
    } catch (err: unknown) {
      return formatError("markdown_delete_file", err);
    }
  };
}

export const markdownDeleteFileTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  handler,
};
