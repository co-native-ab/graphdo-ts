// Full end-to-end integration tests.
//
// Spins up three servers:
//   1. Mock Graph API   — in-memory state for mail, todo, user
//   2. Mock OIDC        — RSA key pair, JWKS endpoint, JWT signing
//   3. Real HTTP server — the actual Express app from src/index.ts
//
// Tests use StreamableHTTPClientTransport (the real MCP HTTP client) to
// connect, authenticate, call tools, and verify side-effects in the mock
// Graph state.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type { Server as HttpServer } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createRemoteJWKSet } from "jose";

import {
  CLIENT_ID,
  AUTHORIZATION_SERVER,
  RESOURCE_SCOPES,
  createTokenValidator,
} from "../src/auth.js";
import { saveConfig } from "../src/config.js";
import { createMockOIDC } from "./mock-oidc.js";
import type { MockOIDC } from "./mock-oidc.js";
import { createMockGraphServer, MockState } from "./mock-graph.js";

// ---------------------------------------------------------------------------
// Shared infrastructure — started once for the whole file
// ---------------------------------------------------------------------------

let oidc: MockOIDC;
let graphState: MockState;
let graphServer: HttpServer;
let graphUrl: string;
let httpServer: HttpServer;
let serverUrl: string;
let tmpDir: string;

beforeAll(async () => {
  // 1. Start mock Graph API
  graphState = new MockState();
  graphState.user = {
    id: "user-1",
    displayName: "Test User",
    mail: "test@example.com",
    userPrincipalName: "test@example.com",
  };
  graphState.todoLists = [
    { id: "list-1", displayName: "My Tasks" },
    { id: "list-2", displayName: "Work" },
  ];
  graphState.todos.set("list-1", [
    { id: "task-1", title: "Buy milk", status: "notStarted" },
  ]);
  graphState.todos.set("list-2", []);

  const graph = await createMockGraphServer(graphState);
  graphServer = graph.server;
  graphUrl = graph.url;

  // 2. Set env vars BEFORE importing src/index.ts (GRAPH_BASE_URL is evaluated at import time)
  process.env["GRAPHDO_GRAPH_URL"] = graphUrl;
  tmpDir = path.join(os.tmpdir(), `graphdo-integ-${crypto.randomUUID()}`);
  process.env["GRAPHDO_CONFIG_DIR"] = tmpDir;
  process.env["PORT"] = "0";

  // 3. Start mock OIDC
  oidc = await createMockOIDC();

  // 4. Dynamically import the server module (picks up env vars)
  const { startServer } = await import("../src/index.js");
  const jwks = createRemoteJWKSet(new URL(oidc.jwksUrl));
  const validator = createTokenValidator(jwks, CLIENT_ID);
  httpServer = await startServer({ validateToken: validator });

  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  serverUrl = `http://localhost:${String(port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await new Promise<void>((resolve) => graphServer.close(() => resolve()));
  await oidc.close();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  delete process.env["GRAPHDO_GRAPH_URL"];
  delete process.env["GRAPHDO_CONFIG_DIR"];
  delete process.env["PORT"];
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an MCP client connected over real HTTP with a signed JWT. */
async function createAuthenticatedClient(): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const token = await oidc.signToken();
  const transport = new StreamableHTTPClientTransport(
    new URL(`${serverUrl}/mcp`),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  );
  const client = new Client({ name: "integration-test", version: "1.0" });
  await client.connect(transport);
  return { client, transport };
}

function textContent(result: Record<string, unknown>): string {
  const content = result["content"] as { type: string; text: string }[];
  const first = content[0];
  if (first?.type !== "text") throw new Error("expected text content");
  return first.text;
}

// ---------------------------------------------------------------------------
// Discovery flow tests
// ---------------------------------------------------------------------------

describe("discovery flow", () => {
  it("serves Protected Resource Metadata", async () => {
    const res = await fetch(
      `${serverUrl}/.well-known/oauth-protected-resource`,
    );
    expect(res.status).toBe(200);

    const metadata = (await res.json()) as Record<string, unknown>;
    expect(metadata["resource"]).toBe(serverUrl);
    expect(metadata["authorization_servers"]).toEqual([AUTHORIZATION_SERVER]);
    expect(metadata["scopes_supported"]).toEqual([...RESOURCE_SCOPES]);
    expect(metadata["bearer_methods_supported"]).toEqual(["header"]);
  });

  it("returns 401 with resource_metadata when no token on existing session", async () => {
    // Initialize a session (allowed without token)
    const initRes = await fetch(`${serverUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "discovery-test", version: "1.0" },
        },
        id: 1,
      }),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    // Send a request without token on the established session
    const res = await fetch(`${serverUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        id: 2,
      }),
    });

    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("www-authenticate") ?? "";
    expect(wwwAuth).toContain("resource_metadata=");
    expect(wwwAuth).toContain("/.well-known/oauth-protected-resource");
  });

  it("completes full discovery → auth → success flow", async () => {
    // Step 1: Init a session (no token needed)
    const initRes = await fetch(`${serverUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "discovery-flow", version: "1.0" },
        },
        id: 1,
      }),
    });
    const sessionId = initRes.headers.get("mcp-session-id")!;

    // Step 2: Try a request without token → get 401
    const unauthRes = await fetch(`${serverUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        id: 2,
      }),
    });
    expect(unauthRes.status).toBe(401);

    // Step 3: Extract resource_metadata URL from WWW-Authenticate
    const wwwAuth = unauthRes.headers.get("www-authenticate") ?? "";
    const metadataMatch = /resource_metadata="([^"]+)"/.exec(wwwAuth);
    expect(metadataMatch).toBeTruthy();
    const metadataUrl = metadataMatch![1]!;

    // Step 4: Fetch the metadata endpoint
    const metadataRes = await fetch(metadataUrl);
    expect(metadataRes.status).toBe(200);
    const metadata = (await metadataRes.json()) as Record<string, unknown>;
    expect(metadata["authorization_servers"]).toEqual([AUTHORIZATION_SERVER]);

    // Step 5: "Get a token" (using mock OIDC) and retry
    const token = await oidc.signToken();
    const authRes = await fetch(`${serverUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });

    // Notification returns 202
    expect(authRes.status).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// Mail tool tests
