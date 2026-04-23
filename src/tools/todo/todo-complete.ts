// MCP tool: todo_complete — mark a todo as completed.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadAndValidateTodoConfig } from "../../config.js";
import { validateGraphId } from "../../graph/ids.js";
import { completeTodo } from "../../graph/todo.js";
import type { ServerConfig } from "../../index.js";
import { GraphScope } from "../../scopes.js";
import type { Tool, ToolDef } from "../../tool-registry.js";
import { formatError } from "../shared.js";

const inputSchema = {
  taskId: z.string().min(1).describe("The ID of the todo task to complete"),
};

const def: ToolDef = {
  name: "todo_complete",
  title: "Complete Todo",
  description: "Mark a todo as completed. Sets its status to 'completed'.",
  requiredScopes: [GraphScope.TasksReadWrite],
};

function handler(config: ServerConfig): ToolCallback<typeof inputSchema> {
  return async (args, { signal }) => {
    try {
      const taskId = validateGraphId("taskId", args.taskId);
      const client = config.graphClient;
      const todoConfig = await loadAndValidateTodoConfig(config.configDir, signal);
      await completeTodo(client, todoConfig.todo.listId, taskId, signal);

      return {
        content: [{ type: "text", text: `Todo "${args.taskId}" marked as completed.` }],
      };
    } catch (err: unknown) {
      return formatError("todo_complete", err);
    }
  };
}

export const todoCompleteTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: false, openWorldHint: false },
  handler,
};
