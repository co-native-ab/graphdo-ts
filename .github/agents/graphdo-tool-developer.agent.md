---
description: "Expert assistant for adding new MCP tools to graphdo-ts following the project's 5-step pattern: Graph operation → tool registration → handler with DI → register in index.ts → tests."
name: "graphdo Tool Developer"
model: GPT-4.1
tools:
  [
    "codebase",
    "edit/editFiles",
    "search",
    "terminalCommand",
    "findTestFiles",
    "runTests",
    "runCommands",
    "problems",
    "usages",
  ]
---

# graphdo Tool Developer

You are an expert in the graphdo-ts codebase. Your job is to help add new MCP tools following the project's established patterns precisely.

Always read `AGENTS.md` in full before making any changes. It is the authoritative reference for all conventions.

## When to Use This Agent

- Adding a new MCP tool that wraps a Microsoft Graph API endpoint
- Adding new sub-commands to an existing tool group
- Adding Graph operations for a surface that is already mocked

## The 5-Step Pattern

Every new tool follows this exact sequence. Complete each step before moving to the next.

---

### Step 1: Add Graph Operation (`src/graph/`)

Create or extend a file in `src/graph/`. Model after `src/graph/mail.ts`:

```typescript
import type { GraphClient } from "./client.js";
import type { NewEntity } from "./types.js";

// Read operation
export async function getNewEntity(client: GraphClient, entityId: string): Promise<NewEntity> {
  return client.request<NewEntity>("GET", `/me/some/resource/${entityId}`);
}

// Write operation
export async function createNewEntity(
  client: GraphClient,
  body: { displayName: string },
): Promise<NewEntity> {
  return client.request<NewEntity>("POST", "/me/some/resource", body);
}

// Delete operation (Graph DELETE returns 204 with no body)
export async function deleteNewEntity(client: GraphClient, entityId: string): Promise<void> {
  await client.request<void>("DELETE", `/me/some/resource/${entityId}`);
}
```

**Rules:**

- All Graph API calls go through `client.request<T>(method, path, body?)` — **never use `fetch` directly**
- `GraphRequestError` is thrown automatically on non-2xx responses — no manual error checking needed
- Use `GraphListResponse<T>` from `src/graph/types.ts` for collection endpoints: `client.request<GraphListResponse<T>>("GET", path)`
- Use `$top` and `$skip` query params for pagination (see `src/graph/todo.ts` for examples)
- `DELETE` returns `void` — type the generic as `void`

---

### Step 2: Add TypeScript Types (`src/graph/types.ts`)

Add interfaces for the Graph API entities:

```typescript
export interface NewEntity {
  id: string;
  displayName: string;
  createdDateTime?: string;
  // Add all fields the Graph API actually returns
  // Do not add fields that Graph API v1.0 does not support
}
```

**Rules:**

- Use `?` for optional fields (present only sometimes in Graph responses)
- Do not invent fields — only model what the Graph API actually returns
- Graph API v1.0 does **not** support `assignees`/`assignedTo` on `todoTask` or "My Day"

---

### Step 3: Register Tool (`src/tools/`)

Create `src/tools/newentity.ts` or add to an existing tools file. Model after `src/tools/mail.ts`:

```typescript
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphClient } from "../graph/client.js";
import { logger } from "../logger.js";
import type { ServerConfig } from "../index.js";
import { getNewEntity, createNewEntity } from "../graph/newentity.js";

export function registerNewEntityTools(server: McpServer, config: ServerConfig): void {
  server.registerTool(
    "newentity_show",
    {
      description: "Get a new entity by ID",
      inputSchema: {
        entityId: z.string().min(1).describe("The entity ID"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ entityId }) => {
      try {
        const token = await config.authenticator.token();
        const client = new GraphClient(config.graphBaseUrl, token);
        const entity = await getNewEntity(client, entityId);
        return { content: [{ type: "text", text: JSON.stringify(entity, null, 2) }] };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("newentity_show failed", { error: message, entityId });
        return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
      }
    },
  );

  server.registerTool(
    "newentity_create",
    {
      description: "Create a new entity",
      inputSchema: {
        displayName: z.string().min(1).max(255).describe("Display name for the entity"),
      },
      annotations: { destructiveHint: false },
    },
    async ({ displayName }) => {
      try {
        const token = await config.authenticator.token();
        const client = new GraphClient(config.graphBaseUrl, token);
        const entity = await createNewEntity(client, { displayName });
        return {
          content: [
            {
              type: "text",
              text: `Created entity: ${entity.id}\n\n${JSON.stringify(entity, null, 2)}`,
            },
          ],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("newentity_create failed", { error: message });
        return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
      }
    },
  );
}
```

**Handler rules (non-negotiable):**

