// graphdo-ts - MCP server providing AI agents with scoped access to Microsoft Graph.
// Entry point: stdio-based MCP server with MSAL authentication (browser-only).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { Authenticator } from "./auth.js";
import { MsalAuthenticator, StaticAuthenticator, DEFAULT_TENANT_ID } from "./auth.js";
import { openBrowser } from "./browser.js";
import { newUlid } from "./collab/ulid.js";
import { SessionRegistry } from "./collab/session.js";
import { configDir } from "./config.js";
import { GraphClient } from "./graph/client.js";
import { acquireInstanceLock, type InstanceLockHandle } from "./instance-lock.js";
import { logger, setLogLevel } from "./logger.js";
import { type AgentPersona, AGENT_PERSONA_ENV_VAR, parseAgentPersonaFromEnv } from "./persona.js";
import type { GraphScope } from "./scopes.js";
import { LOGIN_TOOL_DEFS, registerLoginTools } from "./tools/login.js";
import { MAIL_TOOL_DEFS, registerMailTools } from "./tools/mail.js";
import { MARKDOWN_TOOL_DEFS, registerMarkdownTools } from "./tools/markdown.js";
import { TODO_TOOL_DEFS, STEP_TOOL_DEFS, registerTodoTools } from "./tools/todo.js";
import { CONFIG_TOOL_DEFS, registerConfigTools } from "./tools/config.js";
import { COLLAB_TOOL_DEFS, registerCollabTools } from "./tools/collab/index.js";
import { SESSION_TOOL_DEFS, registerSessionTools } from "./tools/session.js";
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
  /**
   * In-memory holder for the single active collab session (see §2.2 of
   * `docs/plans/collab-v1.md`). Created in `createMcpServer()` and shared
   * across all session/collab tools so they all see the same TTL math,
   * budget counters, and persisted destructive state. The registry mirrors
   * counter mutations to `<configDir>/sessions/destructive-counts.json`
   * (§3.7) so a future `session_open_project` rebinding by `sessionId`
   * does not reset the budget within the same session window.
   */
  sessionRegistry: SessionRegistry;
  /**
   * Lazy accessor for the connected MCP client's `clientInfo` (W5 Day 3,
   * §2.2 / §10 question 4). Returns `undefined` when no client has yet
   * called `initialize`. Used by `session_init_project` and
   * `session_open_project` to seed the session's `agentId` middle segment
   * with the client's slugified `name` (e.g. `"vscode"`, `"claude-ai"`,
   * `"claude-code"`); when the name is missing or all-non-slug-chars the
   * registry emits a one-time `agent_name_unknown` audit and falls back
   * to `"unknown"`.
   *
   * Wired in `createMcpServer()` to read from `mcpServer.server.getClientVersion()`.
   * Tests can override to simulate a specific client identity (or a
   * missing one).
   */
  getClientInfo?: () => { name?: string; version?: string } | undefined;
  /** Set by createMcpServer() — login/logout tools call this to sync tool visibility. */
  onScopesChanged?: (grantedScopes: GraphScope[]) => void;
  /**
   * Optional test-persona override (`docs/plans/two-instance-e2e.md`,
   * ADR-0009). When set, the collab session's `agentId` is replaced
   * with the persona id (e.g. `"persona:alice"`) so two MCP server
   * processes on the same Microsoft account can be treated as
   * distinct collaborators by the destructive classifier, authorship
   * trail, lease ownership, and audit envelopes. The persona id never
   * reaches Microsoft Graph — Graph requests still use the same MSAL
   * token from the same MSAL cache. The override is read **once** from
   * `GRAPHDO_AGENT_PERSONA` in `main()`; tests inject it directly here.
   */
  agentPersona?: AgentPersona;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

/** Create a configured McpServer instance with all tools registered. */
export async function createMcpServer(
  opts: Omit<ServerConfig, "graphClient" | "sessionRegistry"> & {
    /**
     * Optional pre-built {@link SessionRegistry}. Tests pass one to
     * simulate "same process, dropped transport, new transport" — a
     * fresh `McpServer` paired with the surviving registry yields the
     * same active session, matching test 19's DoD. Production callers
     * (`main()`) leave this `undefined` so the registry is constructed
     * from `now` + `configDir`.
     */
    sessionRegistry?: SessionRegistry;
  },
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
    ...SESSION_TOOL_DEFS,
    ...COLLAB_TOOL_DEFS,
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

  // The session registry is server-scoped — one process, one active session
  // (see §2.2). The injected `now` factory keeps TTL math deterministic in
  // tests; the ULID generator is seeded from the same clock so a fake clock
  // yields reproducible session ids too.
  //
  // Tests can also supply a pre-built registry via `opts.sessionRegistry`
  // to simulate transport reconnect within the same process — the same
  // registry threaded into a fresh `McpServer` keeps the in-memory session
  // alive across the disconnect, matching test 19's DoD.
  const now = opts.now ?? ((): Date => new Date());
  const sessionRegistry =
    opts.sessionRegistry ??
    new SessionRegistry(opts.configDir, () => newUlid(() => now().getTime()), now);

  const config: ServerConfig = {
    ...opts,
    graphClient,
    sessionRegistry,
    // Lazy reader: mcpServer.server.getClientVersion() returns the
    // client's `Implementation` record after `initialize`. Tests can
    // override this via opts.getClientInfo (e.g. to simulate a client
    // sending an empty `name` — see test 21).
    getClientInfo:
      opts.getClientInfo ??
      ((): { name?: string; version?: string } | undefined => {
        const impl = mcpServer.server.getClientVersion();
        if (impl === undefined) return undefined;
        return { name: impl.name, version: impl.version };
      }),
  };

  // Register all tools and collect entries for dynamic state management
  const registry: ToolEntry[] = [
    ...registerLoginTools(mcpServer, config),
    ...registerMailTools(mcpServer, config),
    ...registerTodoTools(mcpServer, config),
    ...registerConfigTools(mcpServer, config),
    ...registerMarkdownTools(mcpServer, config),
    ...registerSessionTools(mcpServer, config),
    ...registerCollabTools(mcpServer, config),
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

  // Test-persona override (`docs/plans/two-instance-e2e.md`, ADR-0009).
  // Read **once** here so the override naturally dies with the process
  // and cannot be smuggled via runtime tool calls. Invalid values
  // surface as a fatal startup error rather than silent fallback.
  const agentPersona = parseAgentPersonaFromEnv(process.env);
  if (agentPersona !== undefined) {
    logger.warn("agent persona override active", {
      env: AGENT_PERSONA_ENV_VAR,
      id: agentPersona.id,
      configDir: cfgDir,
    });
  }

  // Per-configDir instance lock — refuses startup when another
  // graphdo-ts process is already pointed at this `<configDir>`. See
  // `src/instance-lock.ts` for rationale.
  let lockHandle: InstanceLockHandle;
  try {
    lockHandle = await acquireInstanceLock(cfgDir);
  } catch (err: unknown) {
    logger.error("instance lock acquisition failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

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
      ...(agentPersona !== undefined ? { agentPersona } : {}),
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

  // Best-effort lock release — never let release errors mask a normal
  // exit. The lock file may legitimately be gone already if another
  // process recovered it as stale (which would itself be a bug, but
  // not one we can act on here).
  await lockHandle.release();
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
