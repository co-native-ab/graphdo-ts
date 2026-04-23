// MCP tool: todo_delete_step — permanently delete a checklist step.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadAndValidateTodoConfig } from "../../../config.js";
import { validateGraphId } from "../../../graph/ids.js";
import { deleteChecklistItem } from "../../../graph/todo.js";
import type { ServerConfig } from "../../../index.js";
import { GraphScope } from "../../../scopes.js";
import type { Tool, ToolDef } from "../../../tool-registry.js";
import { formatError } from "../../shared.js";

const inputSchema = {
  taskId: z.string().min(1).describe("The ID of the parent todo task"),
  stepId: z.string().min(1).describe("The ID of the checklist step to delete"),
};

const def: ToolDef = {
  name: "todo_delete_step",
  title: "Delete Step",
  description: "Permanently delete a checklist step from a todo.",
  requiredScopes: [GraphScope.TasksReadWrite],
};

function handler(config: ServerConfig): ToolCallback<typeof inputSchema> {
  return async (args, { signal }) => {
    try {
      const taskId = validateGraphId("taskId", args.taskId);
      const stepId = validateGraphId("stepId", args.stepId);
      const client = config.graphClient;
      const todoConfig = await loadAndValidateTodoConfig(config.configDir, signal);
      await deleteChecklistItem(client, todoConfig.todo.listId, taskId, stepId, signal);

      return { content: [{ type: "text", text: `Step "${args.stepId}" deleted.` }] };
    } catch (err: unknown) {
      return formatError("todo_delete_step", err);
    }
  };
}

export const todoDeleteStepTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  handler,
};
