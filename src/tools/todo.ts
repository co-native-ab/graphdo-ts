// MCP tool handlers for Microsoft To Do CRUD operations.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { AuthenticationRequiredError } from "../auth.js";
import { GraphClient, GraphRequestError } from "../graph/client.js";
import {
  listTodos,
  getTodo,
  createTodo,
  updateTodo,
  completeTodo,
  deleteTodo,
} from "../graph/todo.js";
import { loadAndValidateConfig } from "../config.js";
import type { ServerConfig } from "../index.js";
import { logger } from "../logger.js";

function statusEmoji(status: string): string {
  return status === "completed" ? "✅" : "⬜";
}

function statusLabel(status: string): string {
  return status === "completed" ? "Completed" : "Not Started";
}

function formatError(toolName: string, err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  if (err instanceof AuthenticationRequiredError) {
    return { content: [{ type: "text", text: err.message }], isError: true };
  }
  const message =
    err instanceof GraphRequestError
      ? `Graph API error: ${err.message} (${String(err.statusCode)})`
      : err instanceof Error
        ? err.message
        : String(err);
  logger.error(`${toolName} failed`, { error: message });
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Register all To Do CRUD tools on the given MCP server. */
export function registerTodoTools(
  server: McpServer,
  config: ServerConfig,
): void {
  // ---- todo_list ----
  server.registerTool(
    "todo_list",
    {
      description: "List todos with pagination",
      inputSchema: {
        top: z.number().optional().default(25),
        skip: z.number().optional().default(0),
      },
      annotations: {
        title: "List Todos",
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const token = await config.authenticator.token();
        const todoConfig = await loadAndValidateConfig(config.configDir);
        const client = new GraphClient(config.graphBaseUrl, token);
        const items = await listTodos(
          client,
          todoConfig.todoListId,
          args.top,
          args.skip,
        );

        const lines = items.map(
          (item, i) =>
            `${String(i + 1 + args.skip)}. ${statusEmoji(item.status)} ${item.title} (${item.id})`,
        );

        const header = `Todos in "${todoConfig.todoListName}":\n`;
        const footer = `\nShowing ${String(items.length)} items (skip: ${String(args.skip)}, top: ${String(args.top)})`;
        const text =
          items.length > 0
            ? `${header}\n${lines.join("\n")}${footer}`
            : `${header}\nNo todos found.${footer}`;

        return { content: [{ type: "text", text }] };
      } catch (err: unknown) {
        return formatError("todo_list", err);
      }
    },
  );

  // ---- todo_show ----
  server.registerTool(
    "todo_show",
    {
      description: "Show a single todo with all details",
      inputSchema: { taskId: z.string() },
      annotations: {
        title: "Show Todo",
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const token = await config.authenticator.token();
        const todoConfig = await loadAndValidateConfig(config.configDir);
        const client = new GraphClient(config.graphBaseUrl, token);
        const item = await getTodo(client, todoConfig.todoListId, args.taskId);

        const lines = [
          `Title: ${item.title}`,
          `Status: ${statusLabel(item.status)}`,
          `ID: ${item.id}`,
          `List: ${todoConfig.todoListName} (${todoConfig.todoListId})`,
        ];

        if (item.body?.content) {
          lines.push("", `Body:\n${item.body.content}`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err: unknown) {
        return formatError("todo_show", err);
      }
    },
  );

  // ---- todo_create ----
  server.registerTool(
    "todo_create",
    {
      description: "Create a new todo",
      inputSchema: {
        title: z.string(),
        body: z.string().optional().default(""),
      },
      annotations: {
        title: "Create Todo",
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const token = await config.authenticator.token();
        const todoConfig = await loadAndValidateConfig(config.configDir);
        const client = new GraphClient(config.graphBaseUrl, token);
        const item = await createTodo(
          client,
          todoConfig.todoListId,
          args.title,
          args.body,
        );

        const text = `Created todo: "${item.title}" (${item.id})\nStatus: ${statusLabel(item.status)}`;
        return { content: [{ type: "text", text }] };
      } catch (err: unknown) {
        return formatError("todo_create", err);
      }
    },
  );

  // ---- todo_update ----
  server.registerTool(
    "todo_update",
    {
      description: "Update an existing todo",
      inputSchema: {
        taskId: z.string(),
        title: z.string().optional().default(""),
        body: z.string().optional().default(""),
      },
      annotations: {
        title: "Update Todo",
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (!args.title && !args.body) {
        return {
          content: [
            {
              type: "text" as const,
              text: "At least one of title or body must be provided.",
            },
          ],
          isError: true,
        };
      }

      try {
        const token = await config.authenticator.token();
        const todoConfig = await loadAndValidateConfig(config.configDir);
        const client = new GraphClient(config.graphBaseUrl, token);
        const item = await updateTodo(
          client,
          todoConfig.todoListId,
          args.taskId,
          args.title,
          args.body,
        );

        const text = `Updated todo: "${item.title}" (${item.id})\nStatus: ${statusLabel(item.status)}`;
        return { content: [{ type: "text", text }] };
      } catch (err: unknown) {
        return formatError("todo_update", err);
      }
    },
  );

  // ---- todo_complete ----
  server.registerTool(
    "todo_complete",
    {
      description: "Mark a todo as completed",
      inputSchema: { taskId: z.string() },
      annotations: {
        title: "Complete Todo",
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const token = await config.authenticator.token();
        const todoConfig = await loadAndValidateConfig(config.configDir);
        const client = new GraphClient(config.graphBaseUrl, token);
        await completeTodo(client, todoConfig.todoListId, args.taskId);

        return {
          content: [
            {
              type: "text",
              text: `Todo "${args.taskId}" marked as completed.`,
            },
          ],
        };
      } catch (err: unknown) {
        return formatError("todo_complete", err);
      }
    },
  );

  // ---- todo_delete ----
  server.registerTool(
    "todo_delete",
    {
      description: "Delete a todo",
      inputSchema: { taskId: z.string() },
      annotations: {
        title: "Delete Todo",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const token = await config.authenticator.token();
        const todoConfig = await loadAndValidateConfig(config.configDir);
        const client = new GraphClient(config.graphBaseUrl, token);
        await deleteTodo(client, todoConfig.todoListId, args.taskId);

        return {
          content: [
            { type: "text", text: `Todo "${args.taskId}" deleted.` },
          ],
        };
      } catch (err: unknown) {
        return formatError("todo_delete", err);
      }
    },
  );
}
