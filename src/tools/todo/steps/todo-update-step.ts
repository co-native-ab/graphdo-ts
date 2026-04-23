// MCP tool: todo_update_step — rename a step or toggle its checked state.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadAndValidateTodoConfig } from "../../../config.js";
import { validateGraphId } from "../../../graph/ids.js";
import { updateChecklistItem } from "../../../graph/todo.js";
import type { ServerConfig } from "../../../index.js";
import { GraphScope } from "../../../scopes.js";
import type { Tool, ToolDef } from "../../../tool-registry.js";
import { formatError } from "../../shared.js";

const inputSchema = {
  taskId: z.string().min(1).describe("The ID of the parent todo task"),
  stepId: z.string().min(1).describe("The ID of the checklist step to update"),
  displayName: z.string().optional().describe("New text label for the step"),
  isChecked: z.boolean().optional().describe("Set to true to check off, false to uncheck"),
};

const def: ToolDef = {
  name: "todo_update_step",
  title: "Update Step",
  description: "Update a checklist step - rename it, check it off, or uncheck it.",
  requiredScopes: [GraphScope.TasksReadWrite],
};

function handler(config: ServerConfig): ToolCallback<typeof inputSchema> {
  return async (args, { signal }) => {
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
        todoConfig.todo.listId,
        taskId,
        stepId,
        { displayName: args.displayName, isChecked: args.isChecked },
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
  };
}

export const todoUpdateStepTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: false, openWorldHint: false },
  handler,
};
