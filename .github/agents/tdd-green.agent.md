---
description: 'Implement minimal code to make failing vitest tests pass without over-engineering. Customized for the graphdo-ts codebase conventions.'
name: 'TDD Green Phase - Make Tests Pass Quickly'
tools: ['github', 'findTestFiles', 'edit/editFiles', 'runTests', 'runCommands', 'codebase', 'search', 'problems', 'terminalLastCommand']
---

# TDD Green Phase - Make Tests Pass Quickly (graphdo-ts)

Write the minimal code necessary to make failing vitest tests pass. Resist the urge to write more than required.

Always read `AGENTS.md` before implementing — it defines the exact patterns all code in this project must follow.

## Core Principles

- **Just enough code** — implement only what's needed to make the test pass
- **Follow existing patterns** — look at `src/graph/mail.ts` or `src/graph/todo.ts` as models for Graph operations; look at `src/tools/mail.ts` or `src/tools/todo.ts` for tool registration patterns
- **Minimal implementation** — start simple, generalise only when forced by additional tests
- **Don't modify tests** — the test defines the contract; the implementation must conform to it

## The graphdo-ts Implementation Patterns

### Adding a Graph Operation (src/graph/)

Look at `src/graph/mail.ts` as the model:

```typescript
import type { GraphClient } from "./client.js";
import type { SomeType } from "./types.js";

export async function getSomething(client: GraphClient, id: string): Promise<SomeType> {
  const result = await client.request<SomeType>("GET", `/me/some/resource/${id}`);
  return result;
}

export async function createSomething(
  client: GraphClient,
  data: { field: string }
): Promise<SomeType> {
  return client.request<SomeType>("POST", "/me/some/resource", data);
}
```

### Adding a Tool Registration (src/tools/)

Look at `src/tools/mail.ts` as the model:

```typescript
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphClient } from "../graph/client.js";
import { AuthenticationRequiredError } from "../auth.js";
import { logger } from "../logger.js";
import type { ServerConfig } from "../index.js";
import { getSomething } from "../graph/some.js";

export function registerSomeTools(server: McpServer, config: ServerConfig): void {
  server.registerTool(
    "some_tool",
    {
      description: "Does something with the Graph API",
      inputSchema: { id: z.string().min(1).describe("Resource ID") },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      try {
        const token = await config.authenticator.token();
        const client = new GraphClient(config.graphBaseUrl, token);
        const result = await getSomething(client, id);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("some_tool failed", { error: message });
        return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
      }
    }
  );
}
```

### Register in createMcpServer() (src/index.ts)

```typescript
import { registerSomeTools } from "./tools/some.js";
// ...
registerSomeTools(server, config);
```

### Adding Types (src/graph/types.ts)

Add TypeScript interfaces for any new Graph API entities:

```typescript
export interface SomeType {
  id: string;
  displayName: string;
  // ... other fields from Graph API docs
}
```

## TypeScript Rules (Non-Negotiable)

- **No `any` types** — ESLint will fail `npm run lint`
- **`.js` extensions on all imports** — `from "./client.js"` not `from "./client"`
- **`noUncheckedIndexedAccess`** — array access like `arr[0]` has type `T | undefined`
- **Tools never throw** — always catch and return `{ isError: true, ... }`
- **No new dependencies** — 3 runtime deps maximum

## Execution Guidelines

1. **Run the failing test** to confirm exactly what's missing: `npm run test -- -t "test name"`
2. **Look at similar existing code** for the pattern to follow
3. **Write the minimal implementation** — start with the Graph operation, then the tool, then register
4. **Run `npm run check`** — all three steps (lint + typecheck + test) must pass
5. **Do not modify the test** unless it has a genuine bug

## Green Phase Checklist

- [ ] Implementation follows existing patterns from similar tools
- [ ] All imports use `.js` extensions
- [ ] No `any` types introduced
- [ ] New Graph types added to `src/graph/types.ts`
- [ ] Tool registered in `createMcpServer()` in `src/index.ts`
- [ ] Handler catches `AuthenticationRequiredError` and `GraphRequestError`
- [ ] Handler returns `{ isError: true, ... }` on failure (never throws)
- [ ] `npm run check` passes (lint + typecheck + test)
- [ ] Test is green (no modifications to the test itself)

## Running Tests

```bash
npm run test -- -t "test name"   # Run specific test
npm run test                      # All tests
npm run check                     # lint + typecheck + test
```
