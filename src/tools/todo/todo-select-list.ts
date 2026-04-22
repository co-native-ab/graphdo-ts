// MCP tool: todo_select_list — human-only browser picker for the active To Do list.
//
// Opens a local web server with a list picker in the user's browser.
// The AI agent cannot change the list - only a human can make this selection.
// If the browser cannot be opened, the tool shows the URL for manual access.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { updateConfig } from "../../config.js";
import { UserCancelledError } from "../../errors.js";
import { listTodoLists } from "../../graph/todo.js";
import type { ServerConfig } from "../../index.js";
import { logger } from "../../logger.js";
import { startBrowserPicker } from "../../picker.js";
import { GraphScope } from "../../scopes.js";
import type { Tool, ToolDef } from "../../tool-registry.js";
import { formatError } from "../shared.js";

const inputSchema = z.object({}).shape;

const def: ToolDef = {
  name: "todo_select_list",
  title: "Select Todo List",
  description:
    "Select which Microsoft To Do list graphdo should use. Call this tool " +
    "directly when a todo list has not been configured yet - do not ask the " +
    "user which list, this tool opens a browser picker where the user makes " +
    "the selection themselves. This is a human-only action - the AI agent " +
    "cannot choose the list programmatically. Calling it again overwrites " +
    "the stored value.",
  requiredScopes: [GraphScope.TasksReadWrite],
};

function handler(config: ServerConfig): ToolCallback<typeof inputSchema> {
  return async (_args, { signal }) => {
    try {
      const client = config.graphClient;
      const lists = await listTodoLists(client, signal);

      if (lists.length === 0) {
        return {
          content: [{ type: "text", text: "No todo lists found in your Microsoft account." }],
        };
      }

      const handle = await startBrowserPicker(
        {
          title: "Select Todo List",
          subtitle: "Select which Microsoft To Do list graphdo should use:",
          options: lists.map((l) => ({ id: l.id, label: l.displayName })),
          filterPlaceholder: "Filter lists...",
          refreshOptions: async (s) => {
            const refreshed = await listTodoLists(client, s);
            return refreshed.map((l) => ({ id: l.id, label: l.displayName }));
          },
          createLink: {
            url: "https://to-do.office.com/tasks/",
            label: "Create a new list in Microsoft To Do",
            description:
              "Open Microsoft To Do in a new tab, create a new list there, then click Refresh here to see it in the list.",
          },
          onSelect: async (option, s) => {
            await updateConfig(
              { todoListId: option.id, todoListName: option.label },
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
        logger.info("config browser opened", { url: handle.url });
      } catch (err: unknown) {
        logger.warn("could not open browser for config", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const instruction = browserOpened
        ? "A browser window has been opened to select your todo list. " +
          "Waiting for you to make a selection..."
        : "Could not open a browser automatically. " +
          `Please visit this URL to select your todo list:\n\n${handle.url}\n\n` +
          "Waiting for you to make a selection...";

      const result = await handle.waitForSelection;

      return {
        content: [
          {
            type: "text",
            text: `${instruction}\n\nTodo list configured: ${result.selected.label} (${result.selected.id})`,
          },
        ],
      };
    } catch (err: unknown) {
      if (err instanceof UserCancelledError) {
        return {
          content: [{ type: "text", text: "Todo list selection cancelled." }],
        };
      }
      const isTimeout = err instanceof Error && err.message.toLowerCase().includes("timed out");
      const retryHint = isTimeout
        ? "\n\nThe user did not make a selection in time. " +
          "You can call this tool again if the user would like to retry."
        : "\n\nYou can call this tool again if the user would like to retry.";

      return formatError("todo_select_list", err, { suffix: retryHint });
    }
  };
}

export const todoSelectListTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler,
};
