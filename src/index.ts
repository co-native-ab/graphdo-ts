// graphdo-ts — MCP server providing AI agents with scoped access to Microsoft Graph.
// Entry point: stdio-based MCP server with MSAL device code authentication.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { Authenticator } from "./auth.js";
import {
  DeviceCodeAuthenticator,
  StaticAuthenticator,
} from "./auth.js";
import { configDir } from "./config.js";
import { logger, setLogLevel } from "./logger.js";
import { registerLoginTools } from "./tools/login.js";
import { registerMailTools } from "./tools/mail.js";
import { registerTodoTools } from "./tools/todo.js";
import { registerConfigTools } from "./tools/config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

declare const __VERSION__: string;
export const VERSION: string = __VERSION__;

/** Azure AD app registration client ID (same as Go graphdo). */
export const CLIENT_ID = "b073490b-a1a2-4bb8-9d83-00bb5c15fcfd";

export const SCOPES: readonly string[] = [
  "Mail.Send",
  "Tasks.ReadWrite",
  "User.Read",
  "offline_access",
];

// ---------------------------------------------------------------------------
// Server configuration
// ---------------------------------------------------------------------------

/** Configuration for the MCP server — all dependencies injected here. */
export interface ServerConfig {
  authenticator: Authenticator;
  graphBaseUrl: string;
  configDir: string;
  /** McpServer instance for elicitation and capability checks. */
  mcpServer: McpServer;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

/** Create a configured McpServer instance with all tools registered. */
export function createMcpServer(
  opts: Omit<ServerConfig, "mcpServer">,
): McpServer {
  const mcpServer = new McpServer(
    { name: "graphdo", version: VERSION },
    { capabilities: { logging: {} } },
  );

  const config: ServerConfig = { ...opts, mcpServer };

  registerLoginTools(mcpServer, config);
  registerMailTools(mcpServer, config);
  registerTodoTools(mcpServer, config);
  registerConfigTools(mcpServer, config);

  return mcpServer;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.env["GRAPHDO_DEBUG"] === "true") {
    setLogLevel("debug");
  }

  const cfgDir = configDir(process.env["GRAPHDO_CONFIG_DIR"]);
  logger.debug("config directory", { path: cfgDir });

  // Use static token if provided, otherwise MSAL device code flow
  const staticToken = process.env["GRAPHDO_ACCESS_TOKEN"];
  const authenticator: Authenticator = staticToken
    ? new StaticAuthenticator(staticToken)
    : new DeviceCodeAuthenticator(CLIENT_ID, cfgDir, [...SCOPES]);

  const graphBaseUrl =
    process.env["GRAPHDO_GRAPH_URL"] ?? "https://graph.microsoft.com/v1.0";

  const server = createMcpServer({
    authenticator,
    graphBaseUrl,
    configDir: cfgDir,
  });
  const transport = new StdioServerTransport();

  await server.connect(transport);
  logger.info("server started on stdio");

  // Keep the process alive until the transport closes.
  await new Promise<void>((resolve) => {
    transport.onclose = () => {
      logger.info("transport closed");
      resolve();
    };
  });
}

// Auto-start only when running as the entry point (not when imported by tests).
if (!process.env["VITEST"]) {
  main().catch((err: unknown) => {
    logger.error("fatal", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
