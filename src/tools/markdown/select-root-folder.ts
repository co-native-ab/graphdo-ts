// MCP tool: markdown_select_root_folder — human-only browser picker for the OneDrive root folder.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { updateConfig } from "../../config.js";
import { UserCancelledError } from "../../errors.js";
import { listRootFolders } from "../../graph/markdown.js";
import type { ServerConfig } from "../../index.js";
import { logger } from "../../logger.js";
import { runPicker } from "../../browser/flows/picker.js";
import { GraphScope } from "../../scopes.js";
import type { Tool, ToolDef } from "../../tool-registry.js";
import { formatError, retryHintForPickerError } from "../shared.js";
import { tryGetDriveWebUrl } from "./helpers.js";

const inputSchema = z.object({}).shape;

const def: ToolDef = {
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

function handler(config: ServerConfig): ToolCallback<typeof inputSchema> {
  return async (_args, { signal }) => {
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

      const handle = await runPicker(
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
  };
}

export const markdownSelectRootFolderTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler,
};
