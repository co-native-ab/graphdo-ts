import http from "node:http";

import type {
  User,
  TodoItem,
  TodoList,
  SendMailRequest,
  GraphErrorEnvelope,
} from "../src/graph/types.js";

export interface SentMail {
  to: string;
  subject: string;
  body: string;
  contentType: string;
}

export class MockState {
  user: User;
  todoLists: TodoList[];
  todos: Map<string, TodoItem[]>;
  sentMails: SentMail[];
  private nextId: number;

  constructor() {
    this.user = { id: "", displayName: "", mail: "", userPrincipalName: "" };
    this.todoLists = [];
    this.todos = new Map();
    this.sentMails = [];
    this.nextId = 1;
  }

  genId(): string {
    const id = `mock-${this.nextId}`;
    this.nextId++;
    return id;
  }

  getSentMails(): SentMail[] {
    return [...this.sentMails];
  }

  getTodos(listId: string): TodoItem[] {
    return [...(this.todos.get(listId) ?? [])];
  }
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(data);
}

function errorResponse(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  const envelope: GraphErrorEnvelope = { error: { code, message } };
  jsonResponse(res, status, envelope);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function parseSegments(pathname: string): string[] {
  return pathname.split("/").filter((s) => s.length > 0);
}

export function createMockGraphServer(state: MockState): Promise<{
  server: http.Server;
  url: string;
}> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(
      (req: http.IncomingMessage, res: http.ServerResponse) => {
        void handleRequest(state, req, res);
      },
    );

    server.once("error", reject);

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("unexpected server address type"));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function handleRequest(
  state: MockState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // Check authorization
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader === "Bearer ") {
    errorResponse(res, 401, "Unauthorized", "missing or empty bearer token");
    return;
  }

  const parsed = new URL(req.url ?? "/", "http://localhost");
  const segments = parseSegments(parsed.pathname);
  const method = req.method ?? "GET";

  try {
    // GET /me
    if (method === "GET" && segments.length === 1 && segments[0] === "me") {
      jsonResponse(res, 200, state.user);
      return;
    }

    // POST /me/sendMail
    if (
      method === "POST" &&
      segments.length === 2 &&
      segments[0] === "me" &&
      segments[1] === "sendMail"
    ) {
      const raw = await readBody(req);
      const payload = JSON.parse(raw) as SendMailRequest;
      const msg = payload.message;
      for (const recipient of msg.toRecipients) {
        state.sentMails.push({
          to: recipient.emailAddress.address,
          subject: msg.subject,
          body: msg.body.content,
          contentType: msg.body.contentType,
        });
      }
      res.writeHead(202);
      res.end();
      return;
    }

    // GET /me/todo/lists
    if (
      method === "GET" &&
      segments.length === 3 &&
      segments[0] === "me" &&
      segments[1] === "todo" &&
      segments[2] === "lists"
    ) {
      jsonResponse(res, 200, { value: state.todoLists });
      return;
    }

    // Routes under /me/todo/lists/:listId/tasks
    if (
      segments.length >= 5 &&
      segments[0] === "me" &&
      segments[1] === "todo" &&
      segments[2] === "lists" &&
      segments[4] === "tasks"
    ) {
      const listId = segments[3];
      if (listId === undefined) {
        errorResponse(res, 404, "NotFound", "missing list ID");
        return;
      }

      // Verify list exists
      if (!state.todoLists.some((l) => l.id === listId)) {
        errorResponse(res, 404, "NotFound", `list ${listId} not found`);
        return;
      }

      // GET/POST /me/todo/lists/:listId/tasks
      if (segments.length === 5) {
        if (method === "GET") {
          return handleListTasks(state, listId, parsed, res);
        }
        if (method === "POST") {
          return await handleCreateTask(state, listId, req, res);
        }
      }

      // GET/PATCH/DELETE /me/todo/lists/:listId/tasks/:taskId
      if (segments.length === 6) {
        const taskId = segments[5];
        if (taskId === undefined) {
          errorResponse(res, 404, "NotFound", "missing task ID");
          return;
        }
        if (method === "GET") {
          return handleGetTask(state, listId, taskId, res);
        }
        if (method === "PATCH") {
          return await handleUpdateTask(state, listId, taskId, req, res);
        }
        if (method === "DELETE") {
          return handleDeleteTask(state, listId, taskId, res);
        }
      }
    }

    errorResponse(res, 404, "NotFound", `no route for ${method} ${parsed.pathname}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "internal server error";
    errorResponse(res, 500, "InternalError", message);
  }
}

function handleListTasks(
  state: MockState,
  listId: string,
  parsed: URL,
  res: http.ServerResponse,
): void {
  const items = state.todos.get(listId) ?? [];

  const skipParam = parsed.searchParams.get("$skip");
  const topParam = parsed.searchParams.get("$top");
  const skip = skipParam !== null ? Math.max(0, Number(skipParam)) : 0;
  const top = topParam !== null ? Math.max(0, Number(topParam)) : undefined;

  let result = items.slice(skip);
  if (top !== undefined) {
    result = result.slice(0, top);
  }

  jsonResponse(res, 200, { value: result });
}

async function handleCreateTask(
  state: MockState,
  listId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const raw = await readBody(req);
  const payload = JSON.parse(raw) as Partial<TodoItem>;

  const newTask: TodoItem = {
    id: state.genId(),
    title: payload.title ?? "",
    status: "notStarted",
    body: payload.body,
  };

  const existing = state.todos.get(listId) ?? [];
  existing.push(newTask);
  state.todos.set(listId, existing);

  jsonResponse(res, 201, newTask);
}

function handleGetTask(
  state: MockState,
  listId: string,
  taskId: string,
  res: http.ServerResponse,
): void {
  const items = state.todos.get(listId) ?? [];
  const task = items.find((t) => t.id === taskId);
  if (!task) {
    errorResponse(res, 404, "NotFound", `task ${taskId} not found`);
    return;
  }
  jsonResponse(res, 200, task);
}

async function handleUpdateTask(
  state: MockState,
  listId: string,
  taskId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const items = state.todos.get(listId) ?? [];
  const task = items.find((t) => t.id === taskId);
  if (!task) {
    errorResponse(res, 404, "NotFound", `task ${taskId} not found`);
    return;
  }

  const raw = await readBody(req);
  const patch = JSON.parse(raw) as Partial<TodoItem>;

  if (patch.title !== undefined) {
    task.title = patch.title;
  }
  if (patch.status !== undefined) {
    task.status = patch.status;
  }
  if (patch.body !== undefined) {
    task.body = patch.body;
  }

  jsonResponse(res, 200, task);
}

function handleDeleteTask(
  state: MockState,
  listId: string,
  taskId: string,
  res: http.ServerResponse,
): void {
  const items = state.todos.get(listId) ?? [];
  const index = items.findIndex((t) => t.id === taskId);
  if (index === -1) {
    errorResponse(res, 404, "NotFound", `task ${taskId} not found`);
    return;
  }
  items.splice(index, 1);
  state.todos.set(listId, items);

  res.writeHead(204);
  res.end();
}
