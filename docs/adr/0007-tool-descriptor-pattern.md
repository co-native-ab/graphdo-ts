---
title: "ADR-0007: Tool Descriptor Pattern — One Tool, One File, One Object"
status: "Proposed"
date: "2026-04-22"
authors: "co-native-ab"
tags: ["architecture", "mcp", "tools", "code-organization", "typescript"]
supersedes: ""
superseded_by: ""
---

# ADR-0007: Tool Descriptor Pattern — One Tool, One File, One Object

## Status

**Proposed**

## Context

graphdo-ts currently exposes ~25 MCP tools spread across six domain modules
in `src/tools/`. The registration model that grew organically alongside those
modules has two distinct halves:

1. **`src/tool-registry.ts`** — a small library that owns the shared
   `ToolDef` / `ToolEntry` types, the `defineTool()` helper that wraps
   `server.registerTool(...)`, the runtime `syncToolState()` that
   enables/disables tools based on granted scopes, and `buildInstructions()`
   which generates the MCP `instructions` text from the full set of defs.
2. **`src/tools/*.ts`** — per-domain modules that each export a
   `*_TOOL_DEFS: readonly ToolDef[]` array and a
   `register*Tools(server, config): ToolEntry[]` function. The register
   function inline-defines every handler in one large body and pushes
   `defineTool(...)` results into an array.

That second half is the problem this ADR addresses. As the surface area
grew — particularly with the markdown family — the register functions grew
into thousand-line bodies:

| File                            | Lines |
| ------------------------------- | ----: |
| `tools/markdown-register.ts`    | 1378  |
| `tools/todo.ts`                 |  505  |
| `tools/todo-steps.ts`           |  253  |
| `tools/markdown-defs.ts`        |  214  |
| `tools/login.ts`                |  140  |
| `tools/config.ts`               |  138  |

The markdown family already hints at where this is going: it splits
`markdown-defs.ts`, `markdown-helpers.ts`, and `markdown-register.ts` into
sibling files. But the handler bodies still live together inside one giant
`registerMarkdownTools` function. Adding or modifying a single tool means
scrolling through every other tool's handler in the same file, and reviewers
see diffs that touch a multi-thousand-line file even when only one tool
changed.

There is also an architectural consequence: the **definition** of a tool
(name, scopes, description) and its **implementation** (input schema,
handler) live in two different places — `*_TOOL_DEFS` arrays at the top of
the file and inline `defineTool` calls inside `register*Tools`. Keeping
those in sync is manual: a new tool requires three coordinated edits per
domain (def constant, defs-array entry, register-function entry) and a
fourth edit in `src/index.ts` to plumb the registration call.

The user analogy is helpful: in Go this would naturally be a
`[]Tool` slice of an interface; in C# it would be a `List<ITool>` or a set
of classes inheriting from an abstract `ToolBase`. What is the **idiomatic
TypeScript** answer for an MCP server?

### What MCP / the SDK requires

The MCP TypeScript SDK exposes a single registration primitive:

```ts
server.registerTool(
  name: string,
  config: { description, title?, inputSchema, outputSchema?, annotations? },
  handler: (args, extra) => Promise<ToolResult>,
): RegisteredTool;
```

That is it. The SDK does not prescribe class hierarchies, decorators, or
collection types. **Any code organisation that ends up calling
`registerTool` once per tool with the right arguments is conformant.**

### What is idiomatic in TypeScript

For a homogeneous list of "things that can be invoked", TypeScript codebases
overwhelmingly prefer **structural descriptor objects**, not inheritance:

- One exported `const` per item, conforming to a shared `interface`.
- Discovery via a flat array (or a directory of files re-exported through a
  barrel). No registry singleton, no `register()` side-effects at import
  time.
- A single registration loop at the composition root that consumes the
  array and wires it into the framework primitive.

Reference points in the wider ecosystem:

- **Python MCP SDK / FastMCP:** `@mcp.tool` decorator turns a function +
  its docstring into a tool descriptor. The runtime collects them into a
  registry. Each tool lives in its own function.
- **`discord.js` / Discord slash command collections:** one file per
  command exporting `{ data, execute }`; a loader iterates the directory.
