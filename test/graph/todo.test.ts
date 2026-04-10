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
  listChecklistItems,
  createChecklistItem,
  updateChecklistItem,
  deleteChecklistItem,
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
      const item = await createTodo(client, "list-1", { title: "New Task" });
      expect(item.id).toBeTruthy();
      expect(item.title).toBe("New Task");
      expect(item.status).toBe("notStarted");

      const todos = env.state.getTodos("list-1");
      expect(todos.some((t) => t.id === item.id)).toBe(true);
    });

    it("with body includes the body content", async () => {
      const item = await createTodo(client, "list-1", {
        title: "Task With Body",
        body: "Some details here",
      });
      expect(item.body).toBeDefined();
      expect(item.body!.content).toBe("Some details here");
      expect(item.body!.contentType).toBe("text");
    });

    it("with importance sets importance", async () => {
      const item = await createTodo(client, "list-1", {
        title: "Important Task",
        importance: "high",
      });
      expect(item.importance).toBe("high");
    });

    it("with due date sets dueDateTime", async () => {
      const dueDateTime = { dateTime: "2025-12-31T00:00:00.0000000", timeZone: "UTC" };
      const item = await createTodo(client, "list-1", {
        title: "Due Task",
        dueDateTime,
      });
      expect(item.dueDateTime).toEqual(dueDateTime);
    });

    it("with reminder sets reminder fields", async () => {
      const reminderDateTime = { dateTime: "2025-12-30T09:00:00.0000000", timeZone: "UTC" };
      const item = await createTodo(client, "list-1", {
        title: "Reminder Task",
        isReminderOn: true,
        reminderDateTime,
      });
      expect(item.isReminderOn).toBe(true);
      expect(item.reminderDateTime).toEqual(reminderDateTime);
    });

    it("with recurrence sets recurrence pattern", async () => {
      const recurrence = {
        pattern: { type: "daily" as const, interval: 1 },
        range: { type: "noEnd" as const, startDate: "2025-01-01" },
      };
      const item = await createTodo(client, "list-1", {
        title: "Daily Task",
        recurrence,
      });
      expect(item.recurrence).toEqual(recurrence);
    });
  });

  describe("updateTodo", () => {
    it("updates title", async () => {
      const updated = await updateTodo(client, "list-1", "task-1", {
        title: "Updated Title",
      });
      expect(updated.title).toBe("Updated Title");
    });

    it("updates body", async () => {
      const updated = await updateTodo(client, "list-1", "task-1", {
        body: "New body content",
      });
      expect(updated.body).toBeDefined();
      expect(updated.body!.content).toBe("New body content");
    });

    it("updates importance", async () => {
      const updated = await updateTodo(client, "list-1", "task-1", {
        importance: "high",
      });
      expect(updated.importance).toBe("high");
    });

    it("sets due date", async () => {
      const dueDateTime = { dateTime: "2025-06-15T00:00:00.0000000", timeZone: "UTC" };
      const updated = await updateTodo(client, "list-1", "task-1", { dueDateTime });
      expect(updated.dueDateTime).toEqual(dueDateTime);
    });

    it("clears due date with null", async () => {
      // First set a due date
      env.state.todos.set("list-1", [
        {
          id: "task-1",
          title: "Buy milk",
          status: "notStarted",
          dueDateTime: { dateTime: "2025-06-15T00:00:00.0000000", timeZone: "UTC" },
        },
      ]);

      const updated = await updateTodo(client, "list-1", "task-1", { dueDateTime: null });
      expect(updated.dueDateTime).toBeUndefined();
    });

    it("sets and clears reminder", async () => {
      const reminderDateTime = { dateTime: "2025-06-15T09:00:00.0000000", timeZone: "UTC" };
      const withReminder = await updateTodo(client, "list-1", "task-1", {
        isReminderOn: true,
        reminderDateTime,
      });
      expect(withReminder.isReminderOn).toBe(true);
      expect(withReminder.reminderDateTime).toEqual(reminderDateTime);

      const cleared = await updateTodo(client, "list-1", "task-1", {
        isReminderOn: false,
        reminderDateTime: null,
      });
      expect(cleared.isReminderOn).toBe(false);
      expect(cleared.reminderDateTime).toBeUndefined();
    });

    it("sets and clears recurrence", async () => {
      const recurrence = {
        pattern: { type: "weekly" as const, interval: 1, daysOfWeek: ["monday"] },
        range: { type: "noEnd" as const, startDate: "2025-01-06" },
      };
      const withRecurrence = await updateTodo(client, "list-1", "task-1", { recurrence });
      expect(withRecurrence.recurrence).toEqual(recurrence);

      const cleared = await updateTodo(client, "list-1", "task-1", { recurrence: null });
      expect(cleared.recurrence).toBeUndefined();
    });
  });

  describe("completeTodo", () => {
    it("sets status to completed", async () => {
      await completeTodo(client, "list-1", "task-1");

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

    it("also removes checklist items for the task", async () => {
      env.state.checklistItems.set("task-1", [
        { id: "ci-1", displayName: "Step 1", isChecked: false },
      ]);

      await deleteTodo(client, "list-1", "task-1");
      expect(env.state.getChecklistItems("task-1")).toHaveLength(0);
    });
  });

  describe("checklistItems", () => {
    it("lists empty checklist", async () => {
      const items = await listChecklistItems(client, "list-1", "task-1");
      expect(items).toHaveLength(0);
    });

    it("creates a checklist item", async () => {
      const item = await createChecklistItem(client, "list-1", "task-1", "Buy eggs");
      expect(item.id).toBeTruthy();
      expect(item.displayName).toBe("Buy eggs");
      expect(item.isChecked).toBe(false);

      const items = env.state.getChecklistItems("task-1");
      expect(items).toHaveLength(1);
      expect(items[0]!.displayName).toBe("Buy eggs");
    });

    it("lists checklist items after creation", async () => {
      await createChecklistItem(client, "list-1", "task-1", "Step 1");
      await createChecklistItem(client, "list-1", "task-1", "Step 2");

      const items = await listChecklistItems(client, "list-1", "task-1");
      expect(items).toHaveLength(2);
      expect(items[0]!.displayName).toBe("Step 1");
      expect(items[1]!.displayName).toBe("Step 2");
    });

    it("updates checklist item name", async () => {
      const created = await createChecklistItem(client, "list-1", "task-1", "Old Name");
      const updated = await updateChecklistItem(client, "list-1", "task-1", created.id, {
        displayName: "New Name",
      });
      expect(updated.displayName).toBe("New Name");
      expect(updated.isChecked).toBe(false);
    });

    it("checks a checklist item", async () => {
      const created = await createChecklistItem(client, "list-1", "task-1", "Step");
      const checked = await updateChecklistItem(client, "list-1", "task-1", created.id, {
        isChecked: true,
      });
      expect(checked.isChecked).toBe(true);
      expect(checked.checkedDateTime).toBeTruthy();
    });

    it("unchecks a checklist item", async () => {
      const created = await createChecklistItem(client, "list-1", "task-1", "Step");
      await updateChecklistItem(client, "list-1", "task-1", created.id, { isChecked: true });
      const unchecked = await updateChecklistItem(client, "list-1", "task-1", created.id, {
        isChecked: false,
      });
      expect(unchecked.isChecked).toBe(false);
      expect(unchecked.checkedDateTime).toBeUndefined();
    });

    it("deletes a checklist item", async () => {
      const created = await createChecklistItem(client, "list-1", "task-1", "Temporary");
      await deleteChecklistItem(client, "list-1", "task-1", created.id);

      const items = env.state.getChecklistItems("task-1");
      expect(items).toHaveLength(0);
    });

    it("throws on non-existent checklist item update", async () => {
      await expect(
        updateChecklistItem(client, "list-1", "task-1", "no-such-item", { isChecked: true }),
      ).rejects.toThrow(GraphRequestError);
    });

    it("throws on non-existent checklist item delete", async () => {
      await expect(
        deleteChecklistItem(client, "list-1", "task-1", "no-such-item"),
      ).rejects.toThrow(GraphRequestError);
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
      await expect(createTodo(client, "", { title: "title" })).rejects.toThrow(
        "createTodo: listId must not be empty",
      );
    });

    it("empty title throws on createTodo", async () => {
      await expect(createTodo(client, "list-1", { title: "" })).rejects.toThrow(
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

    it("empty listId throws on listChecklistItems", async () => {
      await expect(listChecklistItems(client, "", "task-1")).rejects.toThrow(
        "listChecklistItems: listId must not be empty",
      );
    });

    it("empty taskId throws on listChecklistItems", async () => {
      await expect(listChecklistItems(client, "list-1", "")).rejects.toThrow(
        "listChecklistItems: taskId must not be empty",
      );
    });

    it("empty displayName throws on createChecklistItem", async () => {
      await expect(createChecklistItem(client, "list-1", "task-1", "")).rejects.toThrow(
        "createChecklistItem: displayName must not be empty",
      );
    });

    it("empty itemId throws on updateChecklistItem", async () => {
      await expect(
        updateChecklistItem(client, "list-1", "task-1", "", { isChecked: true }),
      ).rejects.toThrow("updateChecklistItem: itemId must not be empty");
    });

    it("empty itemId throws on deleteChecklistItem", async () => {
      await expect(
        deleteChecklistItem(client, "list-1", "task-1", ""),
      ).rejects.toThrow("deleteChecklistItem: itemId must not be empty");
    });
  });
});
