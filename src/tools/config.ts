// MCP tool handler for configuring the active To Do list.
//
// When the client supports elicitation, presents a dropdown picker for the
// user to select a list. Otherwise falls back to a two-step text flow.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { AuthenticationRequiredError } from "../auth.js";
import { GraphClient, GraphRequestError } from "../graph/client.js";
import { listTodoLists } from "../graph/todo.js";
import { saveConfig } from "../config.js";
import type { ServerConfig } from "../index.js";
import { logger } from "../logger.js";

function formatListOptions(lists: { id: string; displayName: string }[]): string {
  const lines = lists.map(
    (l, i) => `${String(i + 1)}. ${l.displayName} (${l.id})`,
  );
  return lines.join("\n");
}

/** Check whether the connected client supports form-based elicitation. */
function clientSupportsElicitation(config: ServerConfig): boolean {
  const caps = config.mcpServer.server.getClientCapabilities();
  return caps?.elicitation?.form !== undefined;
}

/** Register the todo_config tool on the given MCP server. */
export function registerConfigTools(
  server: McpServer,
  config: ServerConfig,
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
        const token = await config.authenticator.token();
        const client = new GraphClient(config.graphBaseUrl, token);
        const lists = await listTodoLists(client);

        if (lists.length === 0) {
          return {
            content: [{ type: "text", text: "No todo lists found in your account." }],
          };
        }

        // If no listId provided and client supports elicitation, show a picker
        if (!args.listId && clientSupportsElicitation(config)) {
          const elicitResult = await config.mcpServer.server.elicitInput({
            message: "Select which Microsoft To Do list to use:",
            requestedSchema: {
              type: "object" as const,
              properties: {
                listId: {
                  type: "string" as const,
                  title: "Todo List",
                  description: "Select a list",
                  oneOf: lists.map((l) => ({
                    const: l.id,
                    title: l.displayName,
                  })),
                },
              },
              required: ["listId"],
            },
          });

          if (elicitResult.action !== "accept" || !elicitResult.content) {
            return {
              content: [
                { type: "text", text: "Configuration cancelled." },
              ],
            };
          }

          const selectedId = elicitResult.content["listId"] as string;
          const selected = lists.find((l) => l.id === selectedId);
          if (!selected) {
            return {
              content: [{ type: "text", text: "Selected list not found." }],
              isError: true,
            };
          }

          await saveConfig(
            { todoListId: selected.id, todoListName: selected.displayName },
            config.configDir,
          );

          const text = `Todo list configured: ${selected.displayName} (${selected.id})`;
          logger.info("todo list configured", {
            listId: selected.id,
            listName: selected.displayName,
          });
          return { content: [{ type: "text", text }] };
        }

        // Fallback: two-step text flow (no elicitation or listId provided)
        if (!args.listId) {
          const text = `Available todo lists:\n\n${formatListOptions(lists)}\n\nCall todo_config again with a listId to select one.`;
          return { content: [{ type: "text", text }] };
        }

        const selected = lists.find((l) => l.id === args.listId);
        if (!selected) {
          const text = `List "${args.listId}" not found. Available lists:\n\n${formatListOptions(lists)}\n\nCall todo_config with one of the above list IDs.`;
          return { content: [{ type: "text", text }], isError: true };
        }

        await saveConfig(
          { todoListId: selected.id, todoListName: selected.displayName },
          config.configDir,
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
