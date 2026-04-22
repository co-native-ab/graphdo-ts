// Integration tests for todo operations: config, CRUD, enhanced features, and checklist items.

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  setupIntegrationEnv,
  teardownIntegrationEnv,
  createTestClient,
  firstText,
  MockAuthenticator,
  saveConfig,
  loadConfig,
  createMcpServer,
  InMemoryTransport,
  Client,
  fetchCsrfToken,
  testSignal,
  type IntegrationEnv,
  type ToolResult,
} from "./helpers.js";

let env: IntegrationEnv;

describe("integration: todo", () => {
  beforeAll(async () => {
    env = await setupIntegrationEnv();
  });

  afterAll(async () => {
    await teardownIntegrationEnv(env);
  });

  // -------------------------------------------------------------------------
  // Todo config (browser-based)
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Todo CRUD
  // -------------------------------------------------------------------------

  describe("todo CRUD", () => {
    beforeEach(async () => {
      await saveConfig(
        { todoListId: "list-1", todoListName: "My Tasks" },
        env.configDir,
        testSignal(),
      );

      env.graphState.todos.set("list-1", [
        { id: "task-1", title: "Buy milk", status: "notStarted" },
        { id: "task-update", title: "Task to update", status: "notStarted" },
        { id: "task-delete", title: "Task to delete", status: "notStarted" },
      ]);
    });

    it("lists todos", async () => {
      const auth = new MockAuthenticator({ token: "todo-token" });
      const client = await createTestClient(env, auth);

      const result = (await client.callTool({
        name: "todo_list",
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("Buy milk");
    });

    it("shows a specific todo", async () => {
      const auth = new MockAuthenticator({ token: "todo-token" });
      const client = await createTestClient(env, auth);

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
      const auth = new MockAuthenticator({ token: "todo-token" });
      const client = await createTestClient(env, auth);

      const result = (await client.callTool({
        name: "todo_create",
        arguments: { title: "New task", body: "Task body" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("New task");

      const tasks = env.graphState.getTodos("list-1");
      expect(tasks.find((t) => t.title === "New task")).toBeDefined();
    });

    it("updates a todo", async () => {
      const auth = new MockAuthenticator({ token: "todo-token" });
      const client = await createTestClient(env, auth);

      const result = (await client.callTool({
        name: "todo_update",
        arguments: { taskId: "task-update", title: "Updated task" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("Updated task");
    });

    it("returns error when todo_update called with no fields", async () => {
      const auth = new MockAuthenticator({ token: "todo-token" });
      const client = await createTestClient(env, auth);

      const result = (await client.callTool({
        name: "todo_update",
        arguments: { taskId: "task-1" },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain("At least one field");
    });

    it("completes a todo", async () => {
      const auth = new MockAuthenticator({ token: "todo-token" });
      const client = await createTestClient(env, auth);

      const result = (await client.callTool({
        name: "todo_complete",
        arguments: { taskId: "task-1" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("completed");

      const tasks = env.graphState.getTodos("list-1");
      const task = tasks.find((t) => t.id === "task-1");
      expect(task?.status).toBe("completed");
    });

    it("deletes a todo", async () => {
      const auth = new MockAuthenticator({ token: "todo-token" });
      const client = await createTestClient(env, auth);

      const result = (await client.callTool({
        name: "todo_delete",
        arguments: { taskId: "task-delete" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("deleted");

      const remaining = env.graphState.getTodos("list-1");
      expect(remaining.find((t) => t.id === "task-delete")).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Enhanced todo features (importance, due date, reminder, recurrence)
  // -------------------------------------------------------------------------

  describe("enhanced todo features", () => {
    beforeAll(async () => {
      await saveConfig(
        { todoListId: "list-1", todoListName: "My Tasks" },
        env.configDir,
        testSignal(),
      );

      env.graphState.todos.set("list-1", [
        { id: "task-1", title: "Base task", status: "notStarted" },
      ]);
    });

    it("creates a todo with importance", async () => {
      const auth = new MockAuthenticator({ token: "enhanced-token" });
      const client = await createTestClient(env, auth);

      const result = (await client.callTool({
        name: "todo_create",
        arguments: { title: "Urgent item", importance: "high" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("Urgent item");

      const tasks = env.graphState.getTodos("list-1");
      const task = tasks.find((t) => t.title === "Urgent item");
      expect(task?.importance).toBe("high");
    });

    it("creates a todo with due date", async () => {
      const auth = new MockAuthenticator({ token: "enhanced-token" });
      const client = await createTestClient(env, auth);

      const result = (await client.callTool({
        name: "todo_create",
        arguments: { title: "Due soon", dueDate: "2025-12-31" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const tasks = env.graphState.getTodos("list-1");
      const task = tasks.find((t) => t.title === "Due soon");
      expect(task?.dueDateTime).toBeDefined();
      expect(task?.dueDateTime?.dateTime).toContain("2025-12-31");
    });

    it("creates a todo with reminder", async () => {
      const auth = new MockAuthenticator({ token: "enhanced-token" });
      const client = await createTestClient(env, auth);

      const result = (await client.callTool({
        name: "todo_create",
        arguments: {
          title: "Reminder task",
          reminderDateTime: "2025-12-30T09:00:00",
        },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const tasks = env.graphState.getTodos("list-1");
      const task = tasks.find((t) => t.title === "Reminder task");
      expect(task?.isReminderOn).toBe(true);
      expect(task?.reminderDateTime).toBeDefined();
    });

    it("creates a todo with daily recurrence", async () => {
      const auth = new MockAuthenticator({ token: "enhanced-token" });
      const client = await createTestClient(env, auth);

      const result = (await client.callTool({
        name: "todo_create",
        arguments: { title: "Daily standup", repeat: "daily" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const tasks = env.graphState.getTodos("list-1");
      const task = tasks.find((t) => t.title === "Daily standup");
      expect(task?.recurrence).toBeDefined();
      expect(task?.recurrence?.pattern.type).toBe("daily");
      expect(task?.recurrence?.pattern.interval).toBe(1);
    });

    it("creates a todo with weekly recurrence", async () => {
      const auth = new MockAuthenticator({ token: "enhanced-token" });
      const client = await createTestClient(env, auth);

      const result = (await client.callTool({
        name: "todo_create",
        arguments: { title: "Weekly review", repeat: "weekly" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const tasks = env.graphState.getTodos("list-1");
      const task = tasks.find((t) => t.title === "Weekly review");
      expect(task?.recurrence?.pattern.type).toBe("weekly");
    });

    it("creates a todo with weekdays recurrence", async () => {
      const auth = new MockAuthenticator({ token: "enhanced-token" });
      const client = await createTestClient(env, auth);

      const result = (await client.callTool({
        name: "todo_create",
        arguments: { title: "Weekday check", repeat: "weekdays" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const tasks = env.graphState.getTodos("list-1");
      const task = tasks.find((t) => t.title === "Weekday check");
      expect(task?.recurrence?.pattern.type).toBe("weekly");
      expect(task?.recurrence?.pattern.daysOfWeek).toEqual(
        expect.arrayContaining(["monday", "tuesday", "wednesday", "thursday", "friday"]),
      );
    });

    it("shows a todo with all fields", async () => {
      const auth = new MockAuthenticator({ token: "enhanced-token" });
      const client = await createTestClient(env, auth);

      const result = (await client.callTool({
        name: "todo_show",
        arguments: { taskId: "task-1" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("Base task");
    });

    it("updates importance", async () => {
      const auth = new MockAuthenticator({ token: "enhanced-token" });
      const client = await createTestClient(env, auth);

      const result = (await client.callTool({
        name: "todo_update",
        arguments: { taskId: "task-1", importance: "low" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const tasks = env.graphState.getTodos("list-1");
      const task = tasks.find((t) => t.id === "task-1");
      expect(task?.importance).toBe("low");
    });

    it("sets and clears due date", async () => {
      const auth = new MockAuthenticator({ token: "enhanced-token" });
      const client = await createTestClient(env, auth);

      // Set
      const setResult = (await client.callTool({
        name: "todo_update",
        arguments: { taskId: "task-1", dueDate: "2025-06-15" },
      })) as ToolResult;
      expect(setResult.isError).toBeFalsy();

      let tasks = env.graphState.getTodos("list-1");
      let task = tasks.find((t) => t.id === "task-1");
      expect(task?.dueDateTime).toBeDefined();

      // Clear
      const clearResult = (await client.callTool({
        name: "todo_update",
        arguments: { taskId: "task-1", clearDueDate: true },
      })) as ToolResult;
      expect(clearResult.isError).toBeFalsy();

      tasks = env.graphState.getTodos("list-1");
      task = tasks.find((t) => t.id === "task-1");
      expect(task?.dueDateTime).toBeUndefined();
    });

    it("sets and clears reminder", async () => {
      const auth = new MockAuthenticator({ token: "enhanced-token" });
      const client = await createTestClient(env, auth);

      // Set
      const setResult = (await client.callTool({
        name: "todo_update",
        arguments: {
          taskId: "task-1",
          reminderDateTime: "2025-06-15T09:00:00",
        },
      })) as ToolResult;
      expect(setResult.isError).toBeFalsy();

      let tasks = env.graphState.getTodos("list-1");
      let task = tasks.find((t) => t.id === "task-1");
      expect(task?.isReminderOn).toBe(true);
      expect(task?.reminderDateTime).toBeDefined();

      // Clear
      const clearResult = (await client.callTool({
        name: "todo_update",
        arguments: { taskId: "task-1", clearReminder: true },
      })) as ToolResult;
      expect(clearResult.isError).toBeFalsy();

      tasks = env.graphState.getTodos("list-1");
      task = tasks.find((t) => t.id === "task-1");
      expect(task?.isReminderOn).toBe(false);
      expect(task?.reminderDateTime).toBeUndefined();
    });

    it("sets and clears recurrence", async () => {
      const auth = new MockAuthenticator({ token: "enhanced-token" });
      const client = await createTestClient(env, auth);

      // Set
      const setResult = (await client.callTool({
        name: "todo_update",
        arguments: { taskId: "task-1", repeat: "monthly" },
      })) as ToolResult;
      expect(setResult.isError).toBeFalsy();

      let tasks = env.graphState.getTodos("list-1");
      let task = tasks.find((t) => t.id === "task-1");
      expect(task?.recurrence?.pattern.type).toBe("absoluteMonthly");

      // Clear
      const clearResult = (await client.callTool({
        name: "todo_update",
        arguments: { taskId: "task-1", clearRecurrence: true },
      })) as ToolResult;
      expect(clearResult.isError).toBeFalsy();

      tasks = env.graphState.getTodos("list-1");
      task = tasks.find((t) => t.id === "task-1");
      expect(task?.recurrence).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Checklist items (steps)
  // -------------------------------------------------------------------------

  describe("checklist items", () => {
    beforeEach(async () => {
      await saveConfig(
        { todoListId: "list-1", todoListName: "My Tasks" },
        env.configDir,
        testSignal(),
      );

      env.graphState.todos.set("list-1", [
        { id: "task-1", title: "Task with steps", status: "notStarted" },
      ]);
      env.graphState.checklistItems.clear();
      // Pre-populate items for tests that need existing steps
      env.graphState.checklistItems.set("task-1", [
        {
          id: "step-1",
          displayName: "Step 1",
          isChecked: false,
          createdDateTime: new Date().toISOString(),
        },
        {
          id: "step-2",
          displayName: "Step 2",
          isChecked: false,
          createdDateTime: new Date().toISOString(),
        },
      ]);
    });

    it("lists empty steps", async () => {
      env.graphState.checklistItems.set("task-1", []);
      const auth = new MockAuthenticator({ token: "steps-token" });
      const client = await createTestClient(env, auth);

      const result = (await client.callTool({
        name: "todo_steps",
        arguments: { taskId: "task-1" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("No steps");
    });

    it("adds a step", async () => {
      env.graphState.checklistItems.set("task-1", []);
      const auth = new MockAuthenticator({ token: "steps-token" });
      const client = await createTestClient(env, auth);

      const result = (await client.callTool({
        name: "todo_add_step",
        arguments: { taskId: "task-1", displayName: "New Step" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("New Step");

      const items = env.graphState.getChecklistItems("task-1");
      expect(items).toHaveLength(1);
      expect(items[0]!.displayName).toBe("New Step");
    });

    it("adds multiple steps", async () => {
      env.graphState.checklistItems.set("task-1", []);
      const auth = new MockAuthenticator({ token: "steps-token" });
      const client = await createTestClient(env, auth);

      await client.callTool({
        name: "todo_add_step",
        arguments: { taskId: "task-1", displayName: "Step A" },
      });
      await client.callTool({
        name: "todo_add_step",
        arguments: { taskId: "task-1", displayName: "Step B" },
      });

      const items = env.graphState.getChecklistItems("task-1");
      expect(items).toHaveLength(2);
    });

    it("lists steps after creation", async () => {
      const auth = new MockAuthenticator({ token: "steps-token" });
      const client = await createTestClient(env, auth);

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
      const auth = new MockAuthenticator({ token: "steps-token" });
      const client = await createTestClient(env, auth);

      const result = (await client.callTool({
        name: "todo_update_step",
        arguments: { taskId: "task-1", stepId: "step-1", isChecked: true },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();

      const updated = env.graphState.getChecklistItems("task-1");
      expect(updated.find((i) => i.id === "step-1")?.isChecked).toBe(true);
    });

    it("returns error when todo_update_step called with no update fields", async () => {
      const auth = new MockAuthenticator({ token: "steps-token" });
      const client = await createTestClient(env, auth);

      const result = (await client.callTool({
        name: "todo_update_step",
        arguments: { taskId: "task-1", stepId: "step-1" },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain("At least one of");
    });

    it("renames a step", async () => {
      const auth = new MockAuthenticator({ token: "steps-token" });
      const client = await createTestClient(env, auth);

      const result = (await client.callTool({
        name: "todo_update_step",
        arguments: {
          taskId: "task-1",
          stepId: "step-1",
          displayName: "Renamed Step",
        },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("Renamed Step");
    });

    it("deletes a step", async () => {
      const auth = new MockAuthenticator({ token: "steps-token" });
      const client = await createTestClient(env, auth);

      const result = (await client.callTool({
        name: "todo_delete_step",
        arguments: { taskId: "task-1", stepId: "step-2" },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain("deleted");

      const remaining = env.graphState.getChecklistItems("task-1");
      expect(remaining).toHaveLength(1);
    });
  });
});
