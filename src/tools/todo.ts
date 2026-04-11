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
  listChecklistItems,
  createChecklistItem,
  updateChecklistItem,
  deleteChecklistItem,
} from "../graph/todo.js";
import type { DateTimeTimeZone, PatternedRecurrence } from "../graph/types.js";
import { loadAndValidateConfig } from "../config.js";
import type { ServerConfig } from "../index.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusEmoji(status: string): string {
  return status === "completed" ? "✅" : "⬜";
}

function statusLabel(status: string): string {
  return status === "completed" ? "Completed" : "Not Started";
}

function importanceLabel(importance?: string): string {
  if (!importance || importance === "normal") return "";
  return importance === "high" ? " ❗" : " ↓";
}

function formatDate(dt?: DateTimeTimeZone): string {
  if (!dt) return "";
  return `${dt.dateTime} (${dt.timeZone})`;
}

function formatRecurrence(rec?: PatternedRecurrence): string {
  if (!rec) return "";
  const p = rec.pattern;
  const interval = p.interval > 1 ? `every ${String(p.interval)} ` : "";
  switch (p.type) {
    case "daily":
      return `${interval}day(s)`;
    case "weekly":
      return `${interval}week(s)${p.daysOfWeek ? ` on ${p.daysOfWeek.join(", ")}` : ""}`;
    case "absoluteMonthly":
      return `${interval}month(s) on day ${String(p.dayOfMonth ?? "")}`;
    case "relativeMonthly":
      return `${interval}month(s)${p.daysOfWeek ? ` on ${p.daysOfWeek.join(", ")}` : ""}`;
    case "absoluteYearly":
      return `${interval}year(s)`;
    case "relativeYearly":
      return `${interval}year(s)`;
    default:
      return p.type;
  }
}

