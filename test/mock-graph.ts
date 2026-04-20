import http from "node:http";

import type {
  User,
  TodoItem,
  TodoList,
  ChecklistItem,
  DriveItem,
  DriveItemVersion,
  SendMailRequest,
  GraphErrorEnvelope,
} from "../src/graph/types.js";

export interface SentMail {
  to: string;
  subject: string;
  body: string;
  contentType: string;
}

/** A mock child of a OneDrive folder — either a file with in-memory content or a subfolder. */
export interface MockDriveFile extends DriveItem {
  content?: string;
}

/** A mock historical version of a drive item, with in-memory content. */
export interface MockDriveItemVersion extends DriveItemVersion {
  content: string;
}

export class MockState {
  user: User;
  todoLists: TodoList[];
  todos: Map<string, TodoItem[]>;
  checklistItems: Map<string, ChecklistItem[]>;
  sentMails: SentMail[];
  /** Top-level drive items under /me/drive/root (folders and/or files). */
  driveRootChildren: DriveItem[];
  /** Children keyed by folder ID. Each folder's entry contains its files/folders. */
  driveFolderChildren: Map<string, MockDriveFile[]>;
  /**
   * Historical versions keyed by file ID, newest first. Populated
   * automatically when a file is overwritten via the upload endpoint; tests
   * may also seed entries directly for explicit scenarios.
   */
  driveItemVersions: Map<string, MockDriveItemVersion[]>;
  /** Metadata returned by `GET /me/drive`. */
  drive: { id: string; driveType: string; webUrl: string };
  /**
   * Append-only log of every authenticated request the mock has served,
   * in arrival order. Lets tests assert on call patterns — e.g. the
   * §4.6 scope-resolution rule that pre-resolution refusals issue zero
   * Graph calls (test 08 in `docs/plans/collab-v1.md` §8.2).
   */
  requestLog: { method: string; path: string }[];
  /** W4 Day 4: Shared-with-me entries. */
  sharedWithMe?: {
    id: string;
    name: string;
    remoteItem?: {
      id?: string;
      folder?: { childCount?: number };
      parentReference?: { driveId?: string };
    };
    lastModifiedDateTime?: string;
  }[];
  /** W4 Day 4: Share URL resolutions keyed by encoded share ID. */
  shares?: Map<string, DriveItem>;
  /** W4 Day 4: Per-item permissions keyed by item ID. */
  permissions?: Map<
    string,
    {
      id: string;
      roles?: string[];
    }[]
  >;
  private nextId: number;
  private nextVersionSeq: number;
  /** Per-item cTag sequence so cTags monotonically bump on every content write. */
  private cTagSeq: Map<string, number>;

  constructor() {
    this.user = { id: "", displayName: "", mail: "", userPrincipalName: "" };
    this.todoLists = [];
    this.todos = new Map();
    this.checklistItems = new Map();
    this.sentMails = [];
    this.driveRootChildren = [];
    this.driveFolderChildren = new Map();
    this.driveItemVersions = new Map();
    this.drive = {
      id: "mock-drive-1",
      driveType: "business",
      webUrl: "https://contoso-my.sharepoint.com/personal/user_contoso_com/Documents",
    };
    this.nextId = 1;
    this.nextVersionSeq = 1;
    this.cTagSeq = new Map();
    this.requestLog = [];
    this.sharedWithMe = [];
    this.shares = new Map();
    this.permissions = new Map();
  }

  genId(): string {
    const id = `mock-${this.nextId}`;
    this.nextId++;
    return id;
  }

  /**
   * Generate an opaque cTag for a drive item, mirroring OneDrive's
   * `c:{GUID},N` shape. Bumped on every content write so conditional-update
   * tests can exercise both matching and stale cTags.
   */
  genCTag(itemId: string): string {
    const seq = (this.cTagSeq.get(itemId) ?? 0) + 1;
    this.cTagSeq.set(itemId, seq);
    return `"c:{${itemId}},${String(seq)}"`;
  }

  /**
   * Generate the next version ID. OneDrive on SharePoint uses "1.0", "2.0",
   * etc.; we use the same shape but treat it as opaque in production code.
   */
  genVersionId(): string {
    const id = `${String(this.nextVersionSeq)}.0`;
    this.nextVersionSeq++;
    return id;
  }

  getSentMails(): SentMail[] {
    return [...this.sentMails];
  }

  getTodos(listId: string): TodoItem[] {
    return [...(this.todos.get(listId) ?? [])];
  }

  getChecklistItems(taskId: string): ChecklistItem[] {
    return [...(this.checklistItems.get(taskId) ?? [])];
  }

  /** Find a drive item by ID anywhere in the mock state. */
  findDriveItem(itemId: string): DriveItem | undefined {
    const root = this.driveRootChildren.find((i) => i.id === itemId);
    if (root) return root;
    for (const files of this.driveFolderChildren.values()) {
      const match = files.find((f) => f.id === itemId);
      if (match) return match;
    }
    return undefined;
  }

