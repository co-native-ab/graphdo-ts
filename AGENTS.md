# graphdo-ts — Scoped Microsoft Graph Access for AI Agents

## What This Is

A TypeScript MCP server that gives AI agents scoped, low-risk access to Microsoft Graph API. Current capabilities cover mail and Microsoft To Do; more Graph surfaces will be added over time. Uses stdio transport and MSAL device code authentication — distributed as an MCPB bundle.

Repository: `github.com/co-native-ab/graphdo-ts`

## Architecture

```
src/
  index.ts               Stdio server entry point (StdioServerTransport)
  auth.ts                MSAL device code authentication (Authenticator interface, token cache)
  config.ts              Config struct, load/save (atomic via temp+rename), configDir()
  logger.ts              Structured logger with level filtering (debug/info/warn/error)
  graph/
    client.ts            Lightweight HTTP client (native fetch, no Graph SDK), GraphRequestError
    types.ts             TypeScript interfaces for Graph API entities
    mail.ts              getMe, sendMail
    todo.ts              TodoList/TodoItem CRUD + pagination ($top/$skip)
  tools/
    login.ts             login (MSAL device code flow) and logout MCP tools
    mail.ts              mail_send MCP tool registration
    todo.ts              todo_list, todo_show, todo_create, todo_update, todo_complete, todo_delete
    config.ts            todo_config MCP tool (list picker with human-in-the-loop)
test/
  helpers.ts             createTestEnv() — standardized test setup
  mock-graph.ts          MockState class + in-memory Graph API server (node:http)
  config.test.ts         Config persistence unit tests
  stdio.test.ts          Full e2e: real stdio server + mock Graph API
  graph/
    client.test.ts       GraphClient + GraphRequestError tests
    mail.test.ts         Mail operation tests
    todo.test.ts         Todo CRUD tests
```

## Key Design Decisions

### No Graph SDK
We use native `fetch` instead of the Microsoft Graph SDK. The `GraphClient` class wraps fetch with Bearer token injection, JSON encoding, and structured error handling via `GraphRequestError`. All Graph API interaction goes through `client.request(method, path, body?)`.

### MSAL Device Code Authentication
The server handles its own authentication using MSAL's device code flow (same as the Go `graphdo`). When the `login` tool is called, the server initiates a device code request with Azure AD, returns the user code and URL, and blocks until the user authenticates in a browser. Tokens are cached locally in the config directory (`msal_cache.json` + `account.json`) and refreshed automatically via `acquireTokenSilent`.

### Authenticator Interface
The `Authenticator` interface abstracts token acquisition: `login()`, `token()`, `logout()`, `isAuthenticated()`. Two implementations:
- `DeviceCodeAuthenticator` — production MSAL flow with file-based token cache
- `StaticAuthenticator` — for testing with a fixed token (via `GRAPHDO_ACCESS_TOKEN` env var)

### Stdio Transport
The server uses `StdioServerTransport` from the MCP SDK, communicating via stdin/stdout JSON-RPC. This is required for MCPB compatibility. Logs go to stderr.

### Config via MCP Tool
The `todo_config` tool implements a two-step human-in-the-loop flow:
1. Call without `listId` → returns available lists for the user to choose
2. Call with `listId` → saves selection to `config.json`

Config is stored in the OS config directory (`~/.config/graphdo-ts/` on Linux, `~/Library/Application Support/graphdo-ts/` on macOS, `%APPDATA%/graphdo-ts` on Windows). The `GRAPHDO_CONFIG_DIR` env var overrides this (used in tests).

### Error Handling
- **MCP tools never throw** — all errors are caught and returned as `{ isError: true, content: [{ type: "text", text: message }] }`
- `GraphRequestError` provides structured error info: method, path, statusCode, code, graphMessage
- `AuthenticationRequiredError` is thrown when no cached token is available — tools catch this and return a helpful error directing the agent to use the `login` tool
- `loadAndValidateConfig()` throws with a clear user-friendly message if config is missing

### Scopes
`Mail.Send`, `Tasks.ReadWrite`, `User.Read`, `offline_access`

## TypeScript Style Rules

