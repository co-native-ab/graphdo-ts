// MCP tool: markdown_list_files — list markdown files in the configured root folder.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadAndValidateMarkdownConfig } from "../../config.js";
import {
  listMarkdownFolderEntries,
  MARKDOWN_FILE_NAME_RULES,
  MarkdownFolderEntryKind,
} from "../../graph/markdown.js";
import type { ServerConfig } from "../../index.js";
import { GraphScope } from "../../scopes.js";
import type { Tool, ToolDef } from "../../tool-registry.js";
import { formatError } from "../shared.js";
import { formatSize } from "./helpers.js";

const inputSchema = z.object({}).shape;

const def: ToolDef = {
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

function handler(config: ServerConfig): ToolCallback<typeof inputSchema> {
  return async (_args, { signal }) => {
    try {
      const cfg = await loadAndValidateMarkdownConfig(config.configDir, signal);
      const client = config.graphClient;
      const allEntries = await listMarkdownFolderEntries(client, cfg.markdown.rootFolderId, signal);

      const supported = allEntries.filter((e) => e.kind === MarkdownFolderEntryKind.Supported);
      const unsupported = allEntries.filter((e) => e.kind === MarkdownFolderEntryKind.Unsupported);

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

      return { content: [{ type: "text", text: sections.join("\n") }] };
    } catch (err: unknown) {
      return formatError("markdown_list_files", err);
    }
  };
}

export const markdownListFilesTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler,
};
