# graphdo-ts — Scoped Microsoft Graph Access for AI Agents

## What This Is

A TypeScript MCP server that gives AI agents scoped, low-risk access to Microsoft Graph API. Current capabilities cover mail and Microsoft To Do; more Graph surfaces will be added over time. Pure server (no CLI) — distributed as an MCPB bundle. OAuth is delegated to the MCP client; the server receives Bearer tokens and forwards them to Graph API.

Repository: `github.com/co-native-ab/graphdo-ts`

## Architecture

```
src/
  index.ts               HTTP server entry point (Streamable HTTP transport)
  auth.ts                JWT token validation (jose + Azure AD JWKS), Protected Resource Metadata
  config.ts              Config struct, load/save (atomic via temp+rename), configDir()
  logger.ts              Structured logger with level filtering (debug/info/warn/error)
  graph/
    client.ts            Lightweight HTTP client (native fetch, no Graph SDK), GraphRequestError
    types.ts             TypeScript interfaces for Graph API entities
    mail.ts              getMe, sendMail
    todo.ts              TodoList/TodoItem CRUD + pagination ($top/$skip)
  tools/
    mail.ts              mail_send MCP tool registration
    todo.ts              todo_list, todo_show, todo_create, todo_update, todo_complete, todo_delete
    config.ts            todo_config MCP tool (list picker with human-in-the-loop)
test/
  helpers.ts             createTestEnv() — standardized test setup
  mock-graph.ts          MockState class + in-memory Graph API server (node:http)
  mock-oidc.ts           Mock OIDC provider — RSA key gen, JWKS endpoint, JWT signing
  config.test.ts         Config persistence unit tests
  auth.test.ts           Token validation unit tests (jose + mock OIDC)
  integration.test.ts    Full e2e: real HTTP server + MCP client + mock Graph + mock OIDC
  graph/
    client.test.ts       GraphClient + GraphRequestError tests
    mail.test.ts         Mail operation tests
    todo.test.ts         Todo CRUD tests
```

## Key Design Decisions

### No Graph SDK
We use native `fetch` instead of the Microsoft Graph SDK. The `GraphClient` class wraps fetch with Bearer token injection, JSON encoding, and structured error handling via `GraphRequestError`. All Graph API interaction goes through `client.request(method, path, body?)`. The client is created per-request with the token extracted from MCP `authInfo`.

### OAuth Delegated to MCP Client
The server never handles OAuth flows. MCP clients provide Bearer tokens via the `Authorization` header. The server validates tokens using `jose` against Azure AD's JWKS endpoint — checking signature, expiry, issuer pattern, audience (`https://graph.microsoft.com`), and authorized party (our client ID). Valid tokens are then forwarded to Graph API. If no token is present, the server returns 401 with a `WWW-Authenticate` header pointing to `/.well-known/oauth-protected-resource` (RFC 9728), which tells the client which authorization server and scopes to use.

### Streamable HTTP Transport
The server uses MCP Streamable HTTP transport on `/mcp`. Sessions are tracked in a `Map<string, StreamableHTTPServerTransport>`. Each POST with an `initialize` request creates a new session; subsequent requests use the `Mcp-Session-Id` header. A new `McpServer` is created per session with all tools registered.

### Config via MCP Tool
The `todo_config` tool implements a two-step human-in-the-loop flow:
1. Call without `listId` → returns available lists for the user to choose
2. Call with `listId` → saves selection to `config.json`

Config is stored in the OS config directory (`~/.config/graphdo-ts/` on Linux, `~/Library/Application Support/graphdo-ts/` on macOS, `%APPDATA%/graphdo-ts` on Windows). The `GRAPHDO_CONFIG_DIR` env var overrides this (used in tests).

### Error Handling
- **MCP tools never throw** — all errors are caught and returned as `{ isError: true, content: [{ type: "text", text: message }] }`
- `GraphRequestError` provides structured error info: method, path, statusCode, code, graphMessage
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
- **Minimal dependencies** — only 5 runtime deps: `@modelcontextprotocol/sdk`, `zod`, `express`, `cors`, `jose`

