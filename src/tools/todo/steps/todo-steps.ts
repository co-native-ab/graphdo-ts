// MCP tool: todo_steps — list checklist steps within a todo.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadAndValidateTodoConfig } from "../../../config.js";
import { validateGraphId } from "../../../graph/ids.js";
import { listChecklistItems } from "../../../graph/todo.js";
import type { ServerConfig } from "../../../index.js";
import { GraphScope } from "../../../scopes.js";
import type { Tool, ToolDef } from "../../../tool-registry.js";
import { formatError } from "../../shared.js";

const inputSchema = {
  taskId: z.string().min(1).describe("The ID of the parent todo task"),
};

const def: ToolDef = {
  name: "todo_steps",
  title: "List Steps",
  description:
    "List all checklist steps (sub-items) within a todo. Each step can be " +
    "checked or unchecked independently.",
  requiredScopes: [GraphScope.TasksReadWrite],
};

function handler(config: ServerConfig): ToolCallback<typeof inputSchema> {
  return async (args, { signal }) => {
    try {
      const taskId = validateGraphId("taskId", args.taskId);
      const client = config.graphClient;
      const todoConfig = await loadAndValidateTodoConfig(config.configDir, signal);
      const items = await listChecklistItems(client, todoConfig.todo.listId, taskId, signal);

      if (items.length === 0) {
        return { content: [{ type: "text", text: "No steps found for this todo." }] };
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
  };
}

export const todoStepsTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler,
};
