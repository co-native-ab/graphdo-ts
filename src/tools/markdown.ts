// MCP tools for OneDrive-backed markdown file management.
//
// All file operations are scoped to a root folder that is selected once by the
// user via a browser picker (human-only action, analogous to `todo_select_list`).
// The selection is persisted to `markdown.rootFolderId` in the shared config.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";

import { loadAndValidateMarkdownConfig, updateConfig } from "../config.js";
import { UserCancelledError } from "../errors.js";
import {
  createMarkdownFile,
  deleteDriveItem,
  downloadMarkdownContent,
  findMarkdownFileByName,
  getDriveItem,
  getMyDrive,
  getRevisionContent,
  listDriveItemVersions,
  listMarkdownFolderEntries,
  MarkdownFolderEntryKind,
  listRootFolders,
  MarkdownEtagMismatchError,
  MarkdownFileAlreadyExistsError,
  MarkdownFileTooLargeError,
  MarkdownUnknownVersionError,
  MARKDOWN_FILE_NAME_RULES,
  buildMarkdownPreviewUrl,
  updateMarkdownFile,
  validateMarkdownFileName,
} from "../graph/markdown.js";
import type { DriveItem } from "../graph/types.js";
import type { ServerConfig } from "../index.js";
import { logger } from "../logger.js";
import { startBrowserPicker } from "../picker.js";
import { GraphScope } from "../scopes.js";
import type { ToolDef, ToolEntry } from "../tool-registry.js";
import { defineTool } from "../tool-registry.js";
import { formatError } from "./shared.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
//
// All markdown tools operate on the signed-in user's own OneDrive, scoped to a
// single root folder selected via markdown_select_root_folder.

// Standard parenthetical to make clear that the 4 MiB ceiling is a graphdo-ts
// policy, not a Microsoft Graph API limit (Graph itself accepts up to 250 MB
// via /content). Reused verbatim across tool descriptions and input schemas.
const MARKDOWN_SIZE_CAP_NOTE = "graphdo-ts tool-side cap, not a Microsoft Graph API limit";

