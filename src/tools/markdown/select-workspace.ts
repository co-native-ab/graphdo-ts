// MCP tool: markdown_select_workspace — human-only browser navigator for workspace folder selection.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { updateConfig } from "../../config.js";
import { UserCancelledError } from "../../errors.js";
import { meDriveScope } from "../../graph/drives.js";
import type { ServerConfig } from "../../index.js";
import { logger } from "../../logger.js";
import { runNavigator } from "../../browser/flows/navigator.js";
import { GraphScope } from "../../scopes.js";
import type { Tool, ToolDef } from "../../tool-registry.js";
import { formatError, retryHintForPickerError } from "../shared.js";

const inputSchema = z.object({}).shape;

const def: ToolDef = {
  name: "markdown_select_workspace",
  title: "Select Markdown Workspace",
  description:
    "Select the workspace folder that graphdo should use for markdown files. " +
    "The workspace can be any folder in the signed-in user's OneDrive. " +
    "Call this tool directly when a workspace has not been configured yet - " +
    "do not ask the user which folder, this tool opens a browser navigator " +
    "where the user makes the selection themselves. This is a human-only " +
    "action - the AI agent cannot choose the folder programmatically. " +
    "Calling it again overwrites the stored value.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

function handler(config: ServerConfig): ToolCallback<typeof inputSchema> {
  return async (_args, { signal }) => {
    try {
      const client = config.graphClient;

      const handle = await runNavigator(
        {
          title: "Select Markdown Workspace",
          subtitle:
            "Navigate to a folder in your OneDrive. " +
            "graphdo will operate on markdown files directly inside the selected folder.",
          initialScope: meDriveScope,
          client,
          onSelect: async (selection, s) => {
            const driveId = selection.scope.kind === "me" ? "me" : selection.scope.driveId;

            await updateConfig(
              {
                workspace: {
                  driveId,
                  itemId: selection.itemId,
                  driveName: selection.driveName,
                  itemName: selection.itemName,
                  itemPath: selection.itemPath,
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
        logger.info("markdown workspace navigator opened", { url: handle.url });
      } catch (err: unknown) {
        logger.warn("could not open browser for markdown workspace navigator", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const instruction = browserOpened
        ? "A browser window has been opened to select the markdown workspace. " +
          "Waiting for you to make a selection..."
        : "Could not open a browser automatically. " +
          `Please visit this URL to select the markdown workspace:\n\n${handle.url}\n\n` +
          "Waiting for you to make a selection...";

      const result = await handle.waitForSelection;

      return {
        content: [
          {
            type: "text",
            text:
              `${instruction}\n\nMarkdown workspace configured: ${result.selected.itemPath} ` +
              `(${result.selected.itemId})`,
          },
        ],
      };
    } catch (err: unknown) {
      if (err instanceof UserCancelledError) {
        return {
          content: [{ type: "text", text: "Markdown workspace selection cancelled." }],
        };
      }
      return formatError("markdown_select_workspace", err, {
        suffix: retryHintForPickerError(err),
      });
    }
  };
}

export const markdownSelectWorkspaceTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler,
};
