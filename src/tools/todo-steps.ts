// MCP tool handlers for To Do checklist step operations.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  listChecklistItems,
  createChecklistItem,
  updateChecklistItem,
  deleteChecklistItem,
} from "../graph/todo.js";
import { loadAndValidateConfig } from "../config.js";
import type { ServerConfig } from "../index.js";
import { createAuthenticatedClient, formatError } from "./shared.js";

/** Register checklist step tools on the given MCP server. */
export function registerStepTools(server: McpServer, config: ServerConfig): void {
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
        const client = await createAuthenticatedClient(config);
        const todoConfig = await loadAndValidateConfig(config.configDir);
        const items = await listChecklistItems(client, todoConfig.todoListId, args.taskId);

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
        const client = await createAuthenticatedClient(config);
        const todoConfig = await loadAndValidateConfig(config.configDir);
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
      description: "Update a checklist step - rename it, check it off, or uncheck it.",
      inputSchema: {
        taskId: z.string().min(1).describe("The ID of the parent todo task"),
        stepId: z.string().min(1).describe("The ID of the checklist step to update"),
        displayName: z.string().optional().describe("New text label for the step"),
        isChecked: z.boolean().optional().describe("Set to true to check off, false to uncheck"),
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
              type: "text",
              text: "At least one of displayName or isChecked must be provided.",
            },
          ],
          isError: true,
        };
      }

      try {
        const client = await createAuthenticatedClient(config);
        const todoConfig = await loadAndValidateConfig(config.configDir);
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
        const client = await createAuthenticatedClient(config);
        const todoConfig = await loadAndValidateConfig(config.configDir);
        await deleteChecklistItem(client, todoConfig.todoListId, args.taskId, args.stepId);

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
