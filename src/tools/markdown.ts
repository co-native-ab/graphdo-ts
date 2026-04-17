// MCP tools for OneDrive-backed markdown file management.
//
// All file operations are scoped to a root folder that is selected once by the
// user via a browser picker (human-only action, analogous to `todo_config`).
// The selection is persisted to `markdown.rootFolderId` in the shared config.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadAndValidateMarkdownConfig, updateConfig } from "../config.js";
import { UserCancelledError } from "../errors.js";
import {
  deleteDriveItem,
  downloadMarkdownContent,
  findMarkdownFileByName,
  getDriveItem,
  listMarkdownFolderEntries,
  listRootFolders,
  MarkdownFileTooLargeError,
  MARKDOWN_FILE_NAME_RULES,
  uploadMarkdownContent,
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

const SELECT_ROOT_DEF: ToolDef = {
  name: "markdown_select_root_folder",
  title: "Select Markdown Root Folder",
  description:
    "Select the root folder that graphdo should use for markdown files. Call " +
    "this tool directly when a markdown root folder has not been configured " +
    "yet - do not ask the user which folder, this tool opens a browser picker " +
    "where the user makes the selection themselves. This is a human-only " +
    "action - the AI agent cannot choose the folder programmatically. Calling " +
    "it again overwrites the stored value.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

const LIST_FILES_DEF: ToolDef = {
  name: "markdown_list_files",
  title: "List Markdown Files",
  description:
    "List markdown files directly inside the configured root folder. Each " +
    "entry reports the file name, opaque file ID, last modified timestamp, " +
    "and size in bytes. Subdirectories and files whose names do not follow " +
    "the strict naming rules are also reported, but marked as UNSUPPORTED - " +
    "these entries exist but cannot be read, written, or deleted by the " +
    "markdown tools. " +
    MARKDOWN_FILE_NAME_RULES,
  requiredScopes: [GraphScope.FilesReadWrite],
};

const GET_FILE_DEF: ToolDef = {
  name: "markdown_get_file",
  title: "Get Markdown File",
  description:
    "Read a markdown file from the configured root folder. Accepts either a " +
    "file ID (from markdown_list_files) or a file name. File names must follow " +
    "the strict naming rules and are rejected otherwise - paths, subdirectories, " +
    "and characters that are not portable across Linux, macOS, and Windows are " +
    "not allowed. Returns the file's UTF-8 content. Files larger than 4 MB " +
    "cannot be downloaded and will return an error. " +
    MARKDOWN_FILE_NAME_RULES,
  requiredScopes: [GraphScope.FilesReadWrite],
};

const UPLOAD_FILE_DEF: ToolDef = {
  name: "markdown_upload_file",
  title: "Upload Markdown File",
  description:
    "Create or overwrite a markdown file in the configured root folder. " +
    "The file name must follow the strict naming rules - paths, subdirectories, " +
    "and characters that are not portable across Linux, macOS, and Windows are " +
    "rejected with a clear error. Accepts the UTF-8 markdown content. " +
    "Payloads larger than 4 MB are rejected - upload sessions are not " +
    "supported. " +
    MARKDOWN_FILE_NAME_RULES,
  requiredScopes: [GraphScope.FilesReadWrite],
};

const DELETE_FILE_DEF: ToolDef = {
  name: "markdown_delete_file",
  title: "Delete Markdown File",
  description:
    "Permanently delete a markdown file from the configured root folder. " +
    "Accepts either a file ID or a file name. File names must follow the " +
    "strict naming rules and are rejected otherwise. " +
    MARKDOWN_FILE_NAME_RULES,
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const MARKDOWN_TOOL_DEFS: readonly ToolDef[] = [
  SELECT_ROOT_DEF,
  LIST_FILES_DEF,
  GET_FILE_DEF,
  UPLOAD_FILE_DEF,
  DELETE_FILE_DEF,
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
const idOrNameShape = {
  itemId: z
    .string()
    .min(1)
    .optional()
    .describe("Opaque file ID previously returned by markdown_list_files."),
  fileName: z
    .string()
    .min(1)
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
          const folders = await listRootFolders(client, signal);

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
              subtitle: "Choose the folder graphdo should use as the markdown root:",
              options: folders.map((f) => ({ id: f.id, label: `/${f.name}` })),
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

          const supported = allEntries.filter((e) => e.kind === "supported");
          const unsupported = allEntries.filter((e) => e.kind === "unsupported");

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

  // -------- markdown_upload_file --------
  entries.push(
    defineTool(
      server,
      UPLOAD_FILE_DEF,
      {
        inputSchema: {
          fileName: markdownNameSchema.describe(
            "File name, must end in .md. Created or overwritten in the configured root folder.",
          ),
          content: z.string().describe("UTF-8 markdown content (max 4 MB / 4,194,304 bytes)."),
        },
        annotations: {
          title: UPLOAD_FILE_DEF.title,
          readOnlyHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args, { signal }) => {
        try {
          const cfg = await loadAndValidateMarkdownConfig(config.configDir, signal);
          const client = config.graphClient;
          const item = await uploadMarkdownContent(
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
                text: `Uploaded "${item.name}" (${item.id})\n` + `Size: ${String(bytes)} bytes`,
              },
            ],
          };
        } catch (err: unknown) {
          if (err instanceof MarkdownFileTooLargeError) {
            return { content: [{ type: "text", text: err.message }], isError: true };
          }
          return formatError("markdown_upload_file", err);
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

  return entries;
}
