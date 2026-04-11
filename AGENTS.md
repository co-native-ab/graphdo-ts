# graphdo-ts - Scoped Microsoft Graph Access for AI Agents

## What This Is

A TypeScript MCP server that gives AI agents scoped, low-risk access to Microsoft Graph API. Current capabilities cover mail and Microsoft To Do; more Graph surfaces will be added over time. Uses stdio transport and MSAL authentication (browser-only) - distributed as an MCPB bundle.

Repository: `github.com/co-native-ab/graphdo-ts`

## Architecture

```
src/
  index.ts               Entry point, ServerConfig, createMcpServer()
  auth.ts                MSAL auth: browser-only login (Authenticator interface)
  browser.ts             Cross-platform openBrowser() utility
  config.ts              Config struct, load/save (atomic via temp+rename), configDir()
  logger.ts              Structured logger with level filtering (debug/info/warn/error)
  loopback.ts            Custom MSAL loopback client - branded login landing page + success page
  picker.ts              Generic browser picker - local HTTP server with clickable options
  graph/
    client.ts            Lightweight HTTP client (native fetch, no Graph SDK), GraphRequestError
    types.ts             TypeScript interfaces for Graph API entities
    mail.ts              getMe, sendMail
    todo.ts              TodoList/TodoItem CRUD + checklist items + pagination ($top/$skip)
  templates/
    layout.ts            Shared HTML shell (doctype, head, fonts, favicon)
    tokens.ts            Design tokens (colors, fonts, spacing)
    styles.ts            CSS built from design tokens
    icons.ts             Base64-encoded icon assets
    login.ts             Login landing, success, and error page templates
    logout.ts            Logout confirmation page template
    picker.ts            Browser picker page template
  tools/
    login.ts             login and logout MCP tools (browser-only)
    mail.ts              mail_send MCP tool registration
    todo.ts              todo_list, todo_show, todo_create, todo_update, todo_complete, todo_delete + step tools
    config.ts            todo_config MCP tool (human-only list selection via browser picker)
    status.ts            auth_status MCP tool (authentication state + config info)
test/
  helpers.ts             createTestEnv() - standardized test setup
  mock-graph.ts          MockState class + in-memory Graph API server (node:http)
  mock-auth.ts           MockAuthenticator - controllable auth state for tests
  config.test.ts         Config persistence unit tests
  loopback.test.ts       Custom loopback client tests (landing page, redirect, auth code, success/error)
  picker.test.ts         Browser picker unit tests (HTML, selection, timeout, XSS, onSelect errors)
  integration/           Full e2e: in-process MCP server + real Client + mock Graph API
  graph/
    client.test.ts       GraphClient + GraphRequestError tests
    mail.test.ts         Mail operation tests
    todo.test.ts         Todo CRUD + checklist item + enhanced field tests
  templates/             Template unit tests (structure, tokens, XSS escaping, favicon)
```

## Key Design Decisions

### ServerConfig (Dependency Injection)

All dependencies are injected via `ServerConfig { authenticator, graphBaseUrl, configDir, graphClient, openBrowser }`. This is threaded through `createMcpServer()` and into all tool registration functions. No tool reads env vars or calls global functions - everything is injected. `main()` is the only place that reads env vars and constructs the config. This makes testing trivial: pass a `MockAuthenticator`, a mock Graph URL, a temp config dir, and a no-op `openBrowser` spy.

### No Graph SDK

We use native `fetch` instead of the Microsoft Graph SDK. The `GraphClient` class wraps fetch with Bearer token injection, JSON encoding, and structured error handling via `GraphRequestError`. All Graph API interaction goes through `client.request(method, path, body?)`.

### MSAL Authentication (Browser-Only)

The `login` tool uses **interactive browser login** exclusively - via a **custom loopback client** (`LoginLoopbackClient` in `src/loopback.ts`) that replaces MSAL's default loopback server. Instead of opening the Microsoft login page directly, the custom loopback:

1. Starts a local HTTP server with a branded landing page showing "Sign in with Microsoft"
2. When the user clicks the button, redirects to Microsoft's OAuth page via `/redirect`
3. After authentication, captures the auth code redirect and shows a success page with auto-close countdown

This implements MSAL's `ILoopbackClient` interface with custom `openBrowser` wrapping: MSAL calls `openBrowser(authUrl)` which stores the auth URL and opens the landing page instead.

If the browser cannot be opened, the login tool returns an error with the URL so the user can navigate manually. There is no device code fallback and no MCP elicitation. See ADR-0003 for the rationale.

