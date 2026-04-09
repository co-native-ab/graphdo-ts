import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import { saveConfig } from "../../src/config.js";
import { createTestEnv, type TestEnv } from "../helpers.js";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  let graphUrl = "";
  let configDirPath = "";
  return {
    getGraphUrl: () => graphUrl,
    setGraphUrl: (url: string) => {
      graphUrl = url;
    },
    getConfigDir: () => configDirPath,
    setConfigDir: (dir: string) => {
      configDirPath = dir;
    },
  };
});

vi.mock("../../src/index.js", () => ({
  get GRAPH_BASE_URL() {
    return mocks.getGraphUrl();
  },
  VERSION: "0.1.0",
}));

vi.mock("../../src/config.js", async (importOriginal) => {
  const orig =
    await importOriginal<typeof import("../../src/config.js")>();
  return {
    ...orig,
    configDir: () => mocks.getConfigDir(),
  };
});

// Import tools AFTER mocks are registered
import { registerTodoTools } from "../../src/tools/todo.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUTH_INFO: AuthInfo = {
  token: "test-token",
  clientId: "test-client-id",
  scopes: ["Tasks.ReadWrite"],
};

function patchTransportAuth(
  transport: InMemoryTransport,
  authInfo: AuthInfo,
): void {
  const originalSend = transport.send.bind(transport);
  transport.send = async (message, options) =>
    originalSend(message, { ...options, authInfo });
}

function textContent(result: Record<string, unknown>): string {
  const content = result["content"] as { type: string; text: string }[];
  const first = content[0];
  if (first?.type !== "text") throw new Error("expected text content");
  return first.text;
}

function makeTempDir(): string {
  return path.join(os.tmpdir(), `graphdo-test-${crypto.randomUUID()}`);
}

