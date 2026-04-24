---
title: "ADR-0008: Browser Flow Pattern — One Local Server Primitive, Per-Flow Descriptors"
status: "Accepted"
date: "2026-04-22"
authors: "co-native-ab"
tags: ["architecture", "browser", "loopback", "code-organization", "typescript"]
supersedes: ""
superseded_by: ""
---

# ADR-0008: Browser Flow Pattern — One Local Server Primitive, Per-Flow Descriptors

## Status

**Accepted**

## Context

graphdo-ts ships three user-facing flows that drive the system browser at a
local loopback server:

1. **Login** (`src/loopback.ts`) — a custom MSAL `ILoopbackClient` that
   serves a branded landing page, captures the OAuth redirect, and shows a
   success / error page.
2. **Picker** (`src/picker.ts`) — a generic option picker used today by
   `todo_select_list` and the markdown root-folder selector.
3. **Logout** (`showLogoutPage` inline in `src/auth.ts`) — a confirmation
   page that runs `onConfirm` once the user clicks "Sign Out".

All three live behind a small platform shim, `src/browser.ts`
(`openBrowser(url)`), with shared hardening in `src/loopback-security.ts`
(CSP nonce, CSRF token, Host / Origin / `Sec-Fetch-Site` / Content-Type
pinning) and shared HTML rendering in `src/templates/`.

> **Update (ADR-0011):** the platform shim has since been moved to
> `src/browser/open.ts` and now delegates to the upstream `open`
> package after our URL validation. The shim's role in this ADR — the
> single seam every flow uses to open the browser, with DI for tests —
> is unchanged.

| File                              | Lines |
| --------------------------------- | ----: |
| `src/auth.ts` (incl. logout page) |   673 |
| `src/picker.ts`                   |   411 |
| `src/loopback.ts`                 |   326 |
| `src/templates/picker.ts`         |   272 |
| `src/loopback-security.ts`        |   130 |
| `src/templates/login.ts`          |   115 |
| `src/templates/logout.ts`         |   100 |
| `src/browser.ts`                  |    84 |

The hardening, templating, and cross-platform browser shim are already in
good shape. The problem is the **three local-server implementations
themselves**: they are near-duplicates of each other but expose three
different public surfaces.

### What the three flows have in common

Stripped of their domain logic, every flow performs the same dance:

1. Generate a per-server CSRF token.
2. `createServer((req, res) => …)` and `listen(0, "127.0.0.1")`.
3. After binding, derive `127.0.0.1:<port>` and `localhost:<port>` as the
   set of allowed `Host` header values.
4. On every response, set `Cache-Control: no-store`, `Pragma: no-cache`,
   and `Content-Security-Policy: <buildLoopbackCsp(nonce)>` with a fresh
   per-request nonce.
5. For each `POST` route: run `validateLoopbackPostHeaders`, read the
   request body with a 1 MB cap, JSON-parse, zod-parse a
   `{ csrfToken, … }` shape, `verifyCsrfToken`.
6. After completing a state-changing action, write the JSON response and
   call `setTimeout(() => server.close(), 100)` so the response flushes
   before the socket dies.
7. Wire up an `AbortSignal` listener to close the server, a 2-minute
   timeout, and a `server.on("close")` cleanup hook that clears the timer
   and removes the abort listener.
8. Render templates via `src/templates/*` and use the shared `serveHtml`
   helper.

Every one of those steps appears, with slight wording differences, in
each of `loopback.ts`, `picker.ts`, and `showLogoutPage`. The most visible
divergence is structural, not behavioural:

| Flow   | Public shape                                                                                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login  | `class LoginLoopbackClient implements ILoopbackClient` — must satisfy MSAL's `listenForAuthCode` / `getRedirectUri` / `closeServer` interface, exposes `setAuthUrl`, `getAuthUrl`, `getCsrfToken`, `getAllowedHosts`, `waitForReady`. |
| Picker | `function startBrowserPicker(config, signal): Promise<{ url, waitForSelection }>` — caller opens the browser themselves.                                                                                                              |
| Logout | `async function showLogoutPage(openBrowser, onConfirm, signal): Promise<void>` — opens the browser internally. Module-private to `auth.ts`.                                                                                           |