// ---------------------------------------------------------------------------

describe("mail_send", () => {
  let client: Client;

  beforeAll(async () => {
    const pair = await createAuthenticatedClient();
    client = pair.client;
  });

  afterAll(async () => {
    await client.close();
  });

  beforeEach(() => {
    // Clear sent mails before each test
    graphState.sentMails = [];
  });

  it("sends email and records it in mock Graph", async () => {
    const result = await client.callTool({
      name: "mail_send",
      arguments: { subject: "Integration Test", body: "Hello from e2e" },
    });

    expect(result.isError).toBeFalsy();
    expect(textContent(result)).toContain("test@example.com");

    // Verify side-effect in mock Graph state
    const mails = graphState.getSentMails();
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe("test@example.com");
    expect(mails[0]!.subject).toBe("Integration Test");
    expect(mails[0]!.body).toBe("Hello from e2e");
    expect(mails[0]!.contentType).toBe("Text");
  });

  it("sends HTML email", async () => {
    const result = await client.callTool({
      name: "mail_send",
      arguments: {
        subject: "HTML Test",
        body: "<b>Bold</b>",
        html: true,
      },
    });

    expect(result.isError).toBeFalsy();

    const mails = graphState.getSentMails();
    expect(mails).toHaveLength(1);
    expect(mails[0]!.contentType).toBe("HTML");
    expect(mails[0]!.body).toBe("<b>Bold</b>");
  });
});

// ---------------------------------------------------------------------------
// Todo tool tests — full CRUD lifecycle
// ---------------------------------------------------------------------------

