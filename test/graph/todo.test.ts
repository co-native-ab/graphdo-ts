import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestEnv, gid, testSignal, type TestEnv } from "../helpers.js";
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

// Branded fixture IDs — same string values the mock-graph server seeds.
// Constructed once per file so the test bodies can keep reading like
// `listTodos(client, LIST_1, ...)` rather than re-validating in every call.
const LIST_1 = gid("list-1");
const TASK_1 = gid("task-1");

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
      const lists = await listTodoLists(client, testSignal());
      expect(lists).toHaveLength(1);
      expect(lists[0]!.id).toBe("list-1");
      expect(lists[0]!.displayName).toBe("My Tasks");
    });
  });

  describe("listTodos", () => {
    it("returns items for a list", async () => {
      const items = await listTodos(client, LIST_1, 0, 0, undefined, undefined, testSignal());
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

      const page1 = await listTodos(client, LIST_1, 2, 0, undefined, undefined, testSignal());
      expect(page1).toHaveLength(2);
      expect(page1[0]!.id).toBe("t1");
      expect(page1[1]!.id).toBe("t2");

      const page2 = await listTodos(client, LIST_1, 2, 2, undefined, undefined, testSignal());
      expect(page2).toHaveLength(2);
      expect(page2[0]!.id).toBe("t3");
      expect(page2[1]!.id).toBe("t4");

      const page3 = await listTodos(client, LIST_1, 2, 4, undefined, undefined, testSignal());
      expect(page3).toHaveLength(0);
    });

    it("filters by status using $filter", async () => {
      env.state.todos.set("list-1", [
        { id: "t1", title: "Task 1", status: "notStarted" },
        { id: "t2", title: "Task 2", status: "completed" },
        { id: "t3", title: "Task 3", status: "notStarted" },
      ]);

      const filtered = await listTodos(
        client,
        LIST_1,
        0,
        0,
        "status eq 'notStarted'",
        undefined,
        testSignal(),
      );
      expect(filtered).toHaveLength(2);
      expect(filtered.every((t) => t.status === "notStarted")).toBe(true);
    });

    it("sorts by importance using $orderby", async () => {
      env.state.todos.set("list-1", [
        { id: "t1", title: "Low", status: "notStarted", importance: "low" },
        { id: "t2", title: "High", status: "notStarted", importance: "high" },
        {
          id: "t3",
          title: "Normal",
          status: "notStarted",
          importance: "normal",
        },
      ]);

      const sorted = await listTodos(client, LIST_1, 0, 0, undefined, "importance", testSignal());
      expect(sorted[0]!.importance).toBe("high");
      expect(sorted[1]!.importance).toBe("low");
      expect(sorted[2]!.importance).toBe("normal");
    });
  });

  describe("getTodo", () => {
    it("returns a single item", async () => {
      const item = await getTodo(client, LIST_1, TASK_1, testSignal());
      expect(item.id).toBe("task-1");
      expect(item.title).toBe("Buy milk");
      expect(item.status).toBe("notStarted");
    });

    it("throws on non-existent ID", async () => {
      await expect(getTodo(client, LIST_1, gid("no-such-task"), testSignal())).rejects.toThrow(
        GraphRequestError,
      );
    });
  });

  describe("createTodo", () => {
    it("creates and returns new item", async () => {
      const item = await createTodo(client, LIST_1, { title: "New Task" }, testSignal());
      expect(item.id).toBeTruthy();
      expect(item.title).toBe("New Task");
      expect(item.status).toBe("notStarted");

      const todos = env.state.getTodos("list-1");
      expect(todos.some((t) => t.id === item.id)).toBe(true);
    });

    it("with body includes the body content", async () => {
      const item = await createTodo(
        client,
        LIST_1,
        {
          title: "Task With Body",
          body: "Some details here",
        },
        testSignal(),
      );
      expect(item.body).toBeDefined();
      expect(item.body!.content).toBe("Some details here");
      expect(item.body!.contentType).toBe("text");
    });

    it("with importance sets importance", async () => {
      const item = await createTodo(
        client,
        LIST_1,
        {
          title: "Important Task",
          importance: "high",
        },
        testSignal(),
      );
      expect(item.importance).toBe("high");
    });

    it("with due date sets dueDateTime", async () => {
      const dueDateTime = { dateTime: "2025-12-31T00:00:00.0000000", timeZone: "UTC" };
      const item = await createTodo(
        client,
        LIST_1,
        {
          title: "Due Task",
          dueDateTime,
        },
        testSignal(),
      );
      expect(item.dueDateTime).toEqual(dueDateTime);
    });

    it("with reminder sets reminder fields", async () => {
      const reminderDateTime = { dateTime: "2025-12-30T09:00:00.0000000", timeZone: "UTC" };
      const item = await createTodo(
        client,
        LIST_1,
        {
          title: "Reminder Task",
          isReminderOn: true,
          reminderDateTime,
        },
        testSignal(),
      );
      expect(item.isReminderOn).toBe(true);
      expect(item.reminderDateTime).toEqual(reminderDateTime);
    });

    it("with recurrence sets recurrence pattern", async () => {
      const recurrence = {
        pattern: { type: "daily" as const, interval: 1 },
        range: { type: "noEnd" as const, startDate: "2025-01-01" },
      };
      const item = await createTodo(
        client,
        LIST_1,
        {
          title: "Daily Task",
          recurrence,
        },
        testSignal(),
      );
      expect(item.recurrence).toEqual(recurrence);
    });
  });

  describe("updateTodo", () => {
    it("updates title", async () => {
      const updated = await updateTodo(
        client,
        LIST_1,
        TASK_1,
        {
          title: "Updated Title",
        },
        testSignal(),
      );
      expect(updated.title).toBe("Updated Title");
    });

    it("updates body", async () => {
      const updated = await updateTodo(
        client,
        LIST_1,
        TASK_1,
        {
          body: "New body content",
        },
        testSignal(),
      );
      expect(updated.body).toBeDefined();
      expect(updated.body!.content).toBe("New body content");
    });

    it("updates importance", async () => {
      const updated = await updateTodo(
        client,
        LIST_1,
        TASK_1,
        {
          importance: "high",
        },
        testSignal(),
      );
      expect(updated.importance).toBe("high");
    });

    it("sets due date", async () => {
      const dueDateTime = { dateTime: "2025-06-15T00:00:00.0000000", timeZone: "UTC" };
      const updated = await updateTodo(client, LIST_1, TASK_1, { dueDateTime }, testSignal());
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

      const updated = await updateTodo(client, LIST_1, TASK_1, { dueDateTime: null }, testSignal());
      expect(updated.dueDateTime).toBeUndefined();
    });

    it("sets and clears reminder", async () => {
      const reminderDateTime = { dateTime: "2025-06-15T09:00:00.0000000", timeZone: "UTC" };
      const withReminder = await updateTodo(
        client,
        LIST_1,
        TASK_1,
        {
          isReminderOn: true,
          reminderDateTime,
        },
        testSignal(),
      );
      expect(withReminder.isReminderOn).toBe(true);
      expect(withReminder.reminderDateTime).toEqual(reminderDateTime);

      const cleared = await updateTodo(
        client,
        LIST_1,
        TASK_1,
        {
          isReminderOn: false,
          reminderDateTime: null,
        },
        testSignal(),
      );
      expect(cleared.isReminderOn).toBe(false);
      expect(cleared.reminderDateTime).toBeUndefined();
    });

    it("sets and clears recurrence", async () => {
      const recurrence = {
        pattern: { type: "weekly" as const, interval: 1, daysOfWeek: ["monday"] },
        range: { type: "noEnd" as const, startDate: "2025-01-06" },
      };
      const withRecurrence = await updateTodo(client, LIST_1, TASK_1, { recurrence }, testSignal());
      expect(withRecurrence.recurrence).toEqual(recurrence);

      const cleared = await updateTodo(client, LIST_1, TASK_1, { recurrence: null }, testSignal());
      expect(cleared.recurrence).toBeUndefined();
    });
  });

  describe("completeTodo", () => {
    it("sets status to completed", async () => {
      await completeTodo(client, LIST_1, TASK_1, testSignal());

      const todos = env.state.getTodos("list-1");
      const task = todos.find((t) => t.id === "task-1");
      expect(task).toBeDefined();
      expect(task!.status).toBe("completed");
    });
  });

  describe("deleteTodo", () => {
    it("removes the item", async () => {
      await deleteTodo(client, LIST_1, TASK_1, testSignal());

      const todos = env.state.getTodos("list-1");
      expect(todos.find((t) => t.id === "task-1")).toBeUndefined();
    });

    it("also removes checklist items for the task", async () => {
      env.state.checklistItems.set("task-1", [
        { id: "ci-1", displayName: "Step 1", isChecked: false },
      ]);

      await deleteTodo(client, LIST_1, TASK_1, testSignal());
      expect(env.state.getChecklistItems("task-1")).toHaveLength(0);
    });
  });

  describe("checklistItems", () => {
    it("lists empty checklist", async () => {
      const items = await listChecklistItems(client, LIST_1, TASK_1, testSignal());
      expect(items).toHaveLength(0);
    });

    it("creates a checklist item", async () => {
      const item = await createChecklistItem(client, LIST_1, TASK_1, "Buy eggs", testSignal());
      expect(item.id).toBeTruthy();
      expect(item.displayName).toBe("Buy eggs");
      expect(item.isChecked).toBe(false);

      const items = env.state.getChecklistItems("task-1");
      expect(items).toHaveLength(1);
      expect(items[0]!.displayName).toBe("Buy eggs");
    });

    it("lists checklist items after creation", async () => {
      await createChecklistItem(client, LIST_1, TASK_1, "Step 1", testSignal());
      await createChecklistItem(client, LIST_1, TASK_1, "Step 2", testSignal());

      const items = await listChecklistItems(client, LIST_1, TASK_1, testSignal());
      expect(items).toHaveLength(2);
      expect(items[0]!.displayName).toBe("Step 1");
      expect(items[1]!.displayName).toBe("Step 2");
    });

    it("updates checklist item name", async () => {
      const created = await createChecklistItem(client, LIST_1, TASK_1, "Old Name", testSignal());
      const updated = await updateChecklistItem(
        client,
        LIST_1,
        TASK_1,
        gid(created.id),
        {
          displayName: "New Name",
        },
        testSignal(),
      );
      expect(updated.displayName).toBe("New Name");
      expect(updated.isChecked).toBe(false);
    });

    it("checks a checklist item", async () => {
      const created = await createChecklistItem(client, LIST_1, TASK_1, "Step", testSignal());
      const checked = await updateChecklistItem(
        client,
        LIST_1,
        TASK_1,
        gid(created.id),
        {
          isChecked: true,
        },
        testSignal(),
      );
      expect(checked.isChecked).toBe(true);
      expect(checked.checkedDateTime).toBeTruthy();
    });

    it("unchecks a checklist item", async () => {
      const created = await createChecklistItem(client, LIST_1, TASK_1, "Step", testSignal());
      await updateChecklistItem(
        client,
        LIST_1,
        TASK_1,
        gid(created.id),
        { isChecked: true },
        testSignal(),
      );
      const unchecked = await updateChecklistItem(
        client,
        LIST_1,
        TASK_1,
        gid(created.id),
        {
          isChecked: false,
        },
        testSignal(),
      );
      expect(unchecked.isChecked).toBe(false);
      expect(unchecked.checkedDateTime).toBeUndefined();
    });

    it("deletes a checklist item", async () => {
      const created = await createChecklistItem(client, LIST_1, TASK_1, "Temporary", testSignal());
      await deleteChecklistItem(client, LIST_1, TASK_1, gid(created.id), testSignal());

      const items = env.state.getChecklistItems("task-1");
      expect(items).toHaveLength(0);
    });

    it("throws on non-existent checklist item update", async () => {
      await expect(
        updateChecklistItem(
          client,
          LIST_1,
          TASK_1,
          gid("no-such-item"),
          { isChecked: true },
          testSignal(),
        ),
      ).rejects.toThrow(GraphRequestError);
    });

    it("throws on non-existent checklist item delete", async () => {
      await expect(
        deleteChecklistItem(client, LIST_1, TASK_1, gid("no-such-item"), testSignal()),
      ).rejects.toThrow(GraphRequestError);
    });
  });

  describe("validation", () => {
    // The branded `ValidatedGraphId` type makes it a compile-time error
    // to pass an unvalidated string to any of the helpers above. The
    // validator's own behaviour is covered exhaustively in
    // `test/graph/ids.test.ts`. The handful of payload-shape checks
    // (e.g. `displayName must not be empty`) that survive the migration
    // are kept here because they are not about identifier validation.

    it("empty title throws on createTodo", async () => {
      await expect(createTodo(client, LIST_1, { title: "" }, testSignal())).rejects.toThrow(
        "createTodo: title must not be empty",
      );
    });

    it("empty displayName throws on createChecklistItem", async () => {
      await expect(createChecklistItem(client, LIST_1, TASK_1, "", testSignal())).rejects.toThrow(
        "createChecklistItem: displayName must not be empty",
      );
    });
  });
});