const SELECT_ROOT_DEF: ToolDef = {
  name: "markdown_select_root_folder",
  title: "Select Markdown Root Folder",
  description:
    "Select the root folder that graphdo should use for markdown files in " +
    "the signed-in user's OneDrive. Call this tool directly when a markdown " +
    "root folder has not been configured yet - do not ask the user which " +
    "folder, this tool opens a browser picker where the user makes the " +
    "selection themselves. This is a human-only action - the AI agent cannot " +
    "choose the folder programmatically. Calling it again overwrites the " +
    "stored value.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

const LIST_FILES_DEF: ToolDef = {
  name: "markdown_list_files",
  title: "List Markdown Files",
  description:
    "List markdown files directly inside the configured root folder in the " +
    "signed-in user's OneDrive. Each entry reports the file name, opaque " +
    "file ID, last modified timestamp, and size in bytes. Subdirectories " +
    "and files whose names do not follow the strict naming rules are also " +
    "reported, but marked as UNSUPPORTED - these entries exist but cannot " +
    "be read, written, or deleted by the markdown tools. " +
    MARKDOWN_FILE_NAME_RULES,
  requiredScopes: [GraphScope.FilesReadWrite],
};

const GET_FILE_DEF: ToolDef = {
  name: "markdown_get_file",
  title: "Get Markdown File",
  description:
    "Read a markdown file from the signed-in user's OneDrive (the configured " +
    "root folder). Accepts either a file ID (from markdown_list_files) or a " +
    "file name. File names must follow the strict naming rules and are " +
    "rejected otherwise - paths, subdirectories, and characters that are " +
    "not portable across Linux, macOS, and Windows are not allowed. Returns " +
    "the current UTF-8 content of the file along with its etag, which " +
    "markdown_update_file requires for safe optimistic concurrency. Files " +
    "larger than 4 MiB cannot be downloaded and will return an error " +
    `(${MARKDOWN_SIZE_CAP_NOTE}). ` +
    "To read a previous version, use markdown_get_file_version. " +
    MARKDOWN_FILE_NAME_RULES,
  requiredScopes: [GraphScope.FilesReadWrite],
};

const CREATE_FILE_DEF: ToolDef = {
  name: "markdown_create_file",
  title: "Create Markdown File",
  description:
    "Create a new markdown file in the configured root folder. Fails with a " +
    "clear error when a file with the same name already exists - in that " +
    "case, call markdown_get_file to fetch the existing content and etag, " +
    "then call markdown_update_file. The file name must follow the strict " +
    "naming rules - paths, subdirectories, and characters that are not " +
    "portable across Linux, macOS, and Windows are rejected. Payloads " +
    `larger than 4 MiB are rejected (${MARKDOWN_SIZE_CAP_NOTE}). ` +
    MARKDOWN_FILE_NAME_RULES,
  requiredScopes: [GraphScope.FilesReadWrite],
};

const UPDATE_FILE_DEF: ToolDef = {
  name: "markdown_update_file",
  title: "Update Markdown File",
  description:
    "Overwrite the content of an existing markdown file in the configured " +
    "root folder. Requires the etag previously returned by markdown_get_file " +
    "(or markdown_create_file / markdown_update_file). The update succeeds " +
    "only when the supplied etag matches the file's current etag - if the " +
    "file has changed since you read it, the call fails with the current " +
    "etag and modification time. When that happens you must call " +
    "markdown_get_file again to retrieve the latest content + etag, decide " +
    "whether your intended update still applies, reconcile your changes " +
    "against any new content, and call markdown_update_file again with the " +
    "new etag - or ask the user how to proceed if the meaning of your " +
    "update no longer fits. Accepts the file by id (preferred) or by name. " +
    `Payloads larger than 4 MiB are rejected (${MARKDOWN_SIZE_CAP_NOTE}). ` +
    MARKDOWN_FILE_NAME_RULES,
  requiredScopes: [GraphScope.FilesReadWrite],
};

const DELETE_FILE_DEF: ToolDef = {
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

const LIST_VERSIONS_DEF: ToolDef = {
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

const GET_VERSION_DEF: ToolDef = {
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

const DIFF_VERSIONS_DEF: ToolDef = {
  name: "markdown_diff_file_versions",
  title: "Diff Markdown File Versions",
  description:
    "Return a unified diff between two revisions of a markdown file in the " +
    "configured root folder, computed server-side so you do not have to " +
    "diff the content yourself. Accepts the file by id (preferred) or name, " +
    "plus a fromVersionId and a toVersionId. Each ID may be either a " +
    "historical version ID returned by markdown_list_file_versions, or the " +
    "current Revision surfaced by markdown_get_file / markdown_create_file / " +
    "markdown_update_file (including the Current Revision reported in an " +
    "etag-mismatch error). This is the preferred way to reconcile a stale " +
    "update: pass the revision you originally read as fromVersionId and the " +
    "current revision as toVersionId. Returns a text/x-diff unified patch. " +
    MARKDOWN_FILE_NAME_RULES,
  requiredScopes: [GraphScope.FilesReadWrite],
};

const PREVIEW_FILE_DEF: ToolDef = {
  name: "markdown_preview_file",
  title: "Preview Markdown File in Browser",
  description:
    "Open a markdown file from the configured root folder in the user's " +
    "browser using the SharePoint OneDrive web preview, which renders the " +
    "markdown nicely instead of triggering a download. Accepts the file " +
    "name only (the preview URL is human-facing, so the agent should look " +
    "the file up by name the same way a user would refer to it). The tool " +
    "opens the URL in the default browser via the configured browser " +
    "launcher and also returns the URL as text so it can be shared. " +
    "Consumer OneDrive (onedrive.live.com) is not supported. " +
    MARKDOWN_FILE_NAME_RULES,
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const MARKDOWN_TOOL_DEFS: readonly ToolDef[] = [
  SELECT_ROOT_DEF,
  LIST_FILES_DEF,
  GET_FILE_DEF,
  CREATE_FILE_DEF,
  UPDATE_FILE_DEF,
  DELETE_FILE_DEF,
  LIST_VERSIONS_DEF,
  GET_VERSION_DEF,
  DIFF_VERSIONS_DEF,
  PREVIEW_FILE_DEF,
];

// ---------------------------------------------------------------------------
// Zod helpers
// ---------------------------------------------------------------------------

/**
 * Zod schema for strict markdown file names. Applies the full
 * {@link validateMarkdownFileName} check at input-validation time so the MCP
 * SDK rejects bad names before the handler runs.
 */
const markdownNameSchema = z.string().superRefine((value, ctx) => {
  const result = validateMarkdownFileName(value);
  if (!result.valid) {
    ctx.addIssue({ code: "custom", message: result.reason });
  }
});

// Either an ID or a name must be provided. The input object shape is the
// full union — validation of "exactly one" is done in the handler because MCP
// tool inputs must be plain object schemas without discriminated unions.
//
// The fileName field uses the strict markdown name schema so the MCP SDK
// rejects unsafe or non-portable names (path separators, Windows reserved
// names, etc.) at input-validation time, before any handler code runs. The
// handler still re-validates the resolved item's stored name as defence in
// depth.
const idOrNameShape = {
  itemId: z
    .string()
    .min(1)
    .optional()
    .describe("Opaque file ID previously returned by markdown_list_files."),
  fileName: markdownNameSchema
    .optional()
    .describe(
      "Markdown file name. Must follow the strict naming rules: " + MARKDOWN_FILE_NAME_RULES,
    ),
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveDriveItem(
  client: ServerConfig["graphClient"],
  folderId: string,
  args: { itemId?: string; fileName?: string },
  signal: AbortSignal,
): Promise<DriveItem> {
  if (args.itemId) {
    return getDriveItem(client, args.itemId, signal);
  }
  if (!args.fileName) {
    throw new Error("Either itemId or fileName must be provided.");
  }
  const validation = validateMarkdownFileName(args.fileName);
  if (!validation.valid) {
    throw new Error(
      `Invalid markdown file name "${args.fileName}": ${validation.reason}. ${MARKDOWN_FILE_NAME_RULES}`,
    );
  }
  const match = await findMarkdownFileByName(client, folderId, args.fileName, signal);
  if (!match) {
    throw new Error(`Markdown file "${args.fileName}" not found in the configured root folder.`);
  }
  // Defensive: the stored name on the remote could still be unsafe even if the
  // caller-supplied name was fine (e.g. a rename happened after creation).
  // Block reads/deletes on such items.
  const storedValidation = validateMarkdownFileName(match.name);
  if (!storedValidation.valid) {
    throw new Error(
      `Matched file "${match.name}" has a name that is not supported by the markdown tools: ` +
        `${storedValidation.reason}. Use markdown_list_files to see entries marked UNSUPPORTED.`,
    );
  }
  return match;
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "unknown size";
  return `${String(bytes)} bytes`;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

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
          const isTimeout = err instanceof Error && err.message.toLowerCase().includes("timed out");
          const retryHint = isTimeout
            ? "\n\nThe user did not make a selection in time. " +
              "You can call this tool again if the user would like to retry."
            : "\n\nYou can call this tool again if the user would like to retry.";
          return formatError("markdown_select_root_folder", err, { suffix: retryHint });
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

          const content = await downloadMarkdownContent(client, item.id, signal);

          const header =
            `${item.name} (${item.id})\n` +
            `Size: ${formatSize(item.size)}\n` +
            `Modified: ${item.lastModifiedDateTime ?? "unknown"}\n` +
            `Revision: ${item.version ?? "(none)"}\n` +
            `eTag: ${item.eTag ?? "(none)"}\n` +
            "(supply the eTag verbatim to markdown_update_file for safe optimistic concurrency; " +
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
          const bytes = Buffer.byteLength(args.content, "utf-8");
          return {
            content: [
              {
                type: "text",
                text:
                  `Created "${item.name}" (${item.id})\n` +
                  `Size: ${String(bytes)} bytes\n` +
                  `Revision: ${item.version ?? "(none)"}\n` +
                  `eTag: ${item.eTag ?? "(none)"}\n` +
                  "(supply the eTag verbatim to markdown_update_file for safe optimistic concurrency)",
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
                    `content and eTag, decide whether your update still applies, then ` +
                    `call markdown_update_file with the eTag.`,
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
          etag: z
            .string()
            .min(1)
            .describe(
              "Opaque eTag previously returned by markdown_get_file, " +
                "markdown_create_file, or markdown_update_file. Sent verbatim in If-Match.",
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
            item.id,
            args.etag,
            args.content,
            signal,
          );
          const bytes = Buffer.byteLength(args.content, "utf-8");
          return {
            content: [
              {
                type: "text",
                text:
                  `Updated "${updated.name}" (${updated.id})\n` +
                  `Size: ${String(bytes)} bytes\n` +
                  `Revision: ${updated.version ?? "(none)"}\n` +
                  `eTag: ${updated.eTag ?? "(none)"}\n` +
                  "(supply the new eTag verbatim to the next markdown_update_file call)",
              },
            ],
          };
        } catch (err: unknown) {
          if (err instanceof MarkdownEtagMismatchError) {
            const cur = err.currentItem;
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Update rejected: the file "${cur.name}" (${cur.id}) has been ` +
                    `modified since you last read it.\n` +
                    `Supplied eTag:    ${err.suppliedEtag}\n` +
                    `Current eTag:     ${cur.eTag ?? "(unknown)"}\n` +
                    `Current Revision: ${cur.version ?? "(unknown)"}\n` +
                    `Modified:         ${cur.lastModifiedDateTime ?? "unknown"}\n` +
                    `Size:             ${formatSize(cur.size)}\n\n` +
                    `Required next steps:\n` +
                    `1. Call markdown_get_file (with itemId="${cur.id}") to fetch the ` +
                    `current content and the new eTag. Note the Revision returned - ` +
                    `that is the revision you'll be reconciling against.\n` +
                    `2. Use markdown_diff_file_versions (with itemId="${cur.id}", ` +
                    `fromVersionId=<the revision you originally read>, ` +
                    `toVersionId="${cur.version ?? "<current revision>"}") to see exactly ` +
                    `what changed as a unified diff - you do NOT need to compute the diff ` +
                    `yourself.\n` +
                    `3. Decide whether your intended update still applies. If it does, ` +
                    `reconcile your changes against the new content and call ` +
                    `markdown_update_file again with the new eTag. If your update no ` +
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

          await deleteDriveItem(client, item.id, signal);

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

          const versions = await listDriveItemVersions(client, item.id, signal);

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
            args.versionId,
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
                "markdown_update_file (e.g. the 'Current Revision' reported in an " +
                "etag-mismatch error).",
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

          const [from, to] = await Promise.all([
            getRevisionContent(client, item, args.fromVersionId, signal),
            getRevisionContent(client, item, args.toVersionId, signal),
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

// ---------------------------------------------------------------------------
// Drive webUrl lookup (best-effort)
// ---------------------------------------------------------------------------

/** Fallback link used when `GET /me/drive` fails or returns no `webUrl`. */
const DEFAULT_ONEDRIVE_WEB_URL = "https://onedrive.live.com/";

/**
 * Best-effort fetch of the user's OneDrive `webUrl`. Returns the configured
 * fallback link when the Graph call fails or when the drive has no `webUrl`.
 * We never want the picker to _fail_ just because we couldn't resolve a
 * deep-link — the picker's core function (selecting a folder) does not
 * depend on the create-link being accurate.
 */
async function tryGetDriveWebUrl(
  client: import("../graph/client.js").GraphClient,
  signal: AbortSignal,
): Promise<string> {
  try {
    const drive = await getMyDrive(client, signal);
    const webUrl = drive.webUrl;
    if (typeof webUrl === "string" && webUrl.length > 0) {
      return webUrl;
    }
    logger.warn("/me/drive returned no webUrl; using fallback OneDrive link");
    return DEFAULT_ONEDRIVE_WEB_URL;
  } catch (err: unknown) {
    logger.warn("failed to load /me/drive; using fallback OneDrive link", {
      error: err instanceof Error ? err.message : String(err),
    });
    return DEFAULT_ONEDRIVE_WEB_URL;
  }
}