`openBrowser` plumbing is also inconsistent: the loopback never opens
itself (the auth module wraps it), the picker doesn't open the browser at
all (every caller does it), and the logout page opens its own. These are
not bugs — but they are three different conventions for the same kind of
thing.

### Why this matters

- **Adding a fourth flow is a copy/paste exercise.** Anything new
  (account picker, "open file in OneDrive" confirmation, MFA
  step-up prompt) starts by duplicating ~150 lines of plumbing.
- **Hardening drift.** The CSP / CSRF / Host-pin invariants are stated
  three times. A reviewer changing one has to remember to change the
  others. (The `loopback-security.ts` helpers cover the per-request
  _checks_ but not the _wiring_ — body reading, response serialisation,
  delayed close, abort handling — which has to be re-implemented per
  flow.)
- **Structural mismatch.** The three flows have the same lifecycle
  (`start → user interacts in browser → produce a result | timeout |
abort → server closes`) but speak three different languages: a class
  with manually-staged methods (login), a `{ handle, promise }` pair
  (picker), and a single fire-and-forget `Promise<void>` (logout).
  A caller learns each flow individually instead of one shape.
- **Testing duplication.** Each flow's tests reconstruct the same
  "stand up the local server, simulate a browser POST" scaffolding.

### What MSAL requires

The login flow is the only one constrained by an external interface:
MSAL's `ILoopbackClient` declares

```ts
interface ILoopbackClient {
  listenForAuthCode(): Promise<AuthorizeResponse>;
  getRedirectUri(): string;
  closeServer(): void;
}
```

That contract has to be honoured. It does _not_ require the loopback
implementation itself to own the server lifecycle, the CSRF token, or the
landing-page logic — it only requires _some object_ to expose those three
methods.

### What is idiomatic in TypeScript

For "a small family of long-running stateful operations that share a
lifecycle but differ in routes and completion semantics", TypeScript
codebases overwhelmingly prefer **one composable primitive plus
per-instance descriptors**, not three sibling implementations:

- `node:http` server creation, lifecycle, headers, body reading, and
  abort handling go into one place — typically a small function or
  builder that returns `{ url, waitForResult, close }`.
- Each _flow_ declares only what is unique to it: the route table, the
  template rendering, the resolution rule for the result Promise.