describe("todo tools", () => {
  let client: Client;

  beforeAll(async () => {
    const pair = await createAuthenticatedClient();
    client = pair.client;
  });

  afterAll(async () => {
    await client.close();
  });

  // ---- todo_config ----

  describe("todo_config", () => {
    it("lists available todo lists when called without listId", async () => {
      const result = await client.callTool({
        name: "todo_config",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      const text = textContent(result);
      expect(text).toContain("Available todo lists");
      expect(text).toContain("My Tasks");
      expect(text).toContain("list-1");
      expect(text).toContain("Work");
      expect(text).toContain("list-2");
    });

    it("rejects an invalid list ID", async () => {
      const result = await client.callTool({
        name: "todo_config",
        arguments: { listId: "nonexistent" },
      });

      expect(result.isError).toBe(true);
      expect(textContent(result)).toContain("not found");
    });

    it("saves config when given a valid listId", async () => {
      const result = await client.callTool({
        name: "todo_config",
        arguments: { listId: "list-1" },
      });

      expect(result.isError).toBeFalsy();
      const text = textContent(result);
      expect(text).toContain("Todo list configured");
      expect(text).toContain("My Tasks");
    });
  });

  // ---- todo_list ----

  describe("todo_list", () => {
    it("returns the pre-seeded todo", async () => {
      const result = await client.callTool({
        name: "todo_list",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      const text = textContent(result);
      expect(text).toContain("Buy milk");
      expect(text).toContain("task-1");
    });
  });

  // ---- Full CRUD lifecycle ----

  describe("CRUD lifecycle", () => {
    let createdTaskId: string;

    it("creates a new todo and it appears in mock state", async () => {
      const result = await client.callTool({
        name: "todo_create",
        arguments: { title: "Integration task", body: "Created by e2e test" },
      });

      expect(result.isError).toBeFalsy();
      const text = textContent(result);
      expect(text).toContain("Created todo");
      expect(text).toContain("Integration task");

      // Extract the ID from the response
      const idMatch = /\(([^)]+)\)/.exec(text);
      expect(idMatch).toBeTruthy();
      createdTaskId = idMatch![1]!;

      // Verify in mock Graph state
      const todos = graphState.getTodos("list-1");
      const created = todos.find((t) => t.id === createdTaskId);
      expect(created).toBeDefined();
      expect(created!.title).toBe("Integration task");
      expect(created!.body).toEqual({
        content: "Created by e2e test",
        contentType: "text",
      });
    });

    it("shows the created todo with full details", async () => {
      const result = await client.callTool({
        name: "todo_show",
        arguments: { taskId: createdTaskId },
      });

      expect(result.isError).toBeFalsy();
      const text = textContent(result);
      expect(text).toContain("Integration task");
      expect(text).toContain("Not Started");
      expect(text).toContain(createdTaskId);
      expect(text).toContain("Created by e2e test");
    });

    it("lists todos and the created one is included", async () => {
      const result = await client.callTool({
        name: "todo_list",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      const text = textContent(result);
      expect(text).toContain("Buy milk");
      expect(text).toContain("Integration task");
    });

    it("updates the todo title", async () => {
      const result = await client.callTool({
        name: "todo_update",
        arguments: { taskId: createdTaskId, title: "Updated task" },
      });

      expect(result.isError).toBeFalsy();
      const text = textContent(result);
      expect(text).toContain("Updated todo");
      expect(text).toContain("Updated task");

      // Verify in mock state
      const todos = graphState.getTodos("list-1");
      const updated = todos.find((t) => t.id === createdTaskId);
      expect(updated!.title).toBe("Updated task");
    });

    it("completes the todo", async () => {
      const result = await client.callTool({
        name: "todo_complete",
        arguments: { taskId: createdTaskId },
      });

      expect(result.isError).toBeFalsy();
      expect(textContent(result)).toContain("marked as completed");

      // Verify in mock state
      const todos = graphState.getTodos("list-1");
      const completed = todos.find((t) => t.id === createdTaskId);
      expect(completed!.status).toBe("completed");
    });

    it("deletes the todo", async () => {
      const result = await client.callTool({
        name: "todo_delete",
        arguments: { taskId: createdTaskId },
      });

      expect(result.isError).toBeFalsy();
      expect(textContent(result)).toContain("deleted");

      // Verify removed from mock state
      const todos = graphState.getTodos("list-1");
      expect(todos.find((t) => t.id === createdTaskId)).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Error scenarios
// ---------------------------------------------------------------------------

describe("error handling", () => {
  it("rejects unauthenticated requests with 401", async () => {
    // The MCP SDK sends an `initialized` notification after the init handshake.
    // Since init succeeds without a token but the notification is a non-init
    // request, the server returns 401 and the SDK throws during connect().
    const transport = new StreamableHTTPClientTransport(
      new URL(`${serverUrl}/mcp`),
    );
    const client = new Client({ name: "no-auth-test", version: "1.0" });

    try {
      await client.connect(transport);
      // If connect somehow succeeds, the tool call should fail
      await expect(
        client.callTool({
          name: "mail_send",
          arguments: { subject: "test", body: "test" },
        }),
      ).rejects.toThrow();
    } catch (err) {
      // Expected: SDK throws StreamableHTTPError with 401
      expect(err).toBeDefined();
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("Unauthorized");
    } finally {
      await client.close();
    }
  });

  it("returns error when todo operations called without config", async () => {
    // Remove any config saved by earlier tests
    const cfgFile = path.join(tmpDir, "config.json");
    await fs.rm(cfgFile, { force: true });

    const { client } = await createAuthenticatedClient();
    try {
      const result = await client.callTool({
        name: "todo_list",
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expect(textContent(result)).toContain("not configured");
    } finally {
      await client.close();
      // Restore config for any subsequent tests
      await saveConfig(
        { todoListId: "list-1", todoListName: "My Tasks" },
        tmpDir,
      );
    }
  });

  it("returns error for non-existent todo", async () => {
    // Ensure config exists
    await saveConfig(
      { todoListId: "list-1", todoListName: "My Tasks" },
      tmpDir,
    );

    const { client } = await createAuthenticatedClient();
    try {
      const result = await client.callTool({
        name: "todo_show",
        arguments: { taskId: "does-not-exist" },
      });

      expect(result.isError).toBe(true);
      expect(textContent(result)).toContain("NotFound");
    } finally {
      await client.close();
    }
  });
});
