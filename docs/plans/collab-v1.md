# Collab v1: Multiplayer Async Collaboration for graphdo-ts

Plan for a new `session_*` and `collab_*` tool surface that sits alongside
the existing single-player `markdown_*` tools. Async, OneDrive-backed,
ETag-driven, no server-side coordinator. Constraints in the task brief are
treated as locked. This document follows them; deviations are flagged in
section 10.

Convention used throughout:

- "Read in repo:" lines are grounded, with `path:line` citations.
- "Proposed:" lines are design choices made in this plan.

## 0. Threat model

The plan ships a non-trivial attack surface (browser loopback approval
forms, an on-drive sentinel, frontmatter as shared coordination state).
This section names what v1 defends and what it does not. Every other
section refers back here when it makes a security-shaped trade-off.

**In scope.** Defending the authoritative file and project scope against:

1. Accidental destructive actions by a well-behaved agent that has been
   misled by a confused human.
2. A hostile *web page* the user visits while an MCP session is active.
   It must not be able to drive the loopback approval forms (CSRF, DNS
   rebinding, port-scan-and-POST).
3. Leakage of secrets (Bearer tokens, refresh tokens, id-token claims)
   into local logs or audit lines.
4. Trivial path-traversal escapes from the project folder
   (`..`, percent-encoded, full-width, NFKC).

**Out of scope.**

1. A locally compromised user account. Such an attacker already has the
   MSAL token cache, the local audit log, and arbitrary file system
   access.
2. A malicious agent that lies about `source`. Technical mitigation is
   heuristic only (see §2.3 `collab_write` and §3.6
   `source_hint_mismatch`).
3. A malicious *cooperator* with write access to the project folder.
   They can forge frontmatter (P1-4 below), tamper with the sentinel
   (mitigated by local pinning, see §3.2), or write garbage to the
   authoritative file. v1 has no cryptographic signing of frontmatter
   or sentinel content because that is excluded by constraint
   ("no external servers, no CRDT sync service, no webhooks").
4. Cross-tenant attacks via SharePoint Teams or shared drives outside
   the project scope. Cross-drive scope is excluded by §11.
5. Side-channel timing or storage analysis on the audit log.

**Trust boundaries.**

1. **MSAL identity** is trusted as the source of `userOid` for local
   audit. Acquired from `AuthenticationResult.account.localAccountId`
   (Entra `oid`) — see §1.6 and open question 6.
2. **Local config** (sentinel cache at
   `<configDir>/projects/<projectId>.json`, recents, renewal counts,
   destructive-counter persistence) is trusted as user-owned. The user
   can edit any of it; rate limits are not a security boundary against
   the user themselves.
3. **OneDrive sentinel content** (`createdBy`, `authoritativeFileId`)
   is **untrusted** on second and subsequent opens. The first
   `session_open_project` pins the sentinel values into local project
   metadata. On any subsequent open, divergence raises
   `SentinelTamperedError`. `createdBy` is for display only and never
   gates behaviour.
4. **Frontmatter** `lease`/`authorship`/`proposals[].author_*` is
   **untrusted** for authorisation; coordination only. Any agent or
   human with folder write access can edit those fields directly. UI
   surfaces label these identifiers as "claimed by", not "verified".
5. **Loopback HTTP server** is trusted only when the request
   originates from the same loopback origin (`Host` and `Origin` both
   equal `127.0.0.1:<thisPort>`) and presents the per-form CSRF token
   minted at `GET /` (see §5.4).
6. **Agent-supplied `source`** is treated as a hint; not enforced.
   See §2.3 for the heuristic tripwire.

**Local rate limits as a security boundary.** Write budget, destructive
budget, and renewal caps defend the *agent* against runaway loops and
the *human* against UI fatigue. They are **not** a security boundary
against the human user, who can lift them by editing local files or
restarting the MCP server. They **are** a security boundary against the
agent within a single session, which is why the destructive counter is
persisted to disk (§3.7) so an agent that triggers MCP restart-on-crash
does not get a fresh budget.

## 1. Starting point

### 1.1 The 10 existing `markdown_*` tools

Read in repo: all 10 tools are registered in `src/tools/markdown.ts`.
Static metadata is grouped in a `MARKDOWN_TOOL_DEFS` array
(`src/tools/markdown.ts:217-228`). Names and current shapes:

| Tool | Inputs (zod shape) | Source |
| --- | --- | --- |
| `markdown_select_root_folder` | `{}` | `src/tools/markdown.ts:332-449` |
| `markdown_list_files` | `{}` | `src/tools/markdown.ts:452-520` |
| `markdown_get_file` | `idOrNameShape` (`itemId?`, `fileName?`) | `src/tools/markdown.ts:522-598` |
| `markdown_create_file` | `{ fileName, content }` | `src/tools/markdown.ts:600-673` |
| `markdown_update_file` | `idOrNameShape + { cTag, content }` | `src/tools/markdown.ts:675-811` |
| `markdown_delete_file` | `idOrNameShape` | `src/tools/markdown.ts:813-881` |
| `markdown_list_file_versions` | `idOrNameShape` | `src/tools/markdown.ts:883-975` |
| `markdown_get_file_version` | `idOrNameShape + { versionId }` | `src/tools/markdown.ts:977-1063` |
| `markdown_diff_file_versions` | `idOrNameShape + { fromVersionId, toVersionId }` | `src/tools/markdown.ts:1065-1222` |
| `markdown_preview_file` | `{ fileName }` | `src/tools/markdown.ts:1224-1296` |

`idOrNameShape` is defined in `src/tools/markdown.ts:255-266`. All tools
return `{ content: [{ type: "text", text }], isError? }`. `formatError()`
(`src/tools/shared.ts:18-30`) is the standard error envelope and special
cases `AuthenticationRequiredError` so the agent gets a "use the login tool"
nudge. Naming is enforced by `validateMarkdownFileName`
(`src/graph/markdown.ts:105-188`); subdirectories and unsafe characters are
rejected at input time and again on the resolved item ("defence in depth"
checks in every tool, see `src/tools/markdown.ts:551-575, 719-743, 909-934,
1009-1035, 1112-1138`).

Single-folder, opaque-ID scoping is enforced by
`loadAndValidateMarkdownConfig` (`src/config.ts:212-229`) and
`markdownRootFolderIdError` (`src/config.ts:164-173`), which actively reject
`/`, `\`, `whitespace`, and any value containing path separators.

### 1.2 cTag + If-Match in `updateMarkdownFile`

Read in repo: `src/graph/markdown.ts:740-773`.

- `PUT /me/drive/items/{itemId}/content` with header `If-Match: <cTag>`.
- Body sent via `client.requestRaw(HttpMethod.PUT, path, content,
  "text/markdown", signal, { "If-Match": cTag })`.
- On HTTP 412 the code does a follow-up `getDriveItem` and throws
  `MarkdownCTagMismatchError(itemId, suppliedCTag, currentItem)`
  (`src/graph/markdown.ts:667-679`).
- `MarkdownFileTooLargeError` (4 MiB cap) and `GraphRequestError` are also
  surfaced. The cap is a graphdo-ts policy
  (`src/graph/markdown.ts:34, MAX_DIRECT_CONTENT_BYTES`).

Microsoft Learn: <https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0>.

### 1.3 `createMarkdownFile` and `conflictBehavior=fail`

Read in repo: `src/graph/markdown.ts:692-723`. Path:

```
/me/drive/items/{folderId}:/{fileName}:/content?@microsoft.graph.conflictBehavior=fail
```

A 409 from Graph is caught and re-thrown as
`MarkdownFileAlreadyExistsError` (`src/graph/markdown.ts:651-659`). The
create-vs-update split is enforced server-side rather than via a racy
client-side existence check.

### 1.4 `If-None-Match` usage

Grep result: only one mention, a comment in `src/graph/client.ts:163-164`
("Use this for conditional requests like `If-Match` / `If-None-Match`.")
under `requestRaw`. No code path actually sets that header. v1 of collab
will not need it either; cTag + `If-Match` covers every CAS we plan.

### 1.5 Throttle handling in `GraphClient.performRequest`

Read in repo: `src/graph/client.ts:178-293`. Behaviour:

- Retryable status codes are `{429, 503, 504}` (`client.ts:105`).
- Default `maxRetries = 3` (`client.ts:117`).
- Each attempt mints a fresh `AbortSignal.timeout(timeoutMs)` and
  combines it with the caller's signal via `AbortSignal.any`
  (`client.ts:209-213`). PR #6 fixed a bug where the same timeout signal
  was reused across retries (see PR body, "AbortSignal bug fixed").
- On a retryable response, `Retry-After` is parsed as integer seconds or
  HTTP-date (`client.ts:257-269`); else the delay falls back to
  `BASE_RETRY_DELAY_MS * 2^attempt` = 1s, 2s, 4s.
- After exhausting retries the loop throws the last `GraphRequestError`.
- Non-retryable 4xx/5xx surface immediately as `GraphRequestError` with
  the parsed `{code, message}` from the Graph error envelope
  (`client.ts:296-302`).

Microsoft Learn: <https://learn.microsoft.com/en-us/graph/throttling>.

### 1.6 MSAL identity flow

Read in repo:

- `Authenticator` interface (`src/auth.ts:42-60`) exposes `login`,
  `token`, `logout`, `isAuthenticated`, `accountInfo`, `grantedScopes`.
- `AccountInfo` is intentionally tiny — only `username`
  (`src/auth.ts:69-72, 405-409`).
- `MsalAuthenticator` persists `account.json`
  (`src/auth.ts:29, 161-200`) and `msal_cache.json` via
  `createFileCachePlugin` (`src/auth.ts:118-160`).
- Tokens flow into `GraphClient` through a `TokenCredential`
  adapter created in `src/index.ts:84-86`.
- `getMe` fetches `/me` and returns `{ id, displayName, mail,
  userPrincipalName }` (`src/graph/mail.ts:11-15`,
  `src/graph/types.ts:20-33`). It is currently called only by the
  `auth_status` tool flow.

Critically, the codebase does **not** currently surface MSAL's
`localAccountId` (Entra `oid`) or `idTokenClaims`. The brief specifies
`agentId = <first 8 chars of graphUserOid>-<clientName>-<first 8 chars of
sessionId>`. To get the `oid` we will need to either parse the id token
claims that MSAL already returns inside the `AuthenticationResult` or
call `GET /me` and use `User.id` (which is the Graph `id`, not the Entra
`oid`, but is stable per drive). Flagged in section 10.

### 1.7 Browser loopback pattern

Read in repo:

- `src/loopback.ts:34-...` — `LoginLoopbackClient implements
  ILoopbackClient`. Starts a `node:http` server on `127.0.0.1` random port,
  serves a branded landing page, captures the OAuth `?code=`, returns to
  MSAL via `AuthorizeResponse`. Only used by login.
- `src/picker.ts` — generic single-shot picker (~250 LOC). Public
  surface: `PickerOption`, `PickerCreateLink`, `PickerConfig`,
  `PickerHandle`, `startBrowserPicker(config, signal)`. Default timeout
  120 s. Body cap 1 MiB (`src/picker.ts:73`).
- `src/templates/login.ts`, `src/templates/picker.ts`,
  `src/templates/layout.ts`, `src/templates/styles.ts`,
  `src/templates/tokens.ts` — pure functions returning strings (`{token}` and
  CSS variables driven by design tokens).
- `src/tools/markdown.ts:332-449` — `markdown_select_root_folder` is the
  canonical example of "agent calls tool, server starts picker, agent waits
  for `handle.waitForSelection`". The `openBrowser` callback is injected
  via `ServerConfig.openBrowser` (`src/index.ts:38-53`).

There is no reuse layer above `picker.ts`/`loopback.ts`: each tool wires
its own `startBrowserPicker(...)` call. Concurrent picker invocations are
not blocked by code; each starts a new HTTP server on its own port. Whether
two concurrent forms work in practice is in section 10.

### 1.8 PR #6 context

Merged 2026-04-11. Three pieces of #6 affect this work directly:

1. **Per-request `AbortSignal.timeout`** (PR body, "AbortSignal bug fixed";
   `src/graph/client.ts:209-213`). Means `collab_*` tools can rely on the
   timeout actually applying per retry attempt, not just once.
2. **Single shared `GraphClient`** in `ServerConfig.graphClient`
   (`src/index.ts:84-88`). All collab Graph helpers should accept the
   client as a parameter and let the tool layer pass `config.graphClient`.
3. **Standardised error envelope**: `GraphRequestError`,
   `GraphResponseParseError`, `formatError`, and
   `AuthenticationRequiredError` are all in place. Collab tools should
   define their own typed errors (`SessionExpiredError`,
   `OutOfScopeError`, etc.) and let `formatError` render them.

Items in #6 *not* used directly: literal-union enums for Graph fields
(useful when defining `RecurrencePatternType`-style enums for collab
metadata), the `parseResponse` helper (every collab Graph helper should
use it).

## 2. New tool surface

### 2.1 Conventions

- All collab tools accept the standard `signal: AbortSignal` from the
  MCP SDK callback. Pass it to every Graph call and config write.
- All write tools accept `source: "chat" | "project" | "external"` as a
  required argument (constraint).
- Result envelope mirrors `markdown_*`: `{ content: [{ type: "text",
  text }], isError? }` rendered by `formatError` on failure.
- Inputs are validated with zod inside `inputSchema`; defence-in-depth
  re-validation happens in the handler (same pattern as
  `src/tools/markdown.ts:564-575`).
- Per-tool MCP `annotations` are filled in the registration call and
  match the tool's actual side effects (`readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint`). The matrix is
  in §2.4.
- "Either A or B" inputs (e.g. `path` xor `itemId`) are enforced at the
  schema level via a zod `superRefine` — the same pattern that
  `src/tools/markdown.ts:239-244` uses for `markdownNameSchema`. The
  handler still re-checks for defence in depth.
- Error class proliferation is bounded. v1 introduces only the **8
  collab-specific error classes** that carry actionable structured data
  (current cTag, lease holder, suggested next step). Everything else is
  a plain `Error` rendered by `formatError`. The 8 are listed in §2.5.
- All variable interpolation in tool-rendered HTML (forms, re-prompts)
  uses an `escapeHtml(value)` helper (proposed addition to
  `src/templates/`). Diff payloads are wrapped in `<pre>` with text
  content set via server-side templating that never concatenates raw
  strings into HTML. See §5.4 for the loopback hardening details.

Proposed shared zod fragments:

```ts
const sourceShape = {
  source: z.enum(["chat", "project", "external"]).describe(
    "Where this content originated. 'chat' = the human typed it this turn; " +
      "'project' = read via collab_read in this session; " +
      "'external' = anything else (web fetch, prior session, generated). " +
      "Writes with source='external' trigger a browser re-approval."
  ),
} as const;