- External-interface shims (here: MSAL's `ILoopbackClient`) become
  **adapters** wrapping the primitive, not parallel implementations of
  it.

Reference points:

- **Hono / Express sub-apps** — one server primitive, many route
  modules. Routes don't re-implement listen / shutdown.
- **`undici` `MockAgent`** — one transport, many `MockPool`s.
- **OAuth client libraries (`openid-client`, `simple-oauth2`)** — the
  loopback redirect handler is a thin route registered on a generic
  callback server, not its own bespoke HTTP module.
- **Web framework "flow" / "wizard" patterns (Remix actions, TanStack
  Form)** — each flow is a descriptor; the framework owns the lifecycle.

This is the same shape ADR-0007 chose for tools: **a single
composable primitive at the framework boundary, per-instance descriptors
for the variable parts.** Tools have `Tool<Args>` + `registerTool`;
browser flows should have `BrowserFlow<Result>` + `runBrowserFlow`.

### Why a class hierarchy is not the answer

An `abstract class LoopbackServer { abstract routes(): … }` would compile
and remove some duplication, but it would re-introduce the same problems
ADR-0007 called out for tools: `new`, `this`, lifetime ceremony, and
methods that immediately have to be bound back into plain callbacks for
`createServer((req, res) => …)`. The flows have no per-instance state
that survives `start()`; once the server closes, the object is garbage.
A factory function returning `{ url, waitForResult, close }` is the
natural shape.

## Decision

We will adopt a **per-flow descriptor** pattern centred on a single local
server primitive, with the following shape.

### 1. A `src/browser/` module

All browser-driven UX moves under one folder so the boundary is obvious:

```
src/browser/
  index.ts              barrel
  open.ts               (was src/browser.ts) — system openBrowser
  security.ts           (was src/loopback-security.ts) — CSP / CSRF / header pins
  server.ts             runBrowserFlow primitive + Route helpers
  flows/
    login.ts            login flow descriptor + MSAL ILoopbackClient adapter
    picker.ts           picker flow descriptor
    logout.ts           logout flow descriptor (extracted from auth.ts)
```

`src/auth.ts` keeps the `Authenticator` interface and the MSAL glue, but
its inline ~190-line `showLogoutPage` and its direct ownership of the
loopback server move out.

### 2. A single `BrowserFlow<Result>` descriptor

```ts
// src/browser/server.ts

export interface BrowserFlow<Result> {
  /** Short label used in logs (`"login"`, `"picker"`, `"logout"`). */
  readonly name: string;

  /** Build the routes for this flow. Called once after the server binds. */
  readonly routes: (ctx: FlowContext<Result>) => RouteTable;

  /** Per-flow timeout. Defaults to 120_000 (2 minutes). */
  readonly timeoutMs?: number;
}

export interface FlowContext<Result> {
  /** Per-server CSRF token, already generated by the primitive. */
  readonly csrfToken: string;
  /** `["127.0.0.1:<port>", "localhost:<port>"]` for POST Host pinning. */
  readonly allowedHosts: readonly string[];
  /** Resolve / reject the flow's result Promise from inside a handler. */
  readonly resolve: (result: Result) => void;
  readonly reject: (err: Error) => void;
}

export type RouteTable = Readonly<Record<string, RouteHandler>>;
//                                     ^ key is "GET /done", "POST /select", …

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  /** Per-request CSP nonce, already set on the response. */
  nonce: string,
) => void | Promise<void>;
```

Two helpers live next to it for the patterns that show up in every flow:

```ts
/** Read a JSON body (≤1 MB), validate CSRF + a zod schema, then invoke onValid. */
export function readJsonWithCsrf<S extends z.ZodTypeAny>(
  req,
  res,
  ctx,
  schema,
  onValid: (data: z.infer<S>) => void | Promise<void>,
): void;

/** Write a JSON 200 response, then close the server after a 100 ms flush delay. */
export function respondAndClose(res, server, body: unknown): void;
```

### 3. One primitive: `runBrowserFlow`

```ts
export interface FlowHandle<Result> {
  /** `http://127.0.0.1:<port>` — pass to openBrowser or surface to the user. */
  readonly url: string;
  /** Resolves with the flow's result, or rejects on timeout / abort / error. */
  readonly result: Promise<Result>;
  /** Close the server early. Idempotent. */
  readonly close: () => void;
}

