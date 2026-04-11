# Technical Debt Remediation Plan

> Generated from analysis of graphdo-ts codebase (6,336 LoC, 144 tests passing)

---

## Summary Table

| # | Item | Priority | Effort | Impact | Risk | Category | Status |
|---|------|----------|--------|--------|------|----------|--------|
| 1 | [No runtime validation of Graph API responses](#1-no-runtime-validation-of-graph-api-responses) | P0 | M | 🔴 High | 🔴 High | Type Safety | ✅ Resolved (PR #6) |
| 2 | [No request timeout on Graph API calls](#2-no-request-timeout-on-graph-api-calls) | P0 | S | 🔴 High | 🔴 High | Error Handling | ✅ Resolved (PR #6) |
| 3 | [No retry logic for transient Graph API errors](#3-no-retry-logic-for-transient-graph-api-errors) | P1 | M | 🔴 High | 🟡 Medium | Error Handling | ✅ Resolved (PR #6) |
| 4 | [Duplicated `isNodeError` utility function](#4-duplicated-isnodeerror-utility-function) | P2 | S | 🟢 Low | 🟢 Low | Code Quality | ✅ Resolved (PR #6) |
| 5 | [Inconsistent error formatting across tools](#5-inconsistent-error-formatting-across-tools) | P2 | S | 🟡 Medium | 🟢 Low | Code Quality | ✅ Resolved (PR #6) |
| 6 | [No unit tests for `browser.ts`](#6-no-unit-tests-for-browserts) | P2 | S | 🟡 Medium | 🟡 Medium | Test Coverage | ✅ Resolved (PR #5) |
| 7 | [No unit tests for `logger.ts`](#7-no-unit-tests-for-loggerts) | P2 | S | 🟢 Low | 🟢 Low | Test Coverage | ✅ Resolved (PR #6) |
| 8 | [No unit tests for `auth.ts` MsalAuthenticator](#8-no-unit-tests-for-authts-msalauthenticator) | P1 | L | 🔴 High | 🟡 Medium | Test Coverage | ✅ Resolved (PR #6) |
| 9 | [`tools/todo.ts` is oversized at 758 lines](#9-toolstodots-is-oversized-at-758-lines) | P2 | M | 🟡 Medium | 🟢 Low | Maintainability | ✅ Resolved (PR #6) |
| 10 | [Inline HTML templates mixed with server logic](#10-inline-html-templates-mixed-with-server-logic) | P3 | M | 🟡 Medium | 🟢 Low | Maintainability | ✅ Resolved (PR #6) |
| 11 | [Graph API response types use `string` for enums](#11-graph-api-response-types-use-string-for-enums) | P2 | S | 🟡 Medium | 🟢 Low | Type Safety | ✅ Resolved (PR #6) |
| 12 | [Node.js version inconsistency across configs](#12-nodejs-version-inconsistency-across-configs) | P1 | S | 🟡 Medium | 🟡 Medium | Dependency Mgmt | ✅ Resolved (PR #7) |
| 13 | [No automated dependency update configuration](#13-no-automated-dependency-update-configuration) | P1 | S | 🟡 Medium | 🟡 Medium | Dependency Mgmt | ✅ Resolved (PR #7) |
| 14 | [No `CONTRIBUTING.md` or `CHANGELOG.md`](#14-no-contributingmd-or-changelogmd) | P3 | S | 🟢 Low | 🟢 Low | Documentation | ✅ Resolved (PR #7) |
| 15 | [GraphClient created per tool call — no reuse](#15-graphclient-created-per-tool-call--no-reuse) | P3 | M | 🟢 Low | 🟢 Low | Performance | ✅ Resolved (PR #6) |
| 16 | [No body size limit in picker `handleSelection`](#16-no-body-size-limit-in-picker-handleselection) | P1 | S | 🟡 Medium | 🟡 Medium | Security | ✅ Resolved (PR #7) |
| 17 | [No `engines` field in `package.json`](#17-no-engines-field-in-packagejson) | P2 | S | 🟢 Low | 🟢 Low | Dependency Mgmt | ✅ Resolved (PR #7) |
| 18 | [`loadConfig` JSON parse lacks runtime validation](#18-loadconfig-json-parse-lacks-runtime-validation) | P2 | S | 🟡 Medium | 🟢 Low | Type Safety | ✅ Resolved (PR #7) |
| 19 | [No test coverage reporting in CI](#19-no-test-coverage-reporting-in-ci) | P2 | S | 🟡 Medium | 🟢 Low | Test Coverage | ✅ Resolved (PR #7) |
| 20 | [No `$filter`/`$orderby` support for todo listing](#20-no-filterorderby-support-for-todo-listing) | P3 | M | 🟢 Low | 🟢 Low | Feature Gap | ✅ Resolved (PR #7) |
| 21 | [eslint-disable for non-null assertion in loopback.ts](#21-eslint-disable-for-non-null-assertion-in-loopbackts) | P3 | S | 🟢 Low | 🟢 Low | Code Quality | ✅ Resolved (PR #7) |
| 22 | [Integration test file is 1,249 lines](#22-integration-test-file-is-1249-lines) | P3 | M | 🟡 Medium | 🟢 Low | Maintainability | ✅ Resolved (PR #7) |

---

## Detailed Plans

---

### 1. No runtime validation of Graph API responses

**Priority:** P0 · **Effort:** M · **Impact:** 🔴 High · **Risk:** 🔴 High

**Overview:** All Graph API response bodies are deserialized with bare `as` type assertions (e.g., `(await response.json()) as User`, `as GraphListResponse<TodoItem>`). There is zero runtime validation that the response matches the expected shape.

**Explanation:** If Microsoft changes the Graph API response shape, adds a new envelope wrapper, or returns an unexpected error format, the code will silently produce corrupted data rather than failing with a clear error. This is the most significant type safety gap in the codebase — it affects every Graph operation (`mail.ts`, `todo.ts`, `client.ts`).

**Requirements:**
- Zod is already a dependency (used for tool input schemas)
- No new dependencies needed

**Implementation Steps:**
1. Create Zod schemas in `src/graph/types.ts` for each response type: `User`, `TodoList`, `TodoItem`, `ChecklistItem`, `GraphListResponse<T>`
2. Create a generic `parseResponse<T>(response: Response, schema: ZodType<T>): Promise<T>` helper in `client.ts`
3. Replace all `(await response.json()) as T` calls with `await parseResponse(response, tSchema)`
4. Throw a descriptive error (e.g., `GraphResponseParseError`) when validation fails, including the raw body for debugging
5. Also validate `loadAccount` JSON parse in `auth.ts` (currently `as msal.AccountInfo`)

**Testing:**
- Add unit tests in `test/graph/client.test.ts` for malformed response bodies
- Add test cases for missing fields, wrong types, and extra fields
- Verify error messages include the path and field that failed

---

### 2. No request timeout on Graph API calls

**Priority:** P0 · **Effort:** S · **Impact:** 🔴 High · **Risk:** 🔴 High

**Overview:** `GraphClient.request()` calls `fetch()` with no timeout. If the Graph API hangs or a network partition occurs, the MCP server will hang indefinitely.

**Explanation:** The native `fetch` API has no built-in timeout. An MCP tool call that makes a Graph request could block forever if the network is unreachable or the API is unresponsive. This would make the entire MCP server appear frozen to the client.

**Requirements:**
- Node.js 18+ `AbortSignal.timeout()` is available (already targeting Node 22+)

**Implementation Steps:**
1. Add a `timeoutMs` parameter to `GraphClient` constructor (default: 30,000ms)
2. Use `AbortSignal.timeout(this.timeoutMs)` in the `fetch` call's `signal` option
3. Catch `AbortError` and throw a descriptive `GraphRequestError` with a timeout-specific message
4. Expose the timeout in `ServerConfig` for testability (tests can use a shorter timeout)

**Testing:**
- Add a test in `test/graph/client.test.ts` using a mock server that never responds
- Verify the error message clearly indicates a timeout
- Verify the timeout duration is configurable

---

### 3. No retry logic for transient Graph API errors

**Priority:** P1 · **Effort:** M · **Impact:** 🔴 High · **Risk:** 🟡 Medium

**Overview:** All Graph API errors are treated as terminal. HTTP 429 (Too Many Requests) and 503 (Service Unavailable) responses immediately throw `GraphRequestError` with no retry.

**Explanation:** Microsoft Graph API has documented rate limits and occasional transient failures. The API returns a `Retry-After` header with 429 responses. Without retry logic, bursts of todo operations or temporary service degradation will surface as hard errors to the AI agent, degrading user experience.

**Requirements:**
- No new dependencies — implement a simple exponential backoff

**Implementation Steps:**
1. Add a `retryableStatusCodes` set to `GraphClient`: `{429, 503, 504}`
2. Implement a retry loop in `GraphClient.request()` with configurable `maxRetries` (default: 3)
3. Parse the `Retry-After` header when present; otherwise use exponential backoff (1s, 2s, 4s)
4. Log each retry attempt at `info` level with the retry count and delay
5. After exhausting retries, throw the original `GraphRequestError`

**Testing:**
- Add tests in `test/graph/client.test.ts` with a mock server that returns 429 then 200
- Test `Retry-After` header parsing
- Test that non-retryable errors (400, 404) are not retried
- Test max retry exhaustion

---

### 4. Duplicated `isNodeError` utility function

**Priority:** P2 · **Effort:** S · **Impact:** 🟢 Low · **Risk:** 🟢 Low

**Overview:** The `isNodeError(err: unknown): err is NodeJS.ErrnoException` type guard is defined identically in both `src/auth.ts` (line 19) and `src/config.ts` (line 127).

**Explanation:** A minor DRY violation. While it's a small function, duplication means both copies must be kept in sync. This is a quick win that demonstrates codebase hygiene.

**Requirements:** None

**Implementation Steps:**
1. Create a `src/errors.ts` module exporting `isNodeError`
2. Import it in `auth.ts` and `config.ts`, removing the local definitions
3. Consider also moving `AuthenticationRequiredError` to this module for a central error registry

**Testing:**
- Existing tests cover both call sites — no new tests needed
- Run full `npm run check` to verify

---

### 5. Inconsistent error formatting across tools

**Priority:** P2 · **Effort:** S · **Impact:** 🟡 Medium · **Risk:** 🟢 Low

**Overview:** `src/tools/todo.ts` has a shared `formatError` helper, but `src/tools/mail.ts`, `src/tools/login.ts`, `src/tools/config.ts`, and `src/tools/status.ts` each inline their own error-to-MCP-result conversion pattern.

**Explanation:** The error handling pattern is repeated 15+ times across tool files: catch error, check `AuthenticationRequiredError`, extract message, log, return `{ isError: true, content }`. This inconsistency means new tools may miss edge cases (e.g., forgetting to check for `AuthenticationRequiredError`).

**Requirements:** None

**Implementation Steps:**
1. Extract the `formatError` function from `tools/todo.ts` into a shared `src/tools/shared.ts` or `src/tools/utils.ts`
2. Generalize it to also handle the `GraphRequestError` case explicitly (for richer error messages)
3. Replace all inline error-catch blocks in `mail.ts`, `login.ts`, `config.ts`, `status.ts` with the shared function
4. Consider also extracting the common `token + GraphClient` setup into a shared helper

**Testing:**
- Existing integration tests already cover error paths
- Add a focused unit test for `formatError` with each error subclass

---

### 6. No unit tests for `browser.ts`

**Priority:** P2 · **Effort:** S · **Impact:** 🟡 Medium · **Risk:** 🟡 Medium

**Overview:** `src/browser.ts` has no dedicated test file. The `openBrowser` function is always stubbed/mocked in tests.

**Explanation:** The function contains security-sensitive logic: URL validation (protocol allowlist), cross-platform command selection, Windows command injection prevention (`safeUrl` double-quote stripping). These code paths are not exercised by any test.

**Requirements:** None

**Implementation Steps:**
1. Create `test/browser.test.ts`
2. Test URL validation: reject non-http/https protocols (`javascript:`, `file:`, `data:`)
3. Test URL validation: reject invalid URLs
4. Test the Windows double-quote stripping in `safeUrl`
5. Use `vi.mock("node:child_process")` to mock `execFile`/`exec` and verify the correct command and arguments are passed per platform

**Testing:**
- Platform-specific behavior can be tested by mocking `os.platform()`
- Verify `execFile` is used (no shell) on macOS/Linux
- Verify `exec` is used on Windows with properly escaped URL

---

### 7. No unit tests for `logger.ts`

**Priority:** P2 · **Effort:** S · **Impact:** 🟢 Low · **Risk:** 🟢 Low

**Overview:** `src/logger.ts` has no test coverage. The structured logging format, level filtering, and context serialization are untested.

**Explanation:** While the logger is simple, it has specific formatting behavior (ISO timestamp, level tags, key=value context pairs) and level filtering logic that should be verified.

**Requirements:** None

**Implementation Steps:**
1. Create `test/logger.test.ts`
2. Mock `console.error` and verify output format
3. Test level filtering: setting level to `warn` should suppress `debug` and `info`
4. Test context formatting: verify key=value pairs are serialized correctly
5. Test `setLogLevel` actually changes filtering behavior

**Testing:**
- Use `vi.spyOn(console, 'error')` to capture output
- Verify timestamp format, level tags, and context pairs

---

### 8. No unit tests for `auth.ts` MsalAuthenticator

**Priority:** P1 · **Effort:** L · **Impact:** 🔴 High · **Risk:** 🟡 Medium

**Overview:** `MsalAuthenticator` is the production authentication implementation (417 lines) with zero direct test coverage. Only `MockAuthenticator` and `StaticAuthenticator` are tested.

**Explanation:** The MSAL integration includes complex logic: file-based cache plugin, account persistence, browser login with timeout, token acquisition with silent refresh, and logout cleanup. All of this is only exercised through the mock in tests. A regression in the cache plugin or login flow would not be caught by the test suite.

**Requirements:**
- Need to mock `@azure/msal-node` module
- Need temp directories for cache file testing

**Implementation Steps:**
1. Create `test/auth.test.ts`
2. Test `createFileCachePlugin`: verify cache file creation, reads, ENOENT handling, and mode `0o600`
3. Test `saveAccount` / `loadAccount`: round-trip, ENOENT handling, file permissions
4. Test `MsalAuthenticator.login()`: mock `PublicClientApplication` to verify browser login succeeds and saves account; verify error is thrown when browser login fails
5. Test `MsalAuthenticator.token()`: mock silent acquisition, `InteractionRequiredAuthError` → `AuthenticationRequiredError`
6. Test `MsalAuthenticator.logout()`: verify cache files are deleted, ENOENT ignored
7. Test `MsalAuthenticator.isAuthenticated()`: returns true/false based on token availability
8. Test `StaticAuthenticator`: all methods (trivial but complete coverage)

**Testing:**
- Use `vi.mock("@azure/msal-node")` for MSAL mocking
- Use temp directories for file operations
- Verify `pendingLogin` state transitions

---

### 9. `tools/todo.ts` is oversized at 758 lines

**Priority:** P2 · **Effort:** M · **Impact:** 🟡 Medium · **Risk:** 🟢 Low

**Overview:** `src/tools/todo.ts` is the largest source file at 758 lines, containing 11 tool registrations, formatting helpers, recurrence parsing, and date handling.

**Explanation:** While each individual tool handler is reasonable, the aggregate makes the file hard to navigate. The helper functions (`formatRecurrence`, `parseRecurrence`, `parseDateTimeTimeZone`, `formatDate`, `statusEmoji`, etc.) are reusable logic that should be separated from the MCP tool wiring.

**Requirements:** None

**Implementation Steps:**
1. Extract formatting helpers (`statusEmoji`, `statusLabel`, `importanceLabel`, `formatDate`, `formatRecurrence`) into `src/tools/todo-format.ts`
2. Extract recurrence/date parsing (`parseRecurrence`, `currentDayOfWeek`, `parseDateTimeTimeZone`) into `src/tools/todo-parse.ts`
3. Keep `src/tools/todo.ts` as the registration file that imports from both
4. Consider splitting checklist step tools into `src/tools/todo-steps.ts`

**Testing:**
- Add focused unit tests for the extracted formatting/parsing functions
- Existing integration tests continue to provide end-to-end coverage
- `parseRecurrence` with various inputs should have explicit unit tests

---

### 10. Inline HTML templates mixed with server logic

**Priority:** P3 · **Effort:** M · **Impact:** 🟡 Medium · **Risk:** 🟢 Low

**Overview:** `src/loopback.ts` (347 lines) and `src/picker.ts` (300 lines) contain large inline HTML template strings mixed with HTTP server logic.

**Explanation:** The HTML templates (landing page, success page, error page, picker page) are embedded as template literals directly in the TypeScript files. This makes them hard to syntax-highlight, lint, or modify without risking logic errors. The `BASE_STYLE` constant is shared in `loopback.ts` but duplicated conceptually in `picker.ts`.

**Requirements:** None

**Implementation Steps:**
1. Create `src/templates/` directory
2. Move HTML generation functions into `src/templates/login.ts` and `src/templates/picker.ts`
3. Extract shared CSS (`BASE_STYLE` and similar) into `src/templates/styles.ts`
4. Import template functions from the server files
5. Keep the HTTP server logic clean — just routing and calling template generators

**Testing:**
- Existing loopback and picker tests already verify HTML content
- No new tests required — just verify existing tests still pass

---

### 11. Graph API response types use `string` for enums

**Priority:** P2 · **Effort:** S · **Impact:** 🟡 Medium · **Risk:** 🟢 Low

**Overview:** In `src/graph/types.ts`, fields like `status`, `importance`, `contentType`, `RecurrencePattern.type`, and `RecurrenceRange.type` are typed as `string` instead of string literal unions.

**Explanation:** Using `string` loses type safety at call sites. For example, `item.status === "completed"` compiles even if someone misspells `"complted"`. String literal unions would enable IDE autocompletion and catch typos at compile time.

**Requirements:** None

**Implementation Steps:**
1. Define literal types:
   - `TodoStatus = "notStarted" | "completed" | "inProgress" | "waitingOnOthers" | "deferred"`
   - `Importance = "low" | "normal" | "high"`
   - `BodyContentType = "text" | "html"`
   - `RecurrencePatternType = "daily" | "weekly" | "absoluteMonthly" | "relativeMonthly" | "absoluteYearly" | "relativeYearly"`
   - `RecurrenceRangeType = "noEnd" | "endDate" | "numbered"`
2. Update the interfaces to use these types
3. Update the Zod schemas and helper functions accordingly

**Testing:**
- Compile-time only — `npm run typecheck` verifies correctness
- Existing tests continue to pass

---

### 12. Node.js version inconsistency across configs

**Priority:** P1 · **Effort:** S · **Impact:** 🟡 Medium · **Risk:** 🟡 Medium

**Overview:** Three different Node.js versions are referenced:
- `manifest.json` compatibility: `node >= 18.0.0`
- `build.mjs` esbuild target: `node22`
- `README.md`: "Node.js 24+"
- CI workflow: `node-version: 24`

**Explanation:** A user running Node.js 18 would see the MCPB bundle claim compatibility, but the code targets Node 22 features. The README says 24+ but the build targets 22. This inconsistency can cause confusing runtime errors.

**Requirements:** None

**Implementation Steps:**
1. Decide on the minimum Node.js version (recommend Node.js 22 as the LTS baseline)
2. Update `manifest.json`: `"node": ">=22.0.0"`
3. Keep `build.mjs` target at `node22`
4. Update `README.md` to say "Node.js 22+"
5. Optionally add `.nvmrc` or `.node-version` file with `22`

**Testing:**
- Verify CI still passes
- Verify the MCPB bundle works on Node.js 22

---

### 13. No automated dependency update configuration

**Priority:** P1 · **Effort:** S · **Impact:** 🟡 Medium · **Risk:** 🟡 Medium

**Overview:** There is no Dependabot, Renovate, or other automated dependency update configuration. All three runtime deps (`@azure/msal-node`, `@modelcontextprotocol/sdk`, `zod`) and six dev deps must be updated manually.

**Explanation:** `@azure/msal-node` receives security patches regularly. The MCP SDK is actively evolving. Without automated updates, the project risks falling behind on security patches and API changes.

**Requirements:** GitHub repository access

**Implementation Steps:**
1. Create `.github/dependabot.yml` with npm ecosystem config
2. Set update schedule to weekly
3. Group minor/patch updates to reduce PR noise
4. Set `open-pull-requests-limit` to a reasonable number (e.g., 10)
5. Pin GitHub Actions dependencies by SHA (already done in CI — good)

**Testing:**
- Verify Dependabot creates PRs on the next cycle
- CI pipeline already validates PRs via the `check` job

---

### 14. No `CONTRIBUTING.md` or `CHANGELOG.md`

**Priority:** P3 · **Effort:** S · **Impact:** 🟢 Low · **Risk:** 🟢 Low

**Overview:** The project has thorough `README.md` and `AGENTS.md` but lacks standard open-source contribution documentation.

**Explanation:** The `AGENTS.md` is excellent for AI agents but not a substitute for human contributor documentation. There's no guidance on branching strategy, PR process, commit conventions, or code style beyond what's inferred from ESLint config. No `CHANGELOG.md` means users must rely on GitHub release notes for version history.

**Requirements:** None

**Implementation Steps:**
1. Create `CONTRIBUTING.md` covering: dev setup, branching model, PR process, coding standards, test requirements
2. Create `CHANGELOG.md` using Keep a Changelog format
3. Consider automating changelog generation from conventional commits or GitHub release notes
4. Add a link from `README.md` to `CONTRIBUTING.md`

**Testing:** N/A — documentation only

---

### 15. GraphClient created per tool call — no reuse

**Priority:** P3 · **Effort:** M · **Impact:** 🟢 Low · **Risk:** 🟢 Low

**Overview:** Every MCP tool handler creates a new `GraphClient` instance: `const token = await config.authenticator.token(); const client = new GraphClient(config.graphBaseUrl, token);`. This is repeated 11+ times across tool files.

**Explanation:** While `GraphClient` is lightweight (just stores baseUrl + token), the pattern creates unnecessary boilerplate and means every tool handler must independently manage token acquisition. A factory or caching wrapper could reduce this. However, since tokens can expire/refresh, per-call creation is actually correct behavior for token freshness — the issue is purely the boilerplate.

**Requirements:** None

**Implementation Steps:**
1. Create a `createAuthenticatedClient(config: ServerConfig): Promise<GraphClient>` helper in `src/tools/shared.ts`
2. Encapsulates `config.authenticator.token()` + `new GraphClient()` in one call
3. Replace all 11+ instances across tool files
4. This also centralizes the point where `AuthenticationRequiredError` would be thrown

**Testing:**
- Existing integration tests provide full coverage
- No behavioral change — purely a refactor

---

### 16. No body size limit in picker `handleSelection`

**Priority:** P1 · **Effort:** S · **Impact:** 🟡 Medium · **Risk:** 🟡 Medium

**Overview:** In `src/picker.ts` `handleSelection()` (line 252), the request body is accumulated without any size limit: `body += chunk.toString()`. The same pattern exists in `mock-graph.ts` `readBody()`.

**Explanation:** The picker server listens on `127.0.0.1` which limits exposure, but a local process could still send a multi-GB POST body to exhaust memory. This is a defense-in-depth concern — the loopback binding already provides significant protection.

**Requirements:** None

**Implementation Steps:**
1. Add a `MAX_BODY_SIZE` constant (e.g., 1MB — more than enough for a JSON selection)
2. In `handleSelection`, track accumulated size and abort with 413 if exceeded
3. Apply the same pattern to `readBody` in the test mock (less critical but good practice)
4. Return a `413 Payload Too Large` response when exceeded

**Testing:**
- Add a test in `test/picker.test.ts` that sends a POST body exceeding the limit
- Verify 413 response and that memory usage stays bounded

---

### 17. No `engines` field in `package.json`

**Priority:** P2 · **Effort:** S · **Impact:** 🟢 Low · **Risk:** 🟢 Low

**Overview:** `package.json` does not declare `"engines": { "node": ">=22" }`. Users who install via npm won't get a warning if they're using an incompatible Node.js version.

**Explanation:** This is a simple metadata gap. Combined with item #12 (version inconsistency), it means there's no programmatic guard against running on an unsupported Node.js version.

**Requirements:** None

**Implementation Steps:**
1. Add `"engines": { "node": ">=22.0.0" }` to `package.json`
2. Optionally add `"engineStrict": true` to `.npmrc` for enforcement during development

**Testing:**
- Verify `npm install` still works
- Verify `npm run check` still passes

---

### 18. `loadConfig` JSON parse lacks runtime validation

**Priority:** P2 · **Effort:** S · **Impact:** 🟡 Medium · **Risk:** 🟢 Low

**Overview:** `loadConfig()` in `config.ts` parses the JSON and casts with `JSON.parse(content) as Config`. The separate `validateConfig()` exists but is only called in `loadAndValidateConfig()`. Any code that calls `loadConfig()` directly (e.g., `status.ts` line 52) gets an unvalidated result.

**Explanation:** If the config file is manually edited or corrupted, `loadConfig()` callers that don't validate will silently work with malformed data. The `status.ts` tool calls `loadConfig()` directly and displays potentially corrupted values.

**Requirements:** None

**Implementation Steps:**
1. Create a Zod schema for `Config` in `config.ts`
2. Validate inside `loadConfig()` after JSON parse — throw a descriptive error for invalid shape
3. Remove the separate `validateConfig()` type guard (it becomes redundant)
4. Or alternatively: make `loadConfig()` return `Config | null` with validated data, and keep `loadAndValidateConfig()` for the "must exist" case

**Testing:**
- Existing `config.test.ts` already tests invalid JSON
- Add tests for: valid JSON but wrong shape (e.g., `{ "foo": 123 }`)
- Add test for: partial config (e.g., missing `todoListName`)

---

### 19. No test coverage reporting in CI

**Priority:** P2 · **Effort:** S · **Impact:** 🟡 Medium · **Risk:** 🟢 Low

**Overview:** Vitest is configured with v8 coverage provider (`vitest.config.ts` line 10) but CI (`ci.yml`) runs `npm run test` without `--coverage`. There's no coverage threshold or reporting.

**Explanation:** Without coverage data in CI, there's no visibility into which code paths are tested and no gate to prevent coverage regression. The current 144 tests are strong, but it's unknown what percentage of source code is actually covered.

**Requirements:** None

**Implementation Steps:**
1. Update the `test` script or add a `test:coverage` script: `vitest run --coverage`
2. Add coverage thresholds to `vitest.config.ts`: `coverage: { thresholds: { lines: 80, branches: 70, functions: 80 } }`
3. Update `ci.yml` to run with coverage and upload the report as an artifact
4. Consider adding a coverage badge to `README.md`

**Testing:**
- Run `npm run test -- --coverage` locally to establish baseline
- Verify CI fails when thresholds are breached

---

### 20. No `$filter`/`$orderby` support for todo listing

**Priority:** P3 · **Effort:** M · **Impact:** 🟢 Low · **Risk:** 🟢 Low

**Overview:** The `todo_list` tool only supports `$top` and `$skip` pagination. The Graph API supports `$filter` (e.g., filter by status or importance) and `$orderby` (e.g., sort by due date), but these are not exposed.

**Explanation:** AI agents frequently want to list "incomplete todos" or "todos due this week." Without filter support, the agent must fetch all todos and filter client-side, which is inefficient and hits pagination limits.

**Requirements:**
- Graph API v1.0 supports `$filter` and `$orderby` on todoTasks

**Implementation Steps:**
1. Add optional `filter` and `orderBy` parameters to the `todo_list` tool's input schema
2. Update `listTodos()` in `src/graph/todo.ts` to accept and pass through these query params
3. Document supported filter expressions in the tool description
4. Update mock server to support basic `$filter` parsing (or at minimum pass-through)

**Testing:**
- Add tests with `$filter=status eq 'notStarted'`
- Add tests with `$orderby=dueDateTime/dateTime`
- Test invalid filter expressions return Graph API errors gracefully

---

### 21. eslint-disable for non-null assertion in loopback.ts

**Priority:** P3 · **Effort:** S · **Impact:** 🟢 Low · **Risk:** 🟢 Low

**Overview:** `src/loopback.ts` line 53 uses `// eslint-disable-next-line @typescript-eslint/no-non-null-assertion` for `this.server!.listen()`.

**Explanation:** The non-null assertion is used because `this.server` is assigned on the line above but TypeScript can't narrow it inside the callback. This is a minor code smell that could be avoided by extracting the server to a local variable.

**Requirements:** None

**Implementation Steps:**
1. Assign `this.server` to a local `const server` before using it
2. Use `server.listen(...)` instead of `this.server!.listen(...)`
3. Remove the `eslint-disable` comment

**Testing:**
- Existing loopback tests provide full coverage
- Run `npm run lint` to verify the disable comment is no longer needed

---

### 22. Integration test file is 1,249 lines

**Priority:** P3 · **Effort:** M · **Impact:** 🟡 Medium · **Risk:** 🟢 Low

**Overview:** `test/integration.test.ts` at 1,249 lines is the largest file in the entire codebase, covering tool discovery, login flows, mail, todo config, todo CRUD, enhanced features, checklist items, error handling, and status.

**Explanation:** While a single integration test file is common, this size makes it hard to navigate and increases merge conflict risk when multiple features are developed in parallel. The file also contains helper function definitions (`createTestClient`, `firstText`) that could be shared.

**Requirements:** None

**Implementation Steps:**
1. Split into focused integration test files:
   - `test/integration/login.test.ts` — login flows
   - `test/integration/mail.test.ts` — mail operations
   - `test/integration/todo.test.ts` — todo CRUD + enhanced features
   - `test/integration/config.test.ts` — todo config browser picker
   - `test/integration/status.test.ts` — auth status tool
2. Extract shared setup (`createTestClient`, graph server init) into `test/integration/helpers.ts`
3. Use vitest's `beforeAll`/`afterAll` with shared server state across files
4. Update `vitest.config.ts` include pattern if needed

**Testing:**
- All 52 integration tests must continue passing
- Verify no test isolation issues from shared state

---

## Priority Guide

| Priority | Meaning | Action Timeline |
|----------|---------|-----------------|
| **P0** | Critical — silent data corruption or server hang risk | Next sprint |
| **P1** | High — security, reliability, or DX gap | Within 2 sprints |
| **P2** | Medium — quality improvement, moderate risk | Within quarter |
| **P3** | Low — nice to have, minimal risk | Backlog |

## Effort Guide

| Effort | Meaning |
|--------|---------|
| **S** | Small — < 2 hours, single file or config change |
| **M** | Medium — 2–8 hours, multiple files, new test coverage needed |
| **L** | Large — 1–3 days, significant refactor or new test infrastructure |