// MCP tool: todo_list — list todos from the configured list with pagination.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadAndValidateTodoConfig } from "../../config.js";
import { listTodos } from "../../graph/todo.js";
import type { ServerConfig } from "../../index.js";
import { GraphScope } from "../../scopes.js";
import type { Tool, ToolDef } from "../../tool-registry.js";
import { formatError } from "../shared.js";
import { importanceLabel, statusEmoji } from "./helpers/format.js";

const inputSchema = {
  top: z
    .number()
    .int()
    .min(1)
    .max(999)
    .optional()
    .default(25)
    .describe("Maximum number of todos to return (1-999, default: 25)"),
  skip: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe("Number of todos to skip for pagination (default: 0)"),
  filter: z
    .string()
    .optional()
    .describe(
      "OData $filter expression. Examples: \"status eq 'notStarted'\", \"importance eq 'high'\"",
    ),
  orderBy: z
    .string()
    .optional()
    .describe('OData $orderby expression. Examples: "dueDateTime/dateTime", "importance desc"'),
};

const def: ToolDef = {
  name: "todo_list",
  title: "List Todos",
  description:
    "List todos from the configured Microsoft To Do list. " +
    "Returns task titles, status, importance, and due dates. " +
    "Supports pagination via top (page size) and skip (offset). " +
    "Supports optional OData $filter and $orderby query parameters.",
  requiredScopes: [GraphScope.TasksReadWrite],
};

function handler(config: ServerConfig): ToolCallback<typeof inputSchema> {
  return async (args, { signal }) => {
    try {
      const client = config.graphClient;
      const todoConfig = await loadAndValidateTodoConfig(config.configDir, signal);
      const items = await listTodos(
        client,
        todoConfig.todoListId,
        args.top,
        args.skip,
        args.filter,
        args.orderBy,
        signal,
      );

      const lines = items.map((item, i) => {
        const num = String(i + 1 + args.skip);
        const emoji = statusEmoji(item.status);
        const imp = importanceLabel(item.importance);
        const due = item.dueDateTime ? ` 📅 ${item.dueDateTime.dateTime}` : "";
        return `${num}. ${emoji}${imp} ${item.title}${due} (${item.id})`;
      });

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
  };
}

export const todoListTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler,
};