function createServer(): McpServer {
  const server = new McpServer(
    { name: "graphdo", version: "0.1.0" },
    { capabilities: { logging: {} } },
  );
  registerTodoTools(server);
  return server;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("todo tools", () => {
  let env: TestEnv;
  let client: Client;
  let mcpServer: McpServer;
  let tmpDir: string;

  beforeEach(async () => {
    env = await createTestEnv();
    mocks.setGraphUrl(env.graphUrl);

    tmpDir = makeTempDir();
    mocks.setConfigDir(tmpDir);

    // Pre-save config with list-1
    await saveConfig(
      { todoListId: "list-1", todoListName: "My Tasks" },
      tmpDir,
    );

    mcpServer = createServer();

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    patchTransportAuth(clientTransport, AUTH_INFO);

    await mcpServer.connect(serverTransport);

    client = new Client({ name: "test-client", version: "1.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await mcpServer.close();
    await env.cleanup();
    await fs
      .rm(tmpDir, { recursive: true, force: true })
      .catch(() => {
        /* ignore cleanup errors */
      });
  });

  // ---------- todo_list ----------

  describe("todo_list", () => {
    it("returns formatted list of todos", async () => {
      const result = await client.callTool({
        name: "todo_list",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      const text = textContent(result);
      expect(text).toContain("My Tasks");
      expect(text).toContain("Buy milk");
      expect(text).toContain("task-1");
    });

    it("with empty list shows 'No todos found'", async () => {
      // Clear all todos from list-1
      env.state.todos.set("list-1", []);

      const result = await client.callTool({
        name: "todo_list",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      expect(textContent(result)).toContain("No todos found");
    });

    it("respects pagination (top/skip)", async () => {
      // Add more todos
      env.state.todos.set("list-1", [
        { id: "t-1", title: "Task A", status: "notStarted" },
        { id: "t-2", title: "Task B", status: "notStarted" },
        { id: "t-3", title: "Task C", status: "notStarted" },
      ]);

      const result = await client.callTool({
        name: "todo_list",
        arguments: { top: 1, skip: 1 },
      });

      expect(result.isError).toBeFalsy();
      const text = textContent(result);
      expect(text).toContain("Task B");
      expect(text).not.toContain("Task A");
      expect(text).not.toContain("Task C");
    });

    it("without config returns error", async () => {
      // Remove config file
      await fs.rm(tmpDir, { recursive: true, force: true });

      const result = await client.callTool({
        name: "todo_list",
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expect(textContent(result)).toContain("not configured");
    });

    it("without auth returns error", async () => {
      const noAuthServer = createServer();

      const [noAuthClientTransport, noAuthServerTransport] =
        InMemoryTransport.createLinkedPair();

      await noAuthServer.connect(noAuthServerTransport);

      const noAuthClient = new Client({
        name: "no-auth-client",
        version: "1.0",
      });
      await noAuthClient.connect(noAuthClientTransport);

      try {
        const result = await noAuthClient.callTool({
          name: "todo_list",
          arguments: {},
        });

        expect(result.isError).toBe(true);
        expect(textContent(result)).toContain("Authentication required");
      } finally {
        await noAuthClient.close();
        await noAuthServer.close();
      }
    });
  });

  // ---------- todo_show ----------

  describe("todo_show", () => {
    it("returns todo details", async () => {
      const result = await client.callTool({
        name: "todo_show",
        arguments: { taskId: "task-1" },
      });

      expect(result.isError).toBeFalsy();
      const text = textContent(result);
      expect(text).toContain("Buy milk");
      expect(text).toContain("Not Started");
      expect(text).toContain("task-1");
    });

    it("with non-existent id returns error", async () => {
      const result = await client.callTool({
        name: "todo_show",
        arguments: { taskId: "nonexistent-id" },
      });

      expect(result.isError).toBe(true);
      expect(textContent(result)).toContain("NotFound");
    });
  });

  // ---------- todo_create ----------

  describe("todo_create", () => {
    it("creates and returns new todo", async () => {
      const result = await client.callTool({
        name: "todo_create",
        arguments: { title: "New task" },
      });

      expect(result.isError).toBeFalsy();
      const text = textContent(result);
      expect(text).toContain("New task");
      expect(text).toContain("Created todo");

      // Verify it was actually added to mock state
      const todos = env.state.getTodos("list-1");
      expect(todos.some((t) => t.title === "New task")).toBe(true);
    });

    it("with body includes body content", async () => {
      const result = await client.callTool({
        name: "todo_create",
        arguments: { title: "Task with body", body: "Some details" },
      });

      expect(result.isError).toBeFalsy();
      expect(textContent(result)).toContain("Task with body");

      const todos = env.state.getTodos("list-1");
      const created = todos.find((t) => t.title === "Task with body");
      expect(created).toBeDefined();
      expect(created!.body).toEqual({
        content: "Some details",
        contentType: "text",
      });
    });
  });

  // ---------- todo_update ----------

  describe("todo_update", () => {
    it("updates title", async () => {
      const result = await client.callTool({
        name: "todo_update",
        arguments: { taskId: "task-1", title: "Buy oat milk" },
      });

      expect(result.isError).toBeFalsy();
      const text = textContent(result);
      expect(text).toContain("Buy oat milk");
      expect(text).toContain("Updated todo");

      // Verify in mock state
      const todos = env.state.getTodos("list-1");
      const updated = todos.find((t) => t.id === "task-1");
      expect(updated!.title).toBe("Buy oat milk");
    });

    it("with neither title nor body returns error", async () => {
      const result = await client.callTool({
        name: "todo_update",
        arguments: { taskId: "task-1" },
      });

      expect(result.isError).toBe(true);
      expect(textContent(result)).toContain(
        "At least one of title or body must be provided",
      );
    });
  });

  // ---------- todo_complete ----------

  describe("todo_complete", () => {
    it("marks todo as completed", async () => {
      const result = await client.callTool({
        name: "todo_complete",
        arguments: { taskId: "task-1" },
      });

      expect(result.isError).toBeFalsy();
      expect(textContent(result)).toContain("marked as completed");

      // Verify in mock state
      const todos = env.state.getTodos("list-1");
      const completed = todos.find((t) => t.id === "task-1");
      expect(completed!.status).toBe("completed");
    });
  });

  // ---------- todo_delete ----------

  describe("todo_delete", () => {
    it("removes the todo", async () => {
      const result = await client.callTool({
        name: "todo_delete",
        arguments: { taskId: "task-1" },
      });

      expect(result.isError).toBeFalsy();
      expect(textContent(result)).toContain("deleted");

      // Verify in mock state
      const todos = env.state.getTodos("list-1");
      expect(todos.find((t) => t.id === "task-1")).toBeUndefined();
    });
  });
});