  /** Find the folder ID that contains the given file (returns null if not found). */
  findParentFolderId(itemId: string): string | null {
    for (const [folderId, files] of this.driveFolderChildren.entries()) {
      if (files.some((f) => f.id === itemId)) return folderId;
    }
    return null;
  }
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
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

const MAX_BODY_SIZE = 8 * 1024 * 1024; // 8 MiB — must exceed our 4 MiB markdown limit so boundary tests can exercise it

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy(new Error("Payload Too Large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function parseSegments(pathname: string): string[] {
  return pathname.split("/").filter((s) => s.length > 0);
}

/**
 * Apply Graph-style `$top` + `$skip` pagination to an in-memory collection,
 * returning the page payload (plus an absolute `@odata.nextLink` when more
 * pages remain). Used by `/me/drive/root/children` and
 * `/me/drive/items/{id}/children` to exercise the listAllPages helper in
 * the production code.
 */
function paginate<T>(
  _state: MockState,
  parsed: URL,
  basePath: string,
  all: T[],
): { value: T[]; "@odata.nextLink"?: string } {
  const top = clampTopParam(parsed.searchParams.get("$top"));
  const skip = clampSkipParam(parsed.searchParams.get("$skip"));
  const slice = all.slice(skip, skip + top);
  if (skip + top < all.length) {
    // Mimic the real Graph nextLink shape so listAllPages.extractNextPath
    // accepts it. The actual host is irrelevant — the client only uses the
    // path + query, and our GraphClient base URL points at this mock.
    const params = new URLSearchParams(parsed.searchParams);
    params.set("$skip", String(skip + top));
    const synthetic = `https://graph.microsoft.com/v1.0${basePath}?${params.toString()}`;
    return { value: slice, "@odata.nextLink": synthetic };
  }
  return { value: slice };
}

function clampTopParam(raw: string | null): number {
  if (raw === null) return 200;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 200;
  return Math.min(n, 200);
}

function clampSkipParam(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export function createMockGraphServer(state: MockState): Promise<{
  server: http.Server;
  url: string;
}> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
      void handleRequest(state, req, res);
    });

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

  // Record every authenticated request (after the bearer-token gate
  // above) so tests can assert on call patterns — e.g. the §4.6
  // scope-resolution rule that pre-resolution refusals issue zero
  // Graph calls.
  state.requestLog.push({ method, path: `${parsed.pathname}${parsed.search}` });

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

