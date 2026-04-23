// MCP tool: markdown_edit — apply targeted text substitutions under cTag-based optimistic concurrency.

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
 * Normalise CRLF and lone CR sequences to LF so the in-memory comparison
 * the markdown_edit tool performs is independent of OneDrive / SharePoint
 * round-tripping. Applied to both the downloaded content and the
 * caller-supplied old_string / new_string values; the persisted content is
 * also LF-only. ADR-0006 decision 3.
 */
function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

const inputSchema = {
  ...idOrNameShape,
  edits: z
    .array(
      z.object({
        old_string: z
          .string()
          .min(1, "old_string must not be empty - it must match a unique substring of the file.")
          .describe(
            "Exact byte-for-byte substring to replace in the current file content. " +
              "After LF normalisation it must match exactly one location, unless " +
              "replace_all is true. Make it long enough (include surrounding " +
              "context) to be unique.",
          ),
        new_string: z
          .string()
          .describe(
            "Replacement text. May be empty to delete the matched region. " +
              "Inserted verbatim - $&, $1, etc. are NOT interpreted as " +
              "regex back-references.",
          ),
        replace_all: z
          .boolean()
          .optional()
          .describe(
            "When true, replaces every occurrence of old_string instead of " +
              "requiring a single match. Still fails if old_string matches zero " +
              "locations - a replace-all that touches nothing is treated as a bug.",
          ),
      }),
    )
    .min(1, "Provide at least one edit.")
    .describe(
      "Sequential edits applied against the evolving in-memory content " +
        "(edit N sees the result of edits 0..N-1). Atomic: if any edit fails, " +
        "the entire batch is rejected and nothing is written.",
    ),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "When true, apply the edits in memory and return the resulting unified " +
        "diff WITHOUT writing to OneDrive. The cTag is not bumped and is omitted " +
        "from structuredContent so the agent does not accidentally use a " +
        "non-existent cTag for a follow-up call.",
    ),
};

const outputSchema = {
  fileName: z.string(),
  itemId: z.string(),
  // Optional because dry_run does not bump the cTag and so cannot
  // surface a "new" one — see ADR-0006 decision 9.
  cTag: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
  editsApplied: z.number().int().nonnegative(),
  // Unified diff (tight context) of the applied edits. Mirrored into
  // structuredContent so MCP clients that prioritise structuredContent
  // over the text content body still surface the diff to the agent and
  // user without an extra round trip. ADR-0006 decision 9.
  diff: z.string(),
};

