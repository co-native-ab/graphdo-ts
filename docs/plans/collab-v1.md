# Collab v1: Multiplayer Async Collaboration for graphdo-ts

Plan for a new `session_*` and `collab_*` tool surface that sits alongside
the existing single-player `markdown_*` tools. Async, OneDrive-backed,
ETag-driven, no server-side coordinator. Constraints in the task brief are
treated as locked. This document follows them; deviations are flagged in
section 10.

Convention used throughout:

- "Read in repo:" lines are grounded, with `path:line` citations.
- "Proposed:" lines are design choices made in this plan.

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
      author_agent_id: "a3f2c891-..."
      author_user_oid_prefix: "a3f2c891"
      created_at: "2026-04-19T05:51:00Z"
      status: "open"                     # open | applied | superseded | withdrawn
      body_path: "proposals/01JCDEF....md"
      rationale: "tighten the wording"
      source: "chat"
  authorship:                            # append-only trail per range
    - line_start: 12
      line_end: 47
      author_kind: "agent"               # agent | human
      author_agent_id: "..."
      author_user_oid_prefix: "..."
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
    "userOidPrefix": "a3f2c891",
    "username": "alice@example.com"
  },
  "createdAt": "2026-04-19T05:00:00Z"
}
```

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
  "authoritativeFileId": "01ABCDEF...",
  "authoritativeFileName": "README.md",
  "addedAt": "2026-04-19T05:00:00Z",
  "lastSeenSentinelAt": "2026-04-19T05:00:00Z",
  "lastSeenAuthoritativeCTag": "\"{...,17}\"",
  "lastSeenAuthoritativeRevision": "17",
  "lastDeltaToken": "abc123==",          // for future delta polling
  "perAgent": {
    "<agentId>": {
      "lastSeenAt": "2026-04-19T05:50:00Z",
      "lastSeenCTag": "\"{...,16}\"",
      "lastSeenRevision": "16"
    }
  }
}
```

