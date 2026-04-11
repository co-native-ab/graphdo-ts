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

/** Register login/logout tools on the given MCP server. */
export function registerLoginTools(server: McpServer, config: ServerConfig): void {
  // ---- login ----

  server.registerTool(
    "login",
    {
      description:
        "Sign in to Microsoft Graph. Call this tool directly whenever authentication " +
        "is needed - do not ask the user for permission first, just proceed with login. " +
        "Opens a browser for interactive sign-in. " +
        "Once signed in, all other tools work automatically.",
      inputSchema: z.object({}),
      annotations: {
        title: "Login to Microsoft",
        readOnlyHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        // Check if already authenticated
        if (await config.authenticator.isAuthenticated()) {
          return {
            content: [
              {
                type: "text",
                text: "Already logged in. Use the logout tool first if you want to re-authenticate.",
              },
            ],
          };
        }

        const loginResult = await config.authenticator.login();

        logger.info("browser login completed");
        return {
          content: [
            {
              type: "text",
              text: loginResult.message,
            },
          ],
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
  );

  // ---- logout ----

  server.registerTool(
    "logout",
    {
      description:
        "Sign out of Microsoft Graph and clear all cached tokens. " +
        "After logging out, the login tool must be used to re-authenticate.",
      inputSchema: z.object({}),
      annotations: {
        title: "Logout from Microsoft",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        await config.authenticator.logout();
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
  );
}