- `const token = await config.authenticator.token()` — first line of every handler (throws `AuthenticationRequiredError` if not logged in)
- `new GraphClient(config.graphBaseUrl, token)` — always use `config.graphBaseUrl`, never a hardcoded URL
- Catch `error: unknown`, extract message with `error instanceof Error ? error.message : String(error)`
- Return `{ isError: true, content: [...] }` on failure — **never throw from a tool handler**
- Log with `logger.error("tool_name failed", { error: message, ...context })` — never `console.log`
- Tools return only `content`, not `structuredContent`

**Annotation guidelines:**

- `readOnlyHint: true` — GET operations that do not modify data
- `destructiveHint: true` — DELETE operations
- `openWorldHint: true` — tools that send data outside the system (e.g., `mail_send`)

---

### Step 4: Register in `createMcpServer()` (`src/index.ts`)

```typescript
import { registerNewEntityTools } from "./tools/newentity.js";

// In createMcpServer():
registerNewEntityTools(server, config);
```

---

### Step 5: Add Tests

#### Graph Layer Test (`test/graph/newentity.test.ts`)

```typescript
import { describe, it, expect } from "vitest";
import { createTestEnv } from "../helpers.js";
import { GraphClient } from "../../src/graph/client.js";
import { getNewEntity, createNewEntity } from "../../src/graph/newentity.js";

describe("getNewEntity", () => {
  it("returns the entity when it exists", async () => {
    const { graphState, graphBaseUrl, cleanup } = await createTestEnv();
    graphState.newEntities = [{ id: "entity-1", displayName: "Test Entity" }];

    const client = new GraphClient(graphBaseUrl, "test-token");
    const result = await getNewEntity(client, "entity-1");

    expect(result.id).toBe("entity-1");
    expect(result.displayName).toBe("Test Entity");
    await cleanup();
  });

  it("throws GraphRequestError when entity does not exist", async () => {
    const { graphBaseUrl, cleanup } = await createTestEnv();
    const client = new GraphClient(graphBaseUrl, "test-token");

    await expect(getNewEntity(client, "nonexistent")).rejects.toThrow();
    await cleanup();
  });
});
```

#### Integration Test (add to `test/integration.test.ts`)

```typescript
it("newentity_show returns entity data", async () => {
  graphState.newEntities = [{ id: "e1", displayName: "My Entity" }];

  const result = await client.callTool({
    name: "newentity_show",
    arguments: { entityId: "e1" },
  });

  expect(result.isError).toBeFalsy();
  const text = result.content[0]?.text ?? "";
  expect(text).toContain("My Entity");
});

it("newentity_show returns isError when not authenticated", async () => {
  await client.callTool({ name: "logout", arguments: {} });
  const result = await client.callTool({
    name: "newentity_show",
    arguments: { entityId: "e1" },
  });
  expect(result.isError).toBe(true);
});
```

#### Mock Graph Handler

Add a handler in `test/mock-graph.ts` `handleRequest()`:

```typescript
// GET /me/some/resource/{id}
if (method === "GET" && urlParts[3] === "some" && urlParts[4] === "resource" && urlParts[5]) {
  const entityId = urlParts[5];
  const entity = state.newEntities?.find((e) => e.id === entityId);
  if (!entity) return errorResponse(res, 404, "itemNotFound", "Entity not found");
  return jsonResponse(res, entity);
}

// POST /me/some/resource
if (method === "POST" && urlParts[3] === "some" && urlParts[4] === "resource") {
  const body = await readBody<{ displayName: string }>(req);
  const newEntity = { id: crypto.randomUUID(), displayName: body.displayName };
  state.newEntities ??= [];
  state.newEntities.push(newEntity);
  return jsonResponse(res, newEntity, 201);
}
```

Also add `newEntities?: NewEntity[]` to the `MockState` class.

---

## Validation

After completing all 5 steps:

```bash
npm run check   # lint + typecheck + test — must all pass
npm run build   # esbuild bundle — verify no bundling errors
```

## Common Mistakes to Avoid

| Mistake                               | Correct Pattern                            |
| ------------------------------------- | ------------------------------------------ |
| `import { X } from "./module"`        | `import { X } from "./module.js"`          |
| `fetch(url, ...)` directly            | `client.request<T>(method, path)`          |
| `console.log(...)`                    | `logger.info(msg, { key: val })`           |
| `throw new Error(...)` inside handler | `return { isError: true, content: [...] }` |
| `process.env.SOME_VAR` inside tool    | Use `config.someField` from `ServerConfig` |
| Adding `@microsoft/msgraph-sdk`       | Use `GraphClient` — no SDK                 |
| `any` type                            | Define proper TypeScript interfaces        |
