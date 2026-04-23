// MCP tool: markdown_create_file — create a new markdown file in the configured folder.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadAndValidateWorkspaceConfig } from "../../config.js";
import { meDriveScope } from "../../graph/drives.js";
import {
  createMarkdownFile,
  MARKDOWN_FILE_NAME_RULES,
  MarkdownFileAlreadyExistsError,
  MarkdownFileTooLargeError,
  resolveCurrentRevision,
} from "../../graph/markdown.js";
import type { ServerConfig } from "../../index.js";
import { GraphScope } from "../../scopes.js";
import type { Tool, ToolDef } from "../../tool-registry.js";
import { formatError } from "../shared.js";
import { formatRevision, markdownNameSchema, MARKDOWN_SIZE_CAP_NOTE } from "./helpers.js";

const inputSchema = {
  fileName: markdownNameSchema.describe(
    "File name, must end in .md. Must not already exist in the configured workspace.",
  ),
  content: z
    .string()
    .describe(`UTF-8 markdown content (max 4 MiB / 4,194,304 bytes; ${MARKDOWN_SIZE_CAP_NOTE}).`),
};

const def: ToolDef = {
  name: "markdown_create_file",
  title: "Create Markdown File",
  description:
    "Create a new markdown file in the configured workspace. Fails with a " +
    "clear error when a file with the same name already exists - in that " +
    "case, call markdown_get_file to fetch the existing content and cTag, " +
    "then call markdown_update_file. The file name must follow the strict " +
    "naming rules - paths, subdirectories, and characters that are not " +
    "portable across Linux, macOS, and Windows are rejected. Payloads " +
    `larger than 4 MiB are rejected (${MARKDOWN_SIZE_CAP_NOTE}). ` +
    MARKDOWN_FILE_NAME_RULES,
  requiredScopes: [GraphScope.FilesReadWrite],
};

function handler(config: ServerConfig): ToolCallback<typeof inputSchema> {
  return async (args, { signal }) => {
    try {
      const cfg = await loadAndValidateWorkspaceConfig(config.configDir, signal);
      const client = config.graphClient;

      const scope =
        cfg.workspace.driveId === "me"
          ? meDriveScope
          : { kind: "drive" as const, driveId: cfg.workspace.driveId };

      const item = await createMarkdownFile(
        client,
        scope,
        cfg.workspace.itemId,
        args.fileName,
        args.content,
        signal,
      );
      const revision = await resolveCurrentRevision(client, scope, item, signal);
      const bytes = Buffer.byteLength(args.content, "utf-8");
      return {
        content: [
          {
            type: "text",
            text:
              `Created "${item.name}" (${item.id})\n` +
              `Size: ${String(bytes)} bytes\n` +
              `Revision: ${formatRevision(revision)}\n` +
              `cTag: ${item.cTag ?? "(none)"}\n` +
              "(supply the cTag verbatim to markdown_update_file for safe optimistic concurrency)",
          },
        ],
      };
    } catch (err: unknown) {
      if (err instanceof MarkdownFileAlreadyExistsError) {
        return {
          content: [
            {
              type: "text",
              text:
                `A file named "${err.fileName}" already exists in the configured ` +
                `root folder. Either choose a different name, or - if you intended ` +
                `to overwrite - call markdown_get_file to fetch the existing ` +
                `content and cTag, decide whether your update still applies, then ` +
                `call markdown_update_file with the cTag.`,
            },
          ],
          isError: true,
        };
      }
      if (err instanceof MarkdownFileTooLargeError) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      return formatError("markdown_create_file", err);
    }
  };
}

export const markdownCreateFileTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  handler,
};
