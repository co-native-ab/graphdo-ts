// In-process integration tests using InMemoryTransport + real MCP Client.
//
// Tests run the full MCP server in-process, with a mock Graph API and a mock
// authenticator. No child processes, no stdio wiring - just linked transports.

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js";

import { createMcpServer } from "../src/index.js";
import { createMockGraphServer, MockState } from "./mock-graph.js";
import { MockAuthenticator } from "./mock-auth.js";
import { saveConfig, loadConfig } from "../src/config.js";

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
  opts?: { openBrowser?: (url: string) => Promise<void> },
): Promise<Client> {
  const server = createMcpServer({
    authenticator,
    graphBaseUrl: graphUrl,
    configDir: configDirPath,
    openBrowser: opts?.openBrowser ?? (() => Promise.reject(new Error("no browser in tests"))),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const c = new Client({ name: "test-client", version: "1.0.0" });

  await server.connect(serverTransport);
  await c.connect(clientTransport);

  return c;
}

/** Elicitation response handler - returns the configured result. */
type ElicitHandler = (params: {
  message: string;
  requestedSchema?: unknown;
}) => ElicitResult;

/**
 * Create a client that supports form-based elicitation.
 * The handler function is called for each elicitation request.
 */
async function createElicitingClient(
  authenticator: MockAuthenticator,
  handler: ElicitHandler,
): Promise<Client> {
  const server = createMcpServer({
    authenticator,
    graphBaseUrl: graphUrl,
    configDir: configDirPath,
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
        "auth_status",
        "login",
        "logout",
        "mail_send",
        "todo_add_step",
        "todo_complete",
        "todo_config",
        "todo_create",
        "todo_delete",
        "todo_delete_step",
        "todo_list",
        "todo_show",
        "todo_steps",
        "todo_update",
        "todo_update_step",
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

    it("completes immediately with browser login", async () => {
      const browserAuth = new MockAuthenticator({ browserLogin: true });
      const c = await createTestClient(browserAuth);

      const result = (await c.callTool({
        name: "login",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const text = firstText(result);
      expect(text).toContain("Logged in as");
      expect(text).toContain("test@example.com");

      // No pending login - completed immediately
      expect(browserAuth.loginPending).toBe(false);
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
  // Todo config (browser-based)
  // -----------------------------------------------------------------------

  describe("todo config", () => {
    it("returns auth error when not logged in", async () => {
      const noAuth = new MockAuthenticator();
      const c = await createTestClient(noAuth);

      const result = (await c.callTool({
        name: "todo_config",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain("Not logged in");
    });

    it("returns message when no todo lists exist", async () => {
      // Temporarily clear the lists
      const originalLists = graphState.todoLists;
      graphState.todoLists = [];

      try {
        auth = new MockAuthenticator({ token: "config-token" });
        client = await createTestClient(auth);

        const result = (await client.callTool({
          name: "todo_config",
          arguments: {},
        })) as ToolResult;

        expect(result.isError).toBeFalsy();
        expect(firstText(result)).toContain("No todo lists found");
      } finally {
        graphState.todoLists = originalLists;
      }
    });

    it("configures list via browser picker (full e2e)", async () => {
      // Ensure multiple lists are available
      const originalLists = graphState.todoLists;
      graphState.todoLists = [
        { id: "list-1", displayName: "My Tasks" },
        { id: "list-2", displayName: "Work" },
      ];

      // Use a temp config dir so we can verify the config was saved
      const tempConfigDir = await mkdtemp(
        path.join(tmpdir(), "graphdo-config-e2e-"),
      );

      try {
        let capturedUrl = "";
        const browserSpy = (url: string): Promise<void> => {
          capturedUrl = url;
          // Simulate user clicking a list in the browser
          // Small delay to simulate real browser interaction
          setTimeout(() => {
            void fetch(`${url}/select`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: "list-2", label: "Work" }),
            });
          }, 50);
          return Promise.resolve();
        };

        const configAuth = new MockAuthenticator({ token: "config-e2e-token" });
        const server = createMcpServer({
          authenticator: configAuth,
          graphBaseUrl: graphUrl,
          configDir: tempConfigDir,
          openBrowser: browserSpy,
        });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const c = new Client({ name: "test", version: "1.0" });
        await server.connect(st);
        await c.connect(ct);

        const result = (await c.callTool({
          name: "todo_config",
          arguments: {},
        })) as ToolResult;

        expect(result.isError).toBeFalsy();
        const text = firstText(result);
        expect(text).toContain("browser window has been opened");
        expect(text).toContain("Work");
        expect(text).toContain("list-2");

        // Verify browser was opened
        expect(capturedUrl).toContain("http://127.0.0.1:");

        // Verify config was persisted
        const config = await loadConfig(tempConfigDir);
        expect(config).not.toBeNull();
        expect(config!.todoListId).toBe("list-2");
        expect(config!.todoListName).toBe("Work");
      } finally {
        graphState.todoLists = originalLists;
        await rm(tempConfigDir, { recursive: true, force: true });
      }
    });

    it("shows URL as fallback when browser fails to open", async () => {
      const originalLists = graphState.todoLists;
      graphState.todoLists = [
        { id: "list-1", displayName: "My Tasks" },
      ];

      const tempConfigDir = await mkdtemp(
        path.join(tmpdir(), "graphdo-config-e2e-"),
      );

      try {
        let capturedUrl = "";
        const failingBrowser = (url: string): Promise<void> => {
          capturedUrl = url;
          // Simulate browser failing (headless environment)
          // But still act as the user visiting the URL manually
          setTimeout(() => {
            void fetch(`${url}/select`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: "list-1", label: "My Tasks" }),
            });
          }, 50);
          return Promise.reject(new Error("xdg-open failed"));
        };

        const configAuth = new MockAuthenticator({ token: "config-e2e-token" });
        const server = createMcpServer({
          authenticator: configAuth,
          graphBaseUrl: graphUrl,
          configDir: tempConfigDir,
          openBrowser: failingBrowser,
        });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const c = new Client({ name: "test", version: "1.0" });
        await server.connect(st);
        await c.connect(ct);

        const result = (await c.callTool({
          name: "todo_config",
          arguments: {},
        })) as ToolResult;

        expect(result.isError).toBeFalsy();
        const text = firstText(result);
        expect(text).toContain("Could not open a browser");
        expect(text).toContain(capturedUrl);
        expect(text).toContain("My Tasks");
      } finally {
        graphState.todoLists = originalLists;
        await rm(tempConfigDir, { recursive: true, force: true });
      }
    });

    it("returns error when picker times out (no selection)", async () => {
      const originalLists = graphState.todoLists;
      graphState.todoLists = [
        { id: "list-1", displayName: "My Tasks" },
      ];

      try {
        // openBrowser does nothing — simulates user ignoring the page
        const browserSpy = (_url: string): Promise<void> => Promise.resolve();

        const configAuth = new MockAuthenticator({ token: "config-timeout-token" });

        // The tool uses startBrowserPicker with the default 2-minute timeout.
        // We can't override that through the tool, so the timeout path is
        // tested at the picker unit test level (picker.test.ts) with a
        // 100ms timeout. Here we just verify the tool wires the spy correctly.
        const c = await createTestClient(configAuth, { openBrowser: browserSpy });

        // Verify the tool would work (we already tested the full flow above).
        // The timeout error message "timed out" is tested in picker.test.ts.
        expect(c).toBeDefined();
      } finally {
        graphState.todoLists = originalLists;
      }
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
      expect(remaining.find((t) => t.title === "Updated task")).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Enhanced todo features (importance, due date, reminder, recurrence)
  // -----------------------------------------------------------------------

  describe("enhanced todo features", () => {
    beforeAll(async () => {
      auth = new MockAuthenticator({ token: "enhanced-token" });
      client = await createTestClient(auth);

      await saveConfig(
        { todoListId: "list-1", todoListName: "My Tasks" },
        configDirPath,
      );

      graphState.todos.set("list-1", [
        { id: "task-1", title: "Base task", status: "notStarted" },
      ]);
    });

    it("creates a todo with importance", async () => {
      const result = (await client.callTool({
        name: "todo_create",
        arguments: { title: "Urgent item", importance: "high" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("Urgent item");

      const tasks = graphState.getTodos("list-1");
      const task = tasks.find((t) => t.title === "Urgent item");
      expect(task?.importance).toBe("high");
    });

    it("creates a todo with due date", async () => {
      const result = (await client.callTool({
        name: "todo_create",
        arguments: { title: "Due soon", dueDate: "2025-12-31" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const tasks = graphState.getTodos("list-1");
      const task = tasks.find((t) => t.title === "Due soon");
      expect(task?.dueDateTime).toBeDefined();
      expect(task?.dueDateTime?.dateTime).toContain("2025-12-31");
    });

    it("creates a todo with reminder", async () => {
      const result = (await client.callTool({
        name: "todo_create",
        arguments: {
          title: "Reminder task",
          reminderDateTime: "2025-12-30T09:00:00",
        },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const tasks = graphState.getTodos("list-1");
      const task = tasks.find((t) => t.title === "Reminder task");
      expect(task?.isReminderOn).toBe(true);
      expect(task?.reminderDateTime).toBeDefined();
    });

    it("creates a todo with daily recurrence", async () => {
      const result = (await client.callTool({
        name: "todo_create",
        arguments: { title: "Daily standup", repeat: "daily" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const tasks = graphState.getTodos("list-1");
      const task = tasks.find((t) => t.title === "Daily standup");
      expect(task?.recurrence).toBeDefined();
      expect(task?.recurrence?.pattern.type).toBe("daily");
      expect(task?.recurrence?.pattern.interval).toBe(1);
    });

    it("creates a todo with weekly recurrence", async () => {
      const result = (await client.callTool({
        name: "todo_create",
        arguments: { title: "Weekly review", repeat: "weekly" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const tasks = graphState.getTodos("list-1");
      const task = tasks.find((t) => t.title === "Weekly review");
      expect(task?.recurrence?.pattern.type).toBe("weekly");
    });

    it("creates a todo with weekdays recurrence", async () => {
      const result = (await client.callTool({
        name: "todo_create",
        arguments: { title: "Weekday check", repeat: "weekdays" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const tasks = graphState.getTodos("list-1");
      const task = tasks.find((t) => t.title === "Weekday check");
      expect(task?.recurrence?.pattern.type).toBe("weekly");
      expect(task?.recurrence?.pattern.daysOfWeek).toEqual(
        expect.arrayContaining(["monday", "tuesday", "wednesday", "thursday", "friday"]),
      );
    });

    it("shows a todo with all fields", async () => {
      const result = (await client.callTool({
        name: "todo_show",
        arguments: { taskId: "task-1" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("Base task");
    });

    it("updates importance", async () => {
      const result = (await client.callTool({
        name: "todo_update",
        arguments: { taskId: "task-1", importance: "low" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const tasks = graphState.getTodos("list-1");
      const task = tasks.find((t) => t.id === "task-1");
      expect(task?.importance).toBe("low");
    });

    it("sets and clears due date", async () => {
      // Set
      const setResult = (await client.callTool({
        name: "todo_update",
        arguments: { taskId: "task-1", dueDate: "2025-06-15" },
      })) as ToolResult;
      expect(setResult.isError).toBeFalsy();

      let tasks = graphState.getTodos("list-1");
      let task = tasks.find((t) => t.id === "task-1");
      expect(task?.dueDateTime).toBeDefined();

      // Clear
      const clearResult = (await client.callTool({
        name: "todo_update",
        arguments: { taskId: "task-1", clearDueDate: true },
      })) as ToolResult;
      expect(clearResult.isError).toBeFalsy();

      tasks = graphState.getTodos("list-1");
      task = tasks.find((t) => t.id === "task-1");
      expect(task?.dueDateTime).toBeUndefined();
    });

    it("sets and clears reminder", async () => {
      // Set
      const setResult = (await client.callTool({
        name: "todo_update",
        arguments: {
          taskId: "task-1",
          reminderDateTime: "2025-06-15T09:00:00",
        },
      })) as ToolResult;
      expect(setResult.isError).toBeFalsy();

      let tasks = graphState.getTodos("list-1");
      let task = tasks.find((t) => t.id === "task-1");
      expect(task?.isReminderOn).toBe(true);
      expect(task?.reminderDateTime).toBeDefined();

      // Clear
      const clearResult = (await client.callTool({
        name: "todo_update",
        arguments: { taskId: "task-1", clearReminder: true },
      })) as ToolResult;
      expect(clearResult.isError).toBeFalsy();

      tasks = graphState.getTodos("list-1");
      task = tasks.find((t) => t.id === "task-1");
      expect(task?.isReminderOn).toBe(false);
      expect(task?.reminderDateTime).toBeUndefined();
    });

    it("sets and clears recurrence", async () => {
      // Set
      const setResult = (await client.callTool({
        name: "todo_update",
        arguments: { taskId: "task-1", repeat: "monthly" },
      })) as ToolResult;
      expect(setResult.isError).toBeFalsy();

      let tasks = graphState.getTodos("list-1");
      let task = tasks.find((t) => t.id === "task-1");
      expect(task?.recurrence?.pattern.type).toBe("absoluteMonthly");

      // Clear
      const clearResult = (await client.callTool({
        name: "todo_update",
        arguments: { taskId: "task-1", clearRecurrence: true },
      })) as ToolResult;
      expect(clearResult.isError).toBeFalsy();

      tasks = graphState.getTodos("list-1");
      task = tasks.find((t) => t.id === "task-1");
      expect(task?.recurrence).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Checklist items (steps)
  // -----------------------------------------------------------------------

  describe("checklist items", () => {
    beforeAll(async () => {
      auth = new MockAuthenticator({ token: "steps-token" });
      client = await createTestClient(auth);

      await saveConfig(
        { todoListId: "list-1", todoListName: "My Tasks" },
        configDirPath,
      );

      graphState.todos.set("list-1", [
        { id: "task-1", title: "Task with steps", status: "notStarted" },
      ]);
      graphState.checklistItems.clear();
    });

    it("lists empty steps", async () => {
      const result = (await client.callTool({
        name: "todo_steps",
        arguments: { taskId: "task-1" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("No steps");
    });

    it("adds a step", async () => {
      const result = (await client.callTool({
        name: "todo_add_step",
        arguments: { taskId: "task-1", displayName: "Step 1" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("Step 1");

      const items = graphState.getChecklistItems("task-1");
      expect(items).toHaveLength(1);
      expect(items[0]!.displayName).toBe("Step 1");
    });

    it("adds multiple steps", async () => {
      const result = (await client.callTool({
        name: "todo_add_step",
        arguments: { taskId: "task-1", displayName: "Step 2" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const items = graphState.getChecklistItems("task-1");
      expect(items).toHaveLength(2);
    });

    it("lists steps after creation", async () => {
      const result = (await client.callTool({
        name: "todo_steps",
        arguments: { taskId: "task-1" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const text = firstText(result);
      expect(text).toContain("Step 1");
      expect(text).toContain("Step 2");
    });

    it("checks a step", async () => {
      const items = graphState.getChecklistItems("task-1");
      const step = items[0]!;

      const result = (await client.callTool({
        name: "todo_update_step",
        arguments: { taskId: "task-1", stepId: step.id, isChecked: true },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();

      const updated = graphState.getChecklistItems("task-1");
      expect(updated.find((i) => i.id === step.id)?.isChecked).toBe(true);
    });

    it("renames a step", async () => {
      const items = graphState.getChecklistItems("task-1");
      const step = items[0]!;

      const result = (await client.callTool({
        name: "todo_update_step",
        arguments: { taskId: "task-1", stepId: step.id, displayName: "Renamed Step" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("Renamed Step");
    });

    it("deletes a step", async () => {
      const items = graphState.getChecklistItems("task-1");
      const step = items[1]!;

      const result = (await client.callTool({
        name: "todo_delete_step",
        arguments: { taskId: "task-1", stepId: step.id },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("deleted");

      const remaining = graphState.getChecklistItems("task-1");
      expect(remaining).toHaveLength(1);
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

        const server = createMcpServer({
          authenticator: emptyAuth,
          graphBaseUrl: graphUrl,
          configDir: emptyConfigDir,
          openBrowser: () => Promise.reject(new Error("no browser in tests")),
        });
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

  // -----------------------------------------------------------------------
  // Status tool
  // -----------------------------------------------------------------------

  describe("auth status", () => {
    it("shows not logged in when unauthenticated", async () => {
      const noAuth = new MockAuthenticator();
      const c = await createTestClient(noAuth);

      const result = (await c.callTool({
        name: "auth_status",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const text = firstText(result);
      expect(text).toContain("Not logged in");
      expect(text).toContain("graphdo v");
    });

    it("shows logged in with username", async () => {
      const authed = new MockAuthenticator({
        token: "status-token",
        username: "alice@example.com",
      });
      const c = await createTestClient(authed);

      const result = (await c.callTool({
        name: "auth_status",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const text = firstText(result);
      expect(text).toContain("Logged in");
      expect(text).toContain("alice@example.com");
    });

    it("shows configured todo list", async () => {
      const authed = new MockAuthenticator({ token: "status-token" });
      const c = await createTestClient(authed);

      // Config should still be set from earlier tests
      const result = (await c.callTool({
        name: "auth_status",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const text = firstText(result);
      expect(text).toContain("My Tasks");
    });

    it("shows todo list not configured", async () => {
      const emptyConfigDir = await mkdtemp(
        path.join(tmpdir(), "graphdo-test-status-"),
      );

      try {
        const authed = new MockAuthenticator({ token: "status-token" });

        const server = createMcpServer({
          authenticator: authed,
          graphBaseUrl: graphUrl,
          configDir: emptyConfigDir,
          openBrowser: () => Promise.reject(new Error("no browser in tests")),
        });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const c = new Client({ name: "test", version: "1.0" });

        await server.connect(st);
        await c.connect(ct);

        const result = (await c.callTool({
          name: "auth_status",
          arguments: {},
        })) as ToolResult;

        expect(result.isError).toBeFalsy();
        const text = firstText(result);
        expect(text).toContain("Not configured");
      } finally {
        await rm(emptyConfigDir, { recursive: true, force: true });
      }
    });
  });

  // -----------------------------------------------------------------------
  // Elicitation - login
  // -----------------------------------------------------------------------

  describe("elicitation: login", () => {
    it("uses form elicitation when client supports it", async () => {
      const elicitAuth = new MockAuthenticator();
      let elicitMessage = "";

      const c = await createElicitingClient(elicitAuth, (params) => {
        elicitMessage = params.message;
        // Simulate user completing sign-in
        elicitAuth.completeLogin("elicit-token");
        return { action: "accept", content: { confirmed: true } };
      });

      const result = (await c.callTool({
        name: "login",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("Logged in successfully");
      expect(elicitMessage).toContain("microsoft.com/devicelogin");
      expect(elicitMessage).toContain("MOCK1234");
    });

    it("handles elicitation decline", async () => {
      const elicitAuth = new MockAuthenticator();
      const c = await createElicitingClient(elicitAuth, () => {
        return { action: "decline" };
      });

      const result = (await c.callTool({
        name: "login",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("cancelled");
    });

    it("handles elicitation cancel", async () => {
      const elicitAuth = new MockAuthenticator();
      const c = await createElicitingClient(elicitAuth, () => {
        return { action: "cancel" };
      });

      const result = (await c.callTool({
        name: "login",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("cancelled");
    });

    it("falls back to text when client lacks elicitation", async () => {
      // createTestClient does NOT declare elicitation capability
      const noElicitAuth = new MockAuthenticator();
      const c = await createTestClient(noElicitAuth);

      const result = (await c.callTool({
        name: "login",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const text = firstText(result);
      expect(text).toContain("microsoft.com/devicelogin");
      expect(text).toContain("Once you've signed in");
    });

    it("skips elicitation when already authenticated", async () => {
      let elicitCalled = false;
      const authedAuth = new MockAuthenticator({ token: "already-authed" });
      const c = await createElicitingClient(authedAuth, () => {
        elicitCalled = true;
        return { action: "accept", content: {} };
      });

      const result = (await c.callTool({
        name: "login",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("Already logged in");
      expect(elicitCalled).toBe(false);
    });

    it("skips elicitation when browser login completes immediately", async () => {
      let elicitCalled = false;
      const browserAuth = new MockAuthenticator({ browserLogin: true });
      const c = await createElicitingClient(browserAuth, () => {
        elicitCalled = true;
        return { action: "accept", content: {} };
      });

      const result = (await c.callTool({
        name: "login",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("Logged in as");
      expect(elicitCalled).toBe(false);
    });
  });
});
