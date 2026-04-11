---
description: "Improve code quality, apply security best practices, and enhance design whilst maintaining green vitest tests. Customized for graphdo-ts conventions."
name: "TDD Refactor Phase - Improve Quality"
tools:
  [
    "github",
    "findTestFiles",
    "edit/editFiles",
    "runTests",
    "runCommands",
    "codebase",
    "search",
    "problems",
    "terminalLastCommand",
  ]
---

# TDD Refactor Phase - Improve Quality (graphdo-ts)

Clean up code, apply best practices, and enhance design whilst keeping all vitest tests green.

Always read `AGENTS.md` before refactoring — it defines conventions that must be preserved after every change.

## Core Principles

- **Tests must stay green** — run `npm run test` after every change
- **Preserve behaviour** — same inputs must produce same outputs
- **Small incremental steps** — one improvement at a time
- **Follow project conventions** — refer to `AGENTS.md` for all patterns

## Code Quality Improvements

### Apply Early Returns

```typescript
// BEFORE — nested
async function handler({ id }: { id: string }) {
  try {
    const token = await config.authenticator.token();
    if (token) {
      const client = new GraphClient(config.graphBaseUrl, token);
      const result = await getResource(client, id);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  } catch { ... }
}

// AFTER — early return
async function handler({ id }: { id: string }) {
  try {
    const token = await config.authenticator.token();
    const client = new GraphClient(config.graphBaseUrl, token);
    const result = await getResource(client, id);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("handler failed", { error: message });
    return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
  }
}
```

### Eliminate Duplication

Extract repeated patterns into shared helpers in `src/graph/` or `src/tools/`. Preserve the `ServerConfig` injection pattern — never introduce globals.

### Improve Naming

- Use descriptive names that express intent
- Tool names: `snake_case` (e.g., `todo_create`, `mail_send`)
- Internal functions: `camelCase`
- Interfaces: `PascalCase`

## TypeScript Best Practices

### Strict Null Safety

```typescript
// Correct — handle undefined from noUncheckedIndexedAccess
const first = items[0];
if (first === undefined) return;

// Wrong — TypeScript will reject this
const first = items[0]!; // non-null assertion is a code smell here
```

### Type Safety for API Responses

```typescript
// Correct — type the generic parameter explicitly
const result = await client.request<TodoTask>("GET", path);

// Avoid — loses type safety
const result = await client.request("GET", path);
```

### Remove Unnecessary Type Assertions

```typescript
// Avoid
const id = (response as { id: string }).id;

// Correct — model the type properly in types.ts
const result = await client.request<{ id: string }>("GET", path);
const { id } = result;
```

## Security Hardening During Refactor

- **Error messages**: Return `error.message` (structured by `GraphRequestError`), never raw `error.graphMessage` alone
- **No token logging**: Ensure `logger.*` calls never include token values
- **File permissions**: Verify `mode: 0o600` for cache files written in `src/config.ts`
- **Input validation**: Verify zod schemas include `.min(1)` for string IDs used in URL paths

## Test Quality Improvements

### Simplify Test Setup

```typescript
// BEFORE — manual setup
const server = new node.http.Server();
// ... 20 lines of setup

// AFTER — use the helper
const { graphState, graphBaseUrl, cleanup } = await createTestEnv();
```

### Add Missing Edge Case Tests

Common gaps to check:

- Unauthenticated call (mock auth with no token, verify `isError: true`)
- Graph API 404 response
- Graph API 429 / 500 response
- Empty list / empty result set
- Maximum field length inputs

### Test Naming Clarity

```typescript
// Vague
it("works correctly");

// Clear
it("returns isError when the Graph API responds with 404");
it("creates the task and returns the new task id on success");
```

## Linting & Type Checking

```bash
npm run lint        # ESLint strict + stylistic — must pass with zero warnings
npm run typecheck   # tsc --noEmit — must pass with zero errors
npm run test        # vitest — all tests must stay green
npm run check       # all three combined — run this before committing
```

## Refactor Phase Checklist

- [ ] All tests remain green (`npm run test`)
- [ ] `npm run check` passes (lint + typecheck + test)
- [ ] No `any` types introduced
- [ ] All imports use `.js` extensions
- [ ] No new dependencies added
- [ ] Error handling follows the try/catch pattern (tools never throw)
- [ ] Structured logging used (no `console.log`)
- [ ] Atomic writes preserved in config operations
- [ ] Code duplication reduced without changing behaviour
- [ ] Tests updated if public interfaces changed (while preserving test intent)
