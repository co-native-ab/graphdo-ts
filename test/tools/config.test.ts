import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import { loadConfig } from "../../src/config.js";
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
import { registerConfigTools } from "../../src/tools/config.js";
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
  registerConfigTools(server);
  registerTodoTools(server);
  return server;
}

async function createMcpPair(opts: { auth: boolean }): Promise<{
  client: Client;
  mcpServer: McpServer;
  cleanup: () => Promise<void>;
}> {
  const mcpServer = createServer();

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  if (opts.auth) {
    patchTransportAuth(clientTransport, AUTH_INFO);
  }

  await mcpServer.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "1.0" });
  await client.connect(clientTransport);

  return {
    client,
    mcpServer,
    cleanup: async () => {
      await client.close();
      await mcpServer.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("todo_config tool", () => {
  let env: TestEnv;
  let client: Client;
  let tmpDir: string;
  let mcpCleanup: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    env = await createTestEnv();
    mocks.setGraphUrl(env.graphUrl);

    tmpDir = makeTempDir();
    mocks.setConfigDir(tmpDir);

    const pair = await createMcpPair({ auth: true });
    client = pair.client;
    mcpCleanup = pair.cleanup;
  });

  afterEach(async () => {
    await mcpCleanup?.();
    await env.cleanup();
    await fs
      .rm(tmpDir, { recursive: true, force: true })
      .catch(() => {
        /* ignore cleanup errors */
      });
  });

  it("without listId returns available lists", async () => {
    const result = await client.callTool({
      name: "todo_config",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const text = textContent(result);
    expect(text).toContain("Available todo lists");
    expect(text).toContain("My Tasks");
    expect(text).toContain("list-1");
  });

  it("with valid listId saves config", async () => {
    const result = await client.callTool({
      name: "todo_config",
      arguments: { listId: "list-1" },
    });

    expect(result.isError).toBeFalsy();
    const text = textContent(result);
    expect(text).toContain("Todo list configured");
    expect(text).toContain("My Tasks");

    // Verify config was persisted
    const config = await loadConfig(tmpDir);
    expect(config).toEqual({
      todoListId: "list-1",
      todoListName: "My Tasks",
    });
  });

  it("with invalid listId returns error", async () => {
    const result = await client.callTool({
      name: "todo_config",
      arguments: { listId: "nonexistent-list" },
    });

    expect(result.isError).toBe(true);
    const text = textContent(result);
    expect(text).toContain("not found");
    expect(text).toContain("Available lists");
  });

  it("without auth returns error", async () => {
    const noAuth = await createMcpPair({ auth: false });

    try {
      const result = await noAuth.client.callTool({
        name: "todo_config",
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expect(textContent(result)).toContain("Authentication required");
    } finally {
      await noAuth.cleanup();
    }
  });

  it("after todo_config, todo tools work (integration)", async () => {
    // First configure the list
    const configResult = await client.callTool({
      name: "todo_config",
      arguments: { listId: "list-1" },
    });
    expect(configResult.isError).toBeFalsy();

    // Now use a todo tool — todo_list should work with the saved config
    const listResult = await client.callTool({
      name: "todo_list",
      arguments: {},
    });

    expect(listResult.isError).toBeFalsy();
    const text = textContent(listResult);
    expect(text).toContain("My Tasks");
    expect(text).toContain("Buy milk");
  });
});