      // Checklist items: /me/todo/lists/:listId/tasks/:taskId/checklistItems[/:itemId]
      if (segments.length >= 7 && segments[6] === "checklistItems") {
        const taskId = segments[5];
        if (taskId === undefined) {
          errorResponse(res, 404, "NotFound", "missing task ID");
          return;
        }

        // Verify task exists
        const tasks = state.todos.get(listId) ?? [];
        if (!tasks.some((t) => t.id === taskId)) {
          errorResponse(res, 404, "NotFound", `task ${taskId} not found`);
          return;
        }

        // GET/POST /me/todo/lists/:listId/tasks/:taskId/checklistItems
        if (segments.length === 7) {
          if (method === "GET") {
            return handleListChecklistItems(state, taskId, res);
          }
          if (method === "POST") {
            return await handleCreateChecklistItem(state, taskId, req, res);
          }
        }

        // GET/PATCH/DELETE /me/todo/lists/:listId/tasks/:taskId/checklistItems/:itemId
        if (segments.length === 8) {
          const itemId = segments[7];
          if (itemId === undefined) {
            errorResponse(res, 404, "NotFound", "missing checklist item ID");
            return;
          }
          if (method === "GET") {
            return handleGetChecklistItem(state, taskId, itemId, res);
          }
          if (method === "PATCH") {
            return await handleUpdateChecklistItem(state, taskId, itemId, req, res);
          }
          if (method === "DELETE") {
            return handleDeleteChecklistItem(state, taskId, itemId, res);
          }
        }
      }
    }

    // OneDrive / drive routes -------------------------------------------
    if (segments[0] === "me" && segments[1] === "drive") {
      const handled = await handleDriveRequest(state, req, res, method, segments, parsed);
      if (handled) return;
    }

    // W4 Day 4: /shares/{encoded}/driveItem
    if (
      method === "GET" &&
      segments.length === 3 &&
      segments[0] === "shares" &&
      segments[2] === "driveItem"
    ) {
      const encodedShareId = decodeURIComponent(segments[1] ?? "");
      const shareItem = state.shares?.get(encodedShareId);
      if (!shareItem) {
        errorResponse(res, 404, "itemNotFound", `share ${encodedShareId} not found`);
        return;
      }
      jsonResponse(res, 200, shareItem);
      return;
    }

    // W4 Day 4: /drives/{driveId}/items/{itemId}/permissions
    if (
      method === "GET" &&
      segments.length === 5 &&
      segments[0] === "drives" &&
      segments[2] === "items" &&
      segments[4] === "permissions"
    ) {
      const _driveId = decodeURIComponent(segments[1] ?? "");
      const itemId = decodeURIComponent(segments[3] ?? "");
      const permissions = state.permissions?.get(itemId) ?? [];
      jsonResponse(res, 200, { value: permissions });
      return;
    }

    // W4 Day 4: /drives/{driveId}/items/{itemId} (folder metadata refresh)
    if (
      method === "GET" &&
      segments.length === 4 &&
      segments[0] === "drives" &&
      segments[2] === "items"
    ) {
      const _driveId = decodeURIComponent(segments[1] ?? "");
      const itemId = decodeURIComponent(segments[3] ?? "");
      const item = state.findDriveItem(itemId);
      if (!item) {
        errorResponse(res, 404, "itemNotFound", `item ${itemId} not found`);
        return;
      }
      jsonResponse(res, 200, driveItemView(item, state));
      return;
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
  let items = state.todos.get(listId) ?? [];

  // Basic $filter support for testing (handles simple "field eq 'value'" patterns)
  const filterParam = parsed.searchParams.get("$filter");
  if (filterParam) {
    const match = /^(\w+)\s+eq\s+'([^']*)'$/.exec(filterParam);
    if (match) {
      const [, field, value] = match;
      items = items.filter((item) => {
        const record = item as unknown as Record<string, unknown>;
        return record[field ?? ""] === value;
      });
    }
  }

  // Basic $orderby support for testing (handles "field" or "field desc")
  const orderByParam = parsed.searchParams.get("$orderby");
  if (orderByParam) {
    const parts = orderByParam.split(/\s+/);
    const field = parts[0] ?? "";
    const desc = parts[1] === "desc";
    items = [...items].sort((a, b) => {
      const recA = a as unknown as Record<string, unknown>;
      const recB = b as unknown as Record<string, unknown>;
      const aVal = typeof recA[field] === "string" ? recA[field] : "";
      const bVal = typeof recB[field] === "string" ? recB[field] : "";
      const cmp = aVal.localeCompare(bVal);
      return desc ? -cmp : cmp;
    });
  }

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
    importance: payload.importance ?? "normal",
    isReminderOn: payload.isReminderOn,
    reminderDateTime: payload.reminderDateTime,
    dueDateTime: payload.dueDateTime,
    recurrence: payload.recurrence,
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

  if (patch.title !== undefined) task.title = patch.title;
  if (patch.status !== undefined) task.status = patch.status;
  if (patch.body !== undefined) task.body = patch.body;
  if (patch.importance !== undefined) task.importance = patch.importance;
  if (patch.isReminderOn !== undefined) task.isReminderOn = patch.isReminderOn;
  // null clears the field, undefined means no change
  if ("reminderDateTime" in patch) task.reminderDateTime = patch.reminderDateTime ?? undefined;
  if ("dueDateTime" in patch) task.dueDateTime = patch.dueDateTime ?? undefined;
  if ("recurrence" in patch) task.recurrence = patch.recurrence ?? undefined;

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

  // Also clean up any checklist items for this task
  state.checklistItems.delete(taskId);

  res.writeHead(204);
  res.end();
}

// ---------------------------------------------------------------------------
// Checklist item handlers
// ---------------------------------------------------------------------------

function handleListChecklistItems(
  state: MockState,
  taskId: string,
  res: http.ServerResponse,
): void {
  const items = state.checklistItems.get(taskId) ?? [];
  jsonResponse(res, 200, { value: items });
}

async function handleCreateChecklistItem(
  state: MockState,
  taskId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const raw = await readBody(req);
  const payload = JSON.parse(raw) as Partial<ChecklistItem>;

  const newItem: ChecklistItem = {
    id: state.genId(),
    displayName: payload.displayName ?? "",
    isChecked: payload.isChecked ?? false,
    createdDateTime: new Date().toISOString(),
  };

  const existing = state.checklistItems.get(taskId) ?? [];
  existing.push(newItem);
  state.checklistItems.set(taskId, existing);

  jsonResponse(res, 201, newItem);
}

function handleGetChecklistItem(
  state: MockState,
  taskId: string,
  itemId: string,
  res: http.ServerResponse,
): void {
  const items = state.checklistItems.get(taskId) ?? [];
  const item = items.find((i) => i.id === itemId);
  if (!item) {
    errorResponse(res, 404, "NotFound", `checklist item ${itemId} not found`);
    return;
  }
  jsonResponse(res, 200, item);
}

async function handleUpdateChecklistItem(
  state: MockState,
  taskId: string,
  itemId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const items = state.checklistItems.get(taskId) ?? [];
  const item = items.find((i) => i.id === itemId);
  if (!item) {
    errorResponse(res, 404, "NotFound", `checklist item ${itemId} not found`);
    return;
  }

  const raw = await readBody(req);
  const patch = JSON.parse(raw) as Partial<ChecklistItem>;

  if (patch.displayName !== undefined) item.displayName = patch.displayName;
  if (patch.isChecked !== undefined) {
    item.isChecked = patch.isChecked;
    item.checkedDateTime = patch.isChecked ? new Date().toISOString() : undefined;
  }

  jsonResponse(res, 200, item);
}

