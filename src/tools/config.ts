// MCP tool for configuring the active To Do list via browser.
//
// Opens a local web server with a list picker in the user's browser.
// The AI agent cannot change the list - only a human can make this selection.
// If the browser cannot be opened, the tool shows the URL for manual access.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { saveConfig } from "../config.js";
import { listTodoLists } from "../graph/todo.js";
import type { ServerConfig } from "../index.js";
import { UserCancelledError } from "../errors.js";
import { z } from "zod";
import { logger } from "../logger.js";
import { startBrowserPicker } from "../picker.js";
import { createAuthenticatedClient, formatError } from "./shared.js";

/** Register the todo_config tool on the given MCP server. */
export function registerConfigTools(server: McpServer, config: ServerConfig): void {
  server.registerTool(
    "todo_config",
    {
      description:
        "Select which Microsoft To Do list to use. Call this tool directly when " +
        "a todo list has not been configured yet - do not ask the user which list " +
        "they want, this tool opens a browser picker where the user makes the " +
        "selection themselves. This is a human-only action - the AI agent cannot " +
        "choose the list programmatically.",
      inputSchema: z.object({}),
      annotations: {
        title: "Configure Todo List",
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const client = await createAuthenticatedClient(config);
        const lists = await listTodoLists(client);

        if (lists.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No todo lists found in your Microsoft account.",
              },
            ],
          };
        }

        const handle = await startBrowserPicker({
          title: "Configure Todo List",
          subtitle: "Select which Microsoft To Do list graphdo should use:",
          options: lists.map((l) => ({ id: l.id, label: l.displayName })),
          onSelect: async (option) => {
            await saveConfig(
              { todoListId: option.id, todoListName: option.label },
              config.configDir,
            );
          },
        });

        // Try to open the browser
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
          ? "A browser window has been opened to configure your todo list. " +
            "Waiting for you to make a selection..."
          : "Could not open a browser automatically. " +
            `Please visit this URL to configure your todo list:\n\n${handle.url}\n\n` +
            "Waiting for you to make a selection...";

        // Wait for the user to make a selection (blocks until done or timeout)
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
            content: [{ type: "text", text: "Todo list configuration cancelled." }],
          };
        }
        const isTimeout = err instanceof Error && err.message.toLowerCase().includes("timed out");
        const retryHint = isTimeout
          ? "\n\nThe user did not make a selection in time. " +
            "You can call this tool again if the user would like to retry."
          : "\n\nYou can call this tool again if the user would like to retry.";

        return formatError("todo_config", err, { suffix: retryHint });
      }
    },
  );
}
