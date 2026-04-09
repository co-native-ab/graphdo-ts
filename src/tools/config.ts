// MCP tool handler for configuring the active To Do list.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Authenticator } from "../auth.js";
import { AuthenticationRequiredError } from "../auth.js";
import { GraphClient, GraphRequestError } from "../graph/client.js";
import { listTodoLists } from "../graph/todo.js";
import { configDir, saveConfig } from "../config.js";
import { GRAPH_BASE_URL } from "../index.js";
import { logger } from "../logger.js";

function formatListOptions(lists: { id: string; displayName: string }[]): string {
  const lines = lists.map(
    (l, i) => `${String(i + 1)}. ${l.displayName} (${l.id})`,
  );
  return lines.join("\n");
}

/** Register the todo_config tool on the given MCP server. */
export function registerConfigTools(
  server: McpServer,
  authenticator: Authenticator,
): void {
  server.registerTool(
    "todo_config",
    {
      description: "Configure which todo list to use",
      inputSchema: { listId: z.string().optional() },
      annotations: {
        title: "Configure Todo List",
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const token = await authenticator.token();
        const client = new GraphClient(GRAPH_BASE_URL, token);
        const lists = await listTodoLists(client);

        if (!args.listId) {
          const text =
            lists.length > 0
              ? `Available todo lists:\n\n${formatListOptions(lists)}\n\nCall todo_config again with a listId to select one.`
              : "No todo lists found in your account.";
          return { content: [{ type: "text", text }] };
        }

        const selected = lists.find((l) => l.id === args.listId);
        if (!selected) {
          const text = `List "${args.listId}" not found. Available lists:\n\n${formatListOptions(lists)}\n\nCall todo_config with one of the above list IDs.`;
          return { content: [{ type: "text", text }], isError: true };
        }

        const cfgPath = configDir();
        await saveConfig(
          { todoListId: selected.id, todoListName: selected.displayName },
          cfgPath,
        );

        const text = `Todo list configured: ${selected.displayName} (${selected.id})`;
        logger.info("todo list configured", {
          listId: selected.id,
          listName: selected.displayName,
        });
        return { content: [{ type: "text", text }] };
      } catch (err: unknown) {
        if (err instanceof AuthenticationRequiredError) {
          return { content: [{ type: "text", text: err.message }], isError: true };
        }
        const message =
          err instanceof GraphRequestError
            ? `Graph API error: ${err.message} (${String(err.statusCode)})`
            : err instanceof Error
              ? err.message
              : String(err);
        logger.error("todo_config failed", { error: message });
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
  );
}
