// Stdio integration tests.
//
// Spawns the actual server process with StdioServerTransport, communicates
// via JSON-RPC over stdin/stdout, and verifies tool calls against the mock
// Graph API server. Uses GRAPHDO_ACCESS_TOKEN for static auth.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { createMockGraphServer, MockState } from "./mock-graph.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

/** Extract the first text content from a tool result. */
function firstText(response: JsonRpcResponse): string {
  const result = response.result as ToolResult;
  const first = result.content[0];
  if (!first) throw new Error("Expected at least one content item");
  return first.text;
}

let nextId = 1;

function makeRequest(
  method: string,
  params?: Record<string, unknown>,
): JsonRpcRequest {
  return { jsonrpc: "2.0", id: nextId++, method, params };
}

/**
 * Send a JSON-RPC message to the process and wait for the response with the
 * matching id. Also handles notifications (no id) by collecting them.
 */
function sendAndReceive(
  proc: ChildProcess,
  request: JsonRpcRequest,
  timeoutMs = 10_000,
): Promise<JsonRpcResponse> {
  return new Promise<JsonRpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for response to ${request.method} (id: ${String(request.id)})`));
    }, timeoutMs);

    let buffer = "";

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();

      // Try to parse complete JSON messages from the buffer.
      // StdioServerTransport sends newline-delimited JSON.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const msg = JSON.parse(trimmed) as JsonRpcResponse;
          if (msg.id === request.id) {
            clearTimeout(timer);
            proc.stdout?.off("data", onData);
            resolve(msg);
            return;
          }
          // Ignore notifications and other responses
        } catch {
          // Not valid JSON yet, skip
        }
      }
    };

    proc.stdout?.on("data", onData);
    proc.stdin?.write(JSON.stringify(request) + "\n");
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("stdio integration", () => {
  let graphState: MockState;
  let graphServer: ReturnType<typeof import("node:http").createServer>;
  let graphUrl: string;
  let configDir: string;
  let serverProc: ChildProcess;

  beforeAll(async () => {
    // Set up mock Graph API
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

    // Create temp config dir
    configDir = await mkdtemp(path.join(tmpdir(), "graphdo-stdio-test-"));

    // Spawn the server process
    const entryPoint = path.resolve("dist/index.js");

    // Spread process.env but remove VITEST so the child process calls main()
    const childEnv = { ...process.env };
    delete childEnv["VITEST"];

    serverProc = spawn("node", [entryPoint], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...childEnv,
        GRAPHDO_GRAPH_URL: graphUrl,
        GRAPHDO_CONFIG_DIR: configDir,
        GRAPHDO_ACCESS_TOKEN: "test-static-token",
        GRAPHDO_DEBUG: "true",
      },
    });

    // Collect stderr for debugging
    serverProc.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[server] ${chunk.toString()}`);
    });

    // Wait for the process to be ready (give it a moment to load MSAL)
    await new Promise((r) => setTimeout(r, 1000));

    // Initialize MCP session
    const initResponse = await sendAndReceive(
      serverProc,
      makeRequest("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      }),
      15_000,
    );

    expect(initResponse.result).toBeDefined();

    // Send initialized notification
    serverProc.stdin?.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }) + "\n",
    );

    // Give server a moment to process the notification
    await new Promise((r) => setTimeout(r, 100));
  }, 30_000);

  afterAll(async () => {
    // Kill the server process
    serverProc.kill("SIGTERM");

    // Clean up mock graph
    await new Promise<void>((resolve, reject) => {
      graphServer.close((err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Clean up temp dir
    await rm(configDir, { recursive: true, force: true });
  });

  // ---- Tool discovery ----

  it("lists available tools", async () => {
    const response = await sendAndReceive(
      serverProc,
      makeRequest("tools/list"),
    );

    expect(response.error).toBeUndefined();
    const result = response.result as { tools: { name: string }[] };
    const toolNames = result.tools.map((t) => t.name).sort();

    expect(toolNames).toContain("login");
    expect(toolNames).toContain("logout");
    expect(toolNames).toContain("mail_send");
    expect(toolNames).toContain("todo_list");
    expect(toolNames).toContain("todo_config");
  });

  // ---- Login (static token) ----

  it("reports already authenticated with static token", async () => {
    const response = await sendAndReceive(
      serverProc,
      makeRequest("tools/call", {
        name: "login",
        arguments: {},
      }),
    );

    expect(response.error).toBeUndefined();
    expect(firstText(response)).toContain("Already");
  });

  // ---- Mail ----

  it("sends mail via mail_send tool", async () => {
    const response = await sendAndReceive(
      serverProc,
      makeRequest("tools/call", {
        name: "mail_send",
        arguments: {
          subject: "Test Subject",
          body: "Test body content",
        },
      }),
    );

    expect(response.error).toBeUndefined();
    const result = response.result as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(firstText(response)).toContain("test@example.com");

    // Verify in mock state
    expect(graphState.sentMails).toHaveLength(1);
    const mail = graphState.sentMails[0]!;
    expect(mail.subject).toBe("Test Subject");
  });

  // ---- Todo config ----

  it("lists todo lists with todo_config", async () => {
    const response = await sendAndReceive(
      serverProc,
      makeRequest("tools/call", {
        name: "todo_config",
        arguments: {},
      }),
    );

    expect(response.error).toBeUndefined();
    expect(firstText(response)).toContain("My Tasks");
  });

  it("selects a todo list", async () => {
    const response = await sendAndReceive(
      serverProc,
      makeRequest("tools/call", {
        name: "todo_config",
        arguments: { listId: "list-1" },
      }),
    );

    expect(response.error).toBeUndefined();
    const text = firstText(response);
    expect(text).toContain("configured");
    expect(text).toContain("My Tasks");
  });

  // ---- Todo CRUD ----

  it("lists todos", async () => {
    const response = await sendAndReceive(
      serverProc,
      makeRequest("tools/call", {
        name: "todo_list",
        arguments: {},
      }),
    );

    expect(response.error).toBeUndefined();
    expect(firstText(response)).toContain("Buy milk");
  });

  it("shows a todo", async () => {
    const response = await sendAndReceive(
      serverProc,
      makeRequest("tools/call", {
        name: "todo_show",
        arguments: { taskId: "task-1" },
      }),
    );

    expect(response.error).toBeUndefined();
    const text = firstText(response);
    expect(text).toContain("Buy milk");
    expect(text).toContain("Not Started");
  });

  it("creates a todo", async () => {
    const response = await sendAndReceive(
      serverProc,
      makeRequest("tools/call", {
        name: "todo_create",
        arguments: { title: "New task", body: "Task body" },
      }),
    );

    expect(response.error).toBeUndefined();
    expect(firstText(response)).toContain("New task");

    // Verify in mock state
    const tasks = graphState.todos.get("list-1") ?? [];
    const created = tasks.find((t) => t.title === "New task");
    expect(created).toBeDefined();
  });

  it("updates a todo", async () => {
    const tasks = graphState.todos.get("list-1") ?? [];
    const task = tasks.find((t) => t.title === "New task");

    const response = await sendAndReceive(
      serverProc,
      makeRequest("tools/call", {
        name: "todo_update",
        arguments: { taskId: task!.id, title: "Updated task" },
      }),
    );

    expect(response.error).toBeUndefined();
    expect(firstText(response)).toContain("Updated task");
  });

  it("completes a todo", async () => {
    const response = await sendAndReceive(
      serverProc,
      makeRequest("tools/call", {
        name: "todo_complete",
        arguments: { taskId: "task-1" },
      }),
    );

    expect(response.error).toBeUndefined();
    expect(firstText(response)).toContain("completed");

    // Verify in mock state
    const tasks = graphState.todos.get("list-1") ?? [];
    const task = tasks.find((t) => t.id === "task-1");
    expect(task?.status).toBe("completed");
  });

  it("deletes a todo", async () => {
    const tasks = graphState.todos.get("list-1") ?? [];
    const task = tasks.find((t) => t.title === "Updated task");

    const response = await sendAndReceive(
      serverProc,
      makeRequest("tools/call", {
        name: "todo_delete",
        arguments: { taskId: task!.id },
      }),
    );

    expect(response.error).toBeUndefined();
    expect(firstText(response)).toContain("deleted");

    // Verify in mock state
    const remaining = graphState.todos.get("list-1") ?? [];
    expect(remaining.find((t) => t.title === "Updated task")).toBeUndefined();
  });

  // ---- Error handling ----

  it("returns error for non-existent todo", async () => {
    const response = await sendAndReceive(
      serverProc,
      makeRequest("tools/call", {
        name: "todo_show",
        arguments: { taskId: "does-not-exist" },
      }),
    );

    expect(response.error).toBeUndefined();
    const result = response.result as ToolResult;
    expect(result.isError).toBe(true);
    expect(firstText(response)).toContain("NotFound");
  });

  it("logout clears auth state", async () => {
    const response = await sendAndReceive(
      serverProc,
      makeRequest("tools/call", {
        name: "logout",
        arguments: {},
      }),
    );

    expect(response.error).toBeUndefined();
    expect(firstText(response)).toContain("Logged out");
  });
});
