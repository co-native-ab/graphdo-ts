// Microsoft To Do CRUD operations via Graph API.

import type {
  TodoList,
  TodoItem,
  ChecklistItem,
  GraphListResponse,
  DateTimeTimeZone,
  PatternedRecurrence,
} from "./types.js";
import type { GraphClient } from "./client.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Todo lists
// ---------------------------------------------------------------------------

/** List all To Do task lists. */
export async function listTodoLists(
  client: GraphClient,
): Promise<TodoList[]> {
  logger.debug("listing todo lists");
  const response = await client.request("GET", "/me/todo/lists");
  const data = (await response.json()) as GraphListResponse<TodoList>;
  return data.value;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** List tasks in a To Do list with pagination. */
export async function listTodos(
  client: GraphClient,
  listId: string,
  top: number,
  skip: number,
): Promise<TodoItem[]> {
  if (!listId) throw new Error("listTodos: listId must not be empty");

  const params = new URLSearchParams();
  if (top > 0) params.set("$top", String(top));
  if (skip > 0) params.set("$skip", String(skip));

  const query = params.toString();
  const path = `/me/todo/lists/${listId}/tasks${query ? `?${query}` : ""}`;

  logger.debug("listing todos", { listId, top, skip });
  const response = await client.request("GET", path);
  const data = (await response.json()) as GraphListResponse<TodoItem>;
  return data.value;
}

/** Get a single task by ID. */
export async function getTodo(
  client: GraphClient,
  listId: string,
  taskId: string,
): Promise<TodoItem> {
  if (!listId) throw new Error("getTodo: listId must not be empty");
  if (!taskId) throw new Error("getTodo: taskId must not be empty");

  logger.debug("getting todo", { listId, taskId });
  const response = await client.request(
    "GET",
    `/me/todo/lists/${listId}/tasks/${taskId}`,
  );
  return (await response.json()) as TodoItem;
}

/** Options for creating a new task. */
export interface CreateTodoOptions {
  title: string;
  body?: string;
  importance?: string;
  isReminderOn?: boolean;
  reminderDateTime?: DateTimeTimeZone;
  dueDateTime?: DateTimeTimeZone;
  recurrence?: PatternedRecurrence;
}

/** Create a new task in a To Do list. */
export async function createTodo(
  client: GraphClient,
  listId: string,
  opts: CreateTodoOptions,
): Promise<TodoItem> {
  if (!listId) throw new Error("createTodo: listId must not be empty");
  if (!opts.title) throw new Error("createTodo: title must not be empty");

  logger.debug("creating todo", { listId, title: opts.title });

  const payload: Record<string, unknown> = { title: opts.title };
  if (opts.body) {
    payload["body"] = { content: opts.body, contentType: "text" };
  }
  if (opts.importance) {
    payload["importance"] = opts.importance;
  }
  if (opts.isReminderOn !== undefined) {
    payload["isReminderOn"] = opts.isReminderOn;
  }
  if (opts.reminderDateTime) {
    payload["reminderDateTime"] = opts.reminderDateTime;
  }
  if (opts.dueDateTime) {
    payload["dueDateTime"] = opts.dueDateTime;
  }
  if (opts.recurrence) {
    payload["recurrence"] = opts.recurrence;
  }

  const response = await client.request(
    "POST",
    `/me/todo/lists/${listId}/tasks`,
    payload,
  );
  return (await response.json()) as TodoItem;
}

/** Options for updating an existing task. */
export interface UpdateTodoOptions {
  title?: string;
  body?: string;
  importance?: string;
  isReminderOn?: boolean;
  reminderDateTime?: DateTimeTimeZone | null;
  dueDateTime?: DateTimeTimeZone | null;
  recurrence?: PatternedRecurrence | null;
}

/** Update an existing task. Pass `null` for date/recurrence fields to clear them. */
export async function updateTodo(
  client: GraphClient,
  listId: string,
  taskId: string,
  opts: UpdateTodoOptions,
): Promise<TodoItem> {
  if (!listId) throw new Error("updateTodo: listId must not be empty");
  if (!taskId) throw new Error("updateTodo: taskId must not be empty");

  logger.debug("updating todo", { listId, taskId });

  const payload: Record<string, unknown> = {};
  if (opts.title) payload["title"] = opts.title;
  if (opts.body) payload["body"] = { content: opts.body, contentType: "text" };
  if (opts.importance) payload["importance"] = opts.importance;
  if (opts.isReminderOn !== undefined) payload["isReminderOn"] = opts.isReminderOn;
  if (opts.reminderDateTime !== undefined) payload["reminderDateTime"] = opts.reminderDateTime;
  if (opts.dueDateTime !== undefined) payload["dueDateTime"] = opts.dueDateTime;
  if (opts.recurrence !== undefined) payload["recurrence"] = opts.recurrence;

  const response = await client.request(
    "PATCH",
    `/me/todo/lists/${listId}/tasks/${taskId}`,
    payload,
  );
  return (await response.json()) as TodoItem;
}

/** Mark a task as completed. */
export async function completeTodo(
  client: GraphClient,
  listId: string,
  taskId: string,
): Promise<void> {
  if (!listId) throw new Error("completeTodo: listId must not be empty");
  if (!taskId) throw new Error("completeTodo: taskId must not be empty");

  logger.debug("completing todo", { listId, taskId });
  await client.request(
    "PATCH",
    `/me/todo/lists/${listId}/tasks/${taskId}`,
    { status: "completed" },
  );
}

/** Delete a task from a To Do list. */
export async function deleteTodo(
  client: GraphClient,
  listId: string,
  taskId: string,
): Promise<void> {
  if (!listId) throw new Error("deleteTodo: listId must not be empty");
  if (!taskId) throw new Error("deleteTodo: taskId must not be empty");

  logger.debug("deleting todo", { listId, taskId });
  await client.request(
    "DELETE",
    `/me/todo/lists/${listId}/tasks/${taskId}`,
  );
}

// ---------------------------------------------------------------------------
// Checklist items (steps)
// ---------------------------------------------------------------------------

/** List checklist items for a task. */
export async function listChecklistItems(
  client: GraphClient,
  listId: string,
  taskId: string,
): Promise<ChecklistItem[]> {
  if (!listId) throw new Error("listChecklistItems: listId must not be empty");
  if (!taskId) throw new Error("listChecklistItems: taskId must not be empty");

  logger.debug("listing checklist items", { listId, taskId });
  const response = await client.request(
    "GET",
    `/me/todo/lists/${listId}/tasks/${taskId}/checklistItems`,
  );
  const data = (await response.json()) as GraphListResponse<ChecklistItem>;
  return data.value;
}

/** Create a new checklist item on a task. */
export async function createChecklistItem(
  client: GraphClient,
  listId: string,
  taskId: string,
  displayName: string,
): Promise<ChecklistItem> {
  if (!listId) throw new Error("createChecklistItem: listId must not be empty");
  if (!taskId) throw new Error("createChecklistItem: taskId must not be empty");
  if (!displayName) throw new Error("createChecklistItem: displayName must not be empty");

  logger.debug("creating checklist item", { listId, taskId, displayName });
  const response = await client.request(
    "POST",
    `/me/todo/lists/${listId}/tasks/${taskId}/checklistItems`,
    { displayName },
  );
  return (await response.json()) as ChecklistItem;
}

/** Options for updating a checklist item. */
export interface UpdateChecklistItemOptions {
  displayName?: string;
  isChecked?: boolean;
}

/** Update a checklist item (rename and/or check/uncheck). */
export async function updateChecklistItem(
  client: GraphClient,
  listId: string,
  taskId: string,
  itemId: string,
  opts: UpdateChecklistItemOptions,
): Promise<ChecklistItem> {
  if (!listId) throw new Error("updateChecklistItem: listId must not be empty");
  if (!taskId) throw new Error("updateChecklistItem: taskId must not be empty");
  if (!itemId) throw new Error("updateChecklistItem: itemId must not be empty");

  logger.debug("updating checklist item", { listId, taskId, itemId });
  const payload: Record<string, unknown> = {};
  if (opts.displayName !== undefined) payload["displayName"] = opts.displayName;
  if (opts.isChecked !== undefined) payload["isChecked"] = opts.isChecked;

  const response = await client.request(
    "PATCH",
    `/me/todo/lists/${listId}/tasks/${taskId}/checklistItems/${itemId}`,
    payload,
  );
  return (await response.json()) as ChecklistItem;
}

/** Delete a checklist item from a task. */
export async function deleteChecklistItem(
  client: GraphClient,
  listId: string,
  taskId: string,
  itemId: string,
): Promise<void> {
  if (!listId) throw new Error("deleteChecklistItem: listId must not be empty");
  if (!taskId) throw new Error("deleteChecklistItem: taskId must not be empty");
  if (!itemId) throw new Error("deleteChecklistItem: itemId must not be empty");

  logger.debug("deleting checklist item", { listId, taskId, itemId });
  await client.request(
    "DELETE",
    `/me/todo/lists/${listId}/tasks/${taskId}/checklistItems/${itemId}`,
  );
}
