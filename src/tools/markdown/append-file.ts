// MCP tool: markdown_append — append text to the end of an existing markdown file
// in a single read-modify-write round trip protected by the existing cTag flow.
//
// This is the deferred follow-up to markdown_edit (ADR-0006). The motivation
// for not expressing it as an edit anchored on the file's tail is that the
// edit-tool workaround (`{ old_string: <last bytes of file>, new_string:
// <last bytes of file> + <new content> }`) requires the agent to first read
// the file to discover the tail bytes — defeating the token-savings rationale
// of markdown_edit on the very append-style workflows (journals, daily notes,
// running todo logs) where the tool would otherwise pay off the most.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";

import { loadAndValidateWorkspaceConfig } from "../../config.js";
import { meDriveScope } from "../../graph/drives.js";
import { validateGraphId } from "../../graph/ids.js";
import {
  MARKDOWN_FILE_NAME_RULES,
  MAX_DIRECT_CONTENT_BYTES,
  MarkdownCTagMismatchError,
  MarkdownFileTooLargeError,
  downloadMarkdownContentWithItem,
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

/**
 * Normalise CRLF and lone CR sequences to LF — same boundary normalisation
 * that markdown_edit applies. The persisted result is also LF-only.
 */
function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

const inputSchema = {
  ...idOrNameShape,
  content: z
    .string()
    .min(1, "content must not be empty - appending nothing is not a meaningful operation.")
    .describe(
      "Text to append to the end of the file. A single LF separator is " +
        "auto-inserted at the join boundary if (and only if) the existing " +
        "file is non-empty and does not already end with a newline; the " +
        "trailing newline of `content` itself is preserved verbatim. Line " +
        "endings inside `content` are normalised to LF.",
    ),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "When true, compute the resulting unified diff WITHOUT writing to " +
        "OneDrive. The cTag is not bumped and is omitted from " +
        "structuredContent so the agent does not accidentally use a " +
        "non-existent cTag for a follow-up call.",
    ),
};

const outputSchema = {
  fileName: z.string(),
  itemId: z.string(),
  // Optional because dry_run does not bump the cTag and so cannot
  // surface a "new" one — same convention as markdown_edit, ADR-0006
  // decision 9.
  cTag: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
  bytesAppended: z.number().int().nonnegative(),
  // Unified diff (tight context) of the appended region. Mirrored into
  // structuredContent so MCP clients that prioritise structuredContent
  // over the text content body still surface the diff to the agent and
  // user. Same convention as markdown_edit.
  diff: z.string(),
};