- **Hono / Elysia route definitions:** route + handler colocated in one
  small unit, registered by a single `app.route(...)` loop.
- **TanStack Router file-based routes:** one file per route, exporting a
  typed descriptor.

The repository is already most of the way there: `defineTool()` is the
factory, `ToolDef` is the descriptor. What is missing is the discipline of
**one tool per file, descriptor-as-data, registration as a one-liner.**

### Why classes are not the answer

A class-based design (`abstract class ToolBase { abstract handler(...); }`)
would compile and run, but it adds ceremony — `new`, `this`, lifetime
management — for zero benefit in our setting:

- Every handler is a pure function over `(args, ctx, config)`. There is no
  per-instance state.
- The MCP SDK takes a plain callback, so every class would immediately
  bind a method back into a function reference.
- TypeScript's structural typing already gives us "implements `Tool`" for
  free without `class X implements Tool`.

This is the inverse of C# / Java, where classes are the lightweight unit.
In TypeScript, a typed object literal is.

## Decision

We will adopt a **per-tool descriptor file** pattern, with the following
shape.

### 1. Single `Tool<Args>` descriptor type

Replace the split between `ToolDef` and the inline `defineTool` call site
with a single descriptor type that fully describes a tool, including its
input schema, output schema, annotations, and handler factory:

```ts
// src/tool-registry.ts

export interface Tool<Args extends ZodRawShape = ZodRawShape> {
  /** Static metadata used for instructions, scope gating, and registration. */
  readonly def: ToolDef;
  /** zod input schema — passed verbatim to the MCP SDK. */
  readonly inputSchema: Args;
  /** Optional output schema. */
  readonly outputSchema?: ZodRawShape;
  /** Optional MCP annotations. Defaults to `{ title: def.title }`. */
  readonly annotations?: ToolAnnotations;
  /**
   * Handler factory. Receives the injected ServerConfig at registration
   * time and returns the actual MCP callback. This keeps `config` out of
   * module-level closures so each tool file remains a pure descriptor and
   * trivially testable.
   */
  readonly handler: (config: ServerConfig) => ToolCallback<Args>;
}
```

`ToolDef` (name + title + description + requiredScopes) stays as-is so
`buildInstructions()` and `syncToolState()` keep their current shape. The
new `Tool` type composes `ToolDef` with the MCP-SDK-shaped registration
inputs.

### 2. One file per tool

Each tool gets its own file under `src/tools/<domain>/<tool-name>.ts`,
exporting one `Tool` object. The handler is a plain function defined at the
top of the file; helpers live alongside or in a sibling `*-helpers.ts`
module. Tool files do not import the `McpServer` and never call
`registerTool` themselves.

### 3. Flat barrel + one registration loop

Each domain re-exports its tools through a barrel:

```ts
// src/tools/todo/index.ts
export { todoListTool } from "./todo-list.js";
export { todoShowTool } from "./todo-show.js";
// …
export const TODO_TOOLS = [
  todoListTool, todoShowTool, todoCreateTool,
  todoUpdateTool, todoCompleteTool, todoDeleteTool,
] as const satisfies readonly Tool[];
```

`src/index.ts` (the composition root) collects all tools into one array
and registers them in a single loop. There is no longer a `register*Tools`
function per domain.

### 4. Backwards-compatible `defineTool` helper

`defineTool` continues to exist but moves to a one-shot
`registerTool(server, config, tool)` that consumes a `Tool` object. The
existing `(server, def, toolConfig, handler)` overload is removed —
descriptors replace it.

## Detailed Design

### Before — current `tools/mail.ts` (59 lines, def + register intermixed)