const cTagShape = {
  cTag: z.string().min(1).describe(
    "Opaque cTag previously returned by collab_read or another collab write. " +
      "Sent verbatim in If-Match. cTag is OneDrive's content-only entity tag, " +
      "so unrelated metadata changes (rename, share, indexing) do not invalidate it."
  ),
} as const;

const conflictModeShape = {
  conflictMode: z.enum(["fail", "proposal"]).default("fail").describe(
    "Behavior on cTag mismatch (HTTP 412). 'fail' returns an error with the " +
      "current cTag and revision so the agent can re-read and reconcile. " +
      "'proposal' diverts the new content to /proposals/<ulid>.md and records " +
      "a proposal entry in frontmatter. 'diff3' is reserved for v2."
  ),
} as const;

const projectScopedPathShape = {
  path: z.string().min(1).describe(
    "Scope-relative path inside the active project, e.g. 'proposals/p-foo.md', " +
      "'drafts/scratch.md', 'attachments/diagram.png'. Absolute paths, '..', " +
      "URL-encoded traversal, and the authoritative .md at the root are rejected."
  ),
} as const;
```

### 2.2 Session tools

#### `session_init_project`

Originator flow. Browser form opens; human picks an existing folder and
the single existing `.md` file inside it. Server writes
`<projectFolder>/.collab/project.json`, records the project locally, and
captures TTL + write budget.

```ts
session_init_project(args: {}): Promise<ToolResult>
```

The tool takes no arguments by design: every required value comes from the
browser form (constraint). Returns text confirming `projectId`, folder,
authoritative file, TTL, budgets. Side effects:

- Writes `.collab/project.json` (atomic, see section 3.2 schema).
- Writes `<configDir>/projects/<projectId>.json`.
- Adds an entry to `<configDir>/projects/recent.json`.
- Activates an in-memory session in this MCP instance.

Graph endpoints called:

| Step | Endpoint | Doc |
| --- | --- | --- |
| List candidate folders for the picker | `GET /me/drive/root/children?$select=id,name,folder,webUrl,parentReference` | <https://learn.microsoft.com/en-us/graph/api/driveitem-list-children?view=graph-rest-1.0> |
| Resolve a pasted OneDrive URL | `GET /shares/{encoded-id}/driveItem?$select=id,name,parentReference,folder` | <https://learn.microsoft.com/en-us/graph/api/shares-get?view=graph-rest-1.0> |
| Enumerate files in chosen folder | `GET /me/drive/items/{folderId}/children?$select=id,name,file,size` | (same as list-children) |
| Verify `.collab/` does not yet exist | `GET /me/drive/items/{folderId}:/.collab/project.json` (expect 404) | <https://learn.microsoft.com/en-us/graph/api/driveitem-get?view=graph-rest-1.0> |
| Create `.collab` folder | `POST /me/drive/items/{folderId}/children` with `{ name: ".collab", folder: {} }` | <https://learn.microsoft.com/en-us/graph/api/driveitem-post-children?view=graph-rest-1.0> |
| Write sentinel file | `PUT /me/drive/items/{collabFolderId}:/project.json:/content?@microsoft.graph.conflictBehavior=fail` | <https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0> |

Headers: `Authorization: Bearer <token>`, `Content-Type:
application/json` (sentinel write). Retries: inherited from `GraphClient`
(429/503/504 with `Retry-After`). Throttle policy: same as section 4.6.

Error cases:

- `SessionAlreadyActiveError` — an active session already exists in this
  MCP instance. Tells the human to stop the MCP server.
- `BlockedScopeError` — folder is `/me/drive/root`, recycle bin pseudo,
  not a folder, in a "Shared with me" item without write access, or
  matches a current scope.
- `SoftWarnAcknowledgedError` — internal, never returned: handled by the
  re-show step in the form for `/Documents`, `/Pictures`, `/Desktop`.
- `NoMarkdownFileError` — folder contains zero `.md` files.
- `MultipleRootMdError` — folder contains more than one `.md` at the
  root; the human must remove or move the extras (constraint says only
  one root `.md`).
- `SentinelAlreadyExistsError` — surface a hint that this is actually
  an open flow; the tool transparently re-routes through the open path.
- `BrowserFormCancelledError`, `BrowserFormTimeoutError`.
- `GraphRequestError` (network/auth/throttle exhausted).
- `AuthenticationRequiredError`.
- `SchemaWriteError` — sentinel content failed Zod validation before
  upload (defence-in-depth on our own writer).

Behaviour: shows an audit entry in `<configDir>/sessions/audit/_unscoped.jsonl`
on early failures (before a `projectId` exists), then in
`<configDir>/sessions/audit/<projectId>.jsonl` once the session is
established.

#### `session_open_project`

Collaborator flow. Browser form opens with three entry points: recents,
"Shared with me", URL paste box. Reads sentinel, validates, captures TTL
and budgets.

```ts
session_open_project(args: {}): Promise<ToolResult>
```

Graph endpoints:

| Step | Endpoint | Doc |
| --- | --- | --- |
| Render "Shared with me" list | `GET /me/drive/sharedWithMe?$select=id,name,remoteItem` | <https://learn.microsoft.com/en-us/graph/api/drive-sharedwithme?view=graph-rest-1.0> |
| Resolve URL paste | `GET /shares/{encoded-id}/driveItem` | <https://learn.microsoft.com/en-us/graph/api/shares-get?view=graph-rest-1.0> |
| Read sentinel | `GET /me/drive/items/{remoteItem.id}:/.collab/project.json:/content` | <https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0> |
| Look up authoritative file | `GET /me/drive/items/{authoritativeFileId}` | <https://learn.microsoft.com/en-us/graph/api/driveitem-get?view=graph-rest-1.0> |

Error cases:

- `SessionAlreadyActiveError`
- `SentinelMissingError` — no `.collab/project.json` at the chosen folder.
- `SentinelMalformedError` — JSON parses but Zod rejects (hard error,
  per constraint).
- `SchemaVersionUnsupportedError` — sentinel `schemaVersion > 1`.
- `BlockedScopeError`, `NoWriteAccessError`, `NotAFolderError`.
- `AuthoritativeFileMissingError` — sentinel points at an `id` that
  no longer resolves.
- `StaleRecentError` — picked from recents but the folder is gone;
  entry is marked unavailable, not dropped.
- `BrowserFormCancelledError`, `BrowserFormTimeoutError`.
- `GraphRequestError`, `AuthenticationRequiredError`.

Returns: same confirmation envelope as `session_init_project`.

#### `session_renew`

Open a fresh browser approval to reset the TTL clock. Caps:

- Per session: max 3 renewals.
- Per user per project per 24h rolling window: max 6.

Counts persisted at `<configDir>/sessions/renewal-counts.json` (schema
in section 3.5).

```ts
session_renew(args: {}): Promise<ToolResult>
```

Side effects: opens browser form; on submit, increments counters and
resets `expiresAt`. Writes one `renewal` audit entry.

Error cases:

- `NoActiveSessionError`.
- `RenewalCapPerSessionError` — already at 3.
- `RenewalCapPerWindowError` — already at 6 in last 24 h.
- `BrowserFormCancelledError`, `BrowserFormTimeoutError`.

#### `session_status`

Read-only.

```ts
session_status(args: {}): Promise<ToolResult>
```

Reports:

- `projectId`, `agentId`, `userOid` (suffix only), folder display path.
- `expiresAt` (absolute), seconds remaining.
- `writes used / total`.
- `renewals used / total per session`, `renewals used / total per
  24h window`.
- `destructive approvals used / total`.
- `source counters`: counts per `source` value (chat / project /
  external) for visibility.

Error cases: `NoActiveSessionError`. Never returns `isError: true` for
"session expired" — instead reports `expired: true` and zeroes out the
remaining counters so the agent can call `session_renew`.

### 2.3 Collab tools

#### `collab_read`

Read any file inside project scope.

```ts
collab_read(args: {
  path: string;     // scope-relative, OR…
  itemId?: string;  // if previously surfaced by collab_list_files
}): Promise<ToolResult>
```

When the resolved item is the authoritative `.md`, the response body
separates frontmatter from body. Output sketch:

```
file: README.md (id-abc)
size: 4012 bytes
modified: 2026-04-19T05:51:00Z
revision: 17
cTag: "{...,17}"
isAuthoritative: true
---FRONTMATTER (parsed)---
{ "version": 1, "doc_id": "01J...", "sections": [...], "proposals": [...] }
---BODY---
# README
...
```

For non-authoritative reads, output mirrors `markdown_get_file`.

Graph endpoints:

| Step | Endpoint |
| --- | --- |
| Authoritative file | `GET /me/drive/items/{authoritativeFileId}` then `GET /me/drive/items/{authoritativeFileId}/content` |
| Other in-scope files | `GET /me/drive/items/{projectFolderId}:/{relative}:/?$select=id,name,size,cTag,lastModifiedDateTime` then `GET .../content` |

Headers: standard. Retries: inherited. Returns immediately on 404 with a
typed `FileNotFoundError`.

Error cases:

- `NoActiveSessionError`, `SessionExpiredError`.
- `OutOfScopeError` — path resolves outside project; absolute path,
  `..`, encoded traversal, or shortcut item that points elsewhere.
- `PathLayoutViolationError` — path lands somewhere other than the four
  allowed locations (root `.md`, `proposals/`, `drafts/`,
  `attachments/`).
- `FileNotFoundError`.
- `MarkdownFileTooLargeError` (reused from `src/graph/markdown.ts:598`).
- `FrontmatterParseWarning` — non-fatal; defaults are returned and an
  audit `frontmatter_reset` entry is written (constraint).
- `GraphRequestError`, `AuthenticationRequiredError`.

#### `collab_list_files`

```ts
collab_list_files(args: {
  prefix?: "/" | "/proposals" | "/drafts" | "/attachments";
}): Promise<ToolResult>
```

Returns supported entries grouped by the four canonical locations.
Anything outside the layout is reported as `UNSUPPORTED` with a reason,
mirroring `markdown_list_files` (`src/tools/markdown.ts:474-510`).

Graph endpoint: `GET /me/drive/items/{folderId}/children` per location,
or one walk per request via `GET /me/drive/items/{folderId}:/path:`.
Retries: inherited.

Error cases: `NoActiveSessionError`, `SessionExpiredError`,
`OutOfScopeError`, `GraphRequestError`, `AuthenticationRequiredError`.

#### `collab_write`

```ts
collab_write(args: {
  path: string;             // scope-relative, e.g. "README.md"
  content: string;          // UTF-8, ≤ 4 MiB cap (reused)
  cTag: string;             // required for existing files
  source: "chat" | "project" | "external";
  conflictMode?: "fail" | "proposal";  // default "fail"
  intent?: string;          // free text shown in re-prompt forms
}): Promise<ToolResult>
```

Graph: `PUT /me/drive/items/{itemId}/content?@microsoft.graph.conflictBehavior=replace`
with `If-Match: <cTag>`. New files (path that does not yet exist in
`/proposals/`, `/drafts/`, `/attachments/`) use the byPath form,
omitting `If-Match` and using `conflictBehavior=fail`. Expected status
codes: 200 (replaced), 201 (created), 412 (cTag mismatch).

Behaviour:

- Path must satisfy section 4 enforcement.
- If `path` resolves to the authoritative file, content is parsed for
  frontmatter; if absent, a fresh `doc_id` (ULID) is generated and the
  block is inserted before the body. This is the visible behaviour
  change called out in section 6.
- If `source === "external"`, **always** opens a re-approval form
  before writing. The agent must wait. Output of the form: the
  destination path and a unified diff (or first-write summary).
- 412 fall-back follows `conflictMode`:
  - `"fail"` → return `CTagMismatchError` with current cTag, revision,
    timestamp, and a recommended next-step (`collab_read` then maybe
    `collab_create_proposal`).
  - `"proposal"` → divert content to `/proposals/<ulid>.md`, record a
    proposal entry in frontmatter (a separate, single-cTag write to
    the authoritative file). Counts as one write.
- Counts toward write budget on success or on diversion.
- **Source heuristic tripwire (advisory, not enforcement).** When
  `source === "project"`, scan the new content for at least one
  256-line rolling-shingle SHA-256 chunk that overlaps with content
  read by `collab_read` earlier in this session. Per-session read
  cache stores chunk hashes only (never bodies). If zero overlap, do
  **not** block the write; emit a `source_hint_mismatch` audit entry
  (§3.6). This is a tripwire for honest mistakes, not adversarial
  agents — agent dishonesty about `source` is explicitly out of scope
  per §0.

Error cases:

- `NoActiveSessionError`, `SessionExpiredError`,
  `BudgetExhaustedError`.
- `OutOfScopeError`, `PathLayoutViolationError`.
- `MarkdownFileTooLargeError`.
- `CTagMismatchError` (when `conflictMode = "fail"`).
- `ProposalDivertedError` (success-as-error envelope so the agent
  notices the diversion; carries the new proposal id).
- `ExternalSourceDeclinedError` — re-approval form rejected.
- `BrowserFormCancelledError`, `BrowserFormTimeoutError`.
- `FrontmatterRoundtripError` — the YAML emitter would not produce a
  parseable doc.
- `GraphRequestError`, `AuthenticationRequiredError`.

#### `collab_acquire_section`

Frontmatter CAS lease on a section in the authoritative file. The
section is identified by a stable id (heading slug or explicit
`{#anchor}`). Acquire = read frontmatter, ensure no active lease, write
back updated frontmatter using `If-Match`. The lease is metadata-only;
nothing in the body changes.

```ts
collab_acquire_section(args: {
  sectionId: string;
  ttlSeconds?: number;          // default 600, max 3600
  authoritativeCTag: string;    // returned by latest collab_read
}): Promise<ToolResult>
```

Graph: `GET` then `PUT` of the authoritative file content with
`If-Match: <authoritativeCTag>`. Headers and retry policy as for
`collab_write`. Not counted toward write budget (constraint: leases are
free).

Error cases:

- `NoActiveSessionError`, `SessionExpiredError`.
- `OutOfScopeError` (sectionId references a section not present).
- `SectionAlreadyLeasedError` — carries the holder `agentId` and lease
  expiry.
- `CTagMismatchError` — frontmatter changed under us; agent re-reads
  and retries. Not diverted to proposal (leases never proposal-divert).
- `GraphRequestError`, `AuthenticationRequiredError`.

#### `collab_release_section`

Inverse. Same shape minus `ttlSeconds`. Releasing a stale lease (one
held by a different agent) is rejected with `LeaseNotHeldError`. No-op
if the lease is already absent. Free.

```ts
collab_release_section(args: {
  sectionId: string;
  authoritativeCTag: string;
}): Promise<ToolResult>
```

Error cases: as above plus `LeaseNotHeldError`.

#### `collab_create_proposal`

Write a proposal body to `/proposals/<ulid>.md` and record proposal
metadata in the authoritative frontmatter. Two CAS writes total; the
proposal body write does not need a cTag (new file), the frontmatter
write does.

```ts
collab_create_proposal(args: {
  targetSectionId: string;       // section the proposal would replace
  body: string;                  // proposed new body for that section
  rationale?: string;
  source: "chat" | "project" | "external";
  authoritativeCTag: string;
}): Promise<ToolResult>
```

Graph: PUT proposal file (byPath with `conflictBehavior=fail`), then
PUT authoritative content with updated frontmatter and `If-Match:
<authoritativeCTag>`. Returns the new `proposalId` (ULID) and the new
authoritative cTag. Counts as 1 write (the visible operation; the
frontmatter update piggybacks). Source policy and re-approval as for
`collab_write`.

Error cases: as `collab_write` plus `ProposalIdCollisionError`
(extremely unlikely but checked).

#### `collab_apply_proposal`

Merge a proposal into the authoritative file. Detects the destructive
case (target range contains any line whose authorship trail attributes
it to a non-agent or a different agent) and triggers a re-approval form
showing the diff. Counts toward both write budget and (when
destructive) destructive-approval budget.

```ts
collab_apply_proposal(args: {
  proposalId: string;
  authoritativeCTag: string;
  intent?: string;
}): Promise<ToolResult>
```

Process:

1. Read proposal body and authoritative file.
2. Compute the new authoritative content by replacing the target
   section.
3. Inspect authorship trail for any human-authored or
   different-agent-authored lines in the original target range.
4. If any: open destructive re-approval form. Form shows a unified
   diff (use the existing `diff` package, already a dependency at
   `package.json:52`) and the ULIDs.
5. PUT authoritative content with `If-Match: <authoritativeCTag>`.
6. Update `proposals[].status = "applied"` in frontmatter (same write).
7. Optionally delete the proposal file (skipped in v1; kept for
   audit). Marked `applied` in frontmatter.

Error cases:

- `NoActiveSessionError`, `SessionExpiredError`,
  `BudgetExhaustedError`, `DestructiveBudgetExhaustedError`.
- `ProposalNotFoundError`, `ProposalAlreadyAppliedError`.
- `OutOfScopeError`, `CTagMismatchError`.
- `DestructiveApprovalDeclinedError`,
  `BrowserFormCancelledError`, `BrowserFormTimeoutError`.
- `GraphRequestError`, `AuthenticationRequiredError`.

#### `collab_list_versions`

Wraps `GET /me/drive/items/{authoritativeFileId}/versions`. Read-only;
no budget cost. Uses existing `listDriveItemVersions`
(`src/graph/markdown.ts:800`). Inputs:

```ts
collab_list_versions(args: {
  itemId?: string;            // defaults to the authoritative file
  path?: string;              // alternative addressing in scope
}): Promise<ToolResult>
```

Output mirrors `markdown_list_file_versions`. Microsoft Learn:
<https://learn.microsoft.com/en-us/graph/api/driveitem-list-versions?view=graph-rest-1.0>.

Error cases: `OutOfScopeError`, `FileNotFoundError`,
`GraphRequestError`, `AuthenticationRequiredError`.

#### `collab_restore_version`

Wraps `POST /me/drive/items/{itemId}/versions/{versionId}/restoreVersion`.
Destructive when applied to the authoritative file (constraint), so a
re-approval form is shown with the diff between current and target
version.

```ts
collab_restore_version(args: {
  itemId?: string;     // defaults to authoritative
  path?: string;
  versionId: string;
  authoritativeCTag?: string;  // required when itemId === authoritative
}): Promise<ToolResult>
```

Microsoft Learn: <https://learn.microsoft.com/en-us/graph/api/driveitem-restoreversion?view=graph-rest-1.0>.

Counts as 1 write. Counts as 1 destructive approval when applied to the
authoritative file.

Error cases: `OutOfScopeError`, `MarkdownUnknownVersionError` (reused
from `src/graph/markdown.ts:892`), `DestructiveApprovalDeclinedError`,
`CTagMismatchError`, plus standard.

#### `collab_delete_file`

Always destructive (constraint). Re-approval form shown for every call.
Refuses any path outside the project scope. Authoritative `.md` is
always refused.

```ts
collab_delete_file(args: {
  path: string;                 // proposals/<...>.md, drafts/<...>.md, attachments/<...>
  intent?: string;
}): Promise<ToolResult>
```

Graph: `DELETE /me/drive/items/{itemId}` after path resolution.
Microsoft Learn: <https://learn.microsoft.com/en-us/graph/api/driveitem-delete?view=graph-rest-1.0>.

Error cases:

- `NoActiveSessionError`, `SessionExpiredError`.
- `BudgetExhaustedError`, `DestructiveBudgetExhaustedError`.
- `OutOfScopeError`, `PathLayoutViolationError`,
  `RefuseDeleteAuthoritativeError`,
  `RefuseDeleteSentinelError`.
- `DestructiveApprovalDeclinedError`,
  `BrowserFormCancelledError`, `BrowserFormTimeoutError`.
- `GraphRequestError`, `AuthenticationRequiredError`.

### 2.4 MCP annotations per tool

Set on the `defineTool` call. Wrong annotations confuse capable hosts;
they drive UX hints like "this tool may modify state".

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
| --- | :---: | :---: | :---: | :---: |
| `session_init_project` | false | false | false | true |
| `session_open_project` | false | false | false | true |
| `session_renew` | false | false | true | true |
| `session_status` | true | false | true | false |
| `collab_read` | true | false | true | false |
| `collab_list_files` | true | false | true | false |
| `collab_write` | false | false | false | false |
| `collab_acquire_section` | false | false | false | false |
| `collab_release_section` | false | false | true | false |
| `collab_create_proposal` | false | false | false | false |
| `collab_apply_proposal` | false | true | false | false |
| `collab_list_versions` | true | false | true | false |
| `collab_restore_version` | false | true | false | false |
| `collab_delete_file` | false | true | false | false |

`openWorldHint: true` on the four flow-opening tools because they
communicate with an external system (the user's browser) outside the
MCP transport.

### 2.5 Bounded set of typed error classes

The codebase prefers plain text for most errors (see
`src/tools/shared.ts:18-30` and the `MarkdownCTagMismatchError`
precedent at `src/graph/markdown.ts:667-679`). v1 introduces only the
errors that carry actionable structured data the agent or operator
needs. Everything else is a plain `Error` rendered by `formatError`.

| Class | Carries | Used by |
| --- | --- | --- |
| `NoActiveSessionError` | nothing | every collab tool |
| `SessionExpiredError` | `expiresAt`, `renewalsRemaining` | every collab tool |
| `BudgetExhaustedError` | `budgetType: "write" \| "destructive"`, `used`, `total` | write tools |
| `OutOfScopeError` | `attemptedPath`, `reason` enum (see §4.7) | path-taking tools |
| `CollabCTagMismatchError` | `currentCTag`, `currentRevision`, `currentItem` | write/lease tools |
| `SectionAlreadyLeasedError` | `holderAgentId`, `expiresAt` | `collab_acquire_section` |
| `SentinelTamperedError` | `pinnedAuthoritativeFileId`, `currentSentinelAuthoritativeFileId`, `pinnedAt` | `session_open_project` |
| `BrowserApprovalDeclinedError` | `flowType`, `csrfTokenMatched: boolean` | every approval form |

Everything else (e.g. `RefuseDeleteAuthoritativeError`,
`PathLayoutViolationError`, `BrowserFormTimeoutError`,
`FrontmatterRoundtripError`, `RenewalCapPerSessionError`) is a plain
`Error` with a clear message — the test suite asserts on message
substrings, not on `instanceof`.

## 3. Schemas

All schemas carry `version: 1` (constraint). Schemas use TypeScript
interface notation here for readability; runtime validation is via Zod.

### 3.1 Authoritative-file YAML frontmatter

```yaml
---
collab:
  version: 1
  doc_id: 01JABCDE0FGHJKMNPQRSTV0WXY     # ULID, assigned on first write
  created_at: "2026-04-19T05:30:00Z"
  sections:
    - id: "intro"
      title: "Introduction"
      anchor_line_start: 12              # 1-based, body coordinates
      anchor_line_end: 47
      lease:                             # optional
        agent_id: "a3f2c891-claude-desktop-01jabcde"
        acquired_at: "2026-04-19T05:50:00Z"
        expires_at: "2026-04-19T06:00:00Z"
  proposals:
    - id: 01JCDEF...
      target_section_id: "intro"
      author_agent_id: "a3f2c891-..."   # claimed; see "integrity" note below
      author_display_name: "Alice"      # display only
      created_at: "2026-04-19T05:51:00Z"
      status: "open"                     # open | applied | superseded | withdrawn
      body_path: "proposals/01JCDEF....md"
      rationale: "tighten the wording"
      source: "chat"
  authorship:                            # append-only trail per range
    - line_start: 12
      line_end: 47
      author_kind: "agent"               # agent | human
      author_agent_id: "..."             # claimed; see "integrity" note below
      author_display_name: "..."
      written_at: "2026-04-19T05:50:00Z"
      revision: 17                        # OneDrive revision after the write
---
# Project Title
...
```

Notes:

- Block delimiter is the standard `---` / `---` pair so non-collab
  readers (VS Code preview, OneDrive web) treat it as YAML frontmatter
  and hide it from the rendered view.
- `doc_id` is set on the first write that finds no frontmatter and is
  immutable thereafter (constraint: distinct from Graph `driveItemId`).
- `authorship` is monotonically appended by collab writes. Trimming or
  compaction is out of scope for v1.
- Missing or malformed frontmatter returns defaults and writes
  `frontmatter_reset` to the audit log (constraint).
- Library: `yaml` (proposed dependency, see section 6 and dep-review
  in section 9).
- Alternative considered: `gray-matter` (rejected per constraint; would
  pull in additional transitive deps and obscures parse errors).
- **Frontmatter integrity is not a security boundary.** Any agent or
  human with folder write access can edit `collab.lease`,
  `collab.proposals[].author_agent_id`, and `collab.authorship[]`
  directly via OneDrive web or another agent. v1 treats these fields
  as cooperative coordination metadata, **not authentication claims**.
  Audit records (§3.6) carry the `agentId` of the actor that called
  the tool, derived from the locally authenticated MSAL identity, and
  that is the authoritative trail. UI surfaces label frontmatter
  agent/user identifiers as "claimed by", not "verified". This trade
  is locked by the "no external servers, no CRDT sync service"
  constraint; signing would require a second party to verify.
- **No `oid` material in frontmatter.** Earlier draft included
  `author_user_oid_prefix`; removed because frontmatter is untrusted
  storage (above) and the prefix would only mislead readers into
  treating it as identity. Display name is sufficient for human
  readability; the audit log is the canonical identity record.

### 3.2 Sentinel `.collab/project.json`

Sentinel folder name: **`.collab`**. Justification:

- Dot-prefix → hidden in OneDrive web by default; reduces visual noise.
- Name is neutral ("collab" reads as "this folder is for
  collaboration") rather than "graphdo", which would lock the format
  to one tool. A second tool could later read the same sentinel.
- Three letters longer than `.git` so it does not collide with VCS
  tooling at the project root.

```json
{
  "schemaVersion": 1,
  "projectId": "01JABCDE0FGHJKMNPQRSTV0WXY",
  "authoritativeFileId": "01ABCDEF...",
  "authoritativeFileName": "README.md",
  "createdBy": {
    "displayName": "Alice"
  },
  "createdAt": "2026-04-19T05:00:00Z"
}
```

`createdBy` carries display name only. No `oid` or `username` — the
sentinel is writable by any cooperator (see §0 trust boundary 3) so
identity claims would be misleading. Display name is for the open form
"created by Alice" caption only and is never used in authorisation.

**Sentinel trust model and tamper detection.** The sentinel is
**untrusted on second and subsequent reads**. v1 implements local
pinning:

1. On the **first** `session_open_project` for a given `projectId`,
   the local project metadata file
   `<configDir>/projects/<projectId>.json` (§3.3) records
   `pinnedAuthoritativeFileId`, `pinnedAuthoritativeFileName`,
   `pinnedSentinelFirstSeenAt`, and `pinnedAtFirstSeenCTag`.
2. On every **subsequent** `session_open_project`, the live sentinel
   is compared against the pinned values. Any divergence on
   `authoritativeFileId` raises `SentinelTamperedError` carrying both
   the pinned and current values. The session does **not** activate.
3. The user must explicitly forget the project from recents (which
   clears the pinning) before re-opening with the new sentinel
   values. This is a deliberate friction step.
4. An `audit.type = "sentinel_changed"` entry is written before the
   refusal, including pinned vs current values, so post-hoc analysis
   can spot tamper attempts even if the user later forgets the
   project.

Atomic write: same temp+rename strategy as `saveConfig`
(`src/config.ts:104-135`) cannot be used directly in OneDrive (no
rename-into-place primitive on Graph drive items). For the sentinel we
rely on `conflictBehavior=fail` to stop concurrent first writes
(constraint says it is the source of truth; corruption is a hard
error).

### 3.3 Local project metadata `<configDir>/projects/<projectId>.json`

```json
{
  "schemaVersion": 1,
  "projectId": "01JABCDE...",
  "folderId": "01FOLDER...",
  "folderPath": "/Documents/Project Foo",
  "driveId": "b!abc...",
  "pinnedAuthoritativeFileId": "01ABCDEF...",
  "pinnedAuthoritativeFileName": "README.md",
  "pinnedSentinelFirstSeenAt": "2026-04-19T05:00:00Z",
  "pinnedAtFirstSeenCTag": "\"{...,1}\"",
  "addedAt": "2026-04-19T05:00:00Z",
  "lastSeenSentinelAt": "2026-04-19T05:00:00Z",
  "lastSeenAuthoritativeCTag": "\"{...,17}\"",
  "lastSeenAuthoritativeRevision": "17",
  "lastDeltaToken": "abc123==",
  "perAgent": {
    "<agentId>": {
      "lastSeenAt": "2026-04-19T05:50:00Z",
      "lastSeenCTag": "\"{...,16}\"",
      "lastSeenRevision": "16"
    }
  }
}
```

`pinned*` fields are write-once and drive the §3.2 sentinel tamper
check. `lastSeen*` fields are pure optimisation (constraint: losing
them never breaks correctness). On session resume, divergence between
`lastSeenAuthoritativeCTag` and the live cTag is logged as
`audit.type = "external_change_detected"` — a free out-of-band
forensic signal, no behaviour change. `driveId` is captured to make
the §4.7 ancestry check cheap (we can refuse anything from a
different drive without an extra Graph call).

### 3.4 Recents `<configDir>/projects/recent.json`

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "projectId": "01JABCDE...",
      "folderId": "01FOLDER...",
      "folderPath": "/Documents/Project Foo",
      "authoritativeFile": "README.md",
      "lastOpened": "2026-04-19T05:00:00Z",
      "role": "originator",
      "available": true,
      "unavailableReason": null
    }
  ]
}
```

Stale entries (folder gone, sentinel gone, user lost access) are
flipped to `available: false` with a reason; not silently dropped
(constraint). "Forget this project" is the only UI affordance that
clears a `pinned*` block in §3.3 and lets a re-open with a different
sentinel succeed (§3.2 tamper detection).

### 3.5 Renewal counts `<configDir>/sessions/renewal-counts.json`

Keyed by `<userOid>/<projectId>` (full Entra `oid`, see §3.6 redaction
notes for why prefix is not used here). Each entry is a sliding window
of timestamps; entries older than 24h are pruned on read.

```json
{
  "schemaVersion": 1,
  "windows": {
    "00000000-0000-0000-0000-0000a3f2c891/01JABCDE...": {
      "renewals": [
        "2026-04-18T07:00:00Z",
        "2026-04-19T03:30:00Z"
      ]
    }
  }
}
```

`session_renew` rejects when `windows[key].renewals` already has 6
entries inside the last 24h (constraint). User-controlled file; trivial
to bypass with `rm`. That is acceptable per §0 ("local rate limits are
not a security boundary against the human user").

### 3.6 Audit JSONL

Path: `<configDir>/sessions/audit/<projectId>.jsonl` for scoped events
or `<configDir>/sessions/audit/_unscoped.jsonl` for failed-init events
(constraint). Plain append-only. One JSON object per line. No hash
chain, no signing (constraint).

Common envelope:

```json
{
  "ts": "2026-04-19T05:50:00Z",
  "schemaVersion": 1,
  "type": "tool_call",
  "sessionId": "01JSESSIO...",
  "agentId": "a3f2c891-claude-desktop-01jabcde",
  "userOid": "00000000-0000-0000-0000-0000a3f2c891",
  "projectId": "01JABCDE...",
  "tool": "collab_write",
  "result": "success",
  "details": { "...": "per-type fields below" }
}
```

Per-type `details`:

| `type` | Notable fields |
| --- | --- |
| `session_start` | `ttlSeconds`, `writeBudget`, `destructiveBudget`, `clientName`, `clientVersion` |
| `session_end` | `reason: "ttl" \| "budget" \| "mcp_shutdown" \| "manual_stop"`, `writesUsed`, `renewalsUsed` |
| `tool_call` | `inputSummary` (allow-listed; see below), `cTagBefore`, `cTagAfter`, `revisionAfter`, `bytes` (writes only), `source` (writes only), `resolvedItemId` |
| `scope_denied` | `reason` (see §4.7 enum), `attemptedPath`, `resolvedItemId?` |
| `destructive_approval` | `tool`, `outcome: "approved" \| "declined" \| "timeout"`, `diffSummaryHash`, `csrfTokenMatched` |
| `renewal` | `windowCountBefore`, `windowCountAfter`, `sessionRenewalsBefore`, `sessionRenewalsAfter` |
| `external_source_approval` | `tool`, `path`, `outcome`, `csrfTokenMatched` |
| `source_hint_mismatch` | `tool`, `path`, `claimedSource`, `chunkOverlapCount: 0` |
| `frontmatter_reset` | `reason: "missing" \| "malformed"`, `previousRevision` |
| `sentinel_changed` | `pinnedAuthoritativeFileId`, `currentAuthoritativeFileId`, `pinnedAtFirstSeenCTag`, `currentSentinelCTag` |
| `external_change_detected` | `pinnedCTag`, `liveCTag`, `liveRevision` |
| `error` | `errorName`, `errorMessage`, `graphCode?`, `graphStatus?` |

**Audit redaction policy.** Every audit producer goes through one
`writeAudit(envelope)` helper that enforces:

- `inputSummary` is an explicit allow-list: `{ path, source,
  conflictMode, contentSizeBytes, sectionId?, proposalId? }` per tool.
  Never `content`. Never `body`. Never `rationale` text — only
  `rationaleSizeBytes` and a SHA-256 prefix (first 16 hex chars).
- `intent` is included up to **200 chars**, NFKC-normalised, control
  chars stripped. Anything longer is truncated with `…(truncated)`.
- `diffSummaryHash` is SHA-256 of the unified diff text, hex, **first
  16 chars only** (correlation without enabling reconstruction from a
  leaked audit log).
- `errorMessage` is sourced from `formatError` output. For
  `GraphRequestError`, `.message` is structured (`method/path/code/
  message/status`) and contains no headers, so token leakage via this
  path is impossible. The audit writer additionally **rejects** any
  envelope whose serialised JSON contains the substring `"Bearer "`
  (defence in depth; logged at `warn` and the line is dropped).
- Total serialised line size **must be ≤ 4096 bytes**. Below that
  threshold, POSIX `O_APPEND` writes are atomic across concurrent
  appenders, so two MCP processes appending to the same project's
  audit cannot interleave half-lines. Lines that would exceed are
  truncated at `inputSummary` first, then `intent`; if still too
  large, the envelope is dropped and a smaller `error` envelope is
  written in its place.
- `userOid` is the **full Entra `oid`** (a UUID, not a secret — it is
  visible in any id token issued for the user). Earlier draft used an
  8-char prefix; rejected because (a) 32 bits is not a privacy
  primitive (trivially correlatable) and (b) full oid is needed for
  cross-machine collation by an operator reviewing audit. The 8-char
  prefix is still used inside `agentId` purely for compactness in
  human-readable identifiers.

Atomic append: open with `O_APPEND` and a single `fs.appendFile` call.
Concurrent appenders from two MCP processes do not corrupt each
other (POSIX guarantees atomic writes ≤ `PIPE_BUF`, ~4096 bytes, for
`O_APPEND`). On crash a partial trailing line may exist; the parser
tolerates it. All writes are best-effort: an audit failure does not
fail the tool call (logged at `warn`).

### 3.7 Destructive counter persistence
`<configDir>/sessions/destructive-counts.json`

```json
{
  "schemaVersion": 1,
  "sessions": {
    "01JSESSIO...": {
      "projectId": "01JABCDE...",
      "destructiveBudgetTotal": 10,
      "destructiveUsed": 3,
      "writeBudgetTotal": 50,
      "writesUsed": 12,
      "expiresAt": "2026-04-19T07:50:00Z",
      "renewalsUsed": 0
    }
  }
}
```

Persisted to disk so a crash-and-restart agent does not get a fresh
budget within the same session window. Removed on `session_end`.
User-editable; that is acceptable per §0.

## 4. Graph call patterns

### 4.1 Canonical read of the authoritative file

```
GET  /me/drive/items/{authoritativeFileId}
```

Response captures `cTag`, `lastModifiedBy`, `size`, `eTag`, `webUrl`,
and the `version` field used by `resolveCurrentRevision`
(`src/graph/markdown.ts:836`).

```
GET  /me/drive/items/{authoritativeFileId}/content
```

Body is UTF-8. Use `downloadMarkdownContent`
(`src/graph/markdown.ts:620-639`); the 4 MiB cap (4 194 304 bytes) is
already enforced.

`src/graph/types.ts` already models all required `DriveItem` fields
(see grep at `src/graph/types.ts:200,226,245,266`). No `$select`
trimming is needed for v1, though it would shave bytes on hot reads;
deferred.


Microsoft Learn: <https://learn.microsoft.com/en-us/graph/api/driveitem-get?view=graph-rest-1.0>
and <https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0>.

### 4.2 Canonical write

```
PUT  /me/drive/items/{itemId}/content?@microsoft.graph.conflictBehavior=replace
Headers:
  Authorization: Bearer <token>
  Content-Type:  text/markdown            # for .md
                 application/octet-stream # for /attachments/* binaries
  If-Match:      <cTag>                   # required for existing files
