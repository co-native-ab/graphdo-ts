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
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js";

import { createMcpServer } from "../../src/index.js";
import { createMockGraphServer, MockState } from "../mock-graph.js";
import { MockAuthenticator } from "../mock-auth.js";

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

/** Elicitation response handler - returns the configured result. */
/** Handler that produces an elicitation response for testing MCP clients with form-based elicitation support. */
export type ElicitHandler = (params: {
  message: string;
  requestedSchema?: unknown;
}) => ElicitResult;

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
  graphState.todos.set("list-1", [
    { id: "task-1", title: "Buy milk", status: "notStarted" },
  ]);

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
  opts?: { openBrowser?: (url: string) => Promise<void> },
): Promise<Client> {
  const server = createMcpServer({
    authenticator,
    graphBaseUrl: env.graphUrl,
    configDir: env.configDir,
    openBrowser:
      opts?.openBrowser ??
      (() => Promise.reject(new Error("no browser in tests"))),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const c = new Client({ name: "test-client", version: "1.0.0" });

  await server.connect(serverTransport);
  await c.connect(clientTransport);

  return c;
}

/**
 * Create a client that supports form-based elicitation.
 * The handler function is called for each elicitation request.
 */
export async function createElicitingClient(
  env: IntegrationEnv,
  authenticator: MockAuthenticator,
  handler: ElicitHandler,
): Promise<Client> {
  const server = createMcpServer({
    authenticator,
    graphBaseUrl: env.graphUrl,
    configDir: env.configDir,
    openBrowser: () => Promise.reject(new Error("no browser in tests")),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const c = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } } },
  );

  c.setRequestHandler(ElicitRequestSchema, (request) => {
    const params = request.params;
    return Promise.resolve(
      handler({
        message: params.message,
        requestedSchema:
          "requestedSchema" in params ? params.requestedSchema : undefined,
      }),
    );
  });

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
