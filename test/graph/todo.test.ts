import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestEnv, type TestEnv } from "../helpers.js";
import { GraphClient } from "../../src/graph/client.js";
import { GraphRequestError } from "../../src/graph/client.js";
import {
  listTodoLists,
  listTodos,
  getTodo,
  createTodo,
  updateTodo,
  completeTodo,
  deleteTodo,
} from "../../src/graph/todo.js";

describe("todo operations", () => {
  let env: TestEnv;
  let client: GraphClient;

  beforeEach(async () => {
    env = await createTestEnv();
    client = new GraphClient(env.graphUrl, "test-token");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  describe("listTodoLists", () => {
    it("returns the seeded lists", async () => {
      const lists = await listTodoLists(client);
      expect(lists).toHaveLength(1);
      expect(lists[0]!.id).toBe("list-1");
      expect(lists[0]!.displayName).toBe("My Tasks");
    });
  });

  describe("listTodos", () => {
    it("returns items for a list", async () => {
      const items = await listTodos(client, "list-1", 0, 0);
      expect(items).toHaveLength(1);
      expect(items[0]!.id).toBe("task-1");
      expect(items[0]!.title).toBe("Buy milk");
    });

    it("respects top and skip pagination", async () => {
      // Add more tasks for pagination testing
      env.state.todos.set("list-1", [
        { id: "t1", title: "Task 1", status: "notStarted" },
        { id: "t2", title: "Task 2", status: "notStarted" },
        { id: "t3", title: "Task 3", status: "notStarted" },
        { id: "t4", title: "Task 4", status: "notStarted" },
      ]);

      const page1 = await listTodos(client, "list-1", 2, 0);
      expect(page1).toHaveLength(2);
      expect(page1[0]!.id).toBe("t1");
      expect(page1[1]!.id).toBe("t2");

      const page2 = await listTodos(client, "list-1", 2, 2);
      expect(page2).toHaveLength(2);
      expect(page2[0]!.id).toBe("t3");
      expect(page2[1]!.id).toBe("t4");

      const page3 = await listTodos(client, "list-1", 2, 4);
      expect(page3).toHaveLength(0);
    });
  });

  describe("getTodo", () => {
    it("returns a single item", async () => {
      const item = await getTodo(client, "list-1", "task-1");
      expect(item.id).toBe("task-1");
      expect(item.title).toBe("Buy milk");
      expect(item.status).toBe("notStarted");
    });

    it("throws on non-existent ID", async () => {
      await expect(
        getTodo(client, "list-1", "no-such-task"),
      ).rejects.toThrow(GraphRequestError);
    });
  });

  describe("createTodo", () => {
    it("creates and returns new item", async () => {
      const item = await createTodo(client, "list-1", "New Task", "");
      expect(item.id).toBeTruthy();
      expect(item.title).toBe("New Task");
      expect(item.status).toBe("notStarted");

      // Verify it exists in mock state
      const todos = env.state.getTodos("list-1");
      expect(todos.some((t) => t.id === item.id)).toBe(true);
    });

    it("with body includes the body content", async () => {
      const item = await createTodo(
        client,
        "list-1",
        "Task With Body",
        "Some details here",
      );
      expect(item.body).toBeDefined();
      expect(item.body!.content).toBe("Some details here");
      expect(item.body!.contentType).toBe("text");
    });
  });

  describe("updateTodo", () => {
    it("updates title", async () => {
      const updated = await updateTodo(
        client,
        "list-1",
        "task-1",
        "Updated Title",
        "",
      );
      expect(updated.title).toBe("Updated Title");
    });

    it("updates body", async () => {
      const updated = await updateTodo(
        client,
        "list-1",
        "task-1",
        "",
        "New body content",
      );
      expect(updated.body).toBeDefined();
      expect(updated.body!.content).toBe("New body content");
    });
  });

  describe("completeTodo", () => {
    it("sets status to completed", async () => {
      await completeTodo(client, "list-1", "task-1");

      // Verify via direct state check
      const todos = env.state.getTodos("list-1");
      const task = todos.find((t) => t.id === "task-1");
      expect(task).toBeDefined();
      expect(task!.status).toBe("completed");
    });
  });

  describe("deleteTodo", () => {
    it("removes the item", async () => {
      await deleteTodo(client, "list-1", "task-1");

      const todos = env.state.getTodos("list-1");
      expect(todos.find((t) => t.id === "task-1")).toBeUndefined();
    });
  });

  describe("validation", () => {
    it("empty listId throws on listTodos", async () => {
      await expect(listTodos(client, "", 10, 0)).rejects.toThrow(
        "listTodos: listId must not be empty",
      );
    });

    it("empty listId throws on getTodo", async () => {
      await expect(getTodo(client, "", "task-1")).rejects.toThrow(
        "getTodo: listId must not be empty",
      );
    });

    it("empty taskId throws on getTodo", async () => {
      await expect(getTodo(client, "list-1", "")).rejects.toThrow(
        "getTodo: taskId must not be empty",
      );
    });

    it("empty listId throws on createTodo", async () => {
      await expect(createTodo(client, "", "title", "")).rejects.toThrow(
        "createTodo: listId must not be empty",
      );
    });

    it("empty title throws on createTodo", async () => {
      await expect(createTodo(client, "list-1", "", "")).rejects.toThrow(
        "createTodo: title must not be empty",
      );
    });

    it("empty listId throws on deleteTodo", async () => {
      await expect(deleteTodo(client, "", "task-1")).rejects.toThrow(
        "deleteTodo: listId must not be empty",
      );
    });

    it("empty taskId throws on deleteTodo", async () => {
      await expect(deleteTodo(client, "list-1", "")).rejects.toThrow(
        "deleteTodo: taskId must not be empty",
      );
    });
  });
});