```

Expected statuses: 200 (replaced), 201 (created when using byPath
addressing), 412 (precondition failed). Body is the full new content
(no PATCH-style merge). Reuses `requestRaw` from
`src/graph/client.ts:166-176` and the same `If-Match` plumbing as
`updateMarkdownFile` (`src/graph/markdown.ts:740-773`).

Note: per constraint we never use `eTag` for collab writes; only
`cTag`, since a metadata-only change (rename, share, indexing) would
spuriously invalidate `eTag`. This claim is documented for OneDrive
personal. **For files surfaced via "Shared with me" that are
SharePoint-backed, cTag is not guaranteed to be metadata-stable** —
a rename or move on the SharePoint side may change cTag. Behaviour:
we accept the resulting spurious 412s and let the agent reconcile via
`collab_read`; we do not invent fall-back logic. This is called out in
the open questions list (§10).

**Race handling.** Sentinel creation and lease writes both rely on
HTTP-level CAS:

- **409 on sentinel create** (`conflictBehavior=fail`): another
  initiator wrote the sentinel between our existence check and our
  PUT. Re-route to `session_open_project` automatically.
- **412 on lease/frontmatter write**: another agent's frontmatter
  write landed first. Surface `CollabCTagMismatchError` with the
  current cTag; the agent re-reads and retries. Lease acquires never
  divert to proposal (constraint).
- **412 on body write**: handled per `conflictMode` (§2.3
  `collab_write`).

Microsoft Learn:
<https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0>.

### 4.3 Scope discovery for `session_open_project`

```
GET  /me/drive/sharedWithMe?$select=id,name,remoteItem,lastModifiedDateTime
```

Each entry is a "shortcut" `driveItem` whose real target is in
`remoteItem.parentReference.driveId`/`remoteItem.id`. Gotchas:

- The same item can appear twice if it has both read and write shares
  (flagged in section 10). v1 dedupes by `remoteItem.id` and prefers
  the entry whose follow-up permissions call returns `write` or
  `owner` roles.
- The endpoint can return items where the user has read-only access.
  `$expand=permissions` is **not supported** on this endpoint
  (verified in graph review). Filter by issuing a follow-up
  `GET /drives/{driveId}/items/{itemId}/permissions` and keeping only
  items where some `permission.roles` entry is `"write"` or `"owner"`.
- Folder vs file: only entries with `remoteItem.folder` are usable as
  project scopes; refuse the rest (constraint).

Microsoft Learn:
<https://learn.microsoft.com/en-us/graph/api/drive-sharedwithme?view=graph-rest-1.0>.

### 4.4 URL-paste resolution

OneDrive sharing URLs are resolved via the shares API. The encoding is
**strict base64url** (RFC 4648 §5: replace `+` with `-`, `/` with `_`,
strip trailing `=` padding):

```
encode(url) = "u!" + base64url(utf8(url)).replace(/=+$/, "")
GET  /shares/{encoded-id}/driveItem?$select=id,parentReference,folder,name,remoteItem
```

For OneDrive sharing URLs that resolve to a file (e.g. the user pasted
the authoritative file rather than the folder), follow up with a `GET
/me/drive/items/{parentReference.id}` to land on the folder and then
the sentinel read.

**Host allow-list before issuing the call.** The pasted string is
agent-or-user input and must be validated client-side before sending
anything to Graph. v1 accepts only:

- `https://*.sharepoint.com/...`
- `https://*-my.sharepoint.com/...`
- `https://1drv.ms/...`
- `https://onedrive.live.com/...`

