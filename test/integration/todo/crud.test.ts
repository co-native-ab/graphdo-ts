// Integration tests for basic todo CRUD operations.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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

  describe("todo CRUD", () => {
    beforeEach(async () => {
      await saveConfig(
        { todo: { listId: "list-1", listName: "My Tasks" } },
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
});
