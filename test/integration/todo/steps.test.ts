// Integration tests for todo checklist items (steps).

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

  describe("checklist items", () => {
    beforeEach(async () => {
      await saveConfig(
        { todo: { listId: "list-1", listName: "My Tasks" } },
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
