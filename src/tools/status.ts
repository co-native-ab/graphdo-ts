// Status tool - shows authentication state and account info.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ServerConfig } from "../index.js";
import { z } from "zod";
import { VERSION } from "../index.js";
import { loadConfig } from "../config.js";
import { formatError } from "./shared.js";

/** Register the auth_status tool on the given MCP server. */
export function registerStatusTool(server: McpServer, config: ServerConfig): void {
  server.registerTool(
    "auth_status",
    {
      description:
        "Check current authentication status, logged-in user, configured todo list, " +
        "and server version. A good first tool to call when diagnosing issues or " +
        "understanding what is set up.",
      inputSchema: z.object({}),
      annotations: {
        title: "Authentication Status",
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
        } else {
          lines.push("Status: Not logged in");
          lines.push('Use the "login" tool to authenticate with Microsoft.');
        }

        lines.push("");

        // Todo list config
        const cfg = await loadConfig(config.configDir);
        if (cfg) {
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
  );
}
