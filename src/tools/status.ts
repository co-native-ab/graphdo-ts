// Status tool - shows authentication state and account info.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ServerConfig } from "../index.js";
import { z } from "zod";
import { VERSION } from "../index.js";
import { loadConfig } from "../config.js";
import { formatError } from "./shared.js";
import type { ToolDef, ToolEntry } from "../tool-registry.js";
import { defineTool } from "../tool-registry.js";

const STATUS_DEF: ToolDef = {
  name: "auth_status",
  title: "Authentication Status",
  description:
    "Check current authentication status, logged-in user, configured todo list, " +
    "granted scopes, and server version. A good first tool to call when diagnosing " +
    "issues or understanding what is set up.",
  requiredScopes: [],
};

export const STATUS_TOOL_DEFS: readonly ToolDef[] = [STATUS_DEF];

/** Register the auth_status tool on the given MCP server. */
export function registerStatusTool(server: McpServer, config: ServerConfig): ToolEntry[] {
  return [
    defineTool(
      server,
      STATUS_DEF,
      {
        inputSchema: z.object({}).shape,
        annotations: {
          title: STATUS_DEF.title,
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        try {
          const lines: string[] = [];
          lines.push(`graphdo v${VERSION}`);
          lines.push("");

          // Authentication status
          const authenticated = await config.authenticator.isAuthenticated();
          if (authenticated) {
            const info = await config.authenticator.accountInfo();
            lines.push(`Status: Logged in`);
            if (info) {
              lines.push(`User: ${info.username}`);
            }

            // Granted scopes
            const scopes = await config.authenticator.grantedScopes();
            if (scopes.length > 0) {
              lines.push(`Scopes: ${scopes.join(", ")}`);
            }
          } else {
            lines.push("Status: Not logged in");
            lines.push('Use the "login" tool to authenticate with Microsoft.');
          }

          lines.push("");

          // Todo list config
          const cfg = await loadConfig(config.configDir);
          if (cfg?.todoListId && cfg.todoListName) {
            lines.push(`Todo list: ${cfg.todoListName} (${cfg.todoListId})`);
          } else {
            lines.push("Todo list: Not configured");
            lines.push('Use the "todo_config" tool to select a todo list.');
          }

          return {
            content: [{ type: "text", text: lines.join("\n") }],
          };
        } catch (error: unknown) {
          return formatError("status check", error, {
            prefix: "Status check failed: ",
          });
        }
      },
    ),
  ];
}