export function runBrowserFlow<Result>(
  flow: BrowserFlow<Result>,
  signal: AbortSignal,
): Promise<FlowHandle<Result>>;
```

`runBrowserFlow` owns everything that is the same across flows:

- `createServer` + `listen(0, "127.0.0.1")`, address resolution.
- Per-server CSRF token, derivation of `allowedHosts`.
- Per-request CSP nonce, `Cache-Control` / `Pragma` / CSP headers.
- 404 fallback when no route matches.
- `AbortSignal` wiring (`abort` → close + reject), per-flow timeout,
  `server.on("close")` cleanup, `server.on("error")` rejection.
- Logging (`browser flow started/completed/timed out/aborted`).

A flow author writes only `routes(ctx)` and the resolution rule.

### 4. Each flow is a one-file descriptor

#### `flows/picker.ts` — replaces `startBrowserPicker`

Exports `pickerFlow(config: PickerConfig): BrowserFlow<PickerResult>`. The
file contains the picker-specific routes (`GET /`, `GET /options`,
`POST /select`, `POST /cancel`) and nothing else. The 411-line
`src/picker.ts` shrinks to roughly the route-and-template logic.

#### `flows/logout.ts` — extracted from `auth.ts`

Exports `logoutFlow(onConfirm): BrowserFlow<void>` plus a thin
`showLogoutConfirmation(openBrowser, onConfirm, signal)` wrapper that
runs the flow and opens the browser. `auth.ts` calls the wrapper.

#### `flows/login.ts` — descriptor + MSAL adapter

Exports `loginFlow(getAuthUrl): BrowserFlow<AuthorizeResponse>` and a
`createMsalLoopback(openBrowser): ILoopbackClient` factory that owns the
adapter:

```ts
export function createMsalLoopback(openBrowser: (url: string) => Promise<void>): ILoopbackClient {
  let handle: FlowHandle<AuthorizeResponse> | undefined;
  let authUrl: string | undefined;
  return {
    async listenForAuthCode() {
      handle = await runBrowserFlow(
        loginFlow(() => authUrl),
        signal,
      );
      return handle.result;
    },
    getRedirectUri() {
      assertHandle();
      return handle.url;
    },
    closeServer() {
      handle?.close();
    },
    // setAuthUrl is called by MSAL's openBrowser hook in auth.ts.
  };
}
```

The MSAL contract is satisfied by an adapter that is ~30 lines of glue
on top of the primitive — not by a 326-line bespoke implementation.

### 5. Consistent `openBrowser` ownership

Every flow opens its own browser. The `runBrowserFlow` primitive does
**not** open the browser itself — it returns the URL — but each flow's
public wrapper (`showLogoutConfirmation`, `runPicker`,
`createMsalLoopback`) takes the injected `openBrowser` from
`ServerConfig` and is the single place that calls it. This removes the
asymmetry where two of the three current flows leak browser-opening
responsibility back to their callers.

If `openBrowser` rejects (headless / remote shell), the wrapper closes
the flow and surfaces the URL in the rejection so the calling tool can
show it as text — the same fallback behaviour that exists today, just
expressed in one place per flow instead of three.

## Detailed Design

### Before — `showLogoutPage` (excerpt from `src/auth.ts`)

~190 lines of inline server setup mixing CSRF generation, server
creation, three route handlers, JSON-body parsing, abort wiring, timeout
wiring, and `openBrowser` invocation, all in one function literal.

### After — `flows/logout.ts`

```ts
// src/browser/flows/logout.ts

const ConfirmSchema = z.object({ csrfToken: z.string() });
const CancelSchema = ConfirmSchema;

export function logoutFlow(
  onConfirm: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): BrowserFlow<void> {
  return {
    name: "logout",
    routes: (ctx) => ({
      "GET /": (_req, res, nonce) => {
        serveHtml(res, logoutPageHtml({ csrfToken: ctx.csrfToken, nonce }));
      },
      "POST /confirm": (req, res) =>
        readJsonWithCsrf(req, res, ctx, ConfirmSchema, async () => {
          await onConfirm(signal);
          respondAndClose(res, ctx.server, { ok: true });
          ctx.resolve();
        }),
      "POST /cancel": (req, res) =>
        readJsonWithCsrf(req, res, ctx, CancelSchema, () => {
          respondAndClose(res, ctx.server, { ok: true });
          ctx.reject(new UserCancelledError("Logout cancelled by user"));
        }),
    }),
  };
}

export async function showLogoutConfirmation(
  openBrowser: (url: string) => Promise<void>,
  onConfirm: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const handle = await runBrowserFlow(logoutFlow(onConfirm, signal), signal);
  try {
    await openBrowser(handle.url);
  } catch (err) {
    handle.close();
    throw err;
  }
  await handle.result;
}
```

The flow file is now small enough to read in one screen, the routes are
visible at a glance, and every line is logout-specific. CSRF, CSP,
abort, timeout, body size cap, and shutdown live in the primitive.

### Test impact

Tests benefit twice over.

**Unit tests** can exercise the primitive once, then drive each flow
through `runBrowserFlow` directly without standing up the surrounding
domain logic:

```ts
it("logout flow rejects with UserCancelledError on POST /cancel", async () => {
  const onConfirm = vi.fn();
  const handle = await runBrowserFlow(logoutFlow(onConfirm, testSignal()), testSignal());
  await postJson(`${handle.url}/cancel`, { csrfToken: getCsrfFrom(handle) });
  await expect(handle.result).rejects.toBeInstanceOf(UserCancelledError);
});
```

**Hardening tests** consolidate. Today, `loopback.test.ts` and
`picker.test.ts` each verify CSP, CSRF, and Host-pin behaviour. After
this refactor, those invariants are tested **once** against
`runBrowserFlow` (fed a trivial test descriptor). Per-flow tests focus
only on per-flow routes. This collapses several hundred lines of
near-duplicate test setup.

**Integration tests** in `test/integration/` are unaffected — they
exercise tool behaviour through the MCP `Client`, and the browser-spy
pattern (capture URL via injected `openBrowser`, POST to `/select`)
keeps working as-is.

## Consequences

### Positive

- **One primitive, three thin descriptors.** ~600 lines of duplicated
  lifecycle/hardening boilerplate across `loopback.ts`, `picker.ts`, and
  `showLogoutPage` collapse into one ~120-line `runBrowserFlow` plus
  three small route-only files.
- **Hardening invariants stated once.** CSP nonce wiring, CSRF
  generation, Host-pin derivation, body-size cap, delayed close, abort
  handling, and timeout all live in `runBrowserFlow`. A change to the
  hardening baseline is a one-file change.
- **Consistent flow shape.** All three flows return the same
  `FlowHandle<Result>` and follow the same `start → result | abort |