function handleDeleteChecklistItem(
  state: MockState,
  taskId: string,
  itemId: string,
  res: http.ServerResponse,
): void {
  const items = state.checklistItems.get(taskId) ?? [];
  const index = items.findIndex((i) => i.id === itemId);
  if (index === -1) {
    errorResponse(res, 404, "NotFound", `checklist item ${itemId} not found`);
    return;
  }
  items.splice(index, 1);
  state.checklistItems.set(taskId, items);

  res.writeHead(204);
  res.end();
}

// ---------------------------------------------------------------------------
// OneDrive / drive handlers
// ---------------------------------------------------------------------------

function readRawBody(req: http.IncomingMessage): Promise<string> {
  // Same as readBody but kept separate for clarity — content uploads for the
  // markdown tools send raw text, not JSON.
  return readBody(req);
}

/**
 * Handle requests under `/me/drive/...`.
 * Returns `true` when the request was routed (a response has been sent);
 * `false` when no route matched and the caller should fall through to 404.
 */
async function handleDriveRequest(
  state: MockState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  segments: string[],
  parsed: URL,
): Promise<boolean> {
  // GET /me/drive
  if (method === "GET" && segments.length === 2) {
    jsonResponse(res, 200, {
      id: state.drive.id,
      driveType: state.drive.driveType,
      webUrl: state.drive.webUrl,
    });
    return true;
  }

  // GET /me/drive/root/children
  if (
    method === "GET" &&
    segments.length === 4 &&
    segments[2] === "root" &&
    segments[3] === "children"
  ) {
    jsonResponse(
      res,
      200,
      paginate(state, parsed, "/me/drive/root/children", state.driveRootChildren),
    );
    return true;
  }

  if (segments[2] !== "items" || segments.length < 4) {
    // GET /me/drive/sharedWithMe (W4 Day 4) — handled here because the
    // `items`-or-bail guard below would otherwise short-circuit it.
    if (method === "GET" && segments.length === 3 && segments[2] === "sharedWithMe") {
      const entries = state.sharedWithMe ?? [];
      jsonResponse(res, 200, { value: entries });
      return true;
    }
    return false;
  }

  // GET by path content: GET /me/drive/items/{folderId}:/{seg1}/.../{lastSeg}:/content
  // Must come BEFORE the bare-metadata byPath handler below (`segments[3]
  // endsWith ":"`, no trailing-colon requirement on the last segment),
  // otherwise that handler greedily matches `/.../{lastSeg}:/content`
  // and tries to look up a file literally called "content".
  if (
    method === "GET" &&
    segments.length >= 6 &&
    segments[3]?.endsWith(":") &&
    segments[segments.length - 1] === "content" &&
    segments[segments.length - 2]?.endsWith(":")
  ) {
    const folderId = decodeURIComponent(segments[3].slice(0, -1));
    const nameSegs = segments.slice(4, -1);
    const relativeSegments = nameSegs.map((s, i, arr) => {
      const raw = i === arr.length - 1 && s.endsWith(":") ? s.slice(0, -1) : s;
      return decodeURIComponent(raw);
    });
    const folderExists =
      state.driveFolderChildren.has(folderId) ||
      state.driveRootChildren.some((i) => i.id === folderId);
    if (!folderExists) {
      errorResponse(res, 404, "itemNotFound", `folder ${folderId} not found`);
      return true;
    }
    let cursor = folderId;
    let resolved: MockDriveFile | undefined;
    for (let i = 0; i < relativeSegments.length; i++) {
      const segName = relativeSegments[i] ?? "";
      const segLower = segName.toLowerCase();
      const children = state.driveFolderChildren.get(cursor) ?? [];
      const match = children.find((c) => c.name.toLowerCase() === segLower);
      if (match === undefined) {
        errorResponse(
          res,
          404,
          "itemNotFound",
          `path segment "${segName}" not found under ${cursor}`,
        );
        return true;
      }
      if (i === relativeSegments.length - 1) {
        resolved = match;
      } else {
        cursor = match.id;
      }
    }
    if (resolved?.content === undefined) {
      errorResponse(res, 404, "itemNotFound", "no content for resolved byPath item");
      return true;
    }
    const body = resolved.content;
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(body, "utf-8")),
    });
    res.end(body);
    return true;
  }

  // GET by path: GET /me/drive/items/{folderId}:/{seg1}/{seg2}/.../{lastSeg}[:]
  // Walks children from `folderId` matching each segment by exact name.
  // Used by the collab v1 §4.6 scope-resolution algorithm. Returns the
  // resolved drive item via `driveItemView` so `parentReference.id /
  // .driveId / .path` plus optional `remoteItem` are populated.
  //
  // The trailing `:` on the last segment is optional — Graph accepts
  // both `/{folder-id}:/path/to/file` (bare metadata form, used by
  // `readSentinel` / `readLeases`) and `/{folder-id}:/path/to/file:`
  // (separator form, used when chaining `:/content` etc.).
  if (method === "GET" && segments.length >= 5 && segments[3]?.endsWith(":")) {
    const lastIdx = segments.length - 1;
    const lastSeg = segments[lastIdx] ?? "";
    const lastEndsWithColon = lastSeg.endsWith(":");
    // Reject when the URL still has more segments after a `path:` —
    // e.g. `:/content` is handled by other branches below.
    if (!lastEndsWithColon) {
      // Bare metadata form: every segment after segments[3] is part of the relative path.
    }
    const folderId = decodeURIComponent(segments[3].slice(0, -1));
    const relativeSegments = segments.slice(4).map((s, i, arr) => {
      const raw = i === arr.length - 1 && s.endsWith(":") ? s.slice(0, -1) : s;
      return decodeURIComponent(raw);
    });
    const folderExists =
      state.driveFolderChildren.has(folderId) ||
      state.driveRootChildren.some((i) => i.id === folderId);
    if (!folderExists) {
      errorResponse(res, 404, "itemNotFound", `folder ${folderId} not found`);
      return true;
    }
    let cursor = folderId;
    let resolved: MockDriveFile | undefined;
    for (let i = 0; i < relativeSegments.length; i++) {
      const segName = relativeSegments[i] ?? "";
      const segLower = segName.toLowerCase();
      const children = state.driveFolderChildren.get(cursor) ?? [];
      // Real OneDrive byPath resolution is case-insensitive — it returns
      // the stored item even when the agent's path differs in case. The
      // §4.6 case-aliasing defence in `src/collab/scope.ts` is what
      // catches the resulting mismatch on the way back. We mirror that
      // behaviour here so test 08's case-aliasing row exercises the
      // post-resolution check rather than failing at lookup.
      const match = children.find((c) => c.name.toLowerCase() === segLower);
      if (match === undefined) {
        errorResponse(
          res,
          404,
          "itemNotFound",
          `path segment "${segName}" not found under ${cursor}`,
        );
        return true;
      }
      if (i === relativeSegments.length - 1) {
        resolved = match;
      } else {
        cursor = match.id;
      }
    }
    if (resolved === undefined) {
      errorResponse(res, 404, "itemNotFound", "empty relative path");
      return true;
    }
    jsonResponse(res, 200, driveItemView(resolved, state));
    return true;
  }

  // Upload by path: PUT /me/drive/items/{folderId}:/{fileName}:/content
  // Segments look like: ["me","drive","items","{folderId}:","{fileName}:","content"]
  if (
    method === "PUT" &&
    segments.length === 6 &&
    segments[3]?.endsWith(":") &&
    segments[4]?.endsWith(":") &&
    segments[5] === "content"
  ) {
    const folderId = decodeURIComponent(segments[3].slice(0, -1));
    const fileName = decodeURIComponent(segments[4].slice(0, -1));
    await handleUploadByPath(state, req, res, folderId, fileName, parsed);
    return true;
  }

  // Update by id: PUT /me/drive/items/{itemId}/content (honours If-Match)
  if (
    method === "PUT" &&
    segments.length === 5 &&
    segments[4] === "content" &&
    segments[3] !== undefined &&
    !segments[3].endsWith(":")
  ) {
    const itemIdRaw = decodeURIComponent(segments[3]);
    await handleUpdateById(state, req, res, itemIdRaw);
    return true;
  }

  // {itemId} path segment may contain no colon (plain ID lookup).
  const itemSegment = segments[3] ?? "";
  const itemId = decodeURIComponent(itemSegment);

  // GET /me/drive/items/{id}
  if (method === "GET" && segments.length === 4) {
    const item = state.findDriveItem(itemId);
    if (!item) {
      errorResponse(res, 404, "itemNotFound", `item ${itemId} not found`);
      return true;
    }
    // Route through driveItemView for files AND folders so the response
    // matches the wire shape (no in-memory `content` field) and so the
    // §4.6 ancestry walk in `src/collab/scope.ts` gets a populated
    // `parentReference.{id,driveId}` for the parent folders it climbs.
    jsonResponse(res, 200, driveItemView(item as MockDriveFile, state));
    return true;
  }

  // GET /me/drive/items/{id}/content
  if (method === "GET" && segments.length === 5 && segments[4] === "content") {
    const file = findMockFile(state, itemId);
    if (file?.content === undefined) {
      errorResponse(res, 404, "itemNotFound", `item ${itemId} not found`);
      return true;
    }
    const body = file.content;
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(body, "utf-8")),
    });
    res.end(body);
    return true;
  }

  // GET /me/drive/items/{id}/children
  if (method === "GET" && segments.length === 5 && segments[4] === "children") {
    const children = state.driveFolderChildren.get(itemId) ?? [];
    // Strip in-memory content from responses so the wire shape matches Graph's DriveItem.
    const all = children.map((f) => driveItemView(f, state));
    jsonResponse(
      res,
      200,
      paginate(state, parsed, `/me/drive/items/${encodeURIComponent(itemId)}/children`, all),
    );
    return true;
  }

  // GET /me/drive/items/{id}/versions
  if (method === "GET" && segments.length === 5 && segments[4] === "versions") {
    const file = findMockFile(state, itemId);
    // Trigger lazy version assignment so the current version ID is populated.
    if (file) driveItemView(file, state);
    const historical = state.driveItemVersions.get(itemId) ?? [];
    // Real OneDrive includes the current version as the first (newest) entry.
    const currentEntry: MockDriveItemVersion[] =
      file?.version !== undefined
        ? [
            {
              id: file.version,
              lastModifiedDateTime: file.lastModifiedDateTime,
              size: file.size,
              lastModifiedBy: { user: { displayName: "Mock User" } },
              content: "",
            },
          ]
        : [];
    const value = [...currentEntry, ...historical].map((v) => driveItemVersionView(v));
    jsonResponse(res, 200, { value });
    return true;
  }

  // GET /me/drive/items/{id}/versions/{versionId}/content
  if (
    method === "GET" &&
    segments.length === 7 &&
    segments[4] === "versions" &&
    segments[6] === "content"
  ) {
    const versionId = decodeURIComponent(segments[5] ?? "");
    const file = findMockFile(state, itemId);
    // Trigger lazy version assignment so we can compare the current version ID.
    if (file) driveItemView(file, state);
    // Real OneDrive rejects content downloads for the current version via this
    // endpoint (HTTP 400 "invalidRequest").
    if (file?.version !== undefined && file.version === versionId) {
      errorResponse(
        res,
        400,
        "invalidRequest",
        "You cannot get the content of the current version.",
      );
      return true;
    }
    const versions = state.driveItemVersions.get(itemId) ?? [];
    const match = versions.find((v) => v.id === versionId);
    if (!match) {
      errorResponse(res, 404, "itemNotFound", `version ${versionId} of item ${itemId} not found`);
      return true;
    }
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(match.content, "utf-8")),
    });
    res.end(match.content);
    return true;
  }

  // POST /me/drive/items/{folderId}/children — create a child folder.
  // Used by the collab `session_init_project` flow to create the
  // `.collab/` subfolder under the chosen project root. Honours
  // `@microsoft.graph.conflictBehavior=fail` (409 on collision) so the
  // init flow can race deterministically against a concurrent
  // initialiser.
  if (method === "POST" && segments.length === 5 && segments[4] === "children") {
    const parentId = decodeURIComponent(segments[3] ?? "");
    const parentExists =
      state.driveFolderChildren.has(parentId) ||
      state.driveRootChildren.some((i) => i.id === parentId);
    if (!parentExists) {
      errorResponse(res, 404, "itemNotFound", `folder ${parentId} not found`);
      return true;
    }
    const raw = await readBody(req);
    let payload: { name?: string; folder?: object; "@microsoft.graph.conflictBehavior"?: string };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      errorResponse(res, 400, "invalidRequest", "request body is not valid JSON");
      return true;
    }
    if (typeof payload.name !== "string" || payload.name.length === 0) {
      errorResponse(res, 400, "invalidRequest", "name is required");
      return true;
    }
    if (payload.folder === undefined) {
      errorResponse(res, 400, "invalidRequest", "folder facet is required");
      return true;
    }
    const existing = state.driveFolderChildren.get(parentId) ?? [];
    const collide = existing.find((c) => c.name.toLowerCase() === payload.name?.toLowerCase());
    if (collide && payload["@microsoft.graph.conflictBehavior"] === "fail") {
      errorResponse(
        res,
        409,
        "nameAlreadyExists",
        `An item with the name "${payload.name}" already exists in this folder.`,
      );
      return true;
    }
    if (collide) {
      jsonResponse(res, 200, {
        id: collide.id,
        name: collide.name,
        folder: collide.folder ?? { childCount: 0 },
      });
      return true;
    }
    const newId = state.genId();
    const created: MockDriveFile = {
      id: newId,
      name: payload.name,
      folder: { childCount: 0 },
      lastModifiedDateTime: new Date().toISOString(),
    };
    existing.push(created);
    state.driveFolderChildren.set(parentId, existing);
    // Register the new folder so subsequent uploads / listings can target it
    // by id (mirroring what real OneDrive does once a folder is created).
    state.driveFolderChildren.set(newId, []);
    jsonResponse(res, 201, {
      id: created.id,
      name: created.name,
      folder: created.folder,
      lastModifiedDateTime: created.lastModifiedDateTime,
    });
    return true;
  }

  // DELETE /me/drive/items/{id}
  if (method === "DELETE" && segments.length === 4) {
    const parentId = state.findParentFolderId(itemId);
    if (parentId !== null) {
      const files = state.driveFolderChildren.get(parentId) ?? [];
      const idx = files.findIndex((f) => f.id === itemId);
      if (idx !== -1) {
        files.splice(idx, 1);
        state.driveFolderChildren.set(parentId, files);
        res.writeHead(204);
        res.end();
        return true;
      }
    }
    // Also allow deleting top-level root items
    const rootIdx = state.driveRootChildren.findIndex((i) => i.id === itemId);
    if (rootIdx !== -1) {
      state.driveRootChildren.splice(rootIdx, 1);
      res.writeHead(204);
      res.end();
      return true;
    }
    errorResponse(res, 404, "itemNotFound", `item ${itemId} not found`);
    return true;
  }

  // GET /me/drive/sharedWithMe relocated above the `items`-or-bail guard
  // (was unreachable here).

  return false;
}

