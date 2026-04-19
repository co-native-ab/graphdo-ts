// graphdo-ts - MCP server providing AI agents with scoped access to Microsoft Graph.
// Entry point: stdio-based MCP server with MSAL authentication (browser-only).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { Authenticator } from "./auth.js";
import { MsalAuthenticator, StaticAuthenticator, DEFAULT_TENANT_ID } from "./auth.js";
import { openBrowser } from "./browser.js";
import { configDir } from "./config.js";
import { GraphClient } from "./graph/client.js";
import { logger, setLogLevel } from "./logger.js";
import type { GraphScope } from "./scopes.js";
import { LOGIN_TOOL_DEFS, registerLoginTools } from "./tools/login.js";
import { MAIL_TOOL_DEFS, registerMailTools } from "./tools/mail.js";
import { MARKDOWN_TOOL_DEFS, registerMarkdownTools } from "./tools/markdown.js";
import { TODO_TOOL_DEFS, STEP_TOOL_DEFS, registerTodoTools } from "./tools/todo.js";
import { CONFIG_TOOL_DEFS, registerConfigTools } from "./tools/config.js";
import { STATUS_TOOL_DEFS, registerStatusTool } from "./tools/status.js";
import type { ToolEntry } from "./tool-registry.js";
import { buildInstructions, syncToolState } from "./tool-registry.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

declare const __VERSION__: string;
export const VERSION: string = __VERSION__;

/** Azure AD (Entra ID) multi-tenant app registration client ID, published by Co-native AB. */
export const CLIENT_ID = "b073490b-a1a2-4bb8-9d83-00bb5c15fcfd";

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
  /** Opens a URL in the system browser. Injected for testability. */
  openBrowser: (url: string) => Promise<void>;
  /**
   * Wall-clock factory. Defaults to `() => new Date()` in production; tests
   * inject a fake clock (`test/collab/clock.ts`, landing with W1 Day 5) so
   * TTL math, audit timestamps, and renewal counters are deterministic.
   * Required by the upcoming collab surfaces — no current consumer beyond
   * tests, but plumbed here per `docs/plans/collab-v1.md` §8.3 so future
   * milestones do not have to back-fill the parameter through every tool.
   */
  now?: () => Date;
  /** Set by createMcpServer() — login/logout tools call this to sync tool visibility. */
  onScopesChanged?: (grantedScopes: GraphScope[]) => void;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

/** Create a configured McpServer instance with all tools registered. */
export async function createMcpServer(
  opts: Omit<ServerConfig, "graphClient">,
  signal: AbortSignal,
): Promise<McpServer> {
  // Collect all static tool definitions for instruction generation
  const allDefs = [
    ...LOGIN_TOOL_DEFS,
    ...STATUS_TOOL_DEFS,
    ...MAIL_TOOL_DEFS,
    ...TODO_TOOL_DEFS,
    ...STEP_TOOL_DEFS,
    ...CONFIG_TOOL_DEFS,
    ...MARKDOWN_TOOL_DEFS,
  ];

  const mcpServer = new McpServer(
    { name: "graphdo", version: VERSION },
    {
      capabilities: { logging: {} },
      instructions: buildInstructions(allDefs),
    },
  );

  // Create a single GraphClient instance for the lifetime of this server.
  const graphClient = new GraphClient(opts.graphBaseUrl, {
    getToken: (s: AbortSignal) => opts.authenticator.token(s),
  });

  const config: ServerConfig = { ...opts, graphClient };

  // Register all tools and collect entries for dynamic state management
  const registry: ToolEntry[] = [
    ...registerLoginTools(mcpServer, config),
    ...registerMailTools(mcpServer, config),
    ...registerTodoTools(mcpServer, config),
    ...registerConfigTools(mcpServer, config),
    ...registerMarkdownTools(mcpServer, config),
    ...registerStatusTool(mcpServer, config),
  ];

  // Disable all scope-gated tools initially
  for (const entry of registry) {
    if (entry.requiredScopes.length > 0) {
      entry.registeredTool.disable();
    }
  }

  // Wire up the callback that login/logout tools use to sync tool visibility
  config.onScopesChanged = (grantedScopes: GraphScope[]) => {
    syncToolState(registry, grantedScopes, mcpServer);
  };

  // Check startup auth state — if already authenticated, enable matching tools
  try {
    if (await opts.authenticator.isAuthenticated(signal)) {
      const scopes = await opts.authenticator.grantedScopes(signal);
      if (scopes.length > 0) {
        syncToolState(registry, scopes, mcpServer);
      }
    }
  } catch {
    // Startup check failure is non-fatal — tools stay disabled
    logger.debug("startup auth check failed, tools remain disabled");
  }

  return mcpServer;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.env["GRAPHDO_DEBUG"] === "true") {
    setLogLevel("debug");
  }

  // Create a top-level AbortController that's cancelled on SIGINT/SIGTERM.
  const shutdown = new AbortController();
  const onProcessSignal = (name: string): void => {
    logger.info("shutdown signal received", { signal: name });
    shutdown.abort(new Error(name));
  };
  process.once("SIGINT", () => onProcessSignal("SIGINT"));
  process.once("SIGTERM", () => onProcessSignal("SIGTERM"));

  const cfgDir = configDir(process.env["GRAPHDO_CONFIG_DIR"]);
  logger.debug("config directory", { path: cfgDir });

  // Use static token if provided, otherwise MSAL (browser-only)
  const staticToken = process.env["GRAPHDO_ACCESS_TOKEN"];
  const clientId = process.env["GRAPHDO_CLIENT_ID"] ?? CLIENT_ID;
  const tenantId = process.env["GRAPHDO_TENANT_ID"] ?? DEFAULT_TENANT_ID;
  const authenticator: Authenticator = staticToken
    ? new StaticAuthenticator(staticToken)
    : new MsalAuthenticator(clientId, tenantId, cfgDir, openBrowser);

  const graphBaseUrl = process.env["GRAPHDO_GRAPH_URL"] ?? "https://graph.microsoft.com/v1.0";

  const server = await createMcpServer(
    {
      authenticator,
      graphBaseUrl,
      configDir: cfgDir,
      openBrowser,
      now: () => new Date(),
    },
    shutdown.signal,
  );
  const transport = new StdioServerTransport();

  await server.connect(transport);
  logger.info("server started on stdio");

  // Keep the process alive until the transport closes or shutdown is signalled.
  await new Promise<void>((resolve) => {
    transport.onclose = () => {
      logger.info("transport closed");
      resolve();
    };
    shutdown.signal.addEventListener(
      "abort",
      () => {
        logger.info("shutting down");
        resolve();
      },
      { once: true },
    );
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
