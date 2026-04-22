// Integration tests for enhanced todo features (importance, due date, reminder, recurrence).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupIntegrationEnv,
  teardownIntegrationEnv,
  createTestClient,
  firstText,
  MockAuthenticator,
  saveConfig,
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
});
