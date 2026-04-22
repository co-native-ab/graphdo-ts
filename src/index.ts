// graphdo-ts - MCP server providing AI agents with scoped access to Microsoft Graph.
// Entry point: stdio-based MCP server with MSAL authentication (browser-only).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { Authenticator } from "./auth.js";
import { MsalAuthenticator, StaticAuthenticator, DEFAULT_TENANT_ID } from "./auth.js";
import { openBrowser } from "./browser/open.js";
import { configDir } from "./config.js";
import { GraphClient } from "./graph/client.js";
import { logger, setLogLevel } from "./logger.js";
import type { GraphScope } from "./scopes.js";
import { AUTH_TOOLS } from "./tools/auth/index.js";
import { MAIL_TOOLS } from "./tools/mail/index.js";
import { MARKDOWN_TOOLS } from "./tools/markdown/index.js";
import { TODO_TOOLS } from "./tools/todo/index.js";
import type { AnyTool, ToolEntry } from "./tool-registry.js";
import { buildInstructions, registerTool, syncToolState } from "./tool-registry.js";

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
  // All tools the server exposes, in instruction-listing order.
  const allTools: readonly AnyTool[] = [
    ...AUTH_TOOLS,
    ...MAIL_TOOLS,
    ...TODO_TOOLS,
    ...MARKDOWN_TOOLS,
  ];

  const mcpServer = new McpServer(
    { name: "graphdo", version: VERSION },
    {
      capabilities: { logging: {} },
      instructions: buildInstructions(allTools.map((t) => t.def)),
    },
  );

  // Create a single GraphClient instance for the lifetime of this server.
  const graphClient = new GraphClient(opts.graphBaseUrl, {
    getToken: (s: AbortSignal) => opts.authenticator.token(s),
  });

  const config: ServerConfig = { ...opts, graphClient };

  // Register every tool descriptor in a single loop. The descriptor is the
  // single source of truth for metadata, schemas, annotations, and handler.
  const registry: ToolEntry[] = allTools.map((tool) => registerTool(mcpServer, config, tool));

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
// Shutdown wiring
// ---------------------------------------------------------------------------

/**
 * Signal sources that trigger a graceful shutdown. Narrower than
 * `NodeJS.Process` / `NodeJS.ReadStream` so tests can pass stand-ins.
 */
export interface ShutdownProcess {
  once(event: "SIGINT" | "SIGTERM" | "SIGHUP", listener: () => void): unknown;
}
export interface ShutdownStdin {
  once(event: "end" | "close", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

/**
 * Subscribe `shutdown` to every signal source that should terminate the
 * MCP server: SIGINT, SIGTERM, SIGHUP, and stdin end/close/error. The
 * stdin hooks matter on Copilot CLI reload — the CLI closes our pipe
 * but does not always deliver SIGTERM, and `StdioServerTransport.onclose`
 * does not always fire. Without this, orphan graphdo-ts processes
 * survive the reload and hold resources hostage.
 *
 * Idempotent per controller: repeated triggers after abort are no-ops.
 * Exported for unit testing; wire with the live process/stdin in main.
 */
export function wireShutdownSignals(
  shutdown: AbortController,
  proc: ShutdownProcess,
  stdin: ShutdownStdin,
): void {
  const trigger = (name: string): void => {
    if (shutdown.signal.aborted) return;
    logger.info("shutdown signal received", { signal: name });
    shutdown.abort(new Error(name));
  };
  proc.once("SIGINT", () => trigger("SIGINT"));
  proc.once("SIGTERM", () => trigger("SIGTERM"));
  proc.once("SIGHUP", () => trigger("SIGHUP"));
  stdin.once("end", () => trigger("stdin-end"));
  stdin.once("close", () => trigger("stdin-close"));
  stdin.on("error", (err: Error) => {
    logger.warn("stdin error", { error: err.message });
    trigger("stdin-error");
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.env["GRAPHDO_DEBUG"] === "true") {
    setLogLevel("debug");
  }

  // Create a top-level AbortController that's cancelled on SIGINT/SIGTERM/SIGHUP
  // or when the MCP client disconnects our stdin pipe. See
  // `wireShutdownSignals` above for the rationale behind the stdin hooks.
  const shutdown = new AbortController();
  wireShutdownSignals(shutdown, process, process.stdin);

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
