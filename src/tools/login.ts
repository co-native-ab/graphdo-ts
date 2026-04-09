// Login tools — authentication management via MCP tools.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Authenticator } from "../auth.js";
import { logger } from "../logger.js";

/** Register login/logout tools on the given MCP server. */
export function registerLoginTools(
  server: McpServer,
  authenticator: Authenticator,
): void {
  // ---- login ----

  server.registerTool(
    "login",
    {
      description:
        "Log in to Microsoft Graph using device code authentication. " +
        "Returns a URL and code — the user visits the URL in a browser and enters the code. " +
        "This tool blocks until the user completes authentication.",
      inputSchema: {},
      annotations: {
        title: "Login to Microsoft",
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        // Check if already authenticated
        if (await authenticator.isAuthenticated()) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Already logged in. Use the logout tool first if you want to re-authenticate.",
              },
            ],
          };
        }

        const loginResult = await authenticator.login();

        // Return the device code message immediately for display, then await completion
        logger.info("device code flow initiated, waiting for user");

        // Block until the user completes authentication
        await loginResult.done;

        return {
          content: [
            {
              type: "text" as const,
              text: `${loginResult.message}\n\nAuthentication successful! You can now use the other tools.`,
            },
          ],
        };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.error("login failed", { error: message });
        return {
          content: [{ type: "text" as const, text: `Login failed: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // ---- logout ----

  server.registerTool(
    "logout",
    {
      description:
        "Log out of Microsoft Graph by clearing cached tokens. " +
        "After logging out, the login tool must be used to re-authenticate.",
      inputSchema: {},
      annotations: {
        title: "Logout from Microsoft",
        readOnlyHint: false,
        destructiveHint: true,
      },
    },
    async () => {
      try {
        await authenticator.logout();
        return {
          content: [
            {
              type: "text" as const,
              text: "Logged out successfully. Token cache cleared.",
            },
          ],
        };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.error("logout failed", { error: message });
        return {
          content: [{ type: "text" as const, text: `Logout failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
