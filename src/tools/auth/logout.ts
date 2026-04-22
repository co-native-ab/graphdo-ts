// MCP tool: logout — clear cached MSAL tokens.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { UserCancelledError } from "../../errors.js";
import type { ServerConfig } from "../../index.js";
import type { Tool, ToolDef } from "../../tool-registry.js";
import { formatError } from "../shared.js";

const inputSchema = z.object({}).shape;

const def: ToolDef = {
  name: "logout",
  title: "Logout from Microsoft",
  description:
    "Sign out of Microsoft Graph and clear all cached tokens. " +
    "After logging out, the login tool must be used to re-authenticate.",
  requiredScopes: [],
};

function handler(config: ServerConfig): ToolCallback<typeof inputSchema> {
  return async (_args, { signal }) => {
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
        content: [{ type: "text", text: "Logged out successfully. Token cache cleared." }],
      };
    } catch (error: unknown) {
      if (error instanceof UserCancelledError) {
        return { content: [{ type: "text", text: "Logout cancelled." }] };
      }
      return formatError("logout", error, { prefix: "Logout failed: " });
    }
  };
}

export const logoutTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  handler,
};
