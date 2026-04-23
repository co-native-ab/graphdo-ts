// MCP tool: todo_update — partial update of an existing todo.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadAndValidateTodoConfig } from "../../config.js";
import { validateGraphId } from "../../graph/ids.js";
import { updateTodo } from "../../graph/todo.js";
import type { ServerConfig } from "../../index.js";
import { GraphScope } from "../../scopes.js";
import type { Tool, ToolDef } from "../../tool-registry.js";
import { formatError } from "../shared.js";
import { statusLabel } from "./helpers/format.js";
import { parseDateTimeTimeZone, parseRecurrence } from "./helpers/parse.js";

const importanceSchema = z.enum(["low", "normal", "high"]).optional();
const repeatSchema = z.enum(["daily", "weekly", "weekdays", "monthly", "yearly"]).optional();

const inputSchema = {
  taskId: z.string().min(1).describe("The ID of the todo task to update"),
  title: z.string().optional().default(""),
  body: z.string().optional().default(""),
  importance: importanceSchema,
  dueDate: z.string().optional().describe("Due date in ISO 8601 format"),
  dueDateTimeZone: z.string().optional().default("UTC"),
  clearDueDate: z.boolean().optional().default(false),
  reminderDateTime: z.string().optional().describe("Reminder date/time in ISO 8601 format"),
  reminderTimeZone: z.string().optional().default("UTC"),
  clearReminder: z.boolean().optional().default(false),
  repeat: repeatSchema,
  repeatInterval: z.number().optional().default(1),
  clearRecurrence: z.boolean().optional().default(false),
};

const def: ToolDef = {
  name: "todo_update",
  title: "Update Todo",
  description:
    "Update an existing todo. Provide only the fields to change - omitted fields " +
    "keep their current values. Set clearDueDate, clearReminder, or clearRecurrence " +
    "to true to remove those fields.",
  requiredScopes: [GraphScope.TasksReadWrite],
};

function handler(config: ServerConfig): ToolCallback<typeof inputSchema> {
  return async (args, { signal }) => {
    const hasChange =
      args.title !== "" ||
      args.body !== "" ||
      args.importance !== undefined ||
      args.dueDate !== undefined ||
      args.clearDueDate ||
      args.reminderDateTime !== undefined ||
      args.clearReminder ||
      args.repeat !== undefined ||
      args.clearRecurrence;

    if (!hasChange) {
      return {
        content: [{ type: "text", text: "At least one field to update must be provided." }],
        isError: true,
      };
    }

    try {
      const taskId = validateGraphId("taskId", args.taskId);
      const client = config.graphClient;
      const todoConfig = await loadAndValidateTodoConfig(config.configDir, signal);

      const item = await updateTodo(
        client,
        todoConfig.todo.listId,
        taskId,
        {
          title: args.title || undefined,
          body: args.body || undefined,
          importance: args.importance,
          dueDateTime: args.clearDueDate
            ? null
            : args.dueDate
              ? parseDateTimeTimeZone(args.dueDate, args.dueDateTimeZone)
              : undefined,
          isReminderOn: args.clearReminder ? false : args.reminderDateTime ? true : undefined,
          reminderDateTime: args.clearReminder
            ? null
            : args.reminderDateTime
              ? parseDateTimeTimeZone(args.reminderDateTime, args.reminderTimeZone)
              : undefined,
          recurrence: args.clearRecurrence
            ? null
            : args.repeat
              ? parseRecurrence(args.repeat, args.repeatInterval)
              : undefined,
        },
        signal,
      );

      const text = `Updated todo: "${item.title}" (${item.id})\nStatus: ${statusLabel(item.status)}`;
      return { content: [{ type: "text", text }] };
    } catch (err: unknown) {
      return formatError("todo_update", err);
    }
  };
}

export const todoUpdateTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: false, openWorldHint: false },
  handler,
};
