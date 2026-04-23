// MCP tool: markdown_diff_file_versions — server-side unified diff between two file revisions.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";

import { loadAndValidateWorkspaceConfig } from "../../config.js";
import { meDriveScope } from "../../graph/drives.js";
import { validateGraphId } from "../../graph/ids.js";
import {
  MARKDOWN_FILE_NAME_RULES,
  MarkdownFileTooLargeError,
  MarkdownUnknownVersionError,
  getRevisionContent,
  validateMarkdownFileName,
} from "../../graph/markdown.js";
import type { ServerConfig } from "../../index.js";
import { GraphScope } from "../../scopes.js";
import type { Tool, ToolDef } from "../../tool-registry.js";
import { formatError } from "../shared.js";
import { idOrNameShape, resolveDriveItem } from "./helpers.js";

const inputSchema = {
  ...idOrNameShape,
  fromVersionId: z
    .string()
    .min(1)
    .describe(
      "Revision to diff from (the 'old' side). Either a historical " +
        "version ID returned by markdown_list_file_versions, or the current " +
        "Revision surfaced by markdown_get_file / markdown_create_file / " +
        "markdown_update_file.",
    ),
  toVersionId: z
    .string()
    .min(1)
    .describe(
      "Revision to diff to (the 'new' side). Either a historical " +
        "version ID returned by markdown_list_file_versions, or the current " +
        "Revision surfaced by markdown_get_file / markdown_create_file / " +
        "markdown_update_file (e.g. the 'Current Revision' reported in a " +
        "cTag-mismatch error).",
    ),
};

const def: ToolDef = {
  name: "markdown_diff_file_versions",
  title: "Diff Markdown File Versions",
  description:
    "Return a unified diff between two revisions of a markdown file in the " +
    "configured workspace, computed server-side so you do not have to " +
    "diff the content yourself. Accepts the file by id (preferred) or name, " +
    "plus a fromVersionId and a toVersionId. Each ID may be either a " +
    "historical version ID returned by markdown_list_file_versions, or the " +
    "current Revision surfaced by markdown_get_file / markdown_create_file / " +
    "markdown_update_file (including the Current Revision reported in a " +
    "cTag-mismatch error). This is the preferred way to reconcile a stale " +
    "update: pass the revision you originally read as fromVersionId and the " +
    "current revision as toVersionId. Returns a text/x-diff unified patch. " +
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
                `"${item.name}" cannot be diffed: ${nameCheck.reason}. ` + MARKDOWN_FILE_NAME_RULES,
            },
          ],
          isError: true,
        };
      }

      if (args.fromVersionId === args.toVersionId) {
        return {
          content: [
            {
              type: "text",
              text:
                `No diff: fromVersionId and toVersionId are the same (${args.fromVersionId}). ` +
                "Pass two different revisions to see a diff.",
            },
          ],
        };
      }

      const fromVersionId = validateGraphId("fromVersionId", args.fromVersionId);
      const toVersionId = validateGraphId("toVersionId", args.toVersionId);
      const [from, to] = await Promise.all([
        getRevisionContent(client, scope, item, fromVersionId, signal),
        getRevisionContent(client, scope, item, toVersionId, signal),
      ]);
      const fromContent = from.content;
      const toContent = to.content;

      if (fromContent === toContent) {
        return {
          content: [
            {
              type: "text",
              text:
                `${item.name} (${item.id})\n` +
                `From revision: ${args.fromVersionId}\n` +
                `To revision:   ${args.toVersionId}\n` +
                `---\n(no content differences between the two revisions)`,
            },
          ],
        };
      }

      // Unified diff via jsdiff - server-side so the agent doesn't have
      // to compute it. Three lines of surrounding context is the
      // conventional default for a readable patch.
      const patch = createTwoFilesPatch(
        `${item.name}@${args.fromVersionId}`,
        `${item.name}@${args.toVersionId}`,
        fromContent,
        toContent,
        undefined,
        undefined,
        { context: 3 },
      );

      return {
        content: [
          {
            type: "text",
            text:
              `${item.name} (${item.id})\n` +
              `From revision: ${args.fromVersionId}\n` +
              `To revision:   ${args.toVersionId}\n` +
              `---\n${patch}`,
          },
        ],
      };
    } catch (err: unknown) {
      if (err instanceof MarkdownUnknownVersionError) {
        return {
          content: [
            {
              type: "text",
              text:
                err.message +
                "\n\nCall markdown_list_file_versions to see all historical " +
                "version IDs, and markdown_get_file to see the current Revision.",
            },
          ],
          isError: true,
        };
      }
      if (err instanceof MarkdownFileTooLargeError) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      return formatError("markdown_diff_file_versions", err);
    }
  };
}

export const markdownDiffFileVersionsTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler,
};
