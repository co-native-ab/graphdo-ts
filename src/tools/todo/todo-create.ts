// MCP tool: todo_create — create a new todo in the configured list.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadAndValidateTodoConfig } from "../../config.js";
import { createTodo } from "../../graph/todo.js";
import type { ServerConfig } from "../../index.js";
import { GraphScope } from "../../scopes.js";
import type { Tool, ToolDef } from "../../tool-registry.js";
import { formatError } from "../shared.js";
import { formatDate, formatRecurrence, statusLabel } from "./helpers/format.js";
import { parseDateTimeTimeZone, parseRecurrence } from "./helpers/parse.js";

const importanceSchema = z.enum(["low", "normal", "high"]).optional();
const repeatSchema = z.enum(["daily", "weekly", "weekdays", "monthly", "yearly"]).optional();

const inputSchema = {
  title: z.string().min(1),
  body: z.string().optional().default(""),
  importance: importanceSchema,
  dueDate: z.string().optional().describe("Due date in ISO 8601 format (e.g. 2025-01-15T09:00:00)"),
  dueDateTimeZone: z.string().optional().default("UTC"),
  reminderDateTime: z.string().optional().describe("Reminder date/time in ISO 8601 format"),
  reminderTimeZone: z.string().optional().default("UTC"),
  repeat: repeatSchema.describe("Recurrence: daily, weekly, weekdays, monthly, yearly"),
  repeatInterval: z
    .number()
    .optional()
    .default(1)
    .describe("Interval between recurrences (e.g. 2 = every 2 weeks)"),
};

const def: ToolDef = {
  name: "todo_create",
  title: "Create Todo",
  description:
    "Create a new todo in the configured list. Supports title, body, " +
    "due date, importance (low/normal/high), reminder, and recurrence " +
    "(daily/weekly/weekdays/monthly/yearly).",
  requiredScopes: [GraphScope.TasksReadWrite],
};

function handler(config: ServerConfig): ToolCallback<typeof inputSchema> {
  return async (args, { signal }) => {
    try {
      const client = config.graphClient;
      const todoConfig = await loadAndValidateTodoConfig(config.configDir, signal);

      const item = await createTodo(
        client,
        todoConfig.todoListId,
        {
          title: args.title,
          body: args.body || undefined,
          importance: args.importance,
          dueDateTime: args.dueDate
            ? parseDateTimeTimeZone(args.dueDate, args.dueDateTimeZone)
            : undefined,
          isReminderOn: args.reminderDateTime ? true : undefined,
          reminderDateTime: args.reminderDateTime
            ? parseDateTimeTimeZone(args.reminderDateTime, args.reminderTimeZone)
            : undefined,
          recurrence: args.repeat ? parseRecurrence(args.repeat, args.repeatInterval) : undefined,
        },
        signal,
      );

      const parts = [`Created todo: "${item.title}" (${item.id})`];
      parts.push(`Status: ${statusLabel(item.status)}`);
      if (item.importance && item.importance !== "normal") {
        parts.push(`Importance: ${item.importance}`);
      }
      if (item.dueDateTime) parts.push(`Due: ${formatDate(item.dueDateTime)}`);
      if (item.isReminderOn) parts.push("Reminder: set");
      if (item.recurrence) parts.push(`Repeat: ${formatRecurrence(item.recurrence)}`);

      return { content: [{ type: "text", text: parts.join("\n") }] };
    } catch (err: unknown) {
      return formatError("todo_create", err);
    }
  };
}

export const todoCreateTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: false, openWorldHint: false },
  handler,
};
