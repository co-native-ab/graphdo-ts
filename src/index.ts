// graphdo-ts - MCP server providing AI agents with scoped access to Microsoft Graph.
// Entry point: stdio-based MCP server with MSAL authentication (browser + device code fallback).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { Authenticator } from "./auth.js";
import { MsalAuthenticator, StaticAuthenticator } from "./auth.js";
import { openBrowser } from "./browser.js";
import { configDir } from "./config.js";
import { GraphClient } from "./graph/client.js";
import { logger, setLogLevel } from "./logger.js";
import { registerLoginTools } from "./tools/login.js";
import { registerMailTools } from "./tools/mail.js";
import { registerTodoTools } from "./tools/todo.js";
import { registerConfigTools } from "./tools/config.js";
import { registerStatusTool } from "./tools/status.js";

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

/** Configuration for the MCP server - all dependencies injected here. */
export interface ServerConfig {
  authenticator: Authenticator;
  graphBaseUrl: string;
  configDir: string;
  /**
   * Single GraphClient instance shared across all tool handlers.
   * Uses the authenticator as a TokenCredential — tokens are fetched (and
   * silently refreshed) on every Graph API request, which is correct for
   * long-running MCP server instances.
   */
  graphClient: GraphClient;
  /** McpServer instance for elicitation and capability checks. */
  mcpServer: McpServer;
  /** Opens a URL in the system browser. Injected for testability. */
  openBrowser: (url: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

/** Create a configured McpServer instance with all tools registered. */
export function createMcpServer(
  opts: Omit<ServerConfig, "mcpServer" | "graphClient">,
): McpServer {
  const mcpServer = new McpServer(
    { name: "graphdo", version: VERSION },
    {
      capabilities: { logging: {} },
      instructions:
        "graphdo gives you access to Microsoft To Do and Outlook mail.\n\n" +
        "IMPORTANT BEHAVIOR RULES:\n" +
        "- When a tool returns an authentication error, call the login tool immediately - " +
        "do not ask the user whether they want to log in.\n" +
        "- When a tool returns a 'todo list not configured' error, call the todo_config " +
        "tool immediately - do not ask the user which list to use, the tool opens a " +
        "browser picker where the user selects the list themselves.\n" +
        "- Use auth_status as a first step when diagnosing issues.\n\n" +
        "WORKFLOW: On first use, call login (automatic browser sign-in), then " +
        "todo_config (browser-based list selection), then the user's requested action.",
    },
  );

  // Create a single GraphClient instance for the lifetime of this server.
  // The credential calls authenticator.token() on every request, so MSAL's
  // silent refresh keeps tokens current even in long-running server sessions.
  const graphClient = new GraphClient(opts.graphBaseUrl, {
    getToken: () => opts.authenticator.token(),
  });

  const config: ServerConfig = { ...opts, mcpServer, graphClient };

  registerLoginTools(mcpServer, config);
  registerMailTools(mcpServer, config);
  registerTodoTools(mcpServer, config);
  registerConfigTools(mcpServer, config);
  registerStatusTool(mcpServer, config);

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

  // Use static token if provided, otherwise MSAL (browser + device code fallback)
  const staticToken = process.env["GRAPHDO_ACCESS_TOKEN"];
  const authenticator: Authenticator = staticToken
    ? new StaticAuthenticator(staticToken)
    : new MsalAuthenticator(CLIENT_ID, cfgDir, [...SCOPES], openBrowser);

  const graphBaseUrl =
    process.env["GRAPHDO_GRAPH_URL"] ?? "https://graph.microsoft.com/v1.0";

  const server = createMcpServer({
    authenticator,
    graphBaseUrl,
    configDir: cfgDir,
    openBrowser,
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