function findMockFile(state: MockState, itemId: string): MockDriveFile | undefined {
  for (const files of state.driveFolderChildren.values()) {
    const match = files.find((f) => f.id === itemId);
    if (match) return match;
  }
  return undefined;
}

function driveItemView(file: MockDriveFile, state?: MockState): DriveItem {
  // Lazily assign a cTag / version on first view if the seed didn't set one.
  // Real Graph always returns a cTag for files; tests that don't care about
  // specific values shouldn't have to set them explicitly. We still maintain
  // an internal `file.version` so the `/versions` endpoint can surface a
  // stable current-revision ID — but, mirroring real OneDrive, this internal
  // version is NOT included in the returned drive item (real Graph commonly
  // omits the `version` field on `GET /me/drive/items/{id}` even when the
  // file has a meaningful version history).
  if (file.cTag === undefined && file.file !== undefined && state !== undefined) {
    file.cTag = state.genCTag(file.id);
  }
  if (file.version === undefined && file.file !== undefined && state !== undefined) {
    file.version = state.genVersionId();
  }
  // Compute parentReference the same way real Graph does: locate the
  // folder this item belongs to and emit `/drive/root:/<…>` plus the
  // parent's opaque id and the drive id. Items that exist directly at
  // the drive root yield `/drive/root:`. Nested folders walk back up
  // the parent chain so deep paths (e.g. `attachments/sub/sub2/foo.png`)
  // surface a correct path and `parentReference.id`.
  //
  // Test fixtures may set `file.parentReference` explicitly to simulate
  // a cooperator-attacked or cross-drive item — those values win over
  // the computed default so the §4.6 defence-in-depth checks
  // (`cross_drive` etc.) can be exercised.
  let parentReference: { path: string; id?: string; driveId?: string } | undefined;
  if (state !== undefined) {
    if (state.driveRootChildren.some((c) => c.id === file.id)) {
      parentReference = { path: "/drive/root:", driveId: state.drive.id };
    } else {
      for (const [folderId, children] of state.driveFolderChildren) {
        if (children.some((c) => c.id === file.id)) {
          const ancestorPath = buildAncestorPath(state, folderId);
          parentReference = {
            path: ancestorPath,
            id: folderId,
            driveId: state.drive.id,
          };
          break;
        }
      }
    }
    // Honour fixture-supplied overrides on top of the computed default
    // so tests can simulate cross-drive / custom-parent items.
    if (file.parentReference !== undefined) {
      parentReference = {
        ...(parentReference ?? { path: "" }),
        ...file.parentReference,
      };
    }
  }
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    cTag: file.cTag,
    // Intentionally NOT exposing `file.version` here — see note above.
    lastModifiedDateTime: file.lastModifiedDateTime,
    file: file.file,
    folder: file.folder,
    webUrl: file.webUrl,
    parentReference: parentReference ?? file.parentReference,
    remoteItem: file.remoteItem,
  };
}

