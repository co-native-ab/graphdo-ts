---
description: "Guide test-first development by writing failing vitest tests that describe desired behaviour before implementation exists. Customized for the graphdo-ts test architecture."
name: "TDD Red Phase - Write Failing Tests First"
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

# TDD Red Phase - Write Failing Tests First (graphdo-ts)

Focus on writing clear, specific failing tests that describe the desired behaviour before any implementation exists.

Always read `AGENTS.md` before writing tests — it documents the three-layer test architecture and all testing patterns for this project.

## Test Architecture

This project has three test layers. Choose the right layer before writing:

| Layer           | Location                                                              | When to Use                               | Setup                                     |
| --------------- | --------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------- |
| **Graph layer** | `test/graph/*.test.ts`                                                | Testing Graph API operations in isolation | `createTestEnv()` from `test/helpers.ts`  |
| **Component**   | `test/picker.test.ts`, `test/loopback.test.ts`, `test/config.test.ts` | Testing individual non-tool components    | Direct instantiation                      |
| **Integration** | `test/integration.test.ts`                                            | Testing full MCP tool round-trips         | `InMemoryTransport` + `Client.callTool()` |

## GitHub Issue Integration

- **Extract issue number** from branch name or context
- **Fetch issue details** to understand requirements and acceptance criteria
- **Extract edge cases** from issue discussion comments

## Core Principles

- **Write the test before the code** — never write production code without a failing test
- **One test at a time** — focus on a single behaviour
- **Fail for the right reason** — tests must fail due to missing implementation, not syntax/import errors
- **Use the right test layer** — most new tool behaviour should be an integration test

## Test Patterns

### Graph Layer Test Pattern

```typescript
import { describe, it, expect } from "vitest";
import { createTestEnv } from "../helpers.js";
import { GraphClient } from "../../src/graph/client.js";
import { someGraphOp } from "../../src/graph/some.js";

describe("someGraphOp", () => {
  it("returns expected data when resource exists", async () => {
    const { graphState, graphBaseUrl, cleanup } = await createTestEnv();
    // Arrange — seed mock state
    graphState.someResource = { id: "test-id", name: "Test" };

    // Act
    const client = new GraphClient(graphBaseUrl, "test-token");
    const result = await someGraphOp(client, "test-id");

    // Assert
    expect(result.id).toBe("test-id");
    expect(result.name).toBe("Test");
    await cleanup();
  });

  it("throws GraphRequestError when resource not found", async () => {
    const { graphBaseUrl, cleanup } = await createTestEnv();
    const client = new GraphClient(graphBaseUrl, "test-token");

    await expect(someGraphOp(client, "nonexistent")).rejects.toThrow("not found");
    await cleanup();
  });
});
```

### Integration Test Pattern

```typescript
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/index.js";
import { MockAuthenticator } from "../mock-auth.js";
import { MockState } from "../mock-graph.js";
import { createTestEnv } from "../helpers.js";

describe("tool_name", () => {
  it("returns expected result when called with valid input", async () => {
    const { graphState, graphBaseUrl, cleanup } = await createTestEnv();
    graphState.someData = { id: "abc", value: "test" };

    const auth = new MockAuthenticator({ browserLogin: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpServer = createMcpServer({
      authenticator: auth,
      graphBaseUrl,
      configDir: "/tmp/test-config",
      openBrowser: async () => {},
    });
    await mcpServer.connect(serverTransport);

    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);

    // Act — this call should fail until the tool is implemented
    const result = await client.callTool({ name: "tool_name", arguments: { id: "abc" } });

    // Assert
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain("test");

    await client.close();
    await cleanup();
  });
});
```

## Test Naming Convention

Use descriptive `describe`/`it` strings that read as sentences:

```typescript
describe("todo_create", () => {
  it("creates a task in the configured list and returns the new task id");
  it("returns isError when not authenticated");
  it("returns isError when the Graph API returns 404");
  it("creates a task with importance when importance param is provided");
});
```

## Execution Guidelines

1. **Fetch GitHub issue** — understand requirements and acceptance criteria
2. **Choose the test layer** — graph layer for pure Graph operations, integration for tool behaviour
3. **Write the simplest failing test** — one test at a time
4. **Run the test**: `npm run test -- -t "test name"` to confirm it fails
5. **Confirm it fails for the right reason** — `TypeError: someGraphOp is not a function` or `Error: tool not found`, not a syntax error

## Red Phase Checklist

- [ ] Test is in the correct layer (graph / component / integration)
- [ ] Test imports use `.js` extensions (e.g., `from "../../src/graph/client.js"`)
- [ ] Test uses `createTestEnv()` for Graph mock setup
- [ ] Test uses `MockAuthenticator` with `{ browserLogin: true }` for integration tests
- [ ] Test follows Arrange / Act / Assert structure
- [ ] Test fails for the right reason (missing implementation, not a syntax error)
- [ ] No production code written yet
- [ ] `npm run typecheck` passes (test itself is type-correct)

## Running Tests

```bash
npm run test                          # All tests
npm run test -- -t "todo_create"      # Filter by test name
npm run test -- --reporter verbose    # Verbose output
npm run typecheck                     # Verify test types compile
```
