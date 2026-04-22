// Tool registration for the markdown family. Split out from `./markdown.ts`.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";

import { loadAndValidateMarkdownConfig, updateConfig } from "../config.js";
import { UserCancelledError } from "../errors.js";
import { validateGraphId } from "../graph/ids.js";
import {
  createMarkdownFile,
  deleteDriveItem,
  downloadMarkdownContent,
  downloadMarkdownContentWithItem,
  getMyDrive,
  getRevisionContent,
  listDriveItemVersions,
  listMarkdownFolderEntries,
  MarkdownFolderEntryKind,
  listRootFolders,
  MarkdownCTagMismatchError,
  MarkdownFileAlreadyExistsError,
  MarkdownFileTooLargeError,
  MarkdownUnknownVersionError,
  MAX_DIRECT_CONTENT_BYTES,
  MARKDOWN_FILE_NAME_RULES,
  buildMarkdownPreviewUrl,
  resolveCurrentRevision,
  updateMarkdownFile,
  validateMarkdownFileName,
} from "../graph/markdown.js";
import type { ServerConfig } from "../index.js";
import { logger } from "../logger.js";
import { startBrowserPicker } from "../picker.js";
import type { ToolEntry } from "../tool-registry.js";
import { defineTool } from "../tool-registry.js";
import { formatError, retryHintForPickerError } from "./shared.js";

import {
  CREATE_FILE_DEF,
  DELETE_FILE_DEF,
  DIFF_VERSIONS_DEF,
  EDIT_FILE_DEF,
  GET_FILE_DEF,
  GET_VERSION_DEF,
  LIST_FILES_DEF,
  LIST_VERSIONS_DEF,
  MARKDOWN_SIZE_CAP_NOTE,
  PREVIEW_FILE_DEF,
  SELECT_ROOT_DEF,
  UPDATE_FILE_DEF,
} from "./markdown-defs.js";
import {
  formatRevision,
  formatSize,
  idOrNameShape,
  markdownNameSchema,
  resolveDriveItem,
  tryGetDriveWebUrl,
} from "./markdown-helpers.js";

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