function formatError(
  toolName: string,
  err: unknown,
): { content: { type: "text"; text: string }[]; isError: true } {
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

/**
 * Parse a simplified repeat string into a full PatternedRecurrence.
 * Supports: "daily", "weekly", "weekdays", "monthly", "yearly"
 * with an optional interval (default 1).
 */
function parseRecurrence(
  repeat: string,
  interval: number,
): PatternedRecurrence {
  const todayParts = new Date().toISOString().split("T");
  const today = todayParts[0] ?? new Date().toISOString().slice(0, 10);
  const range = { type: "noEnd" as const, startDate: today };

  switch (repeat) {
    case "daily":
      return { pattern: { type: "daily", interval }, range };
    case "weekly":
      return {
        pattern: {
          type: "weekly",
          interval,
          daysOfWeek: [currentDayOfWeek()],
          firstDayOfWeek: "sunday",
        },
        range,
      };
    case "weekdays":
      return {
        pattern: {
          type: "weekly",
          interval: 1,
          daysOfWeek: ["monday", "tuesday", "wednesday", "thursday", "friday"],
          firstDayOfWeek: "monday",
        },
        range,
      };
    case "monthly":
      return {
        pattern: {
          type: "absoluteMonthly",
          interval,
          dayOfMonth: new Date().getDate(),
        },
        range,
      };
    case "yearly":
      return {
        pattern: {
          type: "absoluteYearly",
          interval,
          dayOfMonth: new Date().getDate(),
          month: new Date().getMonth() + 1,
        },
        range,
      };
    default:
      throw new Error(
        `Unknown repeat value: "${repeat}". Use: daily, weekly, weekdays, monthly, yearly.`,
      );
  }
}

function currentDayOfWeek(): string {
  const days = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  return days[new Date().getDay()] ?? "monday";
}

/** Parse an ISO date/time string into a DateTimeTimeZone object. */
function parseDateTimeTimeZone(
  dateStr: string,
  timeZone = "UTC",
): DateTimeTimeZone {
  return { dateTime: dateStr, timeZone };
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const importanceSchema = z.enum(["low", "normal", "high"]).optional();
const repeatSchema = z
  .enum(["daily", "weekly", "weekdays", "monthly", "yearly"])
  .optional();

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/** Register all To Do CRUD tools on the given MCP server. */
export function registerTodoTools(
  server: McpServer,
  config: ServerConfig,
): void {
  // ---- todo_list ----
  server.registerTool(
    "todo_list",
    {
      description:
        "List todos from the configured Microsoft To Do list. " +
        "Returns task titles, status, importance, and due dates. " +
        "Supports pagination via top (page size) and skip (offset).",
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

        const lines = items.map((item, i) => {
          const num = String(i + 1 + args.skip);
          const emoji = statusEmoji(item.status);
          const imp = importanceLabel(item.importance);
          const due = item.dueDateTime
            ? ` 📅 ${item.dueDateTime.dateTime}`
            : "";
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
        const checklistItems = await listChecklistItems(
          client,
          todoConfig.todoListId,
          args.taskId,
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
        reminderDateTime: z
          .string()
          .optional()
          .describe("Reminder date/time in ISO 8601 format"),
        reminderTimeZone: z.string().optional().default("UTC"),
        repeat: repeatSchema.describe(
          "Recurrence: daily, weekly, weekdays, monthly, yearly",
        ),
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
        const token = await config.authenticator.token();
        const todoConfig = await loadAndValidateConfig(config.configDir);
        const client = new GraphClient(config.graphBaseUrl, token);

        const item = await createTodo(client, todoConfig.todoListId, {
          title: args.title,
          body: args.body || undefined,
          importance: args.importance,
          dueDateTime: args.dueDate
            ? parseDateTimeTimeZone(args.dueDate, args.dueDateTimeZone)
            : undefined,
          isReminderOn: args.reminderDateTime ? true : undefined,
          reminderDateTime: args.reminderDateTime
            ? parseDateTimeTimeZone(
                args.reminderDateTime,
                args.reminderTimeZone,
              )
            : undefined,
          recurrence: args.repeat
            ? parseRecurrence(args.repeat, args.repeatInterval)
            : undefined,
        });

        const parts = [`Created todo: "${item.title}" (${item.id})`];
        parts.push(`Status: ${statusLabel(item.status)}`);
        if (item.importance && item.importance !== "normal") {
          parts.push(`Importance: ${item.importance}`);
        }
        if (item.dueDateTime)
          parts.push(`Due: ${formatDate(item.dueDateTime)}`);
        if (item.isReminderOn) parts.push("Reminder: set");
        if (item.recurrence)
          parts.push(`Repeat: ${formatRecurrence(item.recurrence)}`);

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
        reminderDateTime: z
          .string()
          .optional()
          .describe("Reminder date/time in ISO 8601 format"),
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
              type: "text" as const,
              text: "At least one field to update must be provided.",
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
          {
            title: args.title || undefined,
            body: args.body || undefined,
            importance: args.importance,
            dueDateTime: args.clearDueDate
              ? null
              : args.dueDate
                ? parseDateTimeTimeZone(args.dueDate, args.dueDateTimeZone)
                : undefined,
            isReminderOn: args.clearReminder
              ? false
              : args.reminderDateTime
                ? true
                : undefined,
            reminderDateTime: args.clearReminder
              ? null
              : args.reminderDateTime
                ? parseDateTimeTimeZone(
                    args.reminderDateTime,
                    args.reminderTimeZone,
                  )
                : undefined,
            recurrence: args.clearRecurrence
              ? null
              : args.repeat
                ? parseRecurrence(args.repeat, args.repeatInterval)
                : undefined,
          },
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
        const token = await config.authenticator.token();
        const todoConfig = await loadAndValidateConfig(config.configDir);
        const client = new GraphClient(config.graphBaseUrl, token);
        await deleteTodo(client, todoConfig.todoListId, args.taskId);

        return {
          content: [{ type: "text", text: `Todo "${args.taskId}" deleted.` }],
        };
      } catch (err: unknown) {
        return formatError("todo_delete", err);
      }
    },
  );

  // ---- todo_steps ----
  server.registerTool(
    "todo_steps",
    {
      description:
        "List all checklist steps (sub-items) within a todo. Each step can be " +
        "checked or unchecked independently.",
      inputSchema: {
        taskId: z.string().min(1).describe("The ID of the parent todo task"),
      },
      annotations: {
        title: "List Steps",
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const token = await config.authenticator.token();
        const todoConfig = await loadAndValidateConfig(config.configDir);
        const client = new GraphClient(config.graphBaseUrl, token);
        const items = await listChecklistItems(
          client,
          todoConfig.todoListId,
          args.taskId,
        );

        if (items.length === 0) {
          return {
            content: [{ type: "text", text: "No steps found for this todo." }],
          };
        }

        const lines = items.map((item) => {
          const check = item.isChecked ? "☑" : "☐";
          return `${check} ${item.displayName} (${item.id})`;
        });

        return {
          content: [{ type: "text", text: `Steps:\n\n${lines.join("\n")}` }],
        };
      } catch (err: unknown) {
        return formatError("todo_steps", err);
      }
    },
  );

  // ---- todo_add_step ----
  server.registerTool(
    "todo_add_step",
    {
      description: "Add a new checklist step (sub-item) to a todo.",
      inputSchema: {
        taskId: z.string().min(1).describe("The ID of the parent todo task"),
        displayName: z.string().min(1).describe("The text label for the new step"),
      },
      annotations: {
        title: "Add Step",
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const token = await config.authenticator.token();
        const todoConfig = await loadAndValidateConfig(config.configDir);
        const client = new GraphClient(config.graphBaseUrl, token);
        const item = await createChecklistItem(
          client,
          todoConfig.todoListId,
          args.taskId,
          args.displayName,
        );

        return {
          content: [
            {
              type: "text",
              text: `Added step: "${item.displayName}" (${item.id})`,
            },
          ],
        };
      } catch (err: unknown) {
        return formatError("todo_add_step", err);
      }
    },
  );

  // ---- todo_update_step ----
  server.registerTool(
    "todo_update_step",
    {
      description:
        "Update a checklist step - rename it, check it off, or uncheck it.",
      inputSchema: {
        taskId: z.string().min(1).describe("The ID of the parent todo task"),
        stepId: z.string().min(1).describe("The ID of the checklist step to update"),
        displayName: z
          .string()
          .optional()
          .describe("New text label for the step"),
        isChecked: z
          .boolean()
          .optional()
          .describe("Set to true to check off, false to uncheck"),
      },
      annotations: {
        title: "Update Step",
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (args.displayName === undefined && args.isChecked === undefined) {
        return {
          content: [
            {
              type: "text" as const,
              text: "At least one of displayName or isChecked must be provided.",
            },
          ],
          isError: true,
        };
      }

      try {
        const token = await config.authenticator.token();
        const todoConfig = await loadAndValidateConfig(config.configDir);
        const client = new GraphClient(config.graphBaseUrl, token);
        const item = await updateChecklistItem(
          client,
          todoConfig.todoListId,
          args.taskId,
          args.stepId,
          {
            displayName: args.displayName,
            isChecked: args.isChecked,
          },
        );

        const check = item.isChecked ? "☑" : "☐";
        return {
          content: [
            {
              type: "text",
              text: `Updated step: ${check} "${item.displayName}" (${item.id})`,
            },
          ],
        };
      } catch (err: unknown) {
        return formatError("todo_update_step", err);
      }
    },
  );

  // ---- todo_delete_step ----
  server.registerTool(
    "todo_delete_step",
    {
      description: "Permanently delete a checklist step from a todo.",
      inputSchema: {
        taskId: z.string().min(1).describe("The ID of the parent todo task"),
        stepId: z.string().min(1).describe("The ID of the checklist step to delete"),
      },
      annotations: {
        title: "Delete Step",
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
        await deleteChecklistItem(
          client,
          todoConfig.todoListId,
          args.taskId,
          args.stepId,
        );

        return {
          content: [
            {
              type: "text",
              text: `Step "${args.stepId}" deleted.`,
            },
          ],
        };
      } catch (err: unknown) {
        return formatError("todo_delete_step", err);
      }
    },
  );
}
