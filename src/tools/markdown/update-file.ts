// MCP tool: markdown_update_file — overwrite a file under cTag-based optimistic concurrency.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadAndValidateWorkspaceConfig } from "../../config.js";
import { meDriveScope } from "../../graph/drives.js";
import { validateGraphId } from "../../graph/ids.js";
import {
  MARKDOWN_FILE_NAME_RULES,
  MarkdownCTagMismatchError,
  MarkdownFileTooLargeError,
  resolveCurrentRevision,
  updateMarkdownFile,
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

const inputSchema = {
  ...idOrNameShape,
  cTag: z
    .string()
    .min(1)
    .describe(
      "Opaque cTag previously returned by markdown_get_file, " +
        "markdown_create_file, or markdown_update_file. Sent verbatim in If-Match. " +
        "cTag is OneDrive's content-only entity tag, so unrelated metadata changes " +
        "(rename, share, indexing, preview generation) do not invalidate it.",
    ),
  content: z
    .string()
    .describe(
      `New UTF-8 markdown content (max 4 MiB / 4,194,304 bytes; ${MARKDOWN_SIZE_CAP_NOTE}).`,
    ),
};

const def: ToolDef = {
  name: "markdown_update_file",
  title: "Update Markdown File",
  description:
    "Overwrite the content of an existing markdown file in the configured " +
    "workspace. Requires the cTag previously returned by markdown_get_file " +
    "(or markdown_create_file / markdown_update_file). The cTag is OneDrive's " +
    "content-only entity tag, so unrelated metadata changes (rename, share, " +
    "indexing, preview generation) do not invalidate it. The update succeeds " +
    "only when the supplied cTag matches the file's current cTag - if the " +
    "file's content has changed since you read it, the call fails with the " +
    "current cTag and modification time. When that happens you must call " +
    "markdown_get_file again to retrieve the latest content + cTag, decide " +
    "whether your intended update still applies, reconcile your changes " +
    "against any new content, and call markdown_update_file again with the " +
    "new cTag - or ask the user how to proceed if the meaning of your " +
    "update no longer fits. Accepts the file by id (preferred) or by name. " +
    `Payloads larger than 4 MiB are rejected (${MARKDOWN_SIZE_CAP_NOTE}). ` +
    MARKDOWN_FILE_NAME_RULES,
  requiredScopes: [GraphScope.FilesReadWrite],
};

function handler(config: ServerConfig): ToolCallback<typeof inputSchema> {
  return async (args, { signal }) => {
    // Hoist scope outside try block so error handlers can access it
    let scope: import("../../graph/drives.js").DriveScope | undefined;
    
    try {
      if (!args.itemId && !args.fileName) {
        return {
          content: [{ type: "text", text: "Either itemId or fileName must be provided." }],
          isError: true,
        };
      }

      const cfg = await loadAndValidateWorkspaceConfig(config.configDir, signal);
      const client = config.graphClient;
      
      scope = cfg.workspace.driveId === "me"
        ? meDriveScope
        : { kind: "drive" as const, driveId: cfg.workspace.driveId };
      
      const item = await resolveDriveItem(client, scope, cfg.workspace.itemId, args, signal);

      // Defence in depth: re-validate the resolved item before writing.
      if (item.folder !== undefined) {
        return {
          content: [
            {
              type: "text",
              text:
                `"${item.name}" is a subdirectory and cannot be updated by the markdown tools. ` +
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
              text: `"${item.name}" cannot be updated: ${nameCheck.reason}. ${MARKDOWN_FILE_NAME_RULES}`,
            },
          ],
          isError: true,
        };
      }

      const updated = await updateMarkdownFile(
        client,
        scope,
        validateGraphId("item.id", item.id),
        args.cTag,
        args.content,
        signal,
      );
      const revision = await resolveCurrentRevision(client, scope, updated, signal);
      const bytes = Buffer.byteLength(args.content, "utf-8");
      return {
        content: [
          {
            type: "text",
            text:
              `Updated "${updated.name}" (${updated.id})\n` +
              `Size: ${String(bytes)} bytes\n` +
              `Revision: ${formatRevision(revision)}\n` +
              `cTag: ${updated.cTag ?? "(none)"}\n` +
              "(supply the new cTag verbatim to the next markdown_update_file call)",
          },
        ],
      };
    } catch (err: unknown) {
      if (err instanceof MarkdownCTagMismatchError && scope) {
        const cur = err.currentItem;
        const currentRevision = await resolveCurrentRevision(config.graphClient, scope, cur, signal);
        return {
          content: [
            {
              type: "text",
              text:
                `Update rejected: the file "${cur.name}" (${cur.id}) has been ` +
                `modified since you last read it.\n` +
                `Supplied cTag:    ${err.suppliedCTag}\n` +
                `Current cTag:     ${cur.cTag ?? "(unknown)"}\n` +
                `Current Revision: ${formatRevision(currentRevision)}\n` +
                `Modified:         ${cur.lastModifiedDateTime ?? "unknown"}\n` +
                `Size:             ${formatSize(cur.size)}\n\n` +
                `Required next steps:\n` +
                `1. Call markdown_get_file (with itemId="${cur.id}") to fetch the ` +
                `current content and the new cTag. Note the Revision returned - ` +
                `that is the revision you'll be reconciling against.\n` +
                `2. Use markdown_diff_file_versions (with itemId="${cur.id}", ` +
                `fromVersionId=<the revision you originally read>, ` +
                `toVersionId="${currentRevision ?? "<current revision>"}") to see exactly ` +
                `what changed as a unified diff - you do NOT need to compute the diff ` +
                `yourself. If you no longer have the revision you originally read, ` +
                `call markdown_list_file_versions (with itemId="${cur.id}") to ` +
                `discover the available revision IDs.\n` +
                `3. Decide whether your intended update still applies. If it does, ` +
                `reconcile your changes against the new content and call ` +
                `markdown_update_file again with the new cTag. If your update no ` +
                `longer fits the new content, ask the user how to proceed - do not ` +
                `silently discard the user's intent or overwrite the newer version.`,
            },
          ],
          isError: true,
        };
      }
      if (err instanceof MarkdownFileTooLargeError) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      return formatError("markdown_update_file", err);
    }
  };
}

export const markdownUpdateFileTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  handler,
};