/** Register all markdown tools on the given MCP server. */
export function registerMarkdownTools(server: McpServer, config: ServerConfig): ToolEntry[] {
  const entries: ToolEntry[] = [];

  // -------- markdown_select_root_folder --------
  entries.push(
    defineTool(
      server,
      SELECT_ROOT_DEF,
      {
        inputSchema: z.object({}).shape,
        annotations: {
          title: SELECT_ROOT_DEF.title,
          readOnlyHint: false,
          openWorldHint: true,
        },
      },
      async (_args, { signal }) => {
        try {
          const client = config.graphClient;

          // Fetch the drive's webUrl so the "Create new folder" link points to
          // the user's _own_ OneDrive (work/school/personal/sovereign) rather
          // than a hardcoded consumer URL. If the drive can't be loaded for
          // any reason, fall back to the public consumer URL — the picker is
          // still usable, just with a generic link.
          const folders = await listRootFolders(client, signal);
          const driveWebUrl = await tryGetDriveWebUrl(client, signal);

          if (folders.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    "No top-level folders are available to choose from. " +
                    "Create a folder in your markdown storage location first, then run this tool again.",
                },
              ],
            };
          }

          const handle = await startBrowserPicker(
            {
              title: "Select Markdown Root Folder",
              subtitle:
                "Choose a single top-level folder in your OneDrive. graphdo will only operate on files directly inside this folder — subdirectories are not supported.",
              options: folders.map((f) => ({ id: f.id, label: `/${f.name}` })),
              filterPlaceholder: "Filter folders...",
              refreshOptions: async (s) => {
                const refreshed = await listRootFolders(client, s);
                return refreshed.map((f) => ({ id: f.id, label: `/${f.name}` }));
              },
              createLink: {
                url: driveWebUrl,
                label: "Create a new folder in OneDrive",
                description:
                  "Open your OneDrive in a new tab, create a top-level folder there, then click Refresh here to see it in the list.",
              },
              onSelect: async (option, s) => {
                await updateConfig(
                  {
                    markdown: {
                      rootFolderId: option.id,
                      rootFolderName: option.label.replace(/^\//, ""),
                      rootFolderPath: option.label,
                    },
                  },
                  config.configDir,
                  s,
                );
              },
            },
            signal,
          );

          let browserOpened = false;
          try {
            await config.openBrowser(handle.url);
            browserOpened = true;
            logger.info("markdown root folder picker opened", { url: handle.url });
          } catch (err: unknown) {
            logger.warn("could not open browser for markdown root folder picker", {
              error: err instanceof Error ? err.message : String(err),
            });
          }

          const instruction = browserOpened
            ? "A browser window has been opened to select the markdown root folder. " +
              "Waiting for you to make a selection..."
            : "Could not open a browser automatically. " +
              `Please visit this URL to select the markdown root folder:\n\n${handle.url}\n\n` +
              "Waiting for you to make a selection...";

          const result = await handle.waitForSelection;

          return {
            content: [
              {
                type: "text",
                text:
                  `${instruction}\n\nMarkdown root folder configured: ${result.selected.label} ` +
                  `(${result.selected.id})`,
              },
            ],
          };
        } catch (err: unknown) {
          if (err instanceof UserCancelledError) {
            return {
              content: [{ type: "text", text: "Markdown root folder selection cancelled." }],
            };
          }
          return formatError("markdown_select_root_folder", err, {
            suffix: retryHintForPickerError(err),
          });
        }
      },
    ),
  );

  // -------- markdown_list_files --------
  entries.push(
    defineTool(
      server,
      LIST_FILES_DEF,
      {
        inputSchema: z.object({}).shape,
        annotations: {
          title: LIST_FILES_DEF.title,
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      async (_args, { signal }) => {
        try {
          const cfg = await loadAndValidateMarkdownConfig(config.configDir, signal);
          const client = config.graphClient;
          const allEntries = await listMarkdownFolderEntries(
            client,
            cfg.markdown.rootFolderId,
            signal,
          );

          const supported = allEntries.filter((e) => e.kind === MarkdownFolderEntryKind.Supported);
          const unsupported = allEntries.filter(
            (e) => e.kind === MarkdownFolderEntryKind.Unsupported,
          );

          const folderLabel =
            cfg.markdown.rootFolderPath ?? cfg.markdown.rootFolderName ?? "the configured folder";
          const header = `Markdown files in ${folderLabel}:`;

          const sections: string[] = [header];

          if (supported.length === 0) {
            sections.push("\nNo supported markdown files found.");
          } else {
            const lines = supported.map((entry, i) => {
              const f = entry.item;
              const modified = f.lastModifiedDateTime ?? "unknown";
              return `${String(i + 1)}. ${f.name} — ${formatSize(f.size)}, modified ${modified} (${f.id})`;
            });
            sections.push(`\n${lines.join("\n")}`);
          }

          if (unsupported.length > 0) {
            const unsupportedLines = unsupported.map((entry, i) => {
              const f = entry.item;
              const kind = f.folder !== undefined ? "subdirectory" : "file";
              return `${String(i + 1)}. [UNSUPPORTED ${kind}] ${f.name} — ${entry.reason}`;
            });
            sections.push(
              "\nUNSUPPORTED entries (visible but cannot be read, written, or deleted by the markdown tools):\n" +
                unsupportedLines.join("\n"),
            );
          }

          sections.push(
            `\nTotal: ${String(supported.length)} supported, ${String(unsupported.length)} unsupported`,
          );

          return {
            content: [{ type: "text", text: sections.join("\n") }],
          };
        } catch (err: unknown) {
          return formatError("markdown_list_files", err);
        }
      },
    ),
  );

  // -------- markdown_get_file --------
  entries.push(
    defineTool(
      server,
      GET_FILE_DEF,
      {
        inputSchema: idOrNameShape,
        annotations: {
          title: GET_FILE_DEF.title,
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      async (args, { signal }) => {
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
      },
    ),
  );

  // -------- markdown_create_file --------
  entries.push(
    defineTool(
      server,
      CREATE_FILE_DEF,
      {
        inputSchema: {
          fileName: markdownNameSchema.describe(
            "File name, must end in .md. Must not already exist in the configured root folder.",
          ),
          content: z
            .string()
            .describe(
              `UTF-8 markdown content (max 4 MiB / 4,194,304 bytes; ${MARKDOWN_SIZE_CAP_NOTE}).`,
            ),
        },
        annotations: {
          title: CREATE_FILE_DEF.title,
          readOnlyHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (args, { signal }) => {
        try {
          const cfg = await loadAndValidateMarkdownConfig(config.configDir, signal);
          const client = config.graphClient;
          const item = await createMarkdownFile(
            client,
            cfg.markdown.rootFolderId,
            args.fileName,
            args.content,
            signal,
          );
          const revision = await resolveCurrentRevision(client, item, signal);
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
      },
    ),
  );

  // -------- markdown_update_file --------
  entries.push(
    defineTool(
      server,
      UPDATE_FILE_DEF,
      {
        inputSchema: {
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
        },
        annotations: {
          title: UPDATE_FILE_DEF.title,
          readOnlyHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (args, { signal }) => {
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

          // Defence in depth: re-validate the resolved item before writing.
          if (item.folder !== undefined) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `"${item.name}" is a subdirectory and cannot be updated by the markdown tools. ` +
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
                  text: `"${item.name}" cannot be updated: ${nameCheck.reason}. ${MARKDOWN_FILE_NAME_RULES}`,
                },
              ],
              isError: true,
            };
          }

          const updated = await updateMarkdownFile(
            client,
            validateGraphId("item.id", item.id),
            args.cTag,
            args.content,
            signal,
          );
          const revision = await resolveCurrentRevision(client, updated, signal);
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
          if (err instanceof MarkdownCTagMismatchError) {
            const cur = err.currentItem;
            const currentRevision = await resolveCurrentRevision(config.graphClient, cur, signal);
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
      },
    ),
  );

  // -------- markdown_edit --------
  entries.push(
    defineTool(
      server,
      EDIT_FILE_DEF,
      {
        inputSchema: {
          ...idOrNameShape,
          edits: z
            .array(
              z.object({
                old_string: z
                  .string()
                  .min(
                    1,
                    "old_string must not be empty - it must match a unique substring of the file.",
                  )
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
        },
        outputSchema: {
          fileName: z.string(),
          itemId: z.string(),
          // Optional because dry_run does not bump the cTag and so cannot
          // surface a "new" one — see ADR-0006 decision 9.
          cTag: z.string().optional(),
          sizeBytes: z.number().int().nonnegative(),
          editsApplied: z.number().int().nonnegative(),
        },
        annotations: {
          title: EDIT_FILE_DEF.title,
          // dry_run does not write, but the tool surface as a whole is a write
          // tool. Per ADR-0006 decision 1 (Open question 2), we accept the
          // pessimistic readOnlyHint rather than splitting into two tools.
          readOnlyHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (args, { signal }) => {
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
                    `"${item.name}" is a subdirectory and cannot be edited by the markdown tools. ` +
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
                content: [
                  { type: "text", text: `Edit #${String(i)}: old_string must not be empty.` },
                ],
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

          const updated = await updateMarkdownFile(client, itemId, cTag, after, signal);
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
            },
          };
        } catch (err: unknown) {
          if (err instanceof MarkdownCTagMismatchError) {
            const cur = err.currentItem;
            const currentRevision = await resolveCurrentRevision(config.graphClient, cur, signal);
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
      },
    ),
  );

  // -------- markdown_delete_file --------
  entries.push(
    defineTool(
      server,
      DELETE_FILE_DEF,
      {
        inputSchema: idOrNameShape,
        annotations: {
          title: DELETE_FILE_DEF.title,
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
      },
      async (args, { signal }) => {
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
            content: [
              {
                type: "text",
                text: `Deleted "${item.name}" (${item.id}).`,
              },
            ],
          };
        } catch (err: unknown) {
          return formatError("markdown_delete_file", err);
        }
      },
    ),
  );

  // -------- markdown_list_file_versions --------
  entries.push(
    defineTool(
      server,
      LIST_VERSIONS_DEF,
      {
        inputSchema: idOrNameShape,
        annotations: {
          title: LIST_VERSIONS_DEF.title,
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      async (args, { signal }) => {
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
      },
    ),
  );

  // -------- markdown_get_file_version --------
  entries.push(
    defineTool(
      server,
      GET_VERSION_DEF,
      {
        inputSchema: {
          ...idOrNameShape,
          versionId: z
            .string()
            .min(1)
            .describe("Opaque version ID previously returned by markdown_list_file_versions."),
        },
        annotations: {
          title: GET_VERSION_DEF.title,
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      async (args, { signal }) => {
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
            item,
            validateGraphId("versionId", args.versionId),
            signal,
          );

          const versionNote = isCurrent
            ? "(current version content)"
            : "(historical content, not the current version — use markdown_update_file to restore)";
          const header =
            `${item.name} (${item.id})\n` +
            `Version: ${args.versionId}\n` +
            `${versionNote}\n` +
            "---";
          return {
            content: [{ type: "text", text: `${header}\n${content}` }],
          };
        } catch (err: unknown) {
          if (err instanceof MarkdownFileTooLargeError) {
            return { content: [{ type: "text", text: err.message }], isError: true };
          }
          return formatError("markdown_get_file_version", err);
        }
      },
    ),
  );

  // -------- markdown_diff_file_versions --------
  entries.push(
    defineTool(
      server,
      DIFF_VERSIONS_DEF,
      {
        inputSchema: {
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
        },
        annotations: {
          title: DIFF_VERSIONS_DEF.title,
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      async (args, { signal }) => {
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
                  text:
                    `"${item.name}" cannot be diffed: ${nameCheck.reason}. ` +
                    MARKDOWN_FILE_NAME_RULES,
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
            getRevisionContent(client, item, fromVersionId, signal),
            getRevisionContent(client, item, toVersionId, signal),
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
      },
    ),
  );

  // -------- markdown_preview_file --------
  entries.push(
    defineTool(
      server,
      PREVIEW_FILE_DEF,
      {
        inputSchema: {
          fileName: markdownNameSchema.describe(
            "Markdown file name. Must follow the strict naming rules: " + MARKDOWN_FILE_NAME_RULES,
          ),
        },
        annotations: {
          title: PREVIEW_FILE_DEF.title,
          readOnlyHint: true,
          openWorldHint: true,
        },
      },
      async (args, { signal }) => {
        try {
          const cfg = await loadAndValidateMarkdownConfig(config.configDir, signal);
          const client = config.graphClient;

          const item = await resolveDriveItem(
            client,
            cfg.markdown.rootFolderId,
            { fileName: args.fileName },
            signal,
          );

          if (item.folder !== undefined) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `"${item.name}" is a subdirectory and cannot be previewed by the markdown tools. ` +
                    "The markdown tools only operate on files directly in the configured root folder.",
                },
              ],
              isError: true,
            };
          }

          // Fetch the drive metadata so we can build the human-friendly
          // SharePoint preview URL. Unlike the picker, this is _not_
          // best-effort — without `webUrl` we cannot build a correct
          // preview URL, so failures here surface as a tool error.
          const drive = await getMyDrive(client, signal);
          const previewUrl = buildMarkdownPreviewUrl(drive, item);

          let browserOpened = false;
          try {
            await config.openBrowser(previewUrl);
            browserOpened = true;
            logger.info("markdown preview opened", { fileName: item.name, url: previewUrl });
          } catch (err: unknown) {
            logger.warn("could not open browser for markdown preview", {
              error: err instanceof Error ? err.message : String(err),
            });
          }

          const text = browserOpened
            ? `Opened "${item.name}" in your default browser.\n\nPreview URL:\n${previewUrl}`
            : "Could not open a browser automatically. " +
              `Please open this URL to preview "${item.name}":\n\n${previewUrl}`;

          return { content: [{ type: "text", text }] };
        } catch (err: unknown) {
          return formatError("markdown_preview_file", err);
        }
      },
    ),
  );

  return entries;
}