Logout clears cached tokens and opens a branded confirmation page in the browser. If the browser cannot be opened for the confirmation page, the token clearing still succeeds silently.

### Authenticator Interface

The `Authenticator` interface abstracts token acquisition: `login()`, `token()`, `logout()`, `isAuthenticated()`, `accountInfo()`. Three implementations:

- `MsalAuthenticator` - production MSAL flow with custom loopback client (branded login page), file-based token cache. Constructor takes `(clientId, configDir, scopes, openBrowser)`.
- `StaticAuthenticator` - for testing with a fixed token (via `GRAPHDO_ACCESS_TOKEN` env var)
- `MockAuthenticator` (test-only) - controllable auth state for browser login simulation

### Stdio Transport

The server uses `StdioServerTransport` from the MCP SDK, communicating via stdin/stdout JSON-RPC. This is required for MCPB compatibility. Logs go to stderr.

### Config via Browser (Human-Only)

The `todo_config` tool uses the generic browser picker (`src/picker.ts`) to let the user select a todo list. This is a deliberate security design: the AI agent **cannot** programmatically change which list it operates on - only a human can make this selection via the browser UI.

The picker (`startBrowserPicker()`) is a reusable component:

1. Starts a local HTTP server on `127.0.0.1` with a random port
2. Serves an HTML page with clickable option buttons (title, subtitle, options are all configurable)
3. When the user clicks an option, JS POSTs to `/select`
4. The `onSelect` callback is invoked (e.g., saves config), server returns success HTML with auto-close countdown, then shuts down

Browser opening is injected via `ServerConfig.openBrowser`, making it testable - tests pass a spy that captures the URL instead of launching a real browser. If the browser cannot be opened (headless/remote), the tool returns the URL as text for manual access. The tool blocks until the user makes a selection (2-minute timeout).

Config is stored in the OS config directory (`~/.config/graphdo-ts/` on Linux, `~/Library/Application Support/graphdo-ts/` on macOS, `%APPDATA%/graphdo-ts` on Windows). The `GRAPHDO_CONFIG_DIR` env var overrides this (used in tests).

### Error Handling

- **MCP tools never throw** - all errors are caught and returned as `{ isError: true, content: [{ type: "text", text: message }] }`
- `GraphRequestError` provides structured error info: method, path, statusCode, code, graphMessage
- `AuthenticationRequiredError` is thrown when no cached token is available - tools catch this and return a helpful error directing the agent to use the `login` tool
- `loadAndValidateConfig()` throws with a clear user-friendly message if config is missing

### Scopes

`Mail.Send`, `Tasks.ReadWrite`, `User.Read`, `offline_access`

## TypeScript Style Rules