Optimization-only (constraint: losing it never breaks correctness).

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
      "role": "originator",              // originator | collaborator
      "available": true,
      "unavailableReason": null
    }
  ]
}
```

Stale entries (folder gone, sentinel gone, user lost access) are
flipped to `available: false` with a reason; not silently dropped
(constraint).

### 3.5 Renewal counts `<configDir>/sessions/renewal-counts.json`

Keyed by `<userOidPrefix>/<projectId>`. Each entry is a sliding window
of timestamps; entries older than 24h are pruned on read.

```json
{
  "schemaVersion": 1,
  "windows": {
    "a3f2c891/01JABCDE...": {
      "renewals": [
        "2026-04-18T07:00:00Z",
        "2026-04-19T03:30:00Z"
      ]
    }
  }
}
```

`session_renew` rejects when `windows[key].renewals` already has 6
entries inside the last 24h (constraint).

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
  "userOidPrefix": "a3f2c891",
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
| `session_end` | `reason: "ttl" | "budget" | "mcp_shutdown" | "manual_stop"`, `writesUsed`, `renewalsUsed` |
| `tool_call` | `inputSummary` (path, source, conflictMode), `cTagBefore`, `cTagAfter`, `revisionAfter`, `bytes` (writes only), `source` (writes only) |
| `scope_denied` | `reason: "out_of_scope" | "path_layout" | "blocked_scope"`, `attemptedPath` |
| `destructive_approval` | `tool`, `outcome: "approved" | "declined" | "timeout"`, `diffSummaryHash` |
| `renewal` | `windowCountBefore`, `windowCountAfter`, `sessionRenewalsBefore`, `sessionRenewalsAfter` |
| `external_source_approval` | `tool`, `path`, `outcome` |
| `frontmatter_reset` | `reason: "missing" | "malformed"`, `previousRevision` |
| `error` | `errorName`, `errorMessage` (already redacted), `graphCode?`, `graphStatus?` |

Atomic append: open with `O_APPEND`, single `fs.appendFile` call. Per
constraint, no chaining; if a line is partially written on crash it is
discarded by the next reader (the parser tolerates trailing partial
JSON). All writes are best-effort: an audit failure does not fail the
tool call (logged at `warn`).

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
spuriously invalidate `eTag`.

Microsoft Learn:
<https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0>.

### 4.3 Scope discovery for `session_open_project`

```
GET  /me/drive/sharedWithMe?$select=id,name,remoteItem,lastModifiedDateTime
```

Each entry is a "shortcut" `driveItem` whose real target is in
`remoteItem.parentReference.driveId`/`remoteItem.id`. Gotchas:

- The same item can appear twice if it has both read and write shares
  (flagged in section 10).
- The endpoint can return items where the user has read-only access; we
  must filter to items where `remoteItem.permissions[].roles`
  contains `"write"` or `"owner"`. Permissions may need a follow-up
  `GET /drives/{driveId}/items/{itemId}/permissions` call when not
  expanded.
- Folder vs file: only entries with `remoteItem.folder` are usable as
  project scopes; refuse the rest (constraint).

Microsoft Learn:
<https://learn.microsoft.com/en-us/graph/api/drive-sharedwithme?view=graph-rest-1.0>.

### 4.4 URL-paste resolution

OneDrive sharing URLs are resolved via the shares API. Encode the URL
with the documented `u!<base64url>` scheme:

```
GET  /shares/u!<base64url-of-share-link>/driveItem?$select=id,parentReference,folder,name
```

For OneDrive sharing URLs that resolve to a file (e.g. the user pasted
the authoritative file rather than the folder), follow up with a `GET
/me/drive/items/{parentReference.id}` to land on the folder and then
the sentinel read.

Microsoft Learn:
<https://learn.microsoft.com/en-us/graph/api/shares-get?view=graph-rest-1.0>.

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
`src/forms/collab-approval.ts` module that defines the shape of the
form, the route layout (`/`, `/submit`, `/cancel`), and the
server-side state to capture. The HTML lives under `src/templates/`
alongside `picker.ts` so design tokens stay consistent.

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

- One active `session_*` form at a time per MCP instance, enforced by
  a small "form lock" in the new approval module. Calls while a form
  is open return `FormBusyError`.
- Mid-session re-prompts (destructive, external) inherit the same
  lock so the agent can never have two re-prompts open at once.

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
session is active. Reasoning:

- Matches the brief's preference and the existing pattern: today's
  `markdown_*` tools stay visible after login even when no root
  folder is configured; the agent learns the flow from the error
  message ("use the markdown_select_root_folder tool"), see
  `src/config.ts:212-229`.
- Discoverability: agents enumerate `tools/list` once. Hiding tools
  behind a session means an agent cannot guide the user to start one.
- Session-state changes do not need to fire `tools/list_changed`
  (which is a real perf win on hot paths).

Counter-argument: dynamically hiding tools would let us avoid
documenting the "no session" error path for every tool. We accept that
documentation cost in exchange for discoverability.

Implementation hook: register all `session_*` and `collab_*` tools at
startup with `requiredScopes: [GraphScope.FilesReadWrite]` (or the new
`GraphScope.Collab` if we add one), and rely on `syncToolState`
(`src/tool-registry.ts:90-111`) to enable them on login. Each
`collab_*` handler starts with:

```ts
const session = currentSession();
if (!session) return formatError(toolName, new NoActiveSessionError());
if (session.expired()) return formatError(toolName, new SessionExpiredError(session));
```

`currentSession()` lives in a new `src/collab/session.ts`.

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
  `resolveSharedWithMe`, `resolveShareUrl`, `listProjectChildren`,
  `applyDelta` (filter by ancestry).
- `test/collab/session.test.ts` — TTL math, renewal-window math,
  budget counters.
- `test/collab/scope.test.ts` — path resolution, `..`, `%2e%2e/`,
  Unicode normalization, shortcut/redirect items resolved outside
  scope.
- `test/collab/audit.test.ts` — JSONL append, schema, file rotation
  not required in v1, partial-line tolerance.
- `test/collab/frontmatter.test.ts` — round-trip of YAML, default
  injection, `doc_id` stability across writes.

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
| `08-scope-traversal-rejected.test.ts` | Tabular: `..`, `..%2f`, `%2e%2e/`, full-width `．．/`, leading `/`, paths in `.collab/`, paths above the project. Each returns `OutOfScopeError`. No Graph call should be made (mock asserts zero requests). |
| `09-budget-exhaustion.test.ts` | Default 50 writes succeed; 51st returns `BudgetExhaustedError`. Reads continue to work. |
| `10-ttl-expiry.test.ts` | Use a fake clock helper; advance past TTL; next call returns `SessionExpiredError`. `session_renew` resets. |
| `11-renewal-caps.test.ts` | Cap-3-per-session: fourth `session_renew` returns `RenewalCapPerSessionError`. Cap-6-per-window: simulate 6 renewals across 23h then a 7th in the same window returns `RenewalCapPerWindowError`; advance to >24h, allowed again. |
| `12-throttle-surfaced.test.ts` | Mock Graph returns 429 with `Retry-After: 1` to all writes. Verify exactly `maxRetries + 1 = 4` attempts (per `src/graph/client.ts:204`), then `GraphRequestError` surfaced as tool error. No infinite retry. |

### 8.3 Helper additions

- Extend `test/mock-graph.ts` with handlers for `/shares/{id}/driveItem`,
  `/me/drive/sharedWithMe`, `/me/drive/items/{id}/versions`,
  `/me/drive/items/{id}/versions/{vid}/restoreVersion`,
  `/me/drives/{id}/root/delta`. Reuse the cTag/version logic from
  existing markdown handlers.
- Extend `test/integration/helpers.ts` with `createTwoClients(env)` for
  the two-agent test.
- Add `test/collab/clock.ts` — simple fake clock helper, injected
  through `ServerConfig.now?: () => Date` (proposed addition to
  `ServerConfig`; falls back to `() => new Date()` in production).

### 8.4 Expectations on existing tests

No changes. Constraint: `markdown_*` tools untouched. The shared
`GraphClient` retry behaviour does not change, so
`test/graph/client.test.ts` stays as-is.

## 9. Rollout plan

Definition-of-done bar for every milestone: lint clean, typecheck
clean, all new tests passing, no regressions in `npm run check`.

Plain markdown calendar; days are working days.

### Week 1

- **W1 Day 1 — `session_init_project` skeleton + sentinel.**
  Module layout (`src/collab/`, `src/tools/session.ts`,
  `src/tools/collab.ts`, `src/forms/`). Sentinel reader/writer with
  Zod schema. Recents writer. Init form HTML with folder pick (no URL
  paste yet). DoD: integration test writes a sentinel and the file
  appears in mock Graph at the right path.
- **W1 Day 2 — `session_status` (read-only).** TTL math, budget
  counters in memory. DoD: status tool reports an active session.
- **W1 Day 3 — `collab_read` + `collab_list_files`.** Frontmatter
  parser (`yaml`), default-fallback path, `frontmatter_reset` audit
  entry. DoD: read of the authoritative file returns parsed
  frontmatter and body separately.
- **W1 Day 4 — Scope enforcement.** Path resolver under the project
  folder, traversal rejection, layout enforcement, shortcut/redirect
  refusal. DoD: every case in `08-scope-traversal-rejected.test.ts`
  passes.
- **W1 Day 5 — `collab_write` with `conflictMode: "fail"` and
  `source` parameter.** Reuses `requestRaw` and `If-Match` plumbing.
  External-source re-prompt form. DoD: write happy path + cTag
  mismatch path + external-source-approve + external-source-decline.

### Week 2

- **W2 Day 1 — Frontmatter writer + `doc_id` assignment.** Inserts
  the block on first write; preserves existing structure. DoD: round-trip
  test passes; existing markdown without frontmatter gains a `doc_id`.
- **W2 Day 2 — `collab_acquire_section` + `collab_release_section`.**
  Free (no budget cost). Lease TTL stored in frontmatter. DoD: two-agent
  acquire test passes.
- **W2 Day 3 — `collab_create_proposal` + `collab_apply_proposal`
  (with destructive re-prompt).** Reuses the `diff` package for the
  re-prompt diff render. DoD:
  `03-cTag-mismatch-proposal-fallback.test.ts` and
  `07-destructive-apply-proposal.test.ts` pass.
- **W2 Day 4 — `session_open_project`.** URL paste resolution,
  shared-with-me listing, recents. Form layout. DoD: end-to-end
  open of a sentinel that another simulated user wrote in the same
  mock drive.
- **W2 Day 5 — `session_renew` + renewal caps.** Renewal counts file
  with rolling-window pruning. Fake-clock test infra.
  DoD: `11-renewal-caps.test.ts` passes.

### Week 3

- **W3 Day 1 — `collab_list_versions` + `collab_restore_version`.**
  Reuse `listDriveItemVersions`. Destructive re-prompt for
  authoritative restore. DoD: integration test for restore on
  authoritative + on a draft file.
- **W3 Day 2 — `collab_delete_file`.** Always-destructive re-prompt;
  refuse authoritative and sentinel. DoD: integration test covers
  proposals, drafts, attachments, and explicit refusal cases.
- **W3 Day 3 — Audit writer hardening.** Atomic appends, partial-line
  tolerance, `_unscoped.jsonl` fallback. DoD: kill-mid-write test
  produces a parseable file on the next read.
- **W3 Day 4 — Scope gate polish + login UX.** Optional new logical
  scope (`GraphScope.Collab`) toggle in the login picker; help text
  for `collab_*` tools when no session is active.
- **W3 Day 5 — Documentation, README, `manifest.json` tool list,
  `npm run check` end-to-end, polish.** DoD: CHANGELOG entry written;
  no `any`; no new lint warnings.

Total estimate: **3 weeks for one engineer** with the existing test
harness. LOC budget below.

## 10. Open questions

Items I could not resolve from the code alone. Listed verbatim where
the brief explicitly asked, plus a few more I hit while writing.

1. **Concurrent picker forms.** `src/picker.ts` does not have a
   "single in-flight" guard. Two `startBrowserPicker` calls produce
   two independent servers on different ports. Whether the browser
   open behaviour stacks gracefully in practice (does the second tab
   open in the user's eyeline, does the first one survive the
   focus-steal?) needs UX testing. v1 mitigation in section 5.3 is a
   server-side lock; the underlying picker code is untouched.
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
   well-tested. Worth a dedicated test before shipping.
4. **`clientInfo.name` reliability across hosts.** The MCP SDK exposes
   `clientInfo.name` on `initialize`. Empirical: Claude Desktop sends
   `"claude-ai"`, VS Code Copilot sends `"vscode"`, Claude Code sends
   `"claude-code"`. I have not verified these in this repo. If absent
   or inconsistent, `agentId` falls back to `unknown`. Need to read
   from the MCP SDK's `Server` instance after `connect`; today the
   server is constructed without persisting `clientInfo` anywhere
   (`src/index.ts:75-81`). Likely a small SDK-side fetch is needed.
5. **`/me/drive/sharedWithMe` duplicates.** Whether the same item
   appears twice when both read and write shares exist depends on
   the share schema. Microsoft docs do not state this clearly. Plan
   is to dedupe by `remoteItem.id` and prefer the entry whose
   `permissions` include `write`.
6. **Entra `oid` source.** Today's `Authenticator.accountInfo` only
   returns `username`. To form the `agentId` prefix we need
   `localAccountId` from MSAL's `AuthenticationResult.account` or the
   `oid` claim from the id token. Both are accessible via `msal-node`
   APIs not currently surfaced. Adding `userOid?: string` to
   `AccountInfo` is a small change but spans `src/auth.ts`,
   `src/tools/status.ts`, and the `MockAuthenticator`. Flag to
   coordinate with anyone touching `auth.ts`.
7. **ULID library vs inlined.** Inlined ULID generator is 30 LOC and
   keeps deps minimal. Preferred. If cryptographic strength of the
   randomness is questioned, switch to `node:crypto.getRandomValues`
   (already used in `src/config.ts:117`).
8. **OneDrive personal vs business cTag stability.** The brief
   constrains v1 to OneDrive personal drives. The cTag semantics
   ("content-only ETag") are documented for OneDrive personal and
   commercial; SharePoint Teams may behave differently. If
   "Shared with me" surfaces a SharePoint-backed item that Graph
   returns a `cTag` for, optimistic concurrency should still work,
   but this needs end-to-end verification before we mark "Shared
   with me" pass-through as supported.
9. **Authorship trail size.** `frontmatter.authorship[]` is
   monotonically appended. For long-lived projects this grows
   unbounded. v1 has no compaction. Need a future strategy: cap at
   the last N entries, store the older ones in a sidecar in
   `/me/drive/special/approot/`, etc. Worth flagging in the schema
   so we are not surprised.
10. **`@microsoft.graph.conflictBehavior=replace` on a destination
    that turns out to be a folder.** `PUT .../content` on a folder ID
    returns 405. We should pre-validate that `path` resolves to a
    file before issuing the PUT, mirroring the defence-in-depth
    checks in markdown tools (`src/tools/markdown.ts:551-575`).
11. **Soft-warn folders cross-locale.** `/Documents`, `/Pictures`,
    `/Desktop` are English defaults; non-English OneDrives use
    localised names but the same well-known folder IDs are exposed
    via `GET /me/drive/special/{name}` (e.g. `documents`, `photos`).
    Resolve via `/me/drive/special/...` and compare item IDs rather
    than names. Otherwise localised users would never see the
    soft-warn.

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

Proposed new files:

| File | LOC estimate |
| --- | --- |
| `src/collab/session.ts` | 220 |
| `src/collab/scope.ts` | 180 |
| `src/collab/frontmatter.ts` | 220 |
| `src/collab/audit.ts` | 140 |
| `src/collab/ulid.ts` | 60 |
| `src/collab/sentinel.ts` | 120 |
| `src/collab/recents.ts` | 100 |
| `src/collab/renewal.ts` | 120 |
| `src/graph/collab.ts` | 320 |
| `src/forms/collab-approval.ts` | 260 |
| `src/templates/collab.ts` | 380 |
| `src/tools/session.ts` | 320 |
| `src/tools/collab.ts` | 740 |

Test files:

| File | LOC estimate |
| --- | --- |
| `test/graph/collab.test.ts` | 360 |
| `test/collab/*.test.ts` (5 files) | 700 |
| `test/integration/collab/*.test.ts` (12 files) | 1500 |
| `test/mock-graph.ts` extensions | 250 |

Modifications:

| File | Δ LOC |
| --- | --- |
| `src/index.ts` (register new tools, optional clock) | +30 |
| `src/scopes.ts` (optional `Collab` toggle) | +20 |
| `src/auth.ts` (`userOid` field) | +30 |
| `src/tools/status.ts` (collab section) | +25 |
| `manifest.json` (tool descriptions) | +60 |
| `README.md`, `CHANGELOG.md` | +200 |

Rough total: **3 100 LOC src, 2 800 LOC tests** for v1. Comfortable
under "dense is fine" budget.

## Appendix B: three biggest risks surfaced while writing

1. **Identity surface gap.** The current `Authenticator` exposes only
   `username`. `agentId` requires the Entra `oid`. Adding it touches
   the auth interface, the mock authenticator, and a handful of
   callers. Easy mechanically, but spans security-sensitive code
   (cache plugin, account.json persistence). Mis-handling could leak
   the full `oid` into logs. Mitigation: only persist the first 8
   chars and derive `agentId` from those.
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
