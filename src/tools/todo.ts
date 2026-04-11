// MCP tool handlers for Microsoft To Do CRUD operations.
// Task-level tools live here; checklist step tools are in todo-steps.ts.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  listTodos,
  getTodo,
  createTodo,
  updateTodo,
  completeTodo,
  deleteTodo,
  listChecklistItems,
} from "../graph/todo.js";
import { loadAndValidateConfig } from "../config.js";
import type { ServerConfig } from "../index.js";
import { createAuthenticatedClient, formatError } from "./shared.js";
import {
  statusEmoji,
  statusLabel,
  importanceLabel,
  formatDate,
  formatRecurrence,
} from "./todo-format.js";
import { parseRecurrence, parseDateTimeTimeZone } from "./todo-parse.js";
import { registerStepTools } from "./todo-steps.js";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const importanceSchema = z.enum(["low", "normal", "high"]).optional();
const repeatSchema = z.enum(["daily", "weekly", "weekdays", "monthly", "yearly"]).optional();

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/** Register all To Do CRUD tools on the given MCP server. */
export function registerTodoTools(server: McpServer, config: ServerConfig): void {
  // ---- todo_list ----
  server.registerTool(
    "todo_list",
    {
      description:
        "List todos from the configured Microsoft To Do list. " +
        "Returns task titles, status, importance, and due dates. " +
        "Supports pagination via top (page size) and skip (offset). " +
        "Supports optional OData $filter and $orderby query parameters.",
      inputSchema: {
        top: z
          .number()
          .optional()
          .default(25)
          .describe("Maximum number of todos to return (default: 25)"),
        skip: z
          .number()
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
          .describe(
            'OData $orderby expression. Examples: "dueDateTime/dateTime", "importance desc"',
          ),
      },
      annotations: {
        title: "List Todos",
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const client = await createAuthenticatedClient(config);
        const todoConfig = await loadAndValidateConfig(config.configDir);
        const items = await listTodos(
          client,
          todoConfig.todoListId,
          args.top,
          args.skip,
          args.filter,
          args.orderBy,
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
    },
  );

  // ---- todo_show ----
  server.registerTool(
    "todo_show",
    {
      description:
        "Show full details for a single todo - title, body, status, importance, " +
        "due date, reminder, recurrence, and checklist steps.",
      inputSchema: {
        taskId: z.string().min(1).describe("The ID of the todo task to show"),
      },
      annotations: {
        title: "Show Todo",
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const client = await createAuthenticatedClient(config);
        const todoConfig = await loadAndValidateConfig(config.configDir);
        const item = await getTodo(client, todoConfig.todoListId, args.taskId);

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
          lines.push(
            `Reminder: ${item.reminderDateTime ? formatDate(item.reminderDateTime) : "on"}`,
          );
        }
        if (item.recurrence) {
          lines.push(`Repeat: ${formatRecurrence(item.recurrence)}`);
        }
        if (item.body?.content) {
          lines.push("", `Body:\n${item.body.content}`);
        }

        // Show checklist items if present
        const checklistItems = await listChecklistItems(client, todoConfig.todoListId, args.taskId);
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
    },
  );

  // ---- todo_create ----
  server.registerTool(
    "todo_create",
    {
      description:
        "Create a new todo in the configured list. Supports title, body, " +
        "due date, importance (low/normal/high), reminder, and recurrence " +
        "(daily/weekly/weekdays/monthly/yearly).",
      inputSchema: {
        title: z.string().min(1),
        body: z.string().optional().default(""),
        importance: importanceSchema,
        dueDate: z
          .string()
          .optional()
          .describe("Due date in ISO 8601 format (e.g. 2025-01-15T09:00:00)"),
        dueDateTimeZone: z.string().optional().default("UTC"),
        reminderDateTime: z.string().optional().describe("Reminder date/time in ISO 8601 format"),
        reminderTimeZone: z.string().optional().default("UTC"),
        repeat: repeatSchema.describe("Recurrence: daily, weekly, weekdays, monthly, yearly"),
        repeatInterval: z
          .number()
          .optional()
          .default(1)
          .describe("Interval between recurrences (e.g. 2 = every 2 weeks)"),
      },
      annotations: {
        title: "Create Todo",
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const client = await createAuthenticatedClient(config);
        const todoConfig = await loadAndValidateConfig(config.configDir);

        const item = await createTodo(client, todoConfig.todoListId, {
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
        });

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
    },
  );

  // ---- todo_update ----
  server.registerTool(
    "todo_update",
    {
      description:
        "Update an existing todo. Provide only the fields to change - omitted fields " +
        "keep their current values. Set clearDueDate, clearReminder, or clearRecurrence " +
        "to true to remove those fields.",
      inputSchema: {
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
      },
      annotations: {
        title: "Update Todo",
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
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
          content: [
            {
              type: "text",
              text: "At least one field to update must be provided.",
            },
          ],
          isError: true,
        };
      }

      try {
        const client = await createAuthenticatedClient(config);
        const todoConfig = await loadAndValidateConfig(config.configDir);

        const item = await updateTodo(client, todoConfig.todoListId, args.taskId, {
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
        });

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
      description: "Mark a todo as completed. Sets its status to 'completed'.",
      inputSchema: {
        taskId: z.string().min(1).describe("The ID of the todo task to complete"),
      },
      annotations: {
        title: "Complete Todo",
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const client = await createAuthenticatedClient(config);
        const todoConfig = await loadAndValidateConfig(config.configDir);
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
      description: "Permanently delete a todo from the configured list.",
      inputSchema: {
        taskId: z.string().min(1).describe("The ID of the todo task to delete"),
      },
      annotations: {
        title: "Delete Todo",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const client = await createAuthenticatedClient(config);
        const todoConfig = await loadAndValidateConfig(config.configDir);
        await deleteTodo(client, todoConfig.todoListId, args.taskId);

        return {
          content: [{ type: "text", text: `Todo "${args.taskId}" deleted.` }],
        };
      } catch (err: unknown) {
        return formatError("todo_delete", err);
      }
    },
  );

  // ---- checklist step tools (todo_steps, todo_add_step, etc.) ----
  registerStepTools(server, config);
}
