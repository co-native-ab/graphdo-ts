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
  listMarkdownFiles,
  listRootFolders,
  MarkdownFileTooLargeError,
  uploadMarkdownContent,
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
    "Select which OneDrive folder graphdo should use for markdown files. Call " +
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
    "List .md files in the configured OneDrive root folder. Returns file name, " +
    "drive item ID, last modified timestamp, and size in bytes for each file.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

const GET_FILE_DEF: ToolDef = {
  name: "markdown_get_file",
  title: "Get Markdown File",
  description:
    "Read a markdown file from the configured root folder. Accepts either a " +
    "drive item ID or a file name (case-insensitive, must end in .md). " +
    "Returns the file's UTF-8 content. Files larger than 4 MB cannot be " +
    "downloaded directly and will return an error.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

const UPLOAD_FILE_DEF: ToolDef = {
  name: "markdown_upload_file",
  title: "Upload Markdown File",
  description:
    "Create or overwrite a markdown file in the configured root folder. " +
    "Accepts a file name (must end in .md) and UTF-8 markdown content. " +
    "Payloads larger than 4 MB are rejected - upload sessions are not " +
    "supported.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

const DELETE_FILE_DEF: ToolDef = {
  name: "markdown_delete_file",
  title: "Delete Markdown File",
  description:
    "Permanently delete a markdown file from the configured root folder. " +
    "Accepts either a drive item ID or a file name (case-insensitive).",
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

const markdownNameSchema = z
  .string()
  .min(1)
  .refine((v) => v.toLowerCase().endsWith(".md"), {
    message: "file name must end with .md",
  });

// Either an ID or a name must be provided. The input object shape is the
// full union — validation of "exactly one" is done in the handler because MCP
// tool inputs must be plain object schemas without discriminated unions.
const idOrNameShape = {
  itemId: z.string().min(1).optional().describe("Drive item ID of the markdown file."),
  fileName: z
    .string()
    .min(1)
    .optional()
    .describe("File name of the markdown file (must end in .md, case-insensitive)."),
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
  if (!args.fileName.toLowerCase().endsWith(".md")) {
    throw new Error("fileName must end in .md");
  }
  const match = await findMarkdownFileByName(client, folderId, args.fileName, signal);
  if (!match) {
    throw new Error(`Markdown file "${args.fileName}" not found in the configured root folder.`);
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
                    "No folders found at the root of your OneDrive. " +
                    "Create a folder in OneDrive first, then run this tool again.",
                },
              ],
            };
          }

          const handle = await startBrowserPicker(
            {
              title: "Select Markdown Root Folder",
              subtitle: "Choose the OneDrive folder graphdo should use for markdown files:",
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
          const files = await listMarkdownFiles(client, cfg.markdown.rootFolderId, signal);

          const header = `Markdown files in ${cfg.markdown.rootFolderPath ?? cfg.markdown.rootFolderName ?? "the configured folder"}:`;
          if (files.length === 0) {
            return {
              content: [{ type: "text", text: `${header}\n\nNo .md files found.` }],
            };
          }

          const lines = files.map((f, i) => {
            const modified = f.lastModifiedDateTime ?? "unknown";
            return `${String(i + 1)}. ${f.name} — ${formatSize(f.size)}, modified ${modified} (${f.id})`;
          });
          const footer = `\nTotal: ${String(files.length)} file(s)`;

          return {
            content: [{ type: "text", text: `${header}\n\n${lines.join("\n")}${footer}` }],
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