Anything else (`http://`, `file:///`, IP literals, localhost, other
hosts) is refused with `InvalidShareUrlError` before any Graph call.
This avoids forwarding arbitrary attacker-controlled URLs to a
trusted endpoint and gives a clear local error.

Graph errors are mapped: HTTP 404 → `ShareNotFoundError` ("the link
may be revoked, or you may not have access"); 403 → `ShareAccessDeniedError`
("the link is valid but you do not have access — ask the owner to
share with your account").

Microsoft Learn:
<https://learn.microsoft.com/en-us/graph/api/shares-get?view=graph-rest-1.0>
and the encoding spec at
<https://learn.microsoft.com/en-us/graph/api/shares-get?view=graph-rest-1.0#encoding-sharing-urls>.

### 4.5 Delta polling

```
GET  /me/drives/{driveId}/root/delta?token=<deltaToken>
```

Drive-scoped from the root (no folder-scoped delta endpoint in v1.0;
constraint acknowledges this). We filter client-side: keep an entry
only if its `parentReference.id` ancestry includes `projectFolderId`.
The `@odata.deltaLink` from the previous call yields the next
`deltaToken` and is persisted as `lastDeltaToken` in section 3.3.

Used opportunistically by `collab_read` and `session_status` to spot
out-of-band changes; not a hard dependency for any tool.

Microsoft Learn:
<https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0>.

### 4.6 Throttle handling for `collab_*`

Same primitive as today (`src/graph/client.ts:254-285`): `Retry-After`
honoured, capped exponential fallback, max 3 retries by default. After
exhausting retries, the `GraphRequestError` (`code: "TooManyRequests"`,
status 429) is surfaced as a tool error:

```
collab_write rate-limited by Microsoft Graph (HTTP 429: TooManyRequests).
Retried 3 times with backoff. Try again in <secs>s.
```

The collab tools deliberately do **not** retry forever; long sessions
should rather see a clear failure than a stuck handler. Acceptance test
in section 8.10.

### 4.7 Scope resolution algorithm

This is the single primitive that gates every `path` argument across
`collab_read`, `collab_list_files`, `collab_write`,
`collab_create_proposal`, `collab_apply_proposal`, and
`collab_delete_file`. Spelling it out so reviewers and implementers
share one definition.

Input: scope-relative `path: string` from the agent, plus the active
session's `projectFolderId` and `driveId` (both read from local
project metadata, §3.3).

```
1. Pre-normalisation refusals (return OutOfScopeError):
   a. path === "" or path.length > 1024
   b. path contains NUL, CR, LF, or any C0/C1 control char (< 0x20)
   c. path contains backslash "\"
   d. path contains "%" — forces explicit decoding before reasoning
      (we decode once below; if "%" still appears, that is double
      encoding and is refused)
   e. path starts with "/" or "\" or matches /^[A-Za-z]:[\/\\]/
      (drive-letter prefix)

2. URL-decode once. If the decoded string still contains "%", refuse.

3. Apply Unicode NFC normalisation. If NFKC(decoded) !== NFC(decoded),
   refuse with reason "homoglyph_or_compatibility_form" (catches
   full-width "．．", full-width "／", zero-width chars, RTL overrides,
   ligatures).

4. Split on "/". Refuse if any segment is "" (empty), ".", "..", or
   begins with "." (belt-and-braces: dot-prefixed segments are excluded
   so .collab/ remains unreachable).

5. Layout enforcement:
   - If segments.length === 1 and the segment matches the pinned
     authoritative file name (NFC-equal, case-sensitive), the path is
     the authoritative file. Allowed.
   - Else, segments[0] must be one of the literal strings
     "proposals", "drafts", "attachments" (case-sensitive). Anything
     else → reason "path_layout_violation".
   - For "proposals" and "drafts", the file must end in ".md" (NFC-
     equal lowercase).

6. Resolve via Graph using the path expression
   `/me/drive/items/{projectFolderId}:/{joined}:`. This call uses byId
   for the project root, never `/me/drive/root`, so a stale or
   spoofed folder reference cannot escape.

7. Defence-in-depth post-resolution checks. Refuse if:
   - The returned driveItem has `remoteItem` set (shortcut/redirect
     pointing outside the drive) → reason "shortcut_redirect".
   - The returned driveItem's `parentReference.driveId` differs from
     the pinned `driveId` → reason "cross_drive".
   - Walking `parentReference` ancestry does not surface
     `projectFolderId` within N hops (N = 8; collab projects are
     shallow). The byId path resolution above usually guarantees this,
     so the ancestry walk is one extra GET kept as a defensive check.
   - The returned name (NFC) differs from the requested last segment.
     Catches case-folding aliasing on Windows-backed OneDrive: a
     write to "Proposals/foo.md" that resolves to an item actually
     named "proposals/foo.md" must be refused so that one path always
     names one item.
```

Audit: every refusal writes a `scope_denied` entry (§3.6) including
`reason` and `attemptedPath`. Successful resolutions populate
`resolvedItemId` in the resulting `tool_call` audit entry so analysis
joins on item identity rather than on path strings (which can alias
under case folding).

Test rows in §8.2 test 08 cover one path per refusal reason.

## 5. Browser loopback approval UX

All approval forms reuse the picker substrate already in
`src/picker.ts` and the layout/style primitives in
`src/templates/layout.ts`, `src/templates/styles.ts`,
`src/templates/tokens.ts`. Each form is a single-page,
non-wizard layout (constraint).

### 5.1 Reusable pieces from existing code

| Component | What we reuse |
| --- | --- |
| Local HTTP server with random port | `src/picker.ts` factory pattern (random port, `127.0.0.1`, body cap, abort wiring). |
| HTML shell (head, fonts, favicon) | `pageLayout` / `pageHead` in `src/templates/layout.ts`. |
| Design tokens and CSS | `src/templates/tokens.ts`, `src/templates/styles.ts`. |
| `openBrowser` injection | `ServerConfig.openBrowser` (`src/index.ts:50`). |
| Tab auto-close after submit | `pickerSuccessHtml` countdown (`src/templates/picker.ts`). |
| Cancel handling | `UserCancelledError` (`src/errors.ts:12-17`). |

### 5.2 Form specifications

Proposed: all forms are factored through a new
`src/tools/collab-forms.ts` module (the form-factory in §5.3) that
defines the shape of the form, the route layout (`/`, `/submit`,
`/cancel`), the per-form CSRF token (§5.4), and the server-side state
to capture. The HTML lives under `src/templates/collab.ts` alongside
`picker.ts` and `login.ts` so design tokens stay consistent.

#### 5.2.1 Init form

Routes:

- `GET /` → render `initFormHtml({ folders, recents })`.
- `POST /select-folder` → updates the folder selection in server
  state, returns the file picker fragment for that folder.
- `POST /submit` → final approval; server writes sentinel.
- `POST /cancel` → returns 204 and rejects the wait promise.

Fields:

| Field | Type | Notes |
| --- | --- | --- |
| Folder | radio + URL paste | radio is populated from `GET /me/drive/root/children`; paste box resolves via `/shares` endpoint. |
| Authoritative file | radio | populated when folder picked; only one selection allowed; greyed if folder has zero or multiple `.md` files. |
| TTL | slider | 15 min – 8 h, default 2 h. |
| Write budget | slider | 10 – 500, default 50. |
| Destructive budget | number | default 10, hard cap 50. |
| Renewal policy | dropdown | "manual" only in v1; future "auto-renew" placeholder visible but disabled. |
| Soft-warn confirm | checkbox shown conditionally | for `/Documents`, `/Pictures`, `/Desktop`. |

Server-side captured state on `POST /submit`: `{ folderId, folderPath,
authoritativeFileId, authoritativeFileName, ttlSeconds, writeBudget,
destructiveBudget }`. The server then:

1. Writes the sentinel (section 4 PUT byPath).
2. Writes `<configDir>/projects/<projectId>.json` and updates
   recents.
3. Activates the in-memory session and resolves the form's promise.
4. Returns a "Session active. You can close this tab." page using the
   existing success template.

Tab close: existing `pickerSuccessHtml` JS countdown (3 s) and a
`window.close()` attempt; some browsers refuse, in which case the
page just stays open (matches today's behaviour).

#### 5.2.2 Open form

Routes mirror the init form. Fields:

| Field | Type | Notes |
| --- | --- | --- |
| Recents | list | populated from `recent.json`; entries with `available: false` are shown disabled with the reason. |
| Shared with me | list | populated from `GET /me/drive/sharedWithMe`. Only items with write access and `folder` set are enabled. |
| Paste a OneDrive folder URL | text | resolved via `/shares` endpoint. |
| TTL | slider | as above. |
| Write budget | slider | as above. |
| Destructive budget | number | as above. |

`POST /submit` body: `{ folderId }` (everything else is captured from
the controls). Server reads sentinel, validates, then activates
session.

#### 5.2.3 Destructive re-prompt form (mid-session)

Triggered by `collab_apply_proposal` (when destructive),
`collab_restore_version` on the authoritative file, and
`collab_delete_file` (always). One round trip; the agent's tool call
blocks until the human submits or cancels.

Fields displayed:

- Tool name and intent (free-text the agent passed).
- Path or proposalId being acted on.
- Unified diff (computed using the existing `diff` package,
  `package.json:52`).
- Counter: "Destructive approvals used N of M".

Buttons: **Approve** and **Cancel**. On approve, the server resolves
the wait promise with `{ approved: true }` and the tool proceeds.

#### 5.2.4 `source: "external"` re-prompt form

Triggered from `collab_write` and `collab_create_proposal` when
`source === "external"`. Fields:

- Tool name, intent, destination path.
- Diff vs current content (or "first write — content summary" with a
  bounded preview of the new bytes, e.g. first 4 KiB).
- Counter: "External-source writes used N this session" (informational
  only; no separate budget per constraint, but visible).

Buttons: **Approve** and **Cancel**.

### 5.3 Concurrency

Today's picker code does not enforce a single in-flight form (see
section 1.7). Two forms running at the same time work mechanically
(each gets its own port) but produce confusing UX if the user submits
the wrong one. v1 mitigation:

- One active approval form at a time, enforced by a **form-factory lock**
  in `src/tools/collab-forms.ts` (see §A directory layout). The lock
  lives at the factory layer, not in tool handlers, so any tool can
  request a form without coupling to other tools' lock state. Calls
  while a form is open return `FormBusyError` carrying the URL of the
  in-flight form so the agent can guide the user.
- Mid-session re-prompts (destructive, external) acquire the same
  lock so the agent can never have two re-prompts open at once.
- The lock is released on form completion (any outcome: submit,
  cancel, timeout, abort).

### 5.4 Loopback hardening (CSRF, DNS rebinding, XSS)

A new piece of work that is a hard prerequisite for the collab
forms — and a retroactive fix for `src/picker.ts` and `src/loopback.ts`
that benefits the existing login and todo-list-picker flows.

Today's picker handler (`src/picker.ts:161-322`) enforces:

- `127.0.0.1` bind (`picker.ts:120`)
- random port
- a CSP header (`picker.ts:175-178`)
- 1 MiB body cap
- option-ID allow-listing on `POST /select`

It does **not** check `Origin`, `Host`, `Referer`, or
`Sec-Fetch-Site`. For login, that gap is acceptable because the only
secret in play is "press a button to start MSAL". For collab v1 it is
**not acceptable**: `POST /submit` on the init/open/destructive/external
forms is a transaction that can configure a project scope, approve a
destructive operation, or approve an `external`-source overwrite of
the authoritative file.

Threat: the user has Claude Desktop running with an active MCP
session. They visit `evil.example`. The page either (a) brute-forces
~64k loopback ports with `no-cors` `fetch` POSTs, or (b) uses DNS
rebinding (a hostname that first resolves to `evil.example`, then to
`127.0.0.1`) so its JavaScript has same-origin to the loopback. A
forged submit lands and a destructive op completes silently.

**v1 hardening, applied uniformly to every loopback POST handler used
by login, picker, and the new collab forms:**

1. **Host header pin.** Reject if `Host` is not exactly
   `127.0.0.1:<thisPort>`. Defeats DNS rebinding because the rebound
   hostname will be sent in `Host`, not the loopback literal.
2. **Origin header pin.** Reject if `Origin` is present and not
   exactly `http://127.0.0.1:<thisPort>`. Browsers send `Origin` on
   `POST` from `fetch`/forms; missing `Origin` is allowed only for
   same-origin top-level navigations from the served HTML.
3. **CSRF token.** Mint a 32-byte cryptographically random token at
   `GET /` (or the page that contains the form). Embed it in a hidden
   field. Require it back as a JSON body field on `POST /submit`,
   compared with `crypto.timingSafeEqual`. Distinct token per form
   instance; expires when the form closes.
4. **Content-Type pin.** Require `Content-Type: application/json` on
   `POST /submit` and `POST /cancel`. Rejects HTML-form-posted CSRF
   that uses `text/plain` to avoid CORS preflight.
5. **Sec-Fetch-Site pin (best effort).** Reject if `Sec-Fetch-Site`
   is present and not `same-origin`. Browsers that don't send the
   header are not punished.
6. **CSP retained.** `Content-Security-Policy: default-src 'none';
   form-action 'self'; script-src 'self' 'nonce-<perRequest>';
   style-src 'self' 'nonce-<perRequest>'; base-uri 'none'; frame-ancestors 'none'`
   matches what `src/picker.ts:175` already does, with
   `frame-ancestors 'none'` added so the form cannot be iframed by a
   rebinding attacker.
7. **HTML escaping.** Every variable interpolated into form HTML
   passes through an `escapeHtml(value)` helper (proposed addition in
   `src/templates/escape.ts`). User-controllable strings rendered by
   the destructive and external re-prompt forms include `intent`,
   `path`, `folderPath`, `authoritativeFileName`, and the unified
   diff body (rendered inside `<pre>`). The diff is set via
   `textContent`-equivalent server-side templating; never raw string
   concatenation.
8. **Special-folder name is a literal type.** The soft-warn flow in
   §5.2.1 looks up well-known folders via
   `GET /me/drive/special/{name}` where `name` is the literal type
   `"documents" | "photos" | "desktop"`. Never derived from any
   input. Stated here to forestall future drift.

These hardening steps are landed first in the rollout (§9, new W0
milestone) so the existing picker tests and login flows benefit, and
collab forms inherit a hardened substrate from day one.

## 6. Migration and compatibility

- `markdown_*` tools are not modified. Their handler bodies, schemas,
  and folder-config dependency stay as-is. They are gated by the
  same `Files.ReadWrite` scope.
- `collab_*` tools are added under their own scope gate (see section
  7). Disabling collab leaves `markdown_*` fully functional.
- First `collab_write` to an authoritative file that lacks
  frontmatter inserts the `collab:` block with a fresh `doc_id`. This
  is **a visible change** for users who point a session at an existing
  `.md`. Spell it out in the README and in the success message of
  `session_init_project`. Suggested wording in the form:

  > "On first write, graphdo will add a YAML frontmatter block to the
  > top of <authoritative file>. This block holds collaboration state
  > and is invisible in rendered markdown. Existing content is not
  > altered."

- Schema versioning. Every persisted artifact carries
  `schemaVersion: 1` (sentinel, local project metadata, recents,
  renewal counts, audit lines, frontmatter `collab.version`).
  Detection on read:

  - `schemaVersion === 1` → parse normally.
  - `schemaVersion > 1` → reject with `SchemaVersionUnsupportedError`,
    instruct the user to upgrade graphdo.
  - `schemaVersion < 1` (impossible today) → also reject; v2 will
    introduce explicit upgraders.

  We do not in v1 implement an upgrader. Forward-compatibility is
  achieved by rejecting unknown versions cleanly.

- Dependency additions:
  - `yaml` (constraint says yes; not `gray-matter`).
    - **Pre-merge verification.** Run `npm audit` and check the
      GitHub Advisory Database for `yaml` advisories before lockfile
      commit. The plan author has done a mental check: the modern
      `yaml` library (eemeli/yaml) does not execute YAML tags by
      default and has no known prototype-pollution-class issues
      comparable to old `js-yaml`'s `!!js/function`. Verify
      empirically.
    - **Parse hardening.** Always call `parse(input, { prettyErrors:
      true, strict: true })`. **Never** use `parseAllDocuments`
      (multi-doc input is a smell and a parser-confusion vector).
      Forbid custom tags. After parse, verify the root is a plain
      object (`Object.getPrototypeOf(x) === Object.prototype`)
      before passing to Zod for shape validation. The Zod step is
      what enforces our schema; `yaml` is just the parser.
  - ULID generator: propose using a small inlined implementation
    (~30 LOC, no dep) to avoid an extra package; alternative is `ulid`
    on npm. Inlined is preferred for supply-chain reasons (matches
    "Minimal dependencies" guidance in `AGENTS.md`).
  - `diff-match-patch` is **not** added (constraint, deferred to v2).

- Optional sidecar at `/me/drive/special/approot/...`: not needed for
  v1 correctness. Skip until a concrete optimization need shows up.

## 7. Scope gating

### 7.1 Graph scope

Proposed: collab tools reuse `Files.ReadWrite` (`GraphScope.FilesReadWrite`,
`src/scopes.ts:10`). Justification:

- All Graph endpoints we call (`/me/drive/...`, `/shares`,
  `/me/drive/sharedWithMe`, `versions`, `restoreVersion`) are covered
  by `Files.ReadWrite`. <https://learn.microsoft.com/en-us/graph/permissions-reference#filesreadwrite>.
- Adding a separate scope (e.g. `Files.ReadWrite.All`) only buys us
  cross-drive access, which is explicitly out of scope (constraint).
- Selected permissions / Graph-side enforcement is v2 (constraint).

Alternative: a new logical app-side scope (e.g. `GraphScope.Collab`)
that maps to `Files.ReadWrite` but lets the user opt out of collab
without losing markdown. Worth it if we want collab off by default in
the consent screen. Proposed default: **add a logical scope toggle in
the existing scope picker** that maps to the same Graph scope under
the hood. That way `markdown_*` and `collab_*` can be enabled
independently in the login UI.

### 7.2 Tool visibility

Proposal: **always-visible after login**, with helpful errors when no
session is active. The MCP review suggested this could fight the
existing scope-driven enable/disable; the answer is that scope-driven
enable/disable is **orthogonal** to session state. The two states
combine like this:

| Scope granted? | Session active? | Tool state |
| --- | --- | --- |
| no | n/a | disabled (hidden in `tools/list`) |
| yes | no | enabled, returns `NoActiveSessionError` |
| yes | yes, not expired | enabled, runs |
| yes | yes, expired | enabled, returns `SessionExpiredError` |

The first row uses the existing `syncToolState` machinery
(`src/tool-registry.ts:90-111`) — collab tools simply add
`Files.ReadWrite` (or the new logical `Collab` scope) to their
`requiredScopes`. The bottom three rows are handled by a tiny prelude
in each `collab_*` handler:

```ts
const session = currentSession();
if (!session) return formatError(toolName, new NoActiveSessionError());
if (session.expired()) return formatError(toolName, new SessionExpiredError(session));
```

`currentSession()` reads from process-local in-memory state. No
`tools/list_changed` notifications fire on session start/end, which
keeps hot paths quiet. Reasoning:

- Matches today's `markdown_*` pattern: tools stay visible after
  login even when no root folder is configured; the agent learns the
  flow from the error message
  (`src/config.ts:212-229`).
- Discoverability: agents enumerate `tools/list` once. Hiding tools
  behind a session means an agent cannot guide the user to start one.

Counter-argument considered and rejected: dynamic hiding would mean
fewer tools surfaced when no session exists, but the cost (extra
`tools/list_changed` round trips on every session boundary, and
agents losing the ability to mention `session_init_project` to a
user who hasn't started one yet) outweighs the saving.

### 7.3 Instruction text and tool listing

`buildInstructions` (`src/tool-registry.ts:122-185`) groups tools by
`requiredScopes` for the MCP `instructions` capability. The plan adds
a new conceptual group ("collaboration") that is a sub-group of
`Files.ReadWrite`. Two extension points:

1. **Group annotation.** Add an optional `group?: string` field to
   `ToolDef` (`src/tool-registry.ts:24-33`). Markdown tools get
   `group: "markdown"`. Collab tools get `group: "collab"`. Inside a
   scope-gated section, tools are listed by group, then alphabetically.
2. **Workflow line.** Append to the existing "WORKFLOW" line in
   `buildInstructions:179-181` a collab branch:
   `"For collaboration: call session_init_project (originator) or
    session_open_project (collaborator), then collab_* tools."`
3. **Behavior rule.** Add to the existing rules block:
   `"When a collab_* tool returns a NoActiveSessionError, call
    session_open_project or session_init_project immediately - do
    not ask the user which one, the browser form will guide them."`

These are tiny edits to one file, but they need to be in the plan so
they are not forgotten in the rollout.

## 8. Test strategy

All collab tests live alongside the existing test layout
(`test/integration/`, `test/graph/`, `test/`). The mock Graph server in
`test/mock-graph.ts` is extended with new handlers; existing tests
must not change behaviour (so we add new endpoints rather than
rewriting handlers).

### 8.1 Unit tests per Graph helper

Files:

- `test/graph/collab.test.ts` — `readSentinel`, `writeSentinel`,
  `readAuthoritative`, `writeAuthoritative` (cTag, conflictMode),
  `resolveSharedWithMe`, `resolveShareUrl` (including base64url
  encoding edge cases and host allow-list refusal),
  `listProjectChildren`, `applyDelta` (filter by ancestry).
- `test/collab/session.test.ts` — TTL math, renewal-window math,
  budget counters, destructive counter persistence across simulated
  restart.
- `test/collab/scope.test.ts` — every step of the §4.7 algorithm:
  pre-normalisation refusals, double-decode refusal, NFKC vs NFC,
  layout enforcement, byId vs `/me/drive/root` (asserted via mock
  Graph URL inspection), shortcut/redirect refusal, cross-drive
  refusal, ancestry walk, case-aliasing refusal.
- `test/collab/audit.test.ts` — JSONL append, schema, ≤4096-byte line
  cap, partial-line tolerance, redaction allow-list, `intent`
  truncation at 200 chars, `diffSummaryHash` length 16, **assertion
  that no audit line contains `"Bearer "` substring** even when
  Graph errors are logged.
- `test/collab/frontmatter.test.ts` — round-trip of YAML, byte-stable
  re-emission, default injection, `doc_id` stability across writes,
  refusal of multi-doc YAML inputs.
- `test/picker.test.ts` (extension) — new rows for §5.4 hardening:
  reject when `Host` not loopback literal; reject when `Origin` is
  not loopback literal; reject when CSRF token is missing or wrong
  (timing-safe compare); reject when `Content-Type` is not
  `application/json`; reject when `Sec-Fetch-Site` is present and not
  `same-origin`; reject when CSP `frame-ancestors` is bypassed (smoke
  test: assert header value).

### 8.2 Integration tests

Folder: `test/integration/collab/`. Each test sets up a fresh
`MockState` and a `MockAuthenticator`, then drives the full server.

| Test | Scenario |
| --- | --- |
| `01-init-write-read-list.test.ts` | `session_init_project` → `collab_write` → `collab_read` → `collab_list_files`. Asserts sentinel created, frontmatter `doc_id` assigned, audit entries written. |
| `02-two-agents-different-sections.test.ts` | Two MCP clients against the same mock Graph. Each acquires a different section, writes, releases. No cTag conflicts. |
| `03-cTag-mismatch-proposal-fallback.test.ts` | Agent A writes successfully; agent B writes with `conflictMode: "proposal"` and stale cTag. Asserts proposal file created in `/proposals/`, frontmatter updated, no body overwrite. |
| `04-frontmatter-stripped.test.ts` | Direct mock-Graph write that wipes frontmatter (simulates the OneDrive web UI). Next `collab_read` returns defaults; `frontmatter_reset` audit entry written; next `collab_write` re-injects with the **same `doc_id`** if the prior cache exists, otherwise a new one (constraint says body is canonical so a fresh id is acceptable). |
| `05-source-external-reapproval.test.ts` | `collab_write` with `source: "external"` triggers the re-prompt path. Browser spy approves; write completes. Audit records `external_source_approval`. |
| `06-source-external-declined.test.ts` | Same as above but spy declines; tool returns `ExternalSourceDeclinedError`. No write. |
| `07-destructive-apply-proposal.test.ts` | Apply a proposal over a section with human authorship; destructive re-prompt fires; on approve, write succeeds and destructive counter increments. |
| `08-scope-traversal-rejected.test.ts` | One row per refusal reason in §4.7: `..`, `..%2f`, `%2e%2e/`, double-encoded `%252e%252e`, full-width `．．/`, leading `/`, drive-letter `C:/`, control char `\u0001`, dot-prefixed `.collab/foo`, layout `random/foo.md`, `proposals/foo.txt` (wrong extension), `proposals/foo.md` resolved to a `remoteItem` (shortcut/redirect), cross-drive item, case-aliased `Proposals/foo.md`. Each returns `OutOfScopeError` with the matching reason. No Graph call should be issued for pre-resolution refusals (mock asserts zero requests). |
| `09-budget-exhaustion.test.ts` | Default 50 writes succeed; 51st returns `BudgetExhaustedError`. Reads continue to work. |
| `10-ttl-expiry.test.ts` | Use a fake clock helper; advance past TTL; next call returns `SessionExpiredError`. `session_renew` resets. |
| `11-renewal-caps.test.ts` | Cap-3-per-session: fourth `session_renew` returns `RenewalCapPerSessionError`. Cap-6-per-window: simulate 6 renewals across 23h then a 7th in the same window returns `RenewalCapPerWindowError`; advance to >24h, allowed again. |
| `12-throttle-surfaced.test.ts` | Mock Graph returns 429 with `Retry-After: 1` to all writes. Verify exactly `maxRetries + 1 = 4` attempts (per `src/graph/client.ts:204`), then `GraphRequestError` surfaced as tool error. No infinite retry. |
| `13-form-xss-escaped.test.ts` | `collab_write` with `intent: "<script>alert(1)</script>"` shown in the external-source re-prompt form. Assert form HTML contains `&lt;script&gt;` text, not raw tag. Repeat for `path`, `folderPath`, `authoritativeFileName`, and a diff body containing `<script>` markers. |
| `14-loopback-csrf-rejected.test.ts` | Forge a `POST /submit` with missing CSRF token, wrong CSRF token, wrong `Host`, missing `Origin`, wrong `Content-Type`. Each must return 4xx and not advance form state. Audit records `csrfTokenMatched: false`. |
| `15-sentinel-tamper-detected.test.ts` | Open the project once (pin recorded). Mutate sentinel `authoritativeFileId` directly via mock Graph. Re-open: returns `SentinelTamperedError`; `sentinel_changed` audit entry written. "Forget project" then re-open: succeeds with new pin. |
| `16-source-hint-mismatch.test.ts` | `collab_read` content X. `collab_write` with `source: "project"` and content Y that has zero shingle overlap with X. Write succeeds, `source_hint_mismatch` audit entry written. Same write with content sharing a chunk with X: no warning entry. |
| `17-share-url-host-allowlist.test.ts` | Paste `file:///etc/passwd`, `http://localhost`, `https://attacker.example`, `https://1drv.ms/foo` (allowed). First three return `InvalidShareUrlError` with no Graph call. Fourth proceeds to `/shares/u!…`. |
| `18-form-busy-lock.test.ts` | Open the init form; while it's open, another tool call requests a destructive form. Second call returns `FormBusyError` carrying the URL of the in-flight form. After completing the first form, the second call succeeds. |

### 8.3 Helper additions

- Extend `test/mock-graph.ts` with handlers for `/shares/{id}/driveItem`,
  `/me/drive/sharedWithMe`, `/me/drive/items/{id}/versions`,
  `/me/drive/items/{id}/versions/{vid}/restoreVersion`,
  `/me/drives/{id}/root/delta`, and
  `/me/drive/items/{id}/permissions`. Reuse the cTag/version logic
  from existing markdown handlers. Add request-recording so tests can
  assert "no Graph call was issued" for pre-resolution refusals.
- Extend `test/integration/helpers.ts` with `createTwoClients(env)`
  for the two-agent test.
- Add `test/collab/clock.ts` — simple fake clock helper, injected
  through `ServerConfig.now?: () => Date` (proposed addition to
  `ServerConfig`; falls back to `() => new Date()` in production).
- Add `test/collab/forms-spy.ts` — a spy `openBrowser` that captures
  the form URL, fetches the rendered HTML for assertion, extracts the
  embedded CSRF token, and lets tests POST a forged or genuine
  submit. Required by tests 05, 06, 07, 13, 14, 17, 18.

### 8.4 Expectations on existing tests

No changes. Constraint: `markdown_*` tools untouched. The shared
`GraphClient` retry behaviour does not change, so
`test/graph/client.test.ts` stays as-is.

## 9. Rollout plan

Definition-of-done bar for every milestone: lint clean, typecheck
clean, all new tests passing, no regressions in `npm run check`.

Plain markdown calendar; days are working days.

### Week 0 (prerequisite hardening)

This week is added in response to security review item P1-1. The work
benefits the existing login and todo-list-picker flows; collab v1
inherits a hardened substrate.

- **W0 Day 1 — `escapeHtml` helper + template audit.** Add
  `src/templates/escape.ts`, route every interpolation in
  `src/templates/{login,picker,logout}.ts` through it. DoD:
  `test/templates/*.test.ts` extended with XSS rows for every
  user-controllable field.
- **W0 Day 2 — Loopback hardening on `src/picker.ts` and
  `src/loopback.ts`.** Host pin, Origin pin, CSRF token, JSON
  Content-Type, Sec-Fetch-Site check, CSP `frame-ancestors 'none'`.
  DoD: `test/picker.test.ts` extended per §8.1; existing login flow
  still works end-to-end.
- **W0 Day 3 — Form-factory module.** Add `src/tools/collab-forms.ts`
  with the form-factory lock and a thin wrapper around
  `startBrowserPicker`-style server creation that bakes in the
  hardening. DoD: `18-form-busy-lock.test.ts` passes against an
  early-stub form. Login and todo flows migrated to use the factory
  for consistency.

### Week 1

- **W1 Day 1 — `ServerConfig` extensions + sentinel reader/writer.**
  Add `now?: () => Date` and `userOid: string` plumbing through
  `auth.ts`, `MockAuthenticator`, and `ServerConfig`. Sentinel reader
  with Zod schema + `SentinelTamperedError` plumbing (no UI yet).
  DoD: `test/auth.test.ts` extended for `userOid`; sentinel round-trip
  unit test passes.
- **W1 Day 2 — `session_init_project` skeleton + init form.**
  Module layout (`src/collab/`, `src/tools/session.ts`,
  `src/tools/collab.ts`). Init form HTML with folder pick (no URL
  paste yet). Recents writer. DoD: integration test writes a sentinel
  and the file appears in mock Graph at the right path; pin block
  written in local project metadata.
- **W1 Day 3 — `session_status` (read-only).** TTL math, budget
  counters in memory + persisted destructive counter (§3.7). DoD:
  status tool reports an active session and survives a simulated
  process restart.
- **W1 Day 4 — `collab_read` + `collab_list_files`.** Frontmatter
  parser (`yaml`, hardened parse options), default-fallback path,
  `frontmatter_reset` audit entry. DoD: read of the authoritative
  file returns parsed frontmatter and body separately.
- **W1 Day 5 — Scope enforcement (§4.7 algorithm in full).** Path
  resolver under the project folder, all eight pre-resolution
  refusals, NFKC check, byId resolution, ancestry check,
  shortcut/redirect refusal, cross-drive refusal, case-aliasing
  refusal. DoD: every row in `08-scope-traversal-rejected.test.ts`
  passes.

### Week 2

- **W2 Day 1 — `collab_write` Graph helper.** `writeAuthoritative`,
  `writeProjectFile` with `If-Match`/`conflictBehavior`. Reuses
  `requestRaw`. DoD: `test/graph/collab.test.ts` covers cTag mismatch,
  byPath create, byId replace.
- **W2 Day 2 — `collab_write` tool registration + `source` parameter
  + external re-prompt + source heuristic.** Per-session read cache
  for shingle hashes. DoD: write happy path + cTag mismatch +
  external-source approve + decline + source-hint mismatch audit
  entry.
- **W2 Day 3 — Frontmatter writer + `doc_id` assignment + audit
  redaction allow-list.** Inserts the block on first write; preserves
  existing structure; byte-stable round-trip. DoD: round-trip test
  passes; existing markdown without frontmatter gains a `doc_id`;
  `audit.test.ts` asserts no `Bearer` substring leaks.
- **W2 Day 4 — `collab_acquire_section` + `collab_release_section`.**
  Free (no budget cost). Lease TTL stored in frontmatter. DoD: two-agent
  acquire test passes; lease-not-held returns the right error.
- **W2 Day 5 — `collab_create_proposal` + `collab_apply_proposal`
  (with destructive re-prompt).** Reuses the `diff` package for the
  re-prompt diff render. DoD:
  `03-cTag-mismatch-proposal-fallback.test.ts` and
  `07-destructive-apply-proposal.test.ts` pass.

### Week 3

- **W3 Day 1 — `session_open_project` + sentinel pinning + tamper
  detection.** URL paste resolution (with host allow-list),
  shared-with-me listing, recents. Open form. DoD:
  `15-sentinel-tamper-detected.test.ts` and
  `17-share-url-host-allowlist.test.ts` pass.
- **W3 Day 2 — `session_renew` + renewal caps.** Renewal counts file
  with rolling-window pruning. Fake-clock test infra.
  DoD: `11-renewal-caps.test.ts` passes.
- **W3 Day 3 — `collab_list_versions` + `collab_restore_version`.**
  Reuse `listDriveItemVersions`. Destructive re-prompt for
  authoritative restore. DoD: integration test for restore on
  authoritative + on a draft file.
- **W3 Day 4 — `collab_delete_file`.** Always-destructive re-prompt;
  refuse authoritative and sentinel. DoD: integration test covers
  proposals, drafts, attachments, and explicit refusal cases.
- **W3 Day 5 — Audit writer hardening + scope-gate polish + docs.**
  Atomic appends, ≤4096-byte cap, `_unscoped.jsonl` fallback. Optional
  `GraphScope.Collab` toggle in the login picker; `buildInstructions`
  extension for collab; help text for `collab_*` tools when no session
  is active. README, CHANGELOG, `manifest.json` tool list, end-to-end
  `npm run check`. DoD: kill-mid-write test produces a parseable file;
  CHANGELOG entry written; no `any`; no new lint warnings.

Total estimate: **4 weeks for one engineer** (3 weeks for the collab
work plus W0 hardening). LOC budget below.

## 10. Open questions

Items I could not resolve from the code alone. Items already addressed
in the plan body (§4.7 path algorithm, §3.2 sentinel pinning, §0
threat model, source heuristic) are no longer listed as questions.

1. **Concurrent picker forms.** `src/picker.ts` does not have a
   "single in-flight" guard. v1 mitigation in §5.3 is a form-factory
   lock; the underlying picker code is not changed. Whether the
   browser open behaviour stacks gracefully when multiple tabs open
   in quick succession (does the second tab steal focus, does the
   first survive?) needs UX testing on each MCP host.
2. **Browser form binary uploads.** The current picker body cap is
   1 MiB (`src/picker.ts:73`) and only handles JSON. The destructive
   re-prompt form will display a diff (text only) so it does not need
   binary upload. If a future form needs to attach a binary
   (screenshot of the proposal?), the picker server will need a
   `multipart/form-data` parser. Out of scope for v1.
3. **MCP client disconnect mid-form.** If the MCP transport closes
   while a form is open, the abort signal cascades down (`createMcpServer`
   accepts `signal`, and `startBrowserPicker(...,signal)` reacts). The
   form's HTTP server should stop and the user's submit should fail
   with a clear "session ended" page. Today's picker handles
   `signal.aborted` but the explicit teardown pathway is not
   well-tested. The W0 hardening milestone adds the missing test.
4. **`clientInfo.name` reliability across hosts.** The MCP SDK exposes
   `clientInfo.name` on `initialize`. Empirical: Claude Desktop sends
   `"claude-ai"`, VS Code Copilot sends `"vscode"`, Claude Code sends
   `"claude-code"`. I have not verified these in this repo. If absent
   or inconsistent, `agentId` falls back to `unknown`. The MCP SDK
   `Server` instance exposes `getClientCapabilities()` and
   `getClientVersion()` after `connect`; today the server is
   constructed without persisting `clientInfo` anywhere
   (`src/index.ts:75-81`). Likely a small one-line read after
   `connect` is enough.
5. **`/me/drive/sharedWithMe` duplicates.** Whether the same item
   appears twice when both read and write shares exist depends on
   the share schema. Microsoft docs do not state this clearly. Plan
   is to dedupe by `remoteItem.id` and prefer the entry whose
   permissions include `write`.
6. **Entra `oid` source.** Today's `Authenticator.accountInfo` only
   returns `username`. To form the `agentId` prefix we need
   `localAccountId` from MSAL's `AuthenticationResult.account` or the
   `oid` claim from the id token. Both are accessible via `msal-node`
   APIs not currently surfaced. Adding `userOid: string` to
   `AccountInfo` is a small change but spans `src/auth.ts`,
   `src/tools/status.ts`, and the `MockAuthenticator`. Flag to
   coordinate with anyone touching `auth.ts`.
7. **OneDrive personal vs business cTag stability.** The brief
   constrains v1 to OneDrive personal drives. The cTag semantics
   ("content-only ETag") are documented for OneDrive personal and
   commercial; SharePoint Teams may behave differently. If
   "Shared with me" surfaces a SharePoint-backed item that Graph
   returns a `cTag` for, optimistic concurrency should still work,
   but spurious 412s on metadata changes are possible. Plan accepts
   them and lets the agent reconcile via `collab_read`.
8. **Authorship trail size.** `frontmatter.authorship[]` is
   monotonically appended. For long-lived projects this grows
   unbounded. v1 has no compaction. Future strategies: cap at the
   last N entries; spill the older ones into a sidecar at
   `/me/drive/special/approot/`. Worth flagging in the schema so we
   are not surprised at the v2 design table.
9. **`@microsoft.graph.conflictBehavior=replace` on a destination
   that turns out to be a folder.** `PUT .../content` on a folder ID
   returns 405. We pre-validate that `path` resolves to a file before
   issuing the PUT, mirroring the defence-in-depth checks in markdown
   tools (`src/tools/markdown.ts:551-575`).
10. **Soft-warn folders cross-locale.** `/Documents`, `/Pictures`,
    `/Desktop` are English defaults; non-English OneDrives use
    localised names but the same well-known folder IDs are exposed
    via `GET /me/drive/special/{name}` (e.g. `documents`, `photos`).
    Resolve via `/me/drive/special/...` and compare item IDs rather
    than names. The `name` value is a literal type, never derived
    from input (§5.4).

## 11. Non-goals (verbatim)

- Webhooks on driveItems
- CRDTs (Yjs, Automerge, Loro, diamond-types)
- Structural/tree-sitter three-way merge
- `diff-match-patch` three-way merge (v2)
- SharePoint checkout/checkin
- SharePoint Teams sites (v2)
- Selected permissions / Graph-side enforcement (v2)
- Cross-drive or multi-folder scopes
- Real-time presence indicators
- Custom listItem field usage
- `session_revoke` tool or browser revoke UI
- Second-human approval flows
- Allow-lists of pre-approved scopes
- Idle expiry

---

## Appendix A: file list and LOC estimate

Directory split. The tool-developer review pushed back on a freestanding
`src/collab/` directory. The compromise: keep `src/collab/` for the
*cross-cutting non-tool, non-Graph utilities* (session lifecycle, scope
resolution algorithm, frontmatter codec, audit writer, sentinel codec,
recents/renewal/destructive-counter persistence). Tool registration
stays in `src/tools/`, Graph helpers stay in `src/graph/`, templates
stay in `src/templates/` (matches existing `login.ts`, `picker.ts`,
`logout.ts` siblings). The form factory and form HTML live under
`src/tools/collab-forms.ts` (factory) and `src/templates/collab.ts`
(HTML), with no separate `src/forms/` directory.

Proposed new files:

| File | LOC estimate |
| --- | --- |
| `src/collab/session.ts` (lifecycle, agentId, currentSession) | 240 |
| `src/collab/scope.ts` (§4.7 algorithm) | 220 |
| `src/collab/frontmatter.ts` (yaml round-trip, doc_id, defaults) | 240 |
| `src/collab/audit.ts` (writer, redaction, ≤4096-byte cap) | 180 |
| `src/collab/ulid.ts` (inlined) | 60 |
| `src/collab/sentinel.ts` (read, write, pinning, tamper detection) | 160 |
| `src/collab/recents.ts` | 100 |
| `src/collab/renewal.ts` | 120 |
| `src/collab/destructive-counter.ts` (§3.7 persistence) | 80 |
| `src/collab/source-cache.ts` (per-session shingle cache) | 100 |
| `src/graph/collab.ts` (sentinel/authoritative I/O, shares, sharedWithMe, delta) | 360 |
| `src/templates/collab.ts` (init/open/destructive/external form HTML) | 420 |
| `src/templates/escape.ts` (`escapeHtml`) | 30 |
| `src/tools/collab-forms.ts` (form factory + lock + hardening wrapper) | 240 |
| `src/tools/session.ts` (4 session_* tools) | 340 |
| `src/tools/collab.ts` (10 collab_* tools) | 760 |

Test files:

| File | LOC estimate |
| --- | --- |
| `test/graph/collab.test.ts` | 380 |
| `test/collab/*.test.ts` (5 files) | 760 |
| `test/integration/collab/*.test.ts` (18 files) | 2100 |
| `test/picker.test.ts` extensions (W0 hardening) | 200 |
| `test/mock-graph.ts` extensions | 280 |

Modifications:

| File | Δ LOC |
| --- | --- |
| `src/index.ts` (register new tools, `now`, `userOid`) | +40 |
| `src/scopes.ts` (optional `Collab` toggle) | +20 |
| `src/auth.ts` (`userOid` field) | +35 |
| `src/picker.ts` (W0 CSRF/Origin/Host/CSP hardening) | +90 |
| `src/loopback.ts` (W0 hardening parity) | +40 |
| `src/tool-registry.ts` (`group` field, instructions block) | +25 |
| `src/tools/status.ts` (collab section) | +25 |
| `src/tools/login.ts`, `src/tools/markdown.ts` (use form factory) | +30 |
| `src/templates/{login,picker,logout}.ts` (escapeHtml plumbing) | +30 |
| `manifest.json` (tool descriptions) | +80 |
| `README.md`, `CHANGELOG.md` | +250 |

Rough total: **3 700 LOC src, 3 700 LOC tests** for v1. The W0
hardening work and the doubled-up integration test suite (18 files vs
the original 12) account for the increase from the first draft's
estimate.

## Appendix B: three biggest risks surfaced while writing

1. **Identity surface gap.** The current `Authenticator` exposes only
   `username`. `agentId` requires the Entra `oid`. Adding it touches
   the auth interface, the mock authenticator, and a handful of
   callers. Easy mechanically, but spans security-sensitive code
   (cache plugin, account.json persistence). Mis-handling could leak
   the full `oid` into logs. The audit writer mitigates by routing
   every envelope through one redaction-enforcing helper (§3.6) and
   asserting in tests that no audit line ever contains the substring
   `"Bearer "` (test `04 audit.test.ts`).
2. **Frontmatter as the coordination substrate.** Putting leases and
   proposal metadata in YAML inside the file means *every* CAS-write
   round-trips the entire file body. For files near the 4 MiB cap,
   a chatty agent can burn the write budget on metadata. Plus, the
   YAML round-trip must be **byte-stable** to avoid spurious diffs in
   OneDrive version history. The `yaml` library has multiple
   serialisation paths; we need to pin one and add round-trip tests
   on day one.
3. **Browser form UX during background sessions.** Mid-session
   re-prompts (destructive, source:external) interrupt the agent
   conversation. If the user is not at the keyboard, the agent
   stalls until the form times out. With a 2-hour TTL the form
   timeout (default 120 s) is much shorter than the session, which
   is correct, but the agent's UX needs careful messaging
   ("waiting for the user to approve in the browser..."). Clear
   audit entries help post-hoc diagnosis but do not fix the live
   stall.
