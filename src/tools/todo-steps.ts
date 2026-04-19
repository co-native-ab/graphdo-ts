// MCP tool handlers for To Do checklist step operations.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  listChecklistItems,
  createChecklistItem,
  updateChecklistItem,
  deleteChecklistItem,
} from "../graph/todo.js";
import { loadAndValidateTodoConfig } from "../config.js";
import { validateGraphId } from "../graph/ids.js";
import type { ServerConfig } from "../index.js";
import { formatError } from "./shared.js";
import { GraphScope } from "../scopes.js";
import type { ToolDef, ToolEntry } from "../tool-registry.js";
import { defineTool } from "../tool-registry.js";

const STEPS_DEF: ToolDef = {
  name: "todo_steps",
  title: "List Steps",
  description:
    "List all checklist steps (sub-items) within a todo. Each step can be " +
    "checked or unchecked independently.",
  requiredScopes: [GraphScope.TasksReadWrite],
};

const ADD_STEP_DEF: ToolDef = {
  name: "todo_add_step",
  title: "Add Step",
  description: "Add a new checklist step (sub-item) to a todo.",
  requiredScopes: [GraphScope.TasksReadWrite],
};

const UPDATE_STEP_DEF: ToolDef = {
  name: "todo_update_step",
  title: "Update Step",
  description: "Update a checklist step - rename it, check it off, or uncheck it.",
  requiredScopes: [GraphScope.TasksReadWrite],
};

const DELETE_STEP_DEF: ToolDef = {
  name: "todo_delete_step",
  title: "Delete Step",
  description: "Permanently delete a checklist step from a todo.",
  requiredScopes: [GraphScope.TasksReadWrite],
};

export const STEP_TOOL_DEFS: readonly ToolDef[] = [
  STEPS_DEF,
  ADD_STEP_DEF,
  UPDATE_STEP_DEF,
  DELETE_STEP_DEF,
];

/** Register checklist step tools on the given MCP server. */
export function registerStepTools(server: McpServer, config: ServerConfig): ToolEntry[] {
  const entries: ToolEntry[] = [];

  // ---- todo_steps ----
  entries.push(
    defineTool(
      server,
      STEPS_DEF,
      {
        inputSchema: {
          taskId: z.string().min(1).describe("The ID of the parent todo task"),
        },
        annotations: {
          title: STEPS_DEF.title,
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      async (args, { signal }) => {
        try {
          const taskId = validateGraphId("taskId", args.taskId);
          const client = config.graphClient;
          const todoConfig = await loadAndValidateTodoConfig(config.configDir, signal);
          const items = await listChecklistItems(client, todoConfig.todoListId, taskId, signal);

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
    ),
  );

  // ---- todo_add_step ----
  entries.push(
    defineTool(
      server,
      ADD_STEP_DEF,
      {
        inputSchema: {
          taskId: z.string().min(1).describe("The ID of the parent todo task"),
          displayName: z.string().min(1).describe("The text label for the new step"),
        },
        annotations: {
          title: ADD_STEP_DEF.title,
          readOnlyHint: false,
          openWorldHint: false,
        },
      },
      async (args, { signal }) => {
        try {
          const taskId = validateGraphId("taskId", args.taskId);
          const client = config.graphClient;
          const todoConfig = await loadAndValidateTodoConfig(config.configDir, signal);
          const item = await createChecklistItem(
            client,
            todoConfig.todoListId,
            taskId,
            args.displayName,
            signal,
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
    ),
  );

  // ---- todo_update_step ----
  entries.push(
    defineTool(
      server,
      UPDATE_STEP_DEF,
      {
        inputSchema: {
          taskId: z.string().min(1).describe("The ID of the parent todo task"),
          stepId: z.string().min(1).describe("The ID of the checklist step to update"),
          displayName: z.string().optional().describe("New text label for the step"),
          isChecked: z.boolean().optional().describe("Set to true to check off, false to uncheck"),
        },
        annotations: {
          title: UPDATE_STEP_DEF.title,
          readOnlyHint: false,
          openWorldHint: false,
        },
      },
      async (args, { signal }) => {
        if (args.displayName === undefined && args.isChecked === undefined) {
          return {
            content: [
              {
                type: "text",
                text: "At least one of displayName or isChecked must be provided.",
              },
            ],
            isError: true,
          };
        }

        try {
          const taskId = validateGraphId("taskId", args.taskId);
          const stepId = validateGraphId("stepId", args.stepId);
          const client = config.graphClient;
          const todoConfig = await loadAndValidateTodoConfig(config.configDir, signal);
          const item = await updateChecklistItem(
            client,
            todoConfig.todoListId,
            taskId,
            stepId,
            {
              displayName: args.displayName,
              isChecked: args.isChecked,
            },
            signal,
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
    ),
  );

  // ---- todo_delete_step ----
  entries.push(
    defineTool(
      server,
      DELETE_STEP_DEF,
      {
        inputSchema: {
          taskId: z.string().min(1).describe("The ID of the parent todo task"),
          stepId: z.string().min(1).describe("The ID of the checklist step to delete"),
        },
        annotations: {
          title: DELETE_STEP_DEF.title,
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        },
      },
      async (args, { signal }) => {
        try {
          const taskId = validateGraphId("taskId", args.taskId);
          const stepId = validateGraphId("stepId", args.stepId);
          const client = config.graphClient;
          const todoConfig = await loadAndValidateTodoConfig(config.configDir, signal);
          await deleteChecklistItem(client, todoConfig.todoListId, taskId, stepId, signal);

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
    ),
  );

  return entries;
}
