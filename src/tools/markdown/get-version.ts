// MCP tool: markdown_get_file_version — read a historical version of a markdown file.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadAndValidateWorkspaceConfig } from "../../config.js";
import { meDriveScope } from "../../graph/drives.js";
import { validateGraphId } from "../../graph/ids.js";
import {
  MARKDOWN_FILE_NAME_RULES,
  MarkdownFileTooLargeError,
  getRevisionContent,
  validateMarkdownFileName,
} from "../../graph/markdown.js";
import type { ServerConfig } from "../../index.js";
import { GraphScope } from "../../scopes.js";
import type { Tool, ToolDef } from "../../tool-registry.js";
import { formatError } from "../shared.js";
import { idOrNameShape, MARKDOWN_SIZE_CAP_NOTE, resolveDriveItem } from "./helpers.js";

const inputSchema = {
  ...idOrNameShape,
  versionId: z
    .string()
    .min(1)
    .describe("Opaque version ID previously returned by markdown_list_file_versions."),
};

const def: ToolDef = {
  name: "markdown_get_file_version",
  title: "Get Markdown File Version",
  description:
    "Read the UTF-8 content of a specific historical version of a markdown " +
    "file in the signed-in user's OneDrive. Requires the file (by ID or " +
    "name) and the version ID previously returned by " +
    "markdown_list_file_versions. This does not restore or modify the file " +
    "- it only reads the prior content. Use markdown_update_file to " +
    "re-upload that content if you want to make it current. Files larger " +
    `than 4 MiB cannot be downloaded (${MARKDOWN_SIZE_CAP_NOTE}). ` +
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

      const scope =
        cfg.workspace.driveId === "me"
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
                `"${item.name}" cannot have a version read: ${nameCheck.reason}. ` +
                MARKDOWN_FILE_NAME_RULES,
            },
          ],
          isError: true,
        };
      }

      const { content, isCurrent } = await getRevisionContent(
        client,
        scope,
        item,
        validateGraphId("versionId", args.versionId),
        signal,
      );

      const versionNote = isCurrent
        ? "(current version content)"
        : "(historical content, not the current version — use markdown_update_file to restore)";
      const header =
        `${item.name} (${item.id})\n` + `Version: ${args.versionId}\n` + `${versionNote}\n` + "---";
      return {
        content: [{ type: "text", text: `${header}\n${content}` }],
      };
    } catch (err: unknown) {
      if (err instanceof MarkdownFileTooLargeError) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      return formatError("markdown_get_file_version", err);
    }
  };
}

export const markdownGetFileVersionTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler,
};
