// Login tools - authentication management via MCP tools.
//
// Uses interactive browser login exclusively. If the browser cannot be opened,
// the tool returns an error with the login URL for manual navigation.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ServerConfig } from "../index.js";
import { UserCancelledError } from "../errors.js";
import { z } from "zod";
import { logger } from "../logger.js";
import { formatError } from "./shared.js";
import type { ToolDef, ToolEntry } from "../tool-registry.js";
import { defineTool } from "../tool-registry.js";

const LOGIN_DEF: ToolDef = {
  name: "login",
  title: "Login to Microsoft",
  description:
    "Sign in to Microsoft Graph. Call this tool directly whenever authentication " +
    "is needed - do not ask the user for permission first, just proceed with login. " +
    "Opens a browser for interactive sign-in. " +
    "Once signed in, all other tools work automatically.",
  requiredScopes: [],
};

const LOGOUT_DEF: ToolDef = {
  name: "logout",
  title: "Logout from Microsoft",
  description:
    "Sign out of Microsoft Graph and clear all cached tokens. " +
    "After logging out, the login tool must be used to re-authenticate.",
  requiredScopes: [],
};

export const LOGIN_TOOL_DEFS: readonly ToolDef[] = [LOGIN_DEF, LOGOUT_DEF];

/** Register login/logout tools on the given MCP server. */
export function registerLoginTools(server: McpServer, config: ServerConfig): ToolEntry[] {
  const entries: ToolEntry[] = [];

  // ---- login ----
  entries.push(
    defineTool(
      server,
      LOGIN_DEF,
      {
        inputSchema: z.object({}).shape,
        annotations: {
          title: LOGIN_DEF.title,
          readOnlyHint: false,
          openWorldHint: true,
          idempotentHint: true,
        },
      },
      async (_args, { signal }) => {
        try {
          if (await config.authenticator.isAuthenticated(signal)) {
            return {
              content: [
                {
                  type: "text",
                  text: "Already logged in. Use the logout tool first if you want to re-authenticate.",
                },
              ],
            };
          }

          const loginResult = await config.authenticator.login(signal);
          config.onScopesChanged?.(loginResult.grantedScopes);

          logger.info("browser login completed");
          return {
            content: [{ type: "text", text: loginResult.message }],
          };
        } catch (error: unknown) {
          if (error instanceof UserCancelledError) {
            return {
              content: [{ type: "text", text: "Login cancelled." }],
            };
          }
          return formatError("login", error, {
            prefix: "Login failed: ",
            suffix: "\n\nYou can call this tool again if the user would like to retry.",
          });
        }
      },
    ),
  );

  // ---- logout ----
  entries.push(
    defineTool(
      server,
      LOGOUT_DEF,
      {
        inputSchema: z.object({}).shape,
        annotations: {
          title: LOGOUT_DEF.title,
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
        },
      },
      async (_args, { signal }) => {
        try {
          if (!(await config.authenticator.isAuthenticated(signal))) {
            return {
              content: [
                {
                  type: "text",
                  text: "Not logged in — nothing to sign out of. Use the login tool to authenticate.",
                },
              ],
            };
          }
          await config.authenticator.logout(signal);
          config.onScopesChanged?.([]);
          return {
            content: [
              {
                type: "text",
                text: "Logged out successfully. Token cache cleared.",
              },
            ],
          };
        } catch (error: unknown) {
          if (error instanceof UserCancelledError) {
            return {
              content: [{ type: "text", text: "Logout cancelled." }],
            };
          }
          return formatError("logout", error, { prefix: "Logout failed: " });
        }
      },
    ),
  );

  return entries;
}
