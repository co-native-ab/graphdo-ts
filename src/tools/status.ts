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
      async (_args, { signal }) => {
        try {
          const lines: string[] = [];
          lines.push(`graphdo v${VERSION}`);
          lines.push("");

          // Authentication status
          const authenticated = await config.authenticator.isAuthenticated(signal);
          if (authenticated) {
            const info = await config.authenticator.accountInfo(signal);
            lines.push(`Status: Logged in`);
            if (info) {
              lines.push(`User: ${info.username}`);
              lines.push(`User OID: ${info.userOid}`);
            }

            // Granted scopes
            const scopes = await config.authenticator.grantedScopes(signal);
            if (scopes.length > 0) {
              lines.push(`Scopes: ${scopes.join(", ")}`);
            }
          } else {
            lines.push("Status: Not logged in");
            lines.push('Use the "login" tool to authenticate with Microsoft.');
          }

          lines.push("");

          // Todo list config
          const cfg = await loadConfig(config.configDir, signal);
          if (cfg?.todoListId && cfg.todoListName) {
            lines.push(`Todo list: ${cfg.todoListName} (${cfg.todoListId})`);
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
