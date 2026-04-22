// MCP tool: todo_add_step — add a checklist step to a todo.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadAndValidateTodoConfig } from "../../../config.js";
import { validateGraphId } from "../../../graph/ids.js";
import { createChecklistItem } from "../../../graph/todo.js";
import type { ServerConfig } from "../../../index.js";
import { GraphScope } from "../../../scopes.js";
import type { Tool, ToolDef } from "../../../tool-registry.js";
import { formatError } from "../../shared.js";

const inputSchema = {
  taskId: z.string().min(1).describe("The ID of the parent todo task"),
  displayName: z.string().min(1).describe("The text label for the new step"),
};

const def: ToolDef = {
  name: "todo_add_step",
  title: "Add Step",
  description: "Add a new checklist step (sub-item) to a todo.",
  requiredScopes: [GraphScope.TasksReadWrite],
};

function handler(config: ServerConfig): ToolCallback<typeof inputSchema> {
  return async (args, { signal }) => {
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
        content: [{ type: "text", text: `Added step: "${item.displayName}" (${item.id})` }],
      };
    } catch (err: unknown) {
      return formatError("todo_add_step", err);
    }
  };
}

export const todoAddStepTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: false, openWorldHint: false },
  handler,
};