timeout → close` lifecycle. A reviewer learns one shape.
- **MSAL boundary is honest.** The 326-line `LoginLoopbackClient` class
  becomes a ~30-line adapter that exists only because MSAL requires the
  `ILoopbackClient` interface. The actual login UX lives in
  `flows/login.ts` next to its siblings.
- **`openBrowser` ownership is consistent.** Every flow's public wrapper
  is the single place that opens the browser, and falls back uniformly
  when `openBrowser` rejects.
- **Logout leaves `auth.ts`.** `auth.ts` shrinks substantially and is
  back to being "the MSAL/Authenticator module" instead of "MSAL +
  inline HTTP server".
- **Trivial extension.** A new browser-driven flow ("approve sending
  this email", "pick a SharePoint site") is one descriptor file
  - one wrapper function.
- **Idiomatic for the language.** Mirrors what TypeScript HTTP / OAuth
  ecosystems do: one composable server primitive, per-flow descriptors,
  external-interface shims as adapters. No class hierarchy.

### Negative

- **One-time refactor cost.** Three files move and one (`auth.ts`)
  shrinks. The total surface is bounded — the existing tests in
  `test/loopback.test.ts`, `test/picker.test.ts`, and any
  logout-specific tests need their imports updated, but their
  _behaviour_ doesn't change.
- **One layer of indirection added.** A reader who today opens
  `picker.ts` and sees the whole flow inline will, after the refactor,
  see a route table that delegates lifecycle to `runBrowserFlow`. This
  is the same trade-off ADR-0007 made for tools: a small amount of
  "where does the lifecycle live?" lookup cost in exchange for not
  re-reading the lifecycle in every file.
- **`runBrowserFlow` becomes a chokepoint.** Every browser flow goes
  through it, so a regression there hits all flows. Mitigated by the
  primitive being small (~120 lines) and tested directly with a trivial
  test descriptor that exercises every code path.

### Neutral

- `src/browser.ts` becomes `src/browser/open.ts`. The `openBrowser`
  export and its WSL/macOS/Linux/Windows behaviour are unchanged.
- `src/loopback-security.ts` becomes `src/browser/security.ts`. Its
  three exports (`generateRandomToken`, `verifyCsrfToken`,
  `buildLoopbackCsp`, `validateLoopbackPostHeaders`) are unchanged and
  re-used by `runBrowserFlow`.
- `src/templates/*` is unaffected — `BrowserFlow.routes` calls the same
  template functions as today.
- `ServerConfig.openBrowser` keeps its current type and DI thread.
- The existing `PickerConfig`, `PickerOption`, `PickerResult`,
  `PickerCreateLink` public types continue to exist; `runPicker(config,
signal)` is a thin wrapper over `runBrowserFlow(pickerFlow(config))`
  for callers that already type against them.

## Alternatives Considered

### A. Keep the current shape (do nothing)

Rejected. The three implementations are already drifting in small ways
(picker has refresh + create-link affordances the others don't, login
has a dedicated `serverReady` Promise the others don't, logout has a
`settled` flag the others don't). Each new flow either reinvents the
boilerplate or copies one of the three slightly-different conventions.

### B. Class hierarchy (`abstract class LoopbackServer`)

Rejected for the same reason ADR-0007 rejected `abstract class
ToolBase`: `new` / `this` / lifetime ceremony for zero benefit when the
flow has no per-instance state that survives `start()`. Methods would
immediately be bound back into plain callbacks for
`createServer((req, res) => …)`. The MSAL `ILoopbackClient` shim is the
_only_ part of the system that genuinely wants a class shape; that one
class becomes a ~30-line adapter.

### C. A web framework (Hono, Express)

Rejected. Adds a runtime dependency for ~10 routes total across three
flows and the lifetime of each flow is sub-second-to-2-minute. The
hardening (Host-pin, Sec-Fetch-Site, exact Content-Type) is more
restrictive than typical framework defaults and would have to be
re-implemented as middleware anyway. `node:http` is sufficient.

### D. Extract only a `LoopbackBaseServer` shared by login and logout, leave the picker alone

Rejected as half-measure. The picker has the _same_ lifecycle as the
other two — leaving it on its own shape preserves the current
"three conventions for one concept" problem and means a reviewer still
has to learn the picker separately.

### E. Merge `openBrowser` into `runBrowserFlow` so the primitive opens the browser itself

Rejected. Some callers (login on a headless box) need the URL surfaced
as text without ever opening a browser; the picker's tests deliberately
intercept the URL via the injected `openBrowser` spy. Keeping
`openBrowser` outside the primitive preserves both. The per-flow
wrapper still gives one consistent place to call it.

## Migration Plan

A single PR is feasible because the three flows share so much that the
refactor is mostly a rearrangement:

1. Create `src/browser/` and move `browser.ts` → `browser/open.ts` and
   `loopback-security.ts` → `browser/security.ts`. Update imports. No
   behaviour change.
2. Add `src/browser/server.ts` with `runBrowserFlow`, `BrowserFlow`,
   `FlowHandle`, `readJsonWithCsrf`, `respondAndClose`. Cover it with
   primitive-level tests using a trivial in-test descriptor.
3. Convert the simplest flow first — **logout** (it is module-private to
   `auth.ts`, so no public type changes). Move the logic to
   `src/browser/flows/logout.ts`, expose `showLogoutConfirmation`,
   call it from `auth.ts`. Run the existing logout test.
4. Convert **picker**. Move to `src/browser/flows/picker.ts`. Keep the
   existing `PickerConfig` / `PickerResult` exports and a
   `runPicker(config, signal)` wrapper so call sites in
   `tools/todo/todo-select-list.ts` and
   `tools/markdown/select-root-folder.ts` change only their import path.
   Run `test/picker.test.ts`.
5. Convert **login**. Move to `src/browser/flows/login.ts`. Keep
   `createMsalLoopback(openBrowser)` returning an `ILoopbackClient` that
   `MsalAuthenticator` instantiates exactly once per `login()` call.
   Run `test/loopback.test.ts` and the integration login tests.
6. Delete `src/loopback.ts`, the inline `showLogoutPage` in `auth.ts`,
   and any now-dead helpers.
7. Run `npm run check` (format + icons + lint + typecheck + test).

The hardening test surface consolidates as part of step 2 — CSP / CSRF /
Host-pin tests previously duplicated across `loopback.test.ts` and
`picker.test.ts` move onto the primitive's tests.

## References

- ADR-0001: Minimize Blast Radius — establishes the DI / `ServerConfig`
  pattern, which `openBrowser` already uses and which `runBrowserFlow`
  preserves.
- ADR-0002: HTML Template and Design System — the `templates/` layer
  this ADR builds on; unchanged by this proposal.
- ADR-0003: Browser-Only Authentication — the rationale for _having_ a
  branded loopback in the first place; this ADR is about how that
  loopback is structured, not whether it exists.
- ADR-0007: Tool Descriptor Pattern — the same "one primitive +
  per-instance descriptors" idiom, applied to MCP tools.
- `src/loopback.ts`, `src/picker.ts`, `src/auth.ts` (`showLogoutPage`)
  — current implementations being consolidated.
- `src/loopback-security.ts` — shared hardening helpers, retained
  unchanged as `src/browser/security.ts`.
- MSAL `@azure/msal-node` `ILoopbackClient` — the only external
  interface this ADR has to honour, satisfied via a thin adapter.
