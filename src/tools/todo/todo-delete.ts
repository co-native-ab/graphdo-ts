// MCP tool: todo_delete — permanently delete a todo.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadAndValidateTodoConfig } from "../../config.js";
import { validateGraphId } from "../../graph/ids.js";
import { deleteTodo } from "../../graph/todo.js";
import type { ServerConfig } from "../../index.js";
import { GraphScope } from "../../scopes.js";
import type { Tool, ToolDef } from "../../tool-registry.js";
import { formatError } from "../shared.js";

const inputSchema = {
  taskId: z.string().min(1).describe("The ID of the todo task to delete"),
};

const def: ToolDef = {
  name: "todo_delete",
  title: "Delete Todo",
  description: "Permanently delete a todo from the configured list.",
  requiredScopes: [GraphScope.TasksReadWrite],
};

function handler(config: ServerConfig): ToolCallback<typeof inputSchema> {
  return async (args, { signal }) => {
    try {
      const taskId = validateGraphId("taskId", args.taskId);
      const client = config.graphClient;
      const todoConfig = await loadAndValidateTodoConfig(config.configDir, signal);
      await deleteTodo(client, todoConfig.todo.listId, taskId, signal);

      return { content: [{ type: "text", text: `Todo "${args.taskId}" deleted.` }] };
    } catch (err: unknown) {
      return formatError("todo_delete", err);
    }
  };
}

export const todoDeleteTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  handler,
};
