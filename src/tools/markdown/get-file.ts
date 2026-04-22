// MCP tool: markdown_get_file — read a markdown file with its current cTag.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadAndValidateMarkdownConfig } from "../../config.js";
import { validateGraphId } from "../../graph/ids.js";
import {
  downloadMarkdownContent,
  MARKDOWN_FILE_NAME_RULES,
  resolveCurrentRevision,
  validateMarkdownFileName,
} from "../../graph/markdown.js";
import type { ServerConfig } from "../../index.js";
import { GraphScope } from "../../scopes.js";
import type { Tool, ToolDef } from "../../tool-registry.js";
import { formatError } from "../shared.js";
import {
  formatRevision,
  formatSize,
  idOrNameShape,
  MARKDOWN_SIZE_CAP_NOTE,
  resolveDriveItem,
} from "./helpers.js";

const inputSchema = idOrNameShape;

const def: ToolDef = {
  name: "markdown_get_file",
  title: "Get Markdown File",
  description:
    "Read a markdown file from the signed-in user's OneDrive (the configured " +
    "root folder). Accepts either a file ID (from markdown_list_files) or a " +
    "file name. File names must follow the strict naming rules and are " +
    "rejected otherwise - paths, subdirectories, and characters that are " +
    "not portable across Linux, macOS, and Windows are not allowed. Returns " +
    "the current UTF-8 content of the file along with its cTag (OneDrive's " +
    "content-only entity tag), which markdown_update_file requires for safe " +
    "optimistic concurrency. Files larger than 4 MiB cannot be downloaded " +
    "and will return an error " +
    `(${MARKDOWN_SIZE_CAP_NOTE}). ` +
    "To read a previous version, use markdown_get_file_version. " +
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

      // Enforce naming rules against the resolved item too. This catches
      // cases where a caller supplied an itemId whose remote name is
      // invalid (e.g. a subdirectory or a file with unsafe characters).
      if (item.folder !== undefined) {
        return {
          content: [
            {
              type: "text",
              text:
                `"${item.name}" is a subdirectory, which is not supported. ` +
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
              text: `"${item.name}" cannot be read: ${nameCheck.reason}. ${MARKDOWN_FILE_NAME_RULES}`,
            },
          ],
          isError: true,
        };
      }

      const itemId = validateGraphId("item.id", item.id);
      const content = await downloadMarkdownContent(client, itemId, signal);
      const revision = await resolveCurrentRevision(client, item, signal);

      const header =
        `${item.name} (${item.id})\n` +
        `Size: ${formatSize(item.size)}\n` +
        `Modified: ${item.lastModifiedDateTime ?? "unknown"}\n` +
        `Revision: ${formatRevision(revision)}\n` +
        `cTag: ${item.cTag ?? "(none)"}\n` +
        "(supply the cTag verbatim to markdown_update_file for safe optimistic concurrency; " +
        "use the Revision with markdown_list_file_versions / markdown_diff_file_versions " +
        "to trace or diff changes)\n" +
        "---";
      return {
        content: [{ type: "text", text: `${header}\n${content}` }],
      };
    } catch (err: unknown) {
      return formatError("markdown_get_file", err);
    }
  };
}

export const markdownGetFileTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler,
};
