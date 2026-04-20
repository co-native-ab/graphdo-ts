// Shared helpers for integration tests.
//
// Each integration test file creates its own mock Graph API server and config
// directory for full isolation — no shared mutable state across test files.

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import type { Server } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../../src/index.js";
import { createMockGraphServer, MockState } from "../mock-graph.js";
import { MockAuthenticator } from "../mock-auth.js";
import { testSignal } from "../helpers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolContent {
  type: string;
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the first text content from a tool call result. */
export function firstText(result: ToolResult): string {
  const first = result.content[0];
  if (!first) throw new Error("Expected at least one content item");
  return first.text;
}

// ---------------------------------------------------------------------------
// Test environment
// ---------------------------------------------------------------------------

export interface IntegrationEnv {
  graphState: MockState;
  graphServer: Server;
  graphUrl: string;
  configDir: string;
}

/** Set up a fresh mock Graph API server and temp config directory. */
export async function setupIntegrationEnv(): Promise<IntegrationEnv> {
  const graphState = new MockState();
  graphState.user = {
    id: "user-1",
    displayName: "Test User",
    mail: "test@example.com",
    userPrincipalName: "test@example.com",
  };
  graphState.todoLists = [{ id: "list-1", displayName: "My Tasks" }];
  graphState.todos.set("list-1", [{ id: "task-1", title: "Buy milk", status: "notStarted" }]);

  const mock = await createMockGraphServer(graphState);
  const configDir = await mkdtemp(path.join(tmpdir(), "graphdo-test-"));

  return {
    graphState,
    graphServer: mock.server,
    graphUrl: mock.url,
    configDir,
  };
}

/** Tear down the mock server and clean up the temp config directory. */
export async function teardownIntegrationEnv(env: IntegrationEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    env.graphServer.close((err?: Error) => {
      if (err) reject(err);
      else resolve();
    });
  });
  await rm(env.configDir, { recursive: true, force: true });
}

/** Create a fresh MCP client + server pair and connect them. */
export async function createTestClient(
  env: IntegrationEnv,
  authenticator: MockAuthenticator,
  opts?: {
    openBrowser?: (url: string) => Promise<void>;
    now?: () => Date;
    /**
     * Override the MCP `clientInfo` payload reported via
     * `ServerConfig.getClientInfo`. Used by `21-agent-name-unknown.test.ts`
     * to simulate a client whose `clientInfo.name` is empty / missing
     * (warn-once `agent_name_unknown` audit, W5 Day 3). Pass `null` to
     * simulate a client that sent no `clientInfo` at all.
     */
    clientInfo?: { name?: string; version?: string } | null;
    /**
     * Pre-built {@link import("../../src/collab/session.js").SessionRegistry}
     * threaded into the server. Used by `19-session-survives-reconnect.test.ts`
     * to keep the in-memory session alive across a transport reconnect.
     */
    sessionRegistry?: import("../../src/collab/session.js").SessionRegistry;
    /** Override the test client's `clientInfo` (defaults to `test-client / 1.0.0`). */
    testClientInfo?: { name: string; version: string };
  },
): Promise<Client> {
  const server = await createMcpServer(
    {
      authenticator,
      graphBaseUrl: env.graphUrl,
      configDir: env.configDir,
      openBrowser: opts?.openBrowser ?? (() => Promise.reject(new Error("no browser in tests"))),
      ...(opts?.now ? { now: opts.now } : {}),
      ...(opts?.sessionRegistry ? { sessionRegistry: opts.sessionRegistry } : {}),
      ...(opts?.clientInfo !== undefined
        ? {
            getClientInfo: (): { name?: string; version?: string } | undefined =>
              opts.clientInfo === null ? undefined : opts.clientInfo,
          }
        : {}),
    },
    testSignal(),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const c = new Client(opts?.testClientInfo ?? { name: "test-client", version: "1.0.0" });

  await server.connect(serverTransport);
  await c.connect(clientTransport);

  return c;
}

// Re-export for convenience
export { MockAuthenticator } from "../mock-auth.js";
export { MockState } from "../mock-graph.js";
export { saveConfig, loadConfig } from "../../src/config.js";
export { createMcpServer } from "../../src/index.js";
export { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
export { Client } from "@modelcontextprotocol/sdk/client/index.js";
export { fetchCsrfToken, testSignal } from "../helpers.js";
