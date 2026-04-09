// In-process integration tests using InMemoryTransport + real MCP Client.
//
// Tests run the full MCP server in-process, with a mock Graph API and a mock
// authenticator. No child processes, no stdio wiring — just linked transports.

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer, type ServerConfig } from "../src/index.js";
import { createMockGraphServer, MockState } from "./mock-graph.js";
import { MockAuthenticator } from "./mock-auth.js";
import { saveConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ToolContent {
  type: string;
  text: string;
}

interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

/** Extract the first text content from a tool call result. */
function firstText(result: ToolResult): string {
  const first = result.content[0];
  if (!first) throw new Error("Expected at least one content item");
  return first.text;
}

// ---------------------------------------------------------------------------
// Test environment
// ---------------------------------------------------------------------------

let graphState: MockState;
let graphServer: ReturnType<typeof import("node:http").createServer>;
let graphUrl: string;
let configDirPath: string;

let client: Client;
let auth: MockAuthenticator;

/** Create a fresh MCP client + server pair and connect them. */
async function createTestClient(
  authenticator: MockAuthenticator,
): Promise<Client> {
  const config: ServerConfig = {
    authenticator,
    graphBaseUrl: graphUrl,
    configDir: configDirPath,
  };

  const server = createMcpServer(config);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const c = new Client({ name: "test-client", version: "1.0.0" });

  await server.connect(serverTransport);
  await c.connect(clientTransport);

  return c;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("integration", () => {
  beforeAll(async () => {
    // Mock Graph API
    graphState = new MockState();
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
    graphServer = mock.server;
    graphUrl = mock.url;

    // Temp config dir
    configDirPath = await mkdtemp(path.join(tmpdir(), "graphdo-test-"));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      graphServer.close((err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });
    await rm(configDirPath, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Tool discovery
  // -----------------------------------------------------------------------

  describe("tool discovery", () => {
    beforeAll(async () => {
      auth = new MockAuthenticator({ token: "discovery-token" });
      client = await createTestClient(auth);
    });

    it("lists all expected tools", async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();

      expect(names).toEqual([
        "login",
        "logout",
        "mail_send",
        "todo_complete",
        "todo_config",
        "todo_create",
        "todo_delete",
        "todo_list",
        "todo_show",
        "todo_update",
      ]);
    });

    it("each tool has a description", async () => {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(tool.description).toBeTruthy();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Login flow
  // -----------------------------------------------------------------------

  describe("login flow", () => {
    beforeEach(async () => {
      auth = new MockAuthenticator();
      client = await createTestClient(auth);
    });

    it("returns device code message when not authenticated", async () => {
      const result = (await client.callTool({
        name: "login",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const text = firstText(result);
      expect(text).toContain("microsoft.com/devicelogin");
      expect(text).toContain("MOCK1234");
      expect(text).toContain("Once you've signed in");

      // Login should be pending
      expect(auth.loginPending).toBe(true);
    });

    it("reports already authenticated", async () => {
      // Complete auth first
      auth = new MockAuthenticator({ token: "existing-token" });
      client = await createTestClient(auth);

      const result = (await client.callTool({
        name: "login",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("Already logged in");
    });

    it("tools fail before login", async () => {
      const result = (await client.callTool({
        name: "mail_send",
        arguments: { subject: "Test", body: "Test body" },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain("Not logged in");
    });

    it("tools work after completing login", async () => {
      // Start login
      await client.callTool({ name: "login", arguments: {} });
      expect(auth.loginPending).toBe(true);

      // Simulate user completing device code flow
      auth.completeLogin("test-access-token");

      // Now tools should work (token() will await the pending login)
      const result = (await client.callTool({
        name: "mail_send",
        arguments: { subject: "Post-login test", body: "It works!" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("test@example.com");
    });

    it("logout clears auth and tools fail again", async () => {
      // Start authenticated
      auth = new MockAuthenticator({ token: "will-be-cleared" });
      client = await createTestClient(auth);

      // Verify tools work
      const before = (await client.callTool({
        name: "mail_send",
        arguments: { subject: "Before logout", body: "Works" },
      })) as ToolResult;
      expect(before.isError).toBeFalsy();

      // Logout
      const logoutResult = (await client.callTool({
        name: "logout",
        arguments: {},
      })) as ToolResult;
      expect(logoutResult.isError).toBeFalsy();
      expect(firstText(logoutResult)).toContain("Logged out");

      // Tools should fail now
      const after = (await client.callTool({
        name: "mail_send",
        arguments: { subject: "After logout", body: "Fails" },
      })) as ToolResult;
      expect(after.isError).toBe(true);
      expect(firstText(after)).toContain("Not logged in");
    });
  });

  // -----------------------------------------------------------------------
  // Mail
  // -----------------------------------------------------------------------

  describe("mail", () => {
    beforeAll(async () => {
      auth = new MockAuthenticator({ token: "mail-token" });
      client = await createTestClient(auth);
      // Reset sent mails
      graphState.sentMails = [];
    });

    it("sends mail to self", async () => {
      const result = (await client.callTool({
        name: "mail_send",
        arguments: { subject: "Test Subject", body: "Hello world" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("test@example.com");

      // Verify in mock state
      expect(graphState.sentMails).toHaveLength(1);
      const mail = graphState.sentMails[0]!;
      expect(mail.subject).toBe("Test Subject");
      expect(mail.body).toBe("Hello world");
      expect(mail.to).toBe("test@example.com");
      expect(mail.contentType).toBe("Text");
    });

    it("sends HTML mail", async () => {
      graphState.sentMails = [];

      const result = (await client.callTool({
        name: "mail_send",
        arguments: {
          subject: "HTML Email",
          body: "<h1>Hello</h1>",
          html: true,
        },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();

      const mail = graphState.sentMails[0]!;
      expect(mail.contentType).toBe("HTML");
      expect(mail.body).toBe("<h1>Hello</h1>");
    });
  });

  // -----------------------------------------------------------------------
  // Todo config
  // -----------------------------------------------------------------------

  describe("todo config", () => {
    beforeAll(async () => {
      auth = new MockAuthenticator({ token: "config-token" });
      client = await createTestClient(auth);
    });

    it("lists available todo lists", async () => {
      const result = (await client.callTool({
        name: "todo_config",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const text = firstText(result);
      expect(text).toContain("My Tasks");
      expect(text).toContain("list-1");
    });

    it("returns error for non-existent list", async () => {
      const result = (await client.callTool({
        name: "todo_config",
        arguments: { listId: "nonexistent" },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain("not found");
    });

    it("selects a todo list", async () => {
      const result = (await client.callTool({
        name: "todo_config",
        arguments: { listId: "list-1" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const text = firstText(result);
      expect(text).toContain("configured");
      expect(text).toContain("My Tasks");
    });
  });

  // -----------------------------------------------------------------------
  // Todo CRUD
  // -----------------------------------------------------------------------

  describe("todo CRUD", () => {
    beforeAll(async () => {
      auth = new MockAuthenticator({ token: "todo-token" });
      client = await createTestClient(auth);

      // Ensure config exists (set up by previous test group, but be explicit)
      await saveConfig(
        { todoListId: "list-1", todoListName: "My Tasks" },
        configDirPath,
      );

      // Reset todo state
      graphState.todos.set("list-1", [
        { id: "task-1", title: "Buy milk", status: "notStarted" },
      ]);
    });

    it("lists todos", async () => {
      const result = (await client.callTool({
        name: "todo_list",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("Buy milk");
    });

    it("shows a specific todo", async () => {
      const result = (await client.callTool({
        name: "todo_show",
        arguments: { taskId: "task-1" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const text = firstText(result);
      expect(text).toContain("Buy milk");
      expect(text).toContain("Not Started");
    });

    it("creates a todo", async () => {
      const result = (await client.callTool({
        name: "todo_create",
        arguments: { title: "New task", body: "Task body" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("New task");

      // Verify in mock state
      const tasks = graphState.getTodos("list-1");
      expect(tasks.find((t) => t.title === "New task")).toBeDefined();
    });

    it("updates a todo", async () => {
      const tasks = graphState.getTodos("list-1");
      const task = tasks.find((t) => t.title === "New task");

      const result = (await client.callTool({
        name: "todo_update",
        arguments: { taskId: task!.id, title: "Updated task" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("Updated task");
    });

    it("completes a todo", async () => {
      const result = (await client.callTool({
        name: "todo_complete",
        arguments: { taskId: "task-1" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("completed");

      // Verify in mock state
      const tasks = graphState.getTodos("list-1");
      const task = tasks.find((t) => t.id === "task-1");
      expect(task?.status).toBe("completed");
    });

    it("deletes a todo", async () => {
      const tasks = graphState.getTodos("list-1");
      const task = tasks.find((t) => t.title === "Updated task");

      const result = (await client.callTool({
        name: "todo_delete",
        arguments: { taskId: task!.id },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("deleted");

      // Verify in mock state
      const remaining = graphState.getTodos("list-1");
      expect(
        remaining.find((t) => t.title === "Updated task"),
      ).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    beforeAll(async () => {
      auth = new MockAuthenticator({ token: "error-token" });
      client = await createTestClient(auth);

      await saveConfig(
        { todoListId: "list-1", todoListName: "My Tasks" },
        configDirPath,
      );
    });

    it("returns error for non-existent todo", async () => {
      const result = (await client.callTool({
        name: "todo_show",
        arguments: { taskId: "does-not-exist" },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain("NotFound");
    });

    it("returns auth error when not logged in", async () => {
      const noAuth = new MockAuthenticator();
      const noAuthClient = await createTestClient(noAuth);

      const result = (await noAuthClient.callTool({
        name: "todo_list",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain("Not logged in");
    });

    it("returns error when todo list not configured", async () => {
      // Create a client with its own empty config dir
      const emptyConfigDir = await mkdtemp(
        path.join(tmpdir(), "graphdo-test-empty-"),
      );

      try {
        const emptyAuth = new MockAuthenticator({ token: "token" });
        const emptyConfig: ServerConfig = {
          authenticator: emptyAuth,
          graphBaseUrl: graphUrl,
          configDir: emptyConfigDir,
        };

        const server = createMcpServer(emptyConfig);
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const c = new Client({ name: "test", version: "1.0" });

        await server.connect(st);
        await c.connect(ct);

        const result = (await c.callTool({
          name: "todo_list",
          arguments: {},
        })) as ToolResult;

        expect(result.isError).toBe(true);
        expect(firstText(result)).toContain("not configured");
      } finally {
        await rm(emptyConfigDir, { recursive: true, force: true });
      }
    });
  });
});
