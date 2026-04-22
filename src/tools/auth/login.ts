// MCP tool: login — interactive browser sign-in to Microsoft Graph.

import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { UserCancelledError } from "../../errors.js";
import type { ServerConfig } from "../../index.js";
import { logger } from "../../logger.js";
import type { Tool, ToolDef } from "../../tool-registry.js";
import { formatError } from "../shared.js";

const inputSchema = z.object({}).shape;

const def: ToolDef = {
  name: "login",
  title: "Login to Microsoft",
  description:
    "Sign in to Microsoft Graph. Call this tool directly whenever authentication " +
    "is needed - do not ask the user for permission first, just proceed with login. " +
    "Opens a browser for interactive sign-in. " +
    "Once signed in, all other tools work automatically.",
  requiredScopes: [],
};

function handler(config: ServerConfig): ToolCallback<typeof inputSchema> {
  return async (_args, { signal }) => {
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
      return { content: [{ type: "text", text: loginResult.message }] };
    } catch (error: unknown) {
      if (error instanceof UserCancelledError) {
        return { content: [{ type: "text", text: "Login cancelled." }] };
      }
      return formatError("login", error, {
        prefix: "Login failed: ",
        suffix: "\n\nYou can call this tool again if the user would like to retry.",
      });
    }
  };
}

export const loginTool: Tool<typeof inputSchema> = {
  def,
  inputSchema,
  annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
  handler,
};