- **Strict mode** - `strict: true` in tsconfig with `noUncheckedIndexedAccess`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`
- **No `any` types** - enforced by `typescript-eslint` strict + stylistic presets
- **ES modules** - all imports use `.js` extensions (e.g., `import { logger } from "./logger.js"`)
- **Early returns** - check errors and return immediately, don't nest
- **Structured logging** - `logger.debug/info/warn/error(message, context?)` with key=value pairs to stderr
- **Cross-platform** - use `node:path`, `node:os`, `node:crypto` for filesystem ops; handle win32/darwin/linux paths
- **Atomic file writes** - write to temp file then rename into place (`saveConfig`)
- **Comments** - only where clarification is needed, not on every function
- **Minimal dependencies** - only 3 runtime deps: `@modelcontextprotocol/sdk`, `zod`, `@azure/msal-node`

## Testing

### Test Architecture

Tests use vitest with three layers:

1. **Graph layer tests** (`test/graph/`) - test `GraphClient`, mail, and todo operations against the mock Graph API server
2. **Picker tests** (`test/picker.test.ts`) - test the generic browser picker directly: HTML rendering, option selection, callback invocation, timeout, XSS escaping, onSelect error handling
3. **Integration tests** (`test/integration/`) - full in-process end-to-end tests using `InMemoryTransport.createLinkedPair()` from the MCP SDK and the real `Client` class. Tests create a `MockAuthenticator` and `MockState`, wire up the server in-process (no child processes or stdio), and verify all tool calls against the mock Graph API.

The mock Graph API server (`test/mock-graph.ts`) is a plain `node:http` server with `MockState` for in-memory state - no mocking libraries for HTTP.

The `MockAuthenticator` (`test/mock-auth.ts`) implements `Authenticator` with controllable state: starts unauthenticated by default, `browserLogin: true` (default) completes login immediately. Used to test the full login → use tools → logout → tools fail cycle.

**Config E2E tests** use the injectable `openBrowser` to capture the picker URL without launching a real browser. The spy function schedules an HTTP POST to `/select` on the captured URL, simulating a user clicking a list. Tests verify the full flow: tool call → picker starts → browser spy captures URL → POST selection → tool returns success → config persisted on disk.

### Running Tests

```bash
npm run test                          # All tests via vitest
npm run test -- --reporter verbose    # Verbose output
npm run test -- -t "todo_config"      # Filter by test name
```

### Linting & Type Checking

```bash
npm run lint                          # ESLint (strict + stylistic)
npm run typecheck                     # tsc --noEmit
npm run check                         # lint + typecheck + test (all three)
```

### Building

```bash
npm run build                         # esbuild single-file bundle (dist/index.js)
```

### Adding New Tests

1. For Graph layer tests - use `createTestEnv()` from `test/helpers.ts`, which provides a `MockState` and running mock server
2. For integration tests - add to the relevant file in `test/integration/`. Create a `MockAuthenticator` + `createTestClient()` helper, call tools via `client.callTool()`, verify responses and side-effects in `graphState`.
3. Assert tool results via `ToolResult` - check `result.isError` and text content
4. For login flow tests - use `MockAuthenticator` with `browserLogin: true` (default) for browser login, or `browserLogin: false` to simulate browser failure

### Adding New Mock Endpoints

Add handlers to `handleRequest()` in `test/mock-graph.ts`. Follow the pattern: check auth → parse URL segments → read body if needed → update `MockState` → return JSON response. Always call `errorResponse()` for error cases.

## Adding New Tools

1. **Add Graph operations** in `src/graph/` - follow the pattern: validate inputs → call `client.request()` → parse response
2. **Register tool** in `src/tools/` - use `server.registerTool(name, { description, inputSchema, annotations }, handler)`
3. **Handler pattern**: get token via `config.authenticator.token()` → create `GraphClient(config.graphBaseUrl, token)` → call Graph operation → format response → catch `AuthenticationRequiredError` and `GraphRequestError` and return `isError: true`
4. **Register in `src/index.ts`** - add `registerXxxTools(server, config)` call in `createMcpServer()`
5. **Add tests** - both Graph layer tests and integration tests
6. **Input validation** - use `zod` schemas in `inputSchema` (the MCP SDK validates automatically)
7. Run `npm run check` (lint + typecheck + test)

## CI/CD

### CI (`ci.yml`)

Runs on push/PR to main: `npm ci` → lint → typecheck → test → build

### Release (`release.yml`)

Triggered by `v*` tags. Stamps version (without `v` prefix) into `package.json` and `manifest.json`, runs full check + build, creates MCPB bundle, generates SHA-256 checksums, and publishes a GitHub Release with the bundle and checksums.

### Environment Variables

- `GRAPHDO_GRAPH_URL` - override Graph API base URL (used in development)
- `GRAPHDO_CONFIG_DIR` - override config directory (used in tests)
- `GRAPHDO_DEBUG=true` - enable debug logging
- `GRAPHDO_ACCESS_TOKEN` - skip MSAL auth and use a static Bearer token

## Config Files

Stored in the config directory (`~/.config/graphdo-ts` on Linux, OS-appropriate elsewhere):

- `config.json` - selected todo list ID and display name
- `msal_cache.json` - MSAL token cache (managed by MSAL library)
- `account.json` - cached MSAL account info for silent token acquisition

The `GRAPHDO_CONFIG_DIR` env var overrides the directory (used in tests with temp dirs).

## Graph API Patterns

- Collections wrapped in `{"value": [...]}` - decoded with `GraphListResponse<T>`
- Pagination via `$top` and `$skip` query params
- `POST /me/sendMail` returns HTTP 202 with empty body
- `PATCH` supports partial updates (omit fields to keep unchanged; `null` clears a field)
- Errors in `{"error": {"code": "...", "message": "..."}}` → parsed into `GraphRequestError`
- TodoTask fields: `importance` ("low"/"normal"/"high"), `isReminderOn`, `reminderDateTime`, `dueDateTime`, `recurrence` (PatternedRecurrence)
- Checklist items: sub-resource at `/tasks/{taskId}/checklistItems` - full CRUD
- `ChecklistItem`: `{ id, displayName, isChecked, createdDateTime?, checkedDateTime? }`
- Recurrence uses `PatternedRecurrence { pattern: RecurrencePattern, range: RecurrenceRange }` - tools accept simplified `repeat` string ("daily"/"weekly"/"weekdays"/"monthly"/"yearly")
- Graph API v1.0 does NOT support `assignees`/`assignedTo` on todoTask or "My Day" field
