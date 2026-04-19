// Microsoft To Do CRUD operations via Graph API.

import type {
  TodoList,
  TodoItem,
  ChecklistItem,
  DateTimeTimeZone,
  PatternedRecurrence,
  Importance,
} from "./types.js";
import {
  TodoListSchema,
  TodoItemSchema,
  ChecklistItemSchema,
  GraphListResponseSchema,
} from "./types.js";
import type { GraphClient } from "./client.js";
import { HttpMethod } from "./client.js";
import type { ValidatedGraphId } from "./ids.js";
import { logger } from "../logger.js";
import { parseResponse } from "./client.js";

// ---------------------------------------------------------------------------
// Todo lists
// ---------------------------------------------------------------------------

/** List all To Do task lists. */
export async function listTodoLists(client: GraphClient, signal: AbortSignal): Promise<TodoList[]> {
  logger.debug("listing todo lists");
  const response = await client.request(HttpMethod.GET, "/me/todo/lists", signal);
  const data = await parseResponse(
    response,
    GraphListResponseSchema(TodoListSchema),
    HttpMethod.GET,
    "/me/todo/lists",
  );
  return data.value;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** List tasks in a To Do list with pagination, optional filtering and sorting. */
export async function listTodos(
  client: GraphClient,
  listId: ValidatedGraphId,
  top: number,
  skip: number,
  filter: string | undefined,
  orderBy: string | undefined,
  signal: AbortSignal,
): Promise<TodoItem[]> {
  const params = new URLSearchParams();
  if (top > 0) params.set("$top", String(top));
  if (skip > 0) params.set("$skip", String(skip));
  if (filter) params.set("$filter", filter);
  if (orderBy) params.set("$orderby", orderBy);

  const query = params.toString();
  const path = `/me/todo/lists/${encodeURIComponent(listId)}/tasks${query ? `?${query}` : ""}`;

  logger.debug("listing todos", { listId, top, skip, filter, orderBy });
  const response = await client.request(HttpMethod.GET, path, signal);
  const data = await parseResponse(
    response,
    GraphListResponseSchema(TodoItemSchema),
    HttpMethod.GET,
    path,
  );
  return data.value;
}

/** Get a single task by ID. */
export async function getTodo(
  client: GraphClient,
  listId: ValidatedGraphId,
  taskId: ValidatedGraphId,
  signal: AbortSignal,
): Promise<TodoItem> {
  logger.debug("getting todo", { listId, taskId });
  const path = `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`;
  const response = await client.request(HttpMethod.GET, path, signal);
  return await parseResponse(response, TodoItemSchema, HttpMethod.GET, path);
}

/** Options for creating a new task. */
export interface CreateTodoOptions {
  title: string;
  body?: string;
  importance?: Importance;
  isReminderOn?: boolean;
  reminderDateTime?: DateTimeTimeZone;
  dueDateTime?: DateTimeTimeZone;
  recurrence?: PatternedRecurrence;
}

/** Create a new task in a To Do list. */
export async function createTodo(
  client: GraphClient,
  listId: ValidatedGraphId,
  opts: CreateTodoOptions,
  signal: AbortSignal,
): Promise<TodoItem> {
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

  const path = `/me/todo/lists/${encodeURIComponent(listId)}/tasks`;
  const response = await client.request(HttpMethod.POST, path, payload, signal);
  return await parseResponse(response, TodoItemSchema, HttpMethod.POST, path);
}

/** Options for updating an existing task. */
export interface UpdateTodoOptions {
  title?: string;
  body?: string;
  importance?: Importance;
  isReminderOn?: boolean;
  reminderDateTime?: DateTimeTimeZone | null;
  dueDateTime?: DateTimeTimeZone | null;
  recurrence?: PatternedRecurrence | null;
}

/** Update an existing task. Pass `null` for date/recurrence fields to clear them. */
export async function updateTodo(
  client: GraphClient,
  listId: ValidatedGraphId,
  taskId: ValidatedGraphId,
  opts: UpdateTodoOptions,
  signal: AbortSignal,
): Promise<TodoItem> {
  logger.debug("updating todo", { listId, taskId });

  const payload: Record<string, unknown> = {};
  if (opts.title) payload["title"] = opts.title;
  if (opts.body) payload["body"] = { content: opts.body, contentType: "text" };
  if (opts.importance) payload["importance"] = opts.importance;
  if (opts.isReminderOn !== undefined) payload["isReminderOn"] = opts.isReminderOn;
  if (opts.reminderDateTime !== undefined) payload["reminderDateTime"] = opts.reminderDateTime;
  if (opts.dueDateTime !== undefined) payload["dueDateTime"] = opts.dueDateTime;
  if (opts.recurrence !== undefined) payload["recurrence"] = opts.recurrence;

  const path = `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`;
  const response = await client.request(HttpMethod.PATCH, path, payload, signal);
  return await parseResponse(response, TodoItemSchema, HttpMethod.PATCH, path);
}

/** Mark a task as completed. */
export async function completeTodo(
  client: GraphClient,
  listId: ValidatedGraphId,
  taskId: ValidatedGraphId,
  signal: AbortSignal,
): Promise<void> {
  logger.debug("completing todo", { listId, taskId });
  await client.request(
    HttpMethod.PATCH,
    `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
    { status: "completed" },
    signal,
  );
}

/** Delete a task from a To Do list. */
export async function deleteTodo(
  client: GraphClient,
  listId: ValidatedGraphId,
  taskId: ValidatedGraphId,
  signal: AbortSignal,
): Promise<void> {
  logger.debug("deleting todo", { listId, taskId });
  await client.request(
    HttpMethod.DELETE,
    `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
    signal,
  );
}

// ---------------------------------------------------------------------------
// Checklist items (steps)
// ---------------------------------------------------------------------------

/** List checklist items for a task. */
export async function listChecklistItems(
  client: GraphClient,
  listId: ValidatedGraphId,
  taskId: ValidatedGraphId,
  signal: AbortSignal,
): Promise<ChecklistItem[]> {
  logger.debug("listing checklist items", { listId, taskId });
  const path = `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}/checklistItems`;
  const response = await client.request(HttpMethod.GET, path, signal);
  const data = await parseResponse(
    response,
    GraphListResponseSchema(ChecklistItemSchema),
    HttpMethod.GET,
    path,
  );
  return data.value;
}

/** Create a new checklist item on a task. */
export async function createChecklistItem(
  client: GraphClient,
  listId: ValidatedGraphId,
  taskId: ValidatedGraphId,
  displayName: string,
  signal: AbortSignal,
): Promise<ChecklistItem> {
  if (!displayName) throw new Error("createChecklistItem: displayName must not be empty");

  logger.debug("creating checklist item", { listId, taskId, displayName });
  const path = `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}/checklistItems`;
  const response = await client.request(HttpMethod.POST, path, { displayName }, signal);
  return await parseResponse(response, ChecklistItemSchema, HttpMethod.POST, path);
}

/** Options for updating a checklist item. */
export interface UpdateChecklistItemOptions {
  displayName?: string;
  isChecked?: boolean;
}

/** Update a checklist item (rename and/or check/uncheck). */
export async function updateChecklistItem(
  client: GraphClient,
  listId: ValidatedGraphId,
  taskId: ValidatedGraphId,
  itemId: ValidatedGraphId,
  opts: UpdateChecklistItemOptions,
  signal: AbortSignal,
): Promise<ChecklistItem> {
  logger.debug("updating checklist item", { listId, taskId, itemId });
  const payload: Record<string, unknown> = {};
  if (opts.displayName !== undefined) payload["displayName"] = opts.displayName;
  if (opts.isChecked !== undefined) payload["isChecked"] = opts.isChecked;

  const path = `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}/checklistItems/${encodeURIComponent(itemId)}`;
  const response = await client.request(HttpMethod.PATCH, path, payload, signal);
  return await parseResponse(response, ChecklistItemSchema, HttpMethod.PATCH, path);
}

/** Delete a checklist item from a task. */
export async function deleteChecklistItem(
  client: GraphClient,
  listId: ValidatedGraphId,
  taskId: ValidatedGraphId,
  itemId: ValidatedGraphId,
  signal: AbortSignal,
): Promise<void> {
  logger.debug("deleting checklist item", { listId, taskId, itemId });
  await client.request(
    HttpMethod.DELETE,
    `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}/checklistItems/${encodeURIComponent(itemId)}`,
    signal,
  );
}