const def: ToolDef = {
  name: "markdown_edit",
  title: "Edit Markdown File",
  description:
    "Apply one or more targeted text substitutions to an existing markdown " +
    "file in the configured root folder, in a single read-modify-write round " +
    "trip under cTag-based optimistic concurrency. Each edit replaces an " +
    "exact byte-for-byte substring (old_string) with another (new_string); " +
    "no whitespace flexibility, no fuzzy matching. By default each old_string " +
    "must match exactly one location in the current file content - if it " +
    "matches zero locations the call fails and asks the agent to extend " +
    "old_string with surrounding context, and if it matches multiple " +
    "locations the call fails and asks the agent to either extend " +
    "old_string until it matches exactly once or set replace_all: true. " +
    "Edits are applied sequentially against the evolving in-memory content " +
    "(edit N sees the result of edits 0..N-1) and are atomic - if any edit " +
    "fails, the entire batch is rejected and nothing is written. Line " +
    "endings are normalised to LF on read, on inputs, and on the persisted " +
    "result. The tool reads the current cTag itself, so the agent does not " +
    "supply one - cTag mismatch only happens when another writer modifies " +
    "the file between this tool's own GET and PUT, in which case the same " +
    "reconcile guidance as markdown_update_file is returned. Set " +
    "dry_run: true to preview the resulting unified diff without writing. " +
    "On success returns a unified diff (tight context) and the new cTag, " +
    `plus a structuredContent mirror for chained edits. Payloads larger ` +
    `than 4 MiB are rejected (${MARKDOWN_SIZE_CAP_NOTE}). ` +
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
                `"${item.name}" is a subdirectory and cannot be edited by the markdown tools. ` +
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
              text: `"${item.name}" cannot be edited: ${nameCheck.reason}. ${MARKDOWN_FILE_NAME_RULES}`,
            },
          ],
          isError: true,
        };
      }

      const itemId = validateGraphId("item.id", item.id);

      // Single read: pulls content + the cTag we'll need for the
      // conditional PUT. ADR-0006 decision 5: one GET + one
      // conditional PUT per call, no interleaved fetches.
      const { item: liveItem, content: rawBefore } = await downloadMarkdownContentWithItem(
        client,
        scope,
        itemId,
        signal,
      );
      const before = normalizeLineEndings(rawBefore);

      // Apply edits sequentially against the evolving content.
      // ADR-0006 decision 4 (atomic, all-or-nothing).
      let after = before;
      let i = 0;
      for (const edit of args.edits) {
        // The zod schema already rejects empty old_string at input
        // validation, but re-check defensively. The catastrophic
        // `split("").join(new_string)` interleave is the reason this
        // matters for the actual code path used here. (ADR-0006
        // decision 2 also documents an `indexOf("", 0) === 0`
        // infinite-loop argument; that argument applies to the
        // documented `indexOf`-loop spelling and not to the
        // `split`/`join` primitive used below — we still keep the
        // upstream rejection so neither spelling is ever exposed to
        // the empty-needle case.)
        if (edit.old_string.length === 0) {
          return {
            content: [{ type: "text", text: `Edit #${String(i)}: old_string must not be empty.` }],
            isError: true,
          };
        }

        const oldString = normalizeLineEndings(edit.old_string);
        const newString = normalizeLineEndings(edit.new_string);

        if (oldString === newString) {
          return {
            content: [
              {
                type: "text",
                text: `Edit #${String(i)}: old_string and new_string are identical. Edits must change the file.`,
              },
            ],
            isError: true,
          };
        }

        // Single primitive: split/join handles substitution AND gives
        // us the occurrence count for free. ADR-0006 decision 7.
        const parts = after.split(oldString);
        const matches = parts.length - 1;

        if (matches === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Edit #${String(i)}: old_string was not found in the current file ` +
                  `content. Make old_string longer or include more surrounding ` +
                  `context to match exactly one location. Looked for: ${JSON.stringify(oldString)}`,
              },
            ],
            isError: true,
          };
        }
        if (matches > 1 && edit.replace_all !== true) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Edit #${String(i)}: old_string matched ${String(matches)} locations. ` +
                  `Pass replace_all: true to replace every occurrence, or extend ` +
                  `old_string with surrounding context until it matches exactly ` +
                  `one location. Looked for: ${JSON.stringify(oldString)}`,
              },
            ],
            isError: true,
          };
        }

        after = parts.join(newString);
        i++;
      }

      // Defence-in-depth: re-check the post-edit byte size against
      // the same cap updateMarkdownFile enforces. Fail with a
      // clearer, edit-tool-specific message before we attempt the
      // conditional PUT. ADR-0006 decision 6.
      const sizeBytes = Buffer.byteLength(after, "utf-8");
      if (sizeBytes > MAX_DIRECT_CONTENT_BYTES) {
        return {
          content: [
            {
              type: "text",
              text:
                `Edits would produce ${String(sizeBytes)} bytes, which exceeds the ` +
                `${String(MAX_DIRECT_CONTENT_BYTES)}-byte graphdo-ts markdown size ` +
                `cap (${MARKDOWN_SIZE_CAP_NOTE}).`,
            },
          ],
          isError: true,
        };
      }

      const fileName = liveItem.name;
      // Tight diff context (ADR-0006 decision 9, open question 3): the
      // agent just authored the edits and does not need three lines of
      // surrounding markdown to confirm what landed.
      const patch = createTwoFilesPatch(fileName, fileName, before, after, "before", "after", {
        context: 1,
      });
      const editsApplied = args.edits.length;

      if (args.dry_run === true) {
        const dryHeader =
          "(dry run — no changes were written)\n" +
          `Edited ${fileName} (${liveItem.id})\n` +
          `Size: ${String(sizeBytes)} bytes\n` +
          `Edits applied: ${String(editsApplied)}\n` +
          "---\n";
        return {
          content: [{ type: "text", text: dryHeader + patch }],
          // ADR-0006 decision 9: omit cTag on dry_run — no PUT
          // happened, the cTag the agent already holds is still
          // valid and surfacing a "new" one would be misleading.
          structuredContent: {
            fileName,
            itemId: liveItem.id,
            sizeBytes,
            editsApplied,
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
        `Edited ${fileName} (${updated.id})\n` +
        `New cTag: ${newCTag}\n` +
        `Size: ${String(sizeBytes)} bytes\n` +
        `Edits applied: ${String(editsApplied)}\n` +
        "---\n";
      return {
        content: [{ type: "text", text: header + patch }],
        structuredContent: {
          fileName,
          itemId: updated.id,
          cTag: updated.cTag,
          sizeBytes,
          editsApplied,
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
                `Edit rejected: the file "${cur.name}" (${cur.id}) has been ` +
                `modified since markdown_edit started its own read. The edits ` +
                `were NOT applied.\n` +
                `Current cTag:     ${cur.cTag ?? "(unknown)"}\n` +
                `Current Revision: ${formatRevision(currentRevision)}\n` +
                `Modified:         ${cur.lastModifiedDateTime ?? "unknown"}\n` +
                `Size:             ${formatSize(cur.size)}\n\n` +
                `Required next steps:\n` +
                `1. Call markdown_get_file (with itemId="${cur.id}") to fetch the ` +
                `current content. The anchor strings (old_string values) you used ` +
                `may no longer mean what you thought they meant.\n` +
                `2. Use markdown_diff_file_versions (with itemId="${cur.id}") to ` +
                `understand what changed between the revision you originally read ` +
                `and "${currentRevision ?? "<current revision>"}". You do NOT need ` +
                `to compute the diff yourself.\n` +
                `3. Decide whether your edits still apply. If they do, call ` +
                `markdown_edit again - do NOT blindly re-run the same edits, ` +
                `because the file changed underneath you. If your update no longer ` +
                `fits the new content, ask the user how to proceed.`,
            },
          ],
          isError: true,
        };
      }
      if (err instanceof MarkdownFileTooLargeError) {
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      return formatError("markdown_edit", err);
    }
  };
}

export const markdownEditFileTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  outputSchema,
  annotations: {
    // dry_run does not write, but the tool surface as a whole is a write
    // tool. Per ADR-0006 decision 1 (Open question 2), we accept the
    // pessimistic readOnlyHint rather than splitting into two tools.
    readOnlyHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler,
};
