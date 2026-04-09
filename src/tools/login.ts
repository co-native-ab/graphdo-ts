// Login tools — authentication management via MCP tools.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ServerConfig } from "../index.js";
import { logger } from "../logger.js";

/** Register login/logout tools on the given MCP server. */
export function registerLoginTools(
  server: McpServer,
  config: ServerConfig,
): void {
  // ---- login ----

  server.registerTool(
    "login",
    {
      description:
        "Log in to Microsoft Graph using device code authentication. " +
        "Returns a URL and code — the user visits the URL in a browser and enters the code. " +
        "Once signed in, the other tools will work automatically.",
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
        if (await config.authenticator.isAuthenticated()) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Already logged in. Use the logout tool first if you want to re-authenticate.",
              },
            ],
          };
        }

        // Start device code flow — returns immediately with URL + code.
        // MSAL continues polling Azure AD in the background.
        const loginResult = await config.authenticator.login();
        logger.info("device code flow initiated, waiting for user");

        return {
          content: [
            {
              type: "text" as const,
              text: loginResult.message +
                "\n\nOnce you've signed in, you can use the other tools.",
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
        await config.authenticator.logout();
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