/**
 * Walk the folder chain backwards from `folderId` until we hit a root-
 * level folder (or run out). Returns the `/drive/root:/<a>/<b>` path
 * real Graph populates on `parentReference.path`. Used by
 * {@link driveItemView}.
 */
function buildAncestorPath(state: MockState, folderId: string): string {
  const names: string[] = [];
  let cursor: string | null = folderId;
  // Bound the walk to defend against accidentally cyclic test fixtures.
  for (let hop = 0; hop < 32 && cursor !== null; hop++) {
    const rootMatch = state.driveRootChildren.find((c) => c.id === cursor);
    if (rootMatch !== undefined) {
      names.unshift(rootMatch.name);
      return names.length === 0 ? "/drive/root:" : `/drive/root:/${names.join("/")}`;
    }
    let nextCursor: string | null = null;
    for (const [parentId, children] of state.driveFolderChildren) {
      const match = children.find((c) => c.id === cursor);
      if (match !== undefined) {
        names.unshift(match.name);
        nextCursor = parentId;
        break;
      }
    }
    cursor = nextCursor;
  }
  return names.length === 0 ? "/drive/root:" : `/drive/root:/${names.join("/")}`;
}

function driveItemVersionView(v: MockDriveItemVersion): DriveItemVersion {
  // Strip the in-memory content from wire responses so tests exercise the
  // same shape the real Graph API returns: content is only available via
  // the /content sub-resource, not the list.
  return {
    id: v.id,
    lastModifiedDateTime: v.lastModifiedDateTime,
    size: v.size,
    lastModifiedBy: v.lastModifiedBy,
  };
}