```ts
// src/tools/mail.ts

const MAIL_SEND_DEF: ToolDef = {
  name: "mail_send",
  title: "Send Email",
  description: "Send an email to yourself via Outlook…",
  requiredScopes: [GraphScope.MailSend],
};

export const MAIL_TOOL_DEFS: readonly ToolDef[] = [MAIL_SEND_DEF];

export function registerMailTools(server: McpServer, config: ServerConfig): ToolEntry[] {
  return [
    defineTool(
      server,
      MAIL_SEND_DEF,
      {
        inputSchema: {
          subject: z.string().describe("Email subject line"),
          body: z.string().describe("Email body content"),
          html: z.boolean().default(false).describe("Whether the body is HTML"),
        },
        annotations: { title: MAIL_SEND_DEF.title, readOnlyHint: false, openWorldHint: true },
      },
      async ({ subject, body, html }, { signal }) => {
        try {
          const client = config.graphClient;
          const user = await getMe(client, signal);
          await sendMail(client, user.mail, subject, body, html, signal);
          logger.info("mail sent", { to: user.mail, subject });
          return { content: [{ type: "text", text: `Email sent to ${user.mail}` }] };
        } catch (error: unknown) {
          return formatError("mail_send", error);
        }
      },
    ),
  ];
}
```

### After — `tools/mail/mail-send.ts` (one tool, one file)

```ts
// src/tools/mail/mail-send.ts

import { z } from "zod";
import { getMe, sendMail } from "../../graph/mail.js";
import { logger } from "../../logger.js";
import { GraphScope } from "../../scopes.js";
import type { Tool } from "../../tool-registry.js";
import { formatError } from "../shared.js";

const inputSchema = {
  subject: z.string().describe("Email subject line"),
  body: z.string().describe("Email body content"),
  html: z.boolean().default(false).describe("Whether the body is HTML"),
};

export const mailSendTool: Tool<typeof inputSchema> = {
  def: {
    name: "mail_send",
    title: "Send Email",
    description: "Send an email to yourself via Outlook…",
    requiredScopes: [GraphScope.MailSend],
  },
  inputSchema,
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: (config) => async ({ subject, body, html }, { signal }) => {
    try {
      const client = config.graphClient;
      const user = await getMe(client, signal);
      await sendMail(client, user.mail, subject, body, html, signal);
      logger.info("mail sent", { to: user.mail, subject });
      return { content: [{ type: "text", text: `Email sent to ${user.mail}` }] };
    } catch (error: unknown) {
      return formatError("mail_send", error);
    }
  },
};
```

```ts
// src/tools/mail/index.ts
import type { Tool } from "../../tool-registry.js";
import { mailSendTool } from "./mail-send.js";

export const MAIL_TOOLS = [mailSendTool] as const satisfies readonly Tool[];
```

### Before — `src/index.ts` (parallel imports per domain)

```ts
import { LOGIN_TOOL_DEFS, registerLoginTools } from "./tools/login.js";
import { MAIL_TOOL_DEFS, registerMailTools } from "./tools/mail.js";
import { MARKDOWN_TOOL_DEFS, registerMarkdownTools } from "./tools/markdown.js";
import { TODO_TOOL_DEFS, STEP_TOOL_DEFS, registerTodoTools } from "./tools/todo.js";
import { CONFIG_TOOL_DEFS, registerConfigTools } from "./tools/config.js";
import { STATUS_TOOL_DEFS, registerStatusTool } from "./tools/status.js";

const allDefs = [
  ...LOGIN_TOOL_DEFS, ...STATUS_TOOL_DEFS, ...MAIL_TOOL_DEFS,
  ...TODO_TOOL_DEFS, ...STEP_TOOL_DEFS, ...CONFIG_TOOL_DEFS, ...MARKDOWN_TOOL_DEFS,
];

const registry: ToolEntry[] = [
  ...registerLoginTools(mcpServer, config),
  ...registerMailTools(mcpServer, config),
  ...registerTodoTools(mcpServer, config),
  ...registerConfigTools(mcpServer, config),
  ...registerMarkdownTools(mcpServer, config),
  ...registerStatusTool(mcpServer, config),
];
```

### After — `src/index.ts` (single source of tools, single loop)

