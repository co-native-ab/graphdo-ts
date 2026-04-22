// MCP tool: todo_show — show full details for a single todo.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadAndValidateTodoConfig } from "../../config.js";
import { validateGraphId } from "../../graph/ids.js";
import { getTodo, listChecklistItems } from "../../graph/todo.js";
import type { ServerConfig } from "../../index.js";
import { GraphScope } from "../../scopes.js";
import type { Tool, ToolDef } from "../../tool-registry.js";
import { formatError } from "../shared.js";
import { formatDate, formatRecurrence, statusLabel } from "./helpers/format.js";

const inputSchema = {
  taskId: z.string().min(1).describe("The ID of the todo task to show"),
};

const def: ToolDef = {
  name: "todo_show",
  title: "Show Todo",
  description:
    "Show full details for a single todo - title, body, status, importance, " +
    "due date, reminder, recurrence, and checklist steps.",
  requiredScopes: [GraphScope.TasksReadWrite],
};

function handler(config: ServerConfig): ToolCallback<typeof inputSchema> {
  return async (args, { signal }) => {
    try {
      const taskId = validateGraphId("taskId", args.taskId);
      const client = config.graphClient;
      const todoConfig = await loadAndValidateTodoConfig(config.configDir, signal);
      const item = await getTodo(client, todoConfig.todoListId, taskId, signal);

      const lines = [
        `Title: ${item.title}`,
        `Status: ${statusLabel(item.status)}`,
        `ID: ${item.id}`,
        `List: ${todoConfig.todoListName} (${todoConfig.todoListId})`,
      ];

      if (item.importance && item.importance !== "normal") {
        lines.push(`Importance: ${item.importance}`);
      }
      if (item.dueDateTime) {
        lines.push(`Due: ${formatDate(item.dueDateTime)}`);
      }
      if (item.isReminderOn) {
        lines.push(`Reminder: ${item.reminderDateTime ? formatDate(item.reminderDateTime) : "on"}`);
      }
      if (item.recurrence) {
        lines.push(`Repeat: ${formatRecurrence(item.recurrence)}`);
      }
      if (item.body?.content) {
        lines.push("", `Body:\n${item.body.content}`);
      }

      const checklistItems = await listChecklistItems(
        client,
        todoConfig.todoListId,
        taskId,
        signal,
      );
      if (checklistItems.length > 0) {
        lines.push("", "Steps:");
        for (const step of checklistItems) {
          const check = step.isChecked ? "☑" : "☐";
          lines.push(`  ${check} ${step.displayName} (${step.id})`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: unknown) {
      return formatError("todo_show", err);
    }
  };
}

export const todoShowTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler,
};
