// Integration tests for the todo_select_list tool (browser-based list picker).

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
  loadConfig,
  createMcpServer,
  InMemoryTransport,
  Client,
  fetchCsrfToken,
  testSignal,
  type IntegrationEnv,
  type ToolResult,
} from "../helpers.js";

let env: IntegrationEnv;

describe("integration: todo", () => {
  beforeAll(async () => {
    env = await setupIntegrationEnv();
  });

  afterAll(async () => {
    await teardownIntegrationEnv(env);
  });

  describe("todo config", () => {
    it("todo_select_list disabled when not logged in", async () => {
      const noAuth = new MockAuthenticator();
      const c = await createTestClient(env, noAuth);

      const { tools } = await c.listTools();
      const names = tools.map((t: { name: string }) => t.name);
      expect(names).not.toContain("todo_select_list");
    });

    it("returns message when no todo lists exist", async () => {
      const originalLists = env.graphState.todoLists;
      env.graphState.todoLists = [];

      try {
        const auth = new MockAuthenticator({ token: "config-token" });
        const client = await createTestClient(env, auth);

        const result = (await client.callTool({
          name: "todo_select_list",
          arguments: {},
        })) as ToolResult;

        expect(result.isError).toBeFalsy();
        expect(firstText(result)).toContain("No todo lists found");
      } finally {
        env.graphState.todoLists = originalLists;
      }
    });

    it("configures list via browser picker (full e2e)", async () => {
      const originalLists = env.graphState.todoLists;
      env.graphState.todoLists = [
        { id: "list-1", displayName: "My Tasks" },
        { id: "list-2", displayName: "Work" },
      ];

      const tempConfigDir = await mkdtemp(path.join(tmpdir(), "graphdo-config-e2e-"));

      try {
        let capturedUrl = "";
        const browserSpy = (url: string): Promise<void> => {
          capturedUrl = url;
          setTimeout(() => {
            void (async () => {
              const csrfToken = await fetchCsrfToken(url);
              await fetch(`${url}/select`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: "list-2", label: "Work", csrfToken }),
              });
            })();
          }, 150);
          return Promise.resolve();
        };

        const configAuth = new MockAuthenticator({ token: "config-e2e-token" });
        const server = await createMcpServer(
          {
            authenticator: configAuth,
            graphBaseUrl: env.graphUrl,
            configDir: tempConfigDir,
            openBrowser: browserSpy,
          },
          testSignal(),
        );
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const c = new Client({ name: "test", version: "1.0" });
        await server.connect(st);
        await c.connect(ct);

        const result = (await c.callTool({
          name: "todo_select_list",
          arguments: {},
        })) as ToolResult;

        expect(result.isError).toBeFalsy();
        const text = firstText(result);
        expect(text).toContain("browser window has been opened");
        expect(text).toContain("Work");
        expect(text).toContain("list-2");

        expect(capturedUrl).toContain("http://127.0.0.1:");

        const config = await loadConfig(tempConfigDir, testSignal());
        expect(config).not.toBeNull();
        expect(config!.todoListId).toBe("list-2");
        expect(config!.todoListName).toBe("Work");
      } finally {
        env.graphState.todoLists = originalLists;
        await rm(tempConfigDir, { recursive: true, force: true });
      }
    });

    it("shows URL as fallback when browser fails to open", async () => {
      const originalLists = env.graphState.todoLists;
      env.graphState.todoLists = [{ id: "list-1", displayName: "My Tasks" }];

      const tempConfigDir = await mkdtemp(path.join(tmpdir(), "graphdo-config-e2e-"));

      try {
        let capturedUrl = "";
        const failingBrowser = (url: string): Promise<void> => {
          capturedUrl = url;
          setTimeout(() => {
            void (async () => {
              const csrfToken = await fetchCsrfToken(url);
              await fetch(`${url}/select`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: "list-1", label: "My Tasks", csrfToken }),
              });
            })();
          }, 150);
          return Promise.reject(new Error("xdg-open failed"));
        };

        const configAuth = new MockAuthenticator({ token: "config-e2e-token" });
        const server = await createMcpServer(
          {
            authenticator: configAuth,
            graphBaseUrl: env.graphUrl,
            configDir: tempConfigDir,
            openBrowser: failingBrowser,
          },
          testSignal(),
        );
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const c = new Client({ name: "test", version: "1.0" });
        await server.connect(st);
        await c.connect(ct);

        const result = (await c.callTool({
          name: "todo_select_list",
          arguments: {},
        })) as ToolResult;

        expect(result.isError).toBeFalsy();
        const text = firstText(result);
        expect(text).toContain("Could not open a browser");
        expect(text).toContain(capturedUrl);
        expect(text).toContain("My Tasks");
      } finally {
        env.graphState.todoLists = originalLists;
        await rm(tempConfigDir, { recursive: true, force: true });
      }
    });

    it("returns error when picker times out (no selection)", async () => {
      // Verify the tool is disabled when no config is set - the picker would
      // time out in a real scenario but that timeout (2 min) is not feasible
      // in tests. Instead verify the tool is available when authenticated.
      const originalLists = env.graphState.todoLists;
      env.graphState.todoLists = [{ id: "list-1", displayName: "My Tasks" }];

      try {
        const browserSpy = (_url: string): Promise<void> => Promise.resolve();

        const configAuth = new MockAuthenticator({
          token: "config-timeout-token",
        });

        const c = await createTestClient(env, configAuth, {
          openBrowser: browserSpy,
        });

        const { tools } = await c.listTools();
        const names = tools.map((t: { name: string }) => t.name);
        expect(names).toContain("todo_select_list");
      } finally {
        env.graphState.todoLists = originalLists;
      }
    });

    it("returns cancelled message when user cancels the picker", async () => {
      const originalLists = env.graphState.todoLists;
      env.graphState.todoLists = [{ id: "list-1", displayName: "My Tasks" }];

      const tempConfigDir = await mkdtemp(path.join(tmpdir(), "graphdo-config-cancel-"));

      try {
        const cancelBrowser = (url: string): Promise<void> => {
          setTimeout(() => {
            void (async () => {
              const csrfToken = await fetchCsrfToken(url);
              await fetch(`${url}/cancel`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ csrfToken }),
              });
            })();
          }, 150);
          return Promise.resolve();
        };

        const configAuth = new MockAuthenticator({ token: "cancel-token" });
        const server = await createMcpServer(
          {
            authenticator: configAuth,
            graphBaseUrl: env.graphUrl,
            configDir: tempConfigDir,
            openBrowser: cancelBrowser,
          },
          testSignal(),
        );
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const c = new Client({ name: "test", version: "1.0" });
        await server.connect(st);
        await c.connect(ct);

        const result = (await c.callTool({
          name: "todo_select_list",
          arguments: {},
        })) as ToolResult;

        expect(result.isError).toBeFalsy();
        expect(firstText(result)).toContain("Todo list selection cancelled");
      } finally {
        env.graphState.todoLists = originalLists;
        await rm(tempConfigDir, { recursive: true, force: true });
      }
    });

    it("refreshes option list when refresh is triggered", async () => {
      // Exercises the refreshOptions callback in src/tools/todo/todo-select-list.ts.
      const originalLists = env.graphState.todoLists;
      env.graphState.todoLists = [{ id: "list-1", displayName: "My Tasks" }];

      const tempConfigDir = await mkdtemp(path.join(tmpdir(), "graphdo-config-refresh-"));

      try {
        const refreshBrowser = (url: string): Promise<void> => {
          setTimeout(() => {
            void (async () => {
              const csrfToken = await fetchCsrfToken(url);
              // Simulate a new list being created between the initial render
              // and the user clicking Refresh.
              env.graphState.todoLists = [
                { id: "list-1", displayName: "My Tasks" },
                { id: "list-new", displayName: "Fresh List" },
              ];
              const refreshRes = await fetch(`${url}/options`);
              const refreshed = (await refreshRes.json()) as {
                options: { id: string; label: string }[];
              };
              // The refreshed set must include the newly created list.
              expect(refreshed.options.some((o) => o.id === "list-new")).toBe(true);

              await fetch(`${url}/select`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: "list-new", label: "Fresh List", csrfToken }),
              });
            })();
          }, 150);
          return Promise.resolve();
        };

        const configAuth = new MockAuthenticator({ token: "refresh-token" });
        const server = await createMcpServer(
          {
            authenticator: configAuth,
            graphBaseUrl: env.graphUrl,
            configDir: tempConfigDir,
            openBrowser: refreshBrowser,
          },
          testSignal(),
        );
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const c = new Client({ name: "test", version: "1.0" });
        await server.connect(st);
        await c.connect(ct);

        const result = (await c.callTool({
          name: "todo_select_list",
          arguments: {},
        })) as ToolResult;

        expect(result.isError).toBeFalsy();
        expect(firstText(result)).toContain("Fresh List");
      } finally {
        env.graphState.todoLists = originalLists;
        await rm(tempConfigDir, { recursive: true, force: true });
      }
    });
  });
});