```ts
import { LOGIN_TOOLS } from "./tools/login/index.js";
import { MAIL_TOOLS } from "./tools/mail/index.js";
import { MARKDOWN_TOOLS } from "./tools/markdown/index.js";
import { TODO_TOOLS } from "./tools/todo/index.js";
import { CONFIG_TOOLS } from "./tools/config/index.js";
import { STATUS_TOOLS } from "./tools/status/index.js";

const ALL_TOOLS = [
  ...LOGIN_TOOLS, ...STATUS_TOOLS, ...MAIL_TOOLS,
  ...TODO_TOOLS, ...CONFIG_TOOLS, ...MARKDOWN_TOOLS,
];

const mcpServer = new McpServer(
  { name: "graphdo", version: VERSION },
  { capabilities: { logging: {} }, instructions: buildInstructions(ALL_TOOLS.map(t => t.def)) },
);

const registry: ToolEntry[] = ALL_TOOLS.map((tool) => registerTool(mcpServer, config, tool));
```

Adding a new tool becomes:

1. Create `src/tools/<domain>/<tool-name>.ts` exporting one `Tool` object.
2. Add it to the domain's `index.ts` barrel array.

No edits to `tool-registry.ts`, no edits to `src/index.ts`, no edits to a
shared register function.

### Test impact

Tests benefit twice over.

**Direct unit tests** can import a tool descriptor and call its handler
without spinning up an `McpServer` or `InMemoryTransport`:

```ts
// test/tools/mail-send.test.ts
import { mailSendTool } from "../../src/tools/mail/mail-send.js";
import { createTestEnv, testSignal } from "../helpers.js";

it("sends mail to the signed-in user", async () => {
  const { config } = await createTestEnv();
  const handler = mailSendTool.handler(config);
  const result = await handler(
    { subject: "hi", body: "hello", html: false },
    { signal: testSignal() },
  );
  expect(result.isError).toBeUndefined();
});
```

**Integration tests** in `test/integration/` continue to use the real
`createMcpServer` + `Client` pair — they exercise the registration loop and
runtime scope gating end-to-end. No integration test needs to change.

## Consequences

### Positive

- **One tool per file.** A reviewer reading the diff for a tool change
  sees only that tool. No more thousand-line files.
- **Single source of truth per tool.** The `Tool` descriptor co-locates
  metadata, schemas, annotations, and handler. No more two-place edits to
  add a tool to both `*_TOOL_DEFS` and `register*Tools`.
- **Trivial extension.** Adding a tool is "create file + add to barrel
  array". No registry plumbing.
- **Better unit testing surface.** Tools can be unit-tested by importing
  the descriptor and calling its handler directly. Integration tests still
  cover the SDK glue.
- **Idiomatic for the language.** Mirrors what TypeScript MCP-adjacent
  ecosystems do (route descriptors, command collections, typed config
  arrays). No class hierarchy required.
- **Smaller `src/index.ts`.** Composition root has one import per domain
  and one registration loop instead of N parallel arrays and N register
  calls.
- **Forward-compatible.** A future "auto-discover tools from
  `src/tools/**/*.tool.ts`" loader becomes a small change because every
  tool already conforms to one shape.

### Negative

- **One-time refactor cost.** Every tool file moves to a new location and
  shape. Imports across `src/`, `test/`, and any docs that reference paths
  must be updated. Estimated touch surface is ~25 tool files plus their
  tests.
- **More files.** Going from 1 file per domain to N files per domain.
  Mitigated by per-domain folders and barrel exports — call sites still
  import a single name from `./tools/<domain>/index.js`.
- **Handler closure shape changes.** The new `handler: (config) => async (args, ctx) => …`
  curry is a small departure from the current "config is captured by the
  outer `register*Tools` closure" pattern. The curry is what makes a tool
  descriptor trivially testable (the inner function is the same shape the
  SDK already calls). Reviewers should not find this surprising — it is
  the same DI thread the codebase already uses, just made explicit.
- **Slightly larger module graph.** ESM tree-shaking is not relevant here
  (we ship a single esbuild bundle), so this is purely a developer-time
  observation.

### Neutral

- `defineTool` is renamed `registerTool` (in `tool-registry.ts`) and
  changes signature. The old `defineTool` overload is removed; nothing
  outside `tool-registry.ts` and the composition root calls it.
- `ToolDef`, `ToolEntry`, `syncToolState`, `buildInstructions` are
  unchanged. Scope-gating, instruction generation, and the dynamic
  enable/disable lifecycle keep their current contracts.