## Testing

### Test Architecture
Tests use vitest with three layers:
1. **Graph layer tests** (`test/graph/`) — test `GraphClient`, mail, and todo operations against the mock Graph API server
2. **Integration tests** (`test/integration.test.ts`) — full end-to-end tests with real HTTP server, real MCP client (`StreamableHTTPClientTransport`), mock Graph API, and mock OIDC provider. Tests the entire flow: discovery, authentication, tool calls, and side-effects in mock state.
3. **Auth unit tests** (`test/auth.test.ts`) — test JWT token validation in isolation via mock OIDC provider (expired tokens, wrong keys, wrong issuer/audience/azp, malformed tokens)

The mock Graph API server (`test/mock-graph.ts`) is a plain `node:http` server with `MockState` for in-memory state — no mocking libraries for HTTP.

The mock OIDC provider (`test/mock-oidc.ts`) generates an RSA key pair, serves JWKS over HTTP, and provides a `signToken(overrides?)` helper for creating valid and invalid JWTs.

Integration tests set `GRAPHDO_GRAPH_URL` and `GRAPHDO_CONFIG_DIR` env vars before dynamically importing the server module, then start the server with a mock token validator. The MCP client connects over real HTTP with signed JWT tokens.

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
2. For integration tests — add to `test/integration.test.ts`. Use `createAuthenticatedClient()` to get a connected MCP client. Call tools via `client.callTool()` and verify side-effects in `graphState`.
3. Assert tool results via `client.callTool()` — check `result.isError` and text content
4. Clean up with `afterAll` — close MCP clients, stop servers, remove temp dirs

### Adding New Mock Endpoints
Add handlers to `handleRequest()` in `test/mock-graph.ts`. Follow the pattern: check auth → parse URL segments → read body if needed → update `MockState` → return JSON response. Always call `errorResponse()` for error cases.

## Adding New Tools

1. **Add Graph operations** in `src/graph/` — follow the pattern: validate inputs → call `client.request()` → parse response
2. **Register tool** in `src/tools/` — use `server.registerTool(name, { description, inputSchema, annotations }, handler)`
3. **Handler pattern**: extract token from `extra.authInfo?.token` → return error if missing → create `GraphClient` → call Graph operation → format response → catch all errors and return `isError: true`
4. **Register in `src/index.ts`** — add `registerXxxTools(server)` call in `handlePost()` where the per-session server is created
5. **Add tests** — both Graph layer tests and MCP tool integration tests
6. **Input validation** — use `zod` schemas in `inputSchema` (the MCP SDK validates automatically)
7. Run `npm run check` (lint + typecheck + test)

## CI/CD

### CI (`ci.yml`)
Runs on push/PR to main: `npm ci` → lint → typecheck → test → build

### Environment Variables
- `GRAPHDO_GRAPH_URL` — override Graph API base URL (used in development)
- `GRAPHDO_CONFIG_DIR` — override config directory (used in tests)
- `GRAPHDO_DEBUG=true` — enable debug logging
- `PORT` — HTTP server port (default: 3000)

## Config Files

Stored in the config directory (`~/.config/graphdo-ts` on Linux, OS-appropriate elsewhere):
- `config.json` — selected todo list ID and display name

The `GRAPHDO_CONFIG_DIR` env var overrides the directory (used in tests with temp dirs).

## Graph API Patterns

- Collections wrapped in `{"value": [...]}` — decoded with `GraphListResponse<T>`
- Pagination via `$top` and `$skip` query params
- `POST /me/sendMail` returns HTTP 202 with empty body
- `PATCH` supports partial updates (omit fields to keep unchanged)
- Errors in `{"error": {"code": "...", "message": "..."}}` → parsed into `GraphRequestError`