const def: ToolDef = {
  name: "markdown_append",
  title: "Append to Markdown File",
  description:
    "Append text to the end of an existing markdown file in the configured " +
    "root folder, in a single read-modify-write round trip under cTag-based " +
    "optimistic concurrency. A single LF separator is auto-inserted at the " +
    "join boundary if (and only if) the existing file is non-empty and does " +
    "not already end with a newline - the agent does NOT need to manage the " +
    "trailing-newline edge case. The trailing newline of `content` itself is " +
    "preserved verbatim. Line endings are normalised to LF on read, on " +
    "input, and on the persisted result. The tool reads the current cTag " +
    "itself, so the agent does not supply one - cTag mismatch only happens " +
    "when another writer modifies the file between this tool's own GET and " +
    "PUT, in which case the same reconcile guidance as markdown_update_file " +
    "is returned. Set dry_run: true to preview the resulting unified diff " +
    "without writing. On success returns a unified diff (tight context) and " +
    "the new cTag, plus a structuredContent mirror for chained calls. " +
    `Payloads larger than 4 MiB after appending are rejected ` +
    `(${MARKDOWN_SIZE_CAP_NOTE}). Use markdown_edit for in-place targeted ` +
    `substitutions; use markdown_update_file when overwriting the entire ` +
    `file. ` +
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

      if (item.folder !== undefined) {
        return {
          content: [
            {
              type: "text",
              text:
                `"${item.name}" is a subdirectory and cannot be appended to by the markdown tools. ` +
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
              text: `"${item.name}" cannot be appended to: ${nameCheck.reason}. ${MARKDOWN_FILE_NAME_RULES}`,
            },
          ],
          isError: true,
        };
      }

      const itemId = validateGraphId("item.id", item.id);

      // Defence-in-depth: zod min(1) already rejects empty content at
      // input validation, but re-check after LF normalisation in case
      // the input was a lone CR that normalises to "\n" (still
      // meaningful) or some future caller bypasses the schema.
      const normalizedContent = normalizeLineEndings(args.content);
      if (normalizedContent.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "content must not be empty - appending nothing is not a meaningful operation.",
            },
          ],
          isError: true,
        };
      }

      // Single read: pulls content + the cTag we'll need for the
      // conditional PUT. Same one-GET-then-one-PUT pattern as
      // markdown_edit (ADR-0006 decision 5).
      const { item: liveItem, content: rawBefore } = await downloadMarkdownContentWithItem(
        client,
        scope,
        itemId,
        signal,
      );
      const before = normalizeLineEndings(rawBefore);

      // Separator policy: insert exactly one LF between the existing
      // tail and the new content if (and only if) the file is
      // non-empty and does not already end with "\n". This is the
      // POSIX "every line ends with \n" convention and the rule that
      // makes the tool agent-ergonomic (no trailing-newline footgun).
      const needsSeparator = before.length > 0 && !before.endsWith("\n");
      const after = before + (needsSeparator ? "\n" : "") + normalizedContent;
      const bytesAppended = Buffer.byteLength(after, "utf-8") - Buffer.byteLength(before, "utf-8");

      // Defence-in-depth: re-check the post-append byte size against
      // the same cap updateMarkdownFile enforces. Fail with a
      // clearer, append-tool-specific message before we attempt the
      // conditional PUT. Mirrors ADR-0006 decision 6.
      const sizeBytes = Buffer.byteLength(after, "utf-8");
      if (sizeBytes > MAX_DIRECT_CONTENT_BYTES) {
        return {
          content: [
            {
              type: "text",
              text:
                `Appending would produce ${String(sizeBytes)} bytes, which exceeds the ` +
                `${String(MAX_DIRECT_CONTENT_BYTES)}-byte graphdo-ts markdown size ` +
                `cap (${MARKDOWN_SIZE_CAP_NOTE}).`,
            },
          ],
          isError: true,
        };
      }

      const fileName = liveItem.name;
      // Tight diff context (1) — same rationale as markdown_edit
      // (ADR-0006 decision 9): the agent just authored the change and
      // does not need three lines of surrounding markdown to confirm
      // what landed.
      const patch = createTwoFilesPatch(fileName, fileName, before, after, "before", "after", {
        context: 1,
      });

      if (args.dry_run === true) {
        const dryHeader =
          "(dry run — no changes were written)\n" +
          `Appended to ${fileName} (${liveItem.id})\n` +
          `Size: ${String(sizeBytes)} bytes (+${String(bytesAppended)})\n` +
          "---\n";
        return {
          content: [{ type: "text", text: dryHeader + patch }],
          // Omit cTag on dry_run — no PUT happened. Same convention
          // as markdown_edit (ADR-0006 decision 9).
          structuredContent: {
            fileName,
            itemId: liveItem.id,
            sizeBytes,
            bytesAppended,
            diff: patch,
          },
        };
      }

      const cTag = liveItem.cTag;
      if (cTag === undefined || cTag.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                `"${fileName}" (${liveItem.id}) was returned by OneDrive ` +
                `without a cTag, which is required for safe optimistic concurrency. ` +
                `Try markdown_get_file followed by markdown_update_file instead.`,
            },
          ],
          isError: true,
        };
      }

      const updated = await updateMarkdownFile(client, scope, itemId, cTag, after, signal);
      const newCTag = updated.cTag ?? "(none)";
      const header =
        `Appended to ${fileName} (${updated.id})\n` +
        `New cTag: ${newCTag}\n` +
        `Size: ${String(sizeBytes)} bytes (+${String(bytesAppended)})\n` +
        "---\n";
      return {
        content: [{ type: "text", text: header + patch }],
        structuredContent: {
          fileName,
          itemId: updated.id,
          cTag: updated.cTag,
          sizeBytes,
          bytesAppended,
          diff: patch,
        },
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
                `Append rejected: the file "${cur.name}" (${cur.id}) has been ` +
                `modified since markdown_append started its own read. The append ` +
                `was NOT applied.\n` +
                `Current cTag:     ${cur.cTag ?? "(unknown)"}\n` +
                `Current Revision: ${formatRevision(currentRevision)}\n` +
                `Modified:         ${cur.lastModifiedDateTime ?? "unknown"}\n` +
                `Size:             ${formatSize(cur.size)}\n\n` +
                `Required next steps:\n` +
                `1. Call markdown_get_file (with itemId="${cur.id}") to fetch the ` +
                `current content. Another writer may have already added what you ` +
                `intended to append, or changed the file in a way that affects ` +
                `whether your append still makes sense.\n` +
                `2. Use markdown_diff_file_versions (with itemId="${cur.id}") to ` +
                `understand what changed between the revision you originally read ` +
                `and "${currentRevision ?? "<current revision>"}". You do NOT need ` +
                `to compute the diff yourself.\n` +
                `3. Decide whether your append still applies. If it does, call ` +
                `markdown_append again - do NOT blindly retry without checking, ` +
                `because the file changed underneath you. If your update no longer ` +
                `fits, ask the user how to proceed.`,
            },
          ],
          isError: true,
        };
      }
      if (err instanceof MarkdownFileTooLargeError) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      return formatError("markdown_append", err);
    }
  };
}

export const markdownAppendFileTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  outputSchema,
  annotations: {
    // dry_run does not write, but the tool surface as a whole is a
    // write tool. Same pessimistic-readOnlyHint convention as
    // markdown_edit (ADR-0006 decision 1, open question 2).
    readOnlyHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler,
};