- `MARKDOWN_TOOL_DEFS`, `TODO_TOOL_DEFS`, etc. constants disappear — they
  are derived as `MARKDOWN_TOOLS.map(t => t.def)` at the composition root
  if needed.

## Alternatives Considered

### A. Keep the current shape (do nothing)

Rejected. The largest tool file is 1378 lines and growing. The two-place
edit to add a tool is a known maintenance hazard. The user explicitly
asked for a refactor.

### B. Class hierarchy (`abstract class ToolBase`)

Rejected. Idiomatic for C# / Java, not for TypeScript. Adds `new`, `this`,
and lifecycle ceremony for zero benefit when every handler is a pure
function. Forces every tool to bind methods back into callbacks for the
MCP SDK, which takes plain function references.

### C. Decorator-based registration (`@tool(...)`)

Rejected. TypeScript decorators on standalone functions still require the
experimental decorators flag (or the new TC39 decorators with their own
quirks). They also push registration into module-import side effects,
which conflicts with the dependency-injection model the codebase uses
(everything threads through `ServerConfig`). Decorators would also make
the composition order implicit and harder to reason about.

### D. Auto-discover via filesystem glob

Rejected for now. Would require a build-time codegen step or
`import.meta`-glob trickery in esbuild, both of which add complexity for
marginal benefit. The barrel-array approach gives explicit ordering and
is one line per tool. We can revisit if the count grows past a few dozen
per domain.

### E. Move handler bodies to private helpers, keep current registry

Rejected as half-measure. It addresses the "large register function"
symptom but leaves the parallel `*_DEFS` array + `register*` function
duality in place. The two-place-edit problem persists.

## Migration Plan

A single-commit refactor is feasible because every tool file changes shape
in the same way. Suggested order (one PR or a small stack):

1. Introduce the `Tool<Args>` interface and the new
   `registerTool(server, config, tool)` helper in `src/tool-registry.ts`,
   keeping the old `defineTool` overload alive temporarily.
2. Convert one domain end-to-end as a worked example
   (suggested: `mail` — smallest surface). Wire it through `src/index.ts`
   alongside the legacy register calls.
3. Convert `login`, `status`, `config`, `todo` (incl. steps), and
   `markdown` in turn.
4. Once every domain is migrated, delete the legacy `defineTool` overload
   and the per-domain `register*Tools` functions.
5. Update tests that import the old register functions to import the new
   tool descriptors. No integration test changes are expected.
6. Run `npm run check` (format + icons + lint + typecheck + test).

Folder layout after migration:

```
src/tools/
  shared.ts                  unchanged
  mail/
    index.ts                 barrel + MAIL_TOOLS array
    mail-send.ts             one Tool descriptor
  todo/
    index.ts                 barrel + TODO_TOOLS array
    todo-list.ts
    todo-show.ts
    todo-create.ts
    todo-update.ts
    todo-complete.ts
    todo-delete.ts
    steps/
      todo-steps.ts          (list)
      todo-add-step.ts
      todo-update-step.ts
      todo-delete-step.ts
    helpers/
      format.ts              (was todo-format.ts)
      parse.ts               (was todo-parse.ts)
  markdown/
    index.ts                 barrel + MARKDOWN_TOOLS array
    helpers.ts               (was markdown-helpers.ts)
    select-root-folder.ts
    list-files.ts
    get-file.ts
    create-file.ts
    update-file.ts
    edit-file.ts
    delete-file.ts
    preview-file.ts
    list-versions.ts
    get-version.ts
    diff-versions.ts
  login/
    index.ts
    login.ts
    logout.ts
  config/
    index.ts
    todo-select-list.ts
  status/
    index.ts
    auth-status.ts
```

## References

- ADR-0001: Minimize Blast Radius — establishes the DI / `ServerConfig`
  pattern this ADR builds on.
- `src/tool-registry.ts` — current `ToolDef` / `defineTool` /
  `syncToolState` / `buildInstructions`.
- `src/tools/mail.ts`, `src/tools/todo.ts`, `src/tools/markdown-register.ts`
  — current tool files of representative size.
- MCP TypeScript SDK `McpServer.registerTool` —
  the only registration primitive this ADR commits to.
