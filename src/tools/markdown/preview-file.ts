// MCP tool: markdown_preview_file — open a markdown file in the SharePoint OneDrive web preview.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadAndValidateWorkspaceConfig } from "../../config.js";
import { meDriveScope } from "../../graph/drives.js";
import {
  MARKDOWN_FILE_NAME_RULES,
  buildMarkdownPreviewUrl,
  getDrive,
} from "../../graph/markdown.js";
import type { ServerConfig } from "../../index.js";
import { logger } from "../../logger.js";
import { GraphScope } from "../../scopes.js";
import type { Tool, ToolDef } from "../../tool-registry.js";
import { formatError } from "../shared.js";
import { markdownNameSchema, resolveDriveItem } from "./helpers.js";

const inputSchema = {
  fileName: markdownNameSchema.describe(
    "Markdown file name. Must follow the strict naming rules: " + MARKDOWN_FILE_NAME_RULES,
  ),
};

const def: ToolDef = {
  name: "markdown_preview_file",
  title: "Preview Markdown File in Browser",
  description:
    "Open a markdown file from the configured workspace in the user's browser " +
    "using the SharePoint OneDrive web preview, which renders the markdown " +
    "nicely instead of triggering a download. Accepts the file name only (the " +
    "preview URL is human-facing, so the agent should look the file up by name " +
    "the same way a user would refer to it). The tool opens the URL in the " +
    "default browser via the configured browser launcher and also returns the " +
    "URL as text so it can be shared. Consumer OneDrive (onedrive.live.com) is " +
    "not supported. " +
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

      const item = await resolveDriveItem(
        client,
        scope,
        cfg.workspace.itemId,
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
                "The markdown tools only operate on files directly in the configured workspace.",
            },
          ],
          isError: true,
        };
      }

      // Fetch the drive metadata so we can build the human-friendly
      // SharePoint preview URL. Unlike the workspace navigator, this is
      // _not_ best-effort — without `webUrl` we cannot build a correct
      // preview URL, so failures here surface as a tool error.
      const drive = await getDrive(client, scope, signal);
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
  };
}

export const markdownPreviewFileTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler,
};