async function handleUploadByPath(
  state: MockState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  folderId: string,
  fileName: string,
  parsed: URL,
): Promise<void> {
  // Require folder to exist (either as a root child or as a registered folder).
  const folderExists =
    state.driveFolderChildren.has(folderId) ||
    state.driveRootChildren.some((i) => i.id === folderId);
  if (!folderExists) {
    errorResponse(res, 404, "itemNotFound", `folder ${folderId} not found`);
    return;
  }

  const content = await readRawBody(req);
  const bytes = Buffer.byteLength(content, "utf-8");
  const now = new Date().toISOString();

  const existing = state.driveFolderChildren.get(folderId) ?? [];
  const existingFile = existing.find((f) => f.name.toLowerCase() === fileName.toLowerCase());

  // Honour @microsoft.graph.conflictBehavior=fail (used by markdown_create_file
  // to make create-vs-update an explicit, server-enforced distinction).
  const conflictBehavior = parsed.searchParams.get("@microsoft.graph.conflictBehavior");
  if (conflictBehavior === "fail" && existingFile) {
    errorResponse(
      res,
      409,
      "nameAlreadyExists",
      `An item with the name "${fileName}" already exists in this folder.`,
    );
    return;
  }

  let file: MockDriveFile;
  let status: number;
  if (existingFile) {
    // Snapshot the previous content as a historical version before
    // overwriting, so tests for markdown_list_file_versions /
    // markdown_get_file_version see OneDrive-like behaviour. The snapshot
    // carries the prior state's `version` ID so the agent can round-trip
    // between the revision it read and the entry in the /versions list.
    if (existingFile.content !== undefined) {
      const priorVersionId = existingFile.version ?? state.genVersionId();
      const prior: MockDriveItemVersion = {
        id: priorVersionId,
        lastModifiedDateTime: existingFile.lastModifiedDateTime ?? now,
        size: existingFile.size,
        content: existingFile.content,
        lastModifiedBy: { user: { displayName: "Mock User" } },
      };
      const history = state.driveItemVersions.get(existingFile.id) ?? [];
      // Newest first — unshift the prior content.
      history.unshift(prior);
      state.driveItemVersions.set(existingFile.id, history);
    }
    existingFile.content = content;
    existingFile.size = bytes;
    existingFile.lastModifiedDateTime = now;
    existingFile.cTag = state.genCTag(existingFile.id);
    existingFile.version = state.genVersionId();
    file = existingFile;
    status = 200;
  } else {
    const id = state.genId();
    file = {
      id,
      name: fileName,
      size: bytes,
      lastModifiedDateTime: now,
      cTag: state.genCTag(id),
      version: state.genVersionId(),
      file: { mimeType: "text/markdown" },
      content,
    };
    existing.push(file);
    state.driveFolderChildren.set(folderId, existing);
    status = 201;
  }

  jsonResponse(res, status, driveItemView(file));
}

