// Integration tests for error handling and auth status.

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupIntegrationEnv,
  teardownIntegrationEnv,
  createTestClient,
  firstText,
  MockAuthenticator,
  saveConfig,
  createMcpServer,
  InMemoryTransport,
  Client,
  type IntegrationEnv,
  type ToolResult,
} from "./helpers.js";

let env: IntegrationEnv;

describe("integration: status & errors", () => {
  beforeAll(async () => {
    env = await setupIntegrationEnv();
    await saveConfig({ todoListId: "list-1", todoListName: "My Tasks" }, env.configDir);
  });

  afterAll(async () => {
    await teardownIntegrationEnv(env);
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("returns error for non-existent todo", async () => {
      const auth = new MockAuthenticator({ token: "error-token" });
      const client = await createTestClient(env, auth);

      const result = (await client.callTool({
        name: "todo_show",
        arguments: { taskId: "does-not-exist" },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain("NotFound");
    });

    it("scope-gated tools disabled when not logged in", async () => {
      const noAuth = new MockAuthenticator();
      const noAuthClient = await createTestClient(env, noAuth);

      const { tools } = await noAuthClient.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).not.toContain("todo_list");
      expect(names).toEqual(["auth_status", "login"]);
    });

    it("returns error when todo list not configured", async () => {
      const emptyConfigDir = await mkdtemp(path.join(tmpdir(), "graphdo-test-empty-"));

      try {
        const emptyAuth = new MockAuthenticator({ token: "token" });

        const server = await createMcpServer({
          authenticator: emptyAuth,
          graphBaseUrl: env.graphUrl,
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

  // -------------------------------------------------------------------------
  // Status tool
  // -------------------------------------------------------------------------

  describe("auth status", () => {
    it("shows not logged in when unauthenticated", async () => {
      const noAuth = new MockAuthenticator();
      const c = await createTestClient(env, noAuth);

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
      const c = await createTestClient(env, authed);

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
      const c = await createTestClient(env, authed);

      const result = (await c.callTool({
        name: "auth_status",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const text = firstText(result);
      expect(text).toContain("My Tasks");
    });

    it("shows todo list not configured", async () => {
      const emptyConfigDir = await mkdtemp(path.join(tmpdir(), "graphdo-test-status-"));

      try {
        const authed = new MockAuthenticator({ token: "status-token" });

        const server = await createMcpServer({
          authenticator: authed,
          graphBaseUrl: env.graphUrl,
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
});
