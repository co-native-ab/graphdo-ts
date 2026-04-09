// Microsoft To Do CRUD operations via Graph API.

import type { TodoList, TodoItem, GraphListResponse } from "./types.js";
import type { GraphClient } from "./client.js";
import { logger } from "../logger.js";

/** List all To Do task lists. */
export async function listTodoLists(
  client: GraphClient,
): Promise<TodoList[]> {
  logger.debug("listing todo lists");
  const response = await client.request("GET", "/me/todo/lists");
  const data = (await response.json()) as GraphListResponse<TodoList>;
  return data.value;
}

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

/** Create a new task in a To Do list. */
export async function createTodo(
  client: GraphClient,
  listId: string,
  title: string,
  body: string,
): Promise<TodoItem> {
  if (!listId) throw new Error("createTodo: listId must not be empty");
  if (!title) throw new Error("createTodo: title must not be empty");

  logger.debug("creating todo", { listId, title });

  const payload: Record<string, unknown> = { title };
  if (body) {
    payload["body"] = { content: body, contentType: "text" };
  }

  const response = await client.request(
    "POST",
    `/me/todo/lists/${listId}/tasks`,
    payload,
  );
  return (await response.json()) as TodoItem;
}

/** Update title and/or body of an existing task. */
export async function updateTodo(
  client: GraphClient,
  listId: string,
  taskId: string,
  title: string,
  body: string,
): Promise<TodoItem> {
  if (!listId) throw new Error("updateTodo: listId must not be empty");
  if (!taskId) throw new Error("updateTodo: taskId must not be empty");

  logger.debug("updating todo", { listId, taskId });

  const payload: Record<string, unknown> = {};
  if (title) payload["title"] = title;
  if (body) payload["body"] = { content: body, contentType: "text" };

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