- **Strict mode** — `strict: true` in tsconfig with `noUncheckedIndexedAccess`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`
- **No `any` types** — enforced by `typescript-eslint` strict + stylistic presets
- **ES modules** — all imports use `.js` extensions (e.g., `import { logger } from "./logger.js"`)
- **Early returns** — check errors and return immediately, don't nest
- **Structured logging** — `logger.debug/info/warn/error(message, context?)` with key=value pairs to stderr
- **Cross-platform** — use `node:path`, `node:os`, `node:crypto` for filesystem ops; handle win32/darwin/linux paths
- **Atomic file writes** — write to temp file then rename into place (`saveConfig`)
- **Comments** — only where clarification is needed, not on every function
- **Minimal dependencies** — only 3 runtime deps: `@modelcontextprotocol/sdk`, `zod`, `@azure/msal-node`

## Testing

### Test Architecture
Tests use vitest with two layers:
1. **Graph layer tests** (`test/graph/`) — test `GraphClient`, mail, and todo operations against the mock Graph API server
2. **Stdio integration tests** (`test/stdio.test.ts`) — full end-to-end tests: spawns the actual server process with `StdioServerTransport`, communicates via JSON-RPC over stdin/stdout pipes, verifies all tool calls against the mock Graph API, and checks side-effects in mock state

The mock Graph API server (`test/mock-graph.ts`) is a plain `node:http` server with `MockState` for in-memory state — no mocking libraries for HTTP.

Stdio tests set `GRAPHDO_ACCESS_TOKEN` (uses `StaticAuthenticator`), `GRAPHDO_GRAPH_URL`, and `GRAPHDO_CONFIG_DIR` env vars, then spawn the built `dist/index.js` as a child process. The `VITEST` env var is explicitly removed from the child so `main()` runs.

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
1. For Graph layer tests — use `createTestEnv()` from `test/helpers.ts`, which provides a `MockState` and running mock server
2. For stdio integration tests — add to `test/stdio.test.ts`. Use `sendAndReceive()` to send JSON-RPC requests and verify responses. Check side-effects in `graphState`.
3. Assert tool results via the JSON-RPC response — check `result.isError` and text content
4. Clean up with `afterAll` — kill server process, close mock graph, remove temp dirs

### Adding New Mock Endpoints
Add handlers to `handleRequest()` in `test/mock-graph.ts`. Follow the pattern: check auth → parse URL segments → read body if needed → update `MockState` → return JSON response. Always call `errorResponse()` for error cases.

## Adding New Tools

1. **Add Graph operations** in `src/graph/` — follow the pattern: validate inputs → call `client.request()` → parse response
2. **Register tool** in `src/tools/` — use `server.registerTool(name, { description, inputSchema, annotations }, handler)`
3. **Handler pattern**: call `authenticator.token()` → create `GraphClient` → call Graph operation → format response → catch `AuthenticationRequiredError` and `GraphRequestError` and return `isError: true`
4. **Register in `src/index.ts`** — add `registerXxxTools(server, authenticator)` call in `createMcpServer()`
5. **Add tests** — both Graph layer tests and stdio integration tests
6. **Input validation** — use `zod` schemas in `inputSchema` (the MCP SDK validates automatically)
7. Run `npm run check` (lint + typecheck + test)

## CI/CD

### CI (`ci.yml`)
Runs on push/PR to main: `npm ci` → lint → typecheck → test → build

### Release (`release.yml`)
Triggered by `v*` tags. Stamps version (without `v` prefix) into `package.json` and `manifest.json`, runs full check + build, creates MCPB bundle, generates SHA-256 checksums, and publishes a GitHub Release with the bundle and checksums.

### Environment Variables
- `GRAPHDO_GRAPH_URL` — override Graph API base URL (used in development)
- `GRAPHDO_CONFIG_DIR` — override config directory (used in tests)
- `GRAPHDO_DEBUG=true` — enable debug logging
- `GRAPHDO_ACCESS_TOKEN` — skip MSAL auth and use a static Bearer token

## Config Files

Stored in the config directory (`~/.config/graphdo-ts` on Linux, OS-appropriate elsewhere):
- `config.json` — selected todo list ID and display name
- `msal_cache.json` — MSAL token cache (managed by MSAL library)
- `account.json` — cached MSAL account info for silent token acquisition

The `GRAPHDO_CONFIG_DIR` env var overrides the directory (used in tests with temp dirs).

## Graph API Patterns

- Collections wrapped in `{"value": [...]}` — decoded with `GraphListResponse<T>`
- Pagination via `$top` and `$skip` query params
- `POST /me/sendMail` returns HTTP 202 with empty body
- `PATCH` supports partial updates (omit fields to keep unchanged)
- Errors in `{"error": {"code": "...", "message": "..."}}` → parsed into `GraphRequestError`
