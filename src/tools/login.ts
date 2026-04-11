// Login tools - authentication management via MCP tools.
//
// Supports two login methods:
// 1. Interactive browser login (preferred) - opens system browser, completes immediately
// 2. Device code flow (fallback) - returns URL + code for manual entry
//
// When the client supports elicitation and device code is used, a form prompt
// displays the URL + code and waits for the user to confirm.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ServerConfig } from "../index.js";
import { z } from "zod";
import { logger } from "../logger.js";
import { formatError } from "./shared.js";

/** Check whether the connected client supports form-based elicitation. */
function clientSupportsElicitation(config: ServerConfig): boolean {
  const caps = config.mcpServer.server.getClientCapabilities();
  return caps?.elicitation?.form !== undefined;
}

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
        "Sign in to Microsoft Graph. Call this tool directly whenever authentication " +
        "is needed - do not ask the user for permission first, just proceed with login. " +
        "Opens a browser for interactive sign-in. If a browser is unavailable, " +
        "falls back to device code authentication (returns a URL and code for manual entry). " +
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

        // Start login - may complete immediately (browser) or need user action (device code)
        const loginResult = await config.authenticator.login();

        // Browser login completed immediately
        if (loginResult.completed) {
          logger.info("browser login completed");
          return {
            content: [
              {
                type: "text",
                text: loginResult.message,
              },
            ],
          };
        }

        // Device code flow - login is pending in the background
        logger.info("device code flow initiated, waiting for user");

        // If the client supports elicitation, show a form prompt and wait
        // for the user to confirm they've completed sign-in.
        if (clientSupportsElicitation(config)) {
          const elicitResult = await config.mcpServer.server.elicitInput({
            message: loginResult.message,
            requestedSchema: {
              type: "object" as const,
              properties: {
                confirmed: {
                  type: "boolean" as const,
                  title: "I've completed sign-in",
                  description:
                    "Check this after you've visited the URL and entered the code.",
                  default: false,
                },
              },
            },
          });

          if (elicitResult.action !== "accept") {
            return {
              content: [
                {
                  type: "text",
                  text: "Login cancelled. Use the login tool when you're ready to sign in.",
                },
              ],
            };
          }

          // Wait for the background MSAL flow to complete
          try {
            await config.authenticator.token();
          } catch {
            return {
              content: [
                {
                  type: "text",
                  text: "Sign-in not yet complete. Please visit the URL, enter the code, and try again.",
                },
              ],
              isError: true,
            };
          }

          return {
            content: [
              {
                type: "text",
                text: "Logged in successfully. You can now use the other tools.",
              },
            ],
          };
        }

        // Fallback: return the device code message as text (non-blocking).
        return {
          content: [
            {
              type: "text",
              text:
                loginResult.message +
                "\n\nOnce you've signed in, you can use the other tools.",
            },
          ],
        };
      } catch (error: unknown) {
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
        return formatError("logout", error, { prefix: "Logout failed: " });
      }
    },
  );
}
