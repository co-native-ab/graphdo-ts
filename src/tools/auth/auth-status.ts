// MCP tool: auth_status — show authentication state, account, config, and version.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadConfig } from "../../config.js";
import type { ServerConfig } from "../../index.js";
import { VERSION } from "../../index.js";
import type { Tool, ToolDef } from "../../tool-registry.js";
import { formatError } from "../shared.js";

const inputSchema = z.object({}).shape;

const def: ToolDef = {
  name: "auth_status",
  title: "Authentication Status",
  description:
    "Check current authentication status, logged-in user, configured todo list, " +
    "granted scopes, and server version. A good first tool to call when diagnosing " +
    "issues or understanding what is set up.",
  requiredScopes: [],
};

function handler(config: ServerConfig): ToolCallback<typeof inputSchema> {
  return async (_args, { signal }) => {
    try {
      const lines: string[] = [];
      lines.push(`graphdo v${VERSION}`);
      lines.push("");

      const authenticated = await config.authenticator.isAuthenticated(signal);
      if (authenticated) {
        const info = await config.authenticator.accountInfo(signal);
        lines.push(`Status: Logged in`);
        if (info) {
          lines.push(`User: ${info.username}`);
        }

        const scopes = await config.authenticator.grantedScopes(signal);
        if (scopes.length > 0) {
          lines.push(`Scopes: ${scopes.join(", ")}`);
        }
      } else {
        lines.push("Status: Not logged in");
        lines.push('Use the "login" tool to authenticate with Microsoft.');
      }

      lines.push("");

      const cfg = await loadConfig(config.configDir, signal);
      if (cfg?.todo?.listId && cfg.todo.listName) {
        lines.push(`Todo list: ${cfg.todo.listName} (${cfg.todo.listId})`);
      } else {
        lines.push("Todo list: Not configured");
        lines.push('Use the "todo_select_list" tool to select a todo list.');
      }

      if (cfg?.markdown?.rootFolderId) {
        const folderLabel = cfg.markdown.rootFolderPath ?? cfg.markdown.rootFolderName ?? "";
        lines.push(
          `Markdown root folder: ${folderLabel ? `${folderLabel} ` : ""}(${cfg.markdown.rootFolderId})`,
        );
      } else {
        lines.push("Markdown root folder: Not configured");
        lines.push('Use the "markdown_select_root_folder" tool to choose one.');
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error: unknown) {
      return formatError("status check", error, { prefix: "Status check failed: " });
    }
  };
}

export const authStatusTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler,
};