/**
 * Update by id: `PUT /me/drive/items/{id}/content` with `If-Match` carrying
 * the file's `cTag` for content-only optimistic concurrency. Returns 412
 * when the supplied cTag doesn't match the current one. Used by
 * `markdown_update_file`.
 */
async function handleUpdateById(
  state: MockState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  itemId: string,
): Promise<void> {
  const file = findMockFile(state, itemId);
  if (!file) {
    errorResponse(res, 404, "itemNotFound", `item ${itemId} not found`);
    return;
  }

  const ifMatch = headerValue(req, "if-match");
  if (ifMatch === null) {
    errorResponse(
      res,
      400,
      "invalidRequest",
      "If-Match header is required for PUT /items/{id}/content in this mock.",
    );
    return;
  }
  if (ifMatch !== file.cTag) {
    errorResponse(
      res,
      412,
      "etagMismatch",
      `If-Match cTag ${ifMatch} does not match current ${file.cTag ?? "(none)"}`,
    );
    return;
  }

  const content = await readRawBody(req);
  const bytes = Buffer.byteLength(content, "utf-8");
  const now = new Date().toISOString();

  // Snapshot previous content before overwriting. Carry the prior state's
  // `version` ID into the history list so the agent can round-trip between
  // the revision it read and the entry in /versions.
  if (file.content !== undefined) {
    const priorVersionId = file.version ?? state.genVersionId();
    const prior: MockDriveItemVersion = {
      id: priorVersionId,
      lastModifiedDateTime: file.lastModifiedDateTime ?? now,
      size: file.size,
      content: file.content,
      lastModifiedBy: { user: { displayName: "Mock User" } },
    };
    const history = state.driveItemVersions.get(file.id) ?? [];
    history.unshift(prior);
    state.driveItemVersions.set(file.id, history);
  }

  file.content = content;
  file.size = bytes;
  file.lastModifiedDateTime = now;
  file.cTag = state.genCTag(file.id);
  file.version = state.genVersionId();

  jsonResponse(res, 200, driveItemView(file));
}

function headerValue(req: http.IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return v[0];
  return null;
}
