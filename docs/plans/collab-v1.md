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
2. A hostile _web page_ the user visits while an MCP session is active.
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
2. A malicious agent that lies about `source`. Out of scope at the
   tool layer; the audit log records `source` per write so post-hoc
   detection is a one-line `jq` query (e.g. `source: "project"` on
   files no `collab_read` ever touched in that session). v1 does not
   add a runtime tripwire because the heuristics tested in earlier
   drafts produced both false positives (legitimate from-scratch
   rewrites) and false negatives (a malicious agent need only quote
   one shingle of real content). See §2.3 `collab_write`.
3. A malicious _cooperator_ with write access to the project folder.
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
budget, and renewal caps defend the _agent_ against runaway loops and
the _human_ against UI fatigue. They are **not** a security boundary
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

| Tool                          | Inputs (zod shape)                               | Source                            |
| ----------------------------- | ------------------------------------------------ | --------------------------------- |
| `markdown_select_root_folder` | `{}`                                             | `src/tools/markdown.ts:332-449`   |
| `markdown_list_files`         | `{}`                                             | `src/tools/markdown.ts:452-520`   |
| `markdown_get_file`           | `idOrNameShape` (`itemId?`, `fileName?`)         | `src/tools/markdown.ts:522-598`   |
| `markdown_create_file`        | `{ fileName, content }`                          | `src/tools/markdown.ts:600-673`   |
| `markdown_update_file`        | `idOrNameShape + { cTag, content }`              | `src/tools/markdown.ts:675-811`   |
| `markdown_delete_file`        | `idOrNameShape`                                  | `src/tools/markdown.ts:813-881`   |
| `markdown_list_file_versions` | `idOrNameShape`                                  | `src/tools/markdown.ts:883-975`   |
| `markdown_get_file_version`   | `idOrNameShape + { versionId }`                  | `src/tools/markdown.ts:977-1063`  |
| `markdown_diff_file_versions` | `idOrNameShape + { fromVersionId, toVersionId }` | `src/tools/markdown.ts:1065-1222` |
| `markdown_preview_file`       | `{ fileName }`                                   | `src/tools/markdown.ts:1224-1296` |

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

Items in #6 _not_ used directly: literal-union enums for Graph fields
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
  source: z
    .enum(["chat", "project", "external"])
    .describe(
      "Where this content originated. 'chat' = the human typed it this turn; " +
        "'project' = read via collab_read in this session; " +
        "'external' = anything else (web fetch, prior session, generated). " +
        "Writes with source='external' trigger a browser re-approval.",
    ),
} as const;

const cTagShape = {
  cTag: z
    .string()
    .min(1)
    .describe(
      "Opaque cTag previously returned by collab_read or another collab write. " +
        "Sent verbatim in If-Match. cTag is OneDrive's content-only entity tag, " +
        "so unrelated metadata changes (rename, share, indexing) do not invalidate it.",
    ),
} as const;

const conflictModeShape = {
  conflictMode: z
    .enum(["fail", "proposal"])
    .default("fail")
    .describe(
      "Behavior on cTag mismatch (HTTP 412). 'fail' returns an error with the " +
        "current cTag and revision so the agent can re-read and reconcile. " +
        "'proposal' diverts the new content to /proposals/<ulid>.md and records " +
        "a proposal entry in frontmatter. 'diff3' is reserved for v2.",
    ),
} as const;

const projectScopedPathShape = {
  path: z
    .string()
    .min(1)
    .describe(
      "Scope-relative path inside the active project, e.g. 'proposals/p-foo.md', " +
        "'drafts/scratch.md', 'attachments/diagram.png'. Absolute paths, '..', " +
        "URL-encoded traversal, and the authoritative .md at the root are rejected.",
    ),
} as const;
```

### 2.2 Session tools

A note on **session lifetime vs MCP transport**. A session is bound to
the MCP server **OS process**, not to the transport connection. If the
MCP host (Claude Desktop, VS Code, Claude Code) drops the stdio
transport and reconnects without restarting the server process, the
session survives: in-memory state is unchanged, the destructive
counter persisted to disk (§3.7) is rebound on the new connection by
matching `sessionId`. Sessions die on:

- explicit `manual_stop` (not exposed in v1; user ends the MCP server)
- TTL expiry (§3.5)
- write-budget exhaustion (write tools error; reads still work until
  TTL)
- OS process exit (stdio EOF + signal handler in `main()`)

#### `session_init_project`

Originator flow. Browser form opens; human picks an existing folder and,
when the folder contains more than one `.md` at the root, picks which
one is the authoritative file. Server writes
`<projectFolder>/.collab/project.json`, records the project locally, and
captures TTL + write budget.

```ts
session_init_project(args: {}): Promise<ToolResult>
```

The tool takes no arguments by design: every required value comes from
the browser form (constraint). **This must be spelled out explicitly in
the MCP tool description** so agents that pattern-match on input/output
shape don't get confused by a tool with no inputs and a side-effectful
return:

> `description`: "Start a new collaboration project. Opens a browser
> form where the human selects the OneDrive folder and authoritative
> markdown file; all parameters come from that form, not from this
> tool call. Returns the resulting projectId, folder path,
> authoritative file name, TTL, and budgets."

Returns text confirming `projectId`, folder, authoritative file, TTL,
budgets. Side effects:

- Writes `.collab/project.json` (atomic, see section 3.2 schema).
- Writes `<configDir>/projects/<projectId>.json`.
- Adds an entry to `<configDir>/projects/recent.json`.
- Activates an in-memory session in this MCP instance.

Graph endpoints called:

| Step                                  | Endpoint                                                                                             | Doc                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| List candidate folders for the picker | `GET /me/drive/root/children?$select=id,name,folder,webUrl,parentReference`                          | <https://learn.microsoft.com/en-us/graph/api/driveitem-list-children?view=graph-rest-1.0> |
| Resolve a pasted OneDrive URL         | `GET /shares/{encoded-id}/driveItem?$select=id,name,parentReference,folder`                          | <https://learn.microsoft.com/en-us/graph/api/shares-get?view=graph-rest-1.0>              |
| Enumerate files in chosen folder      | `GET /me/drive/items/{folderId}/children?$select=id,name,file,size`                                  | (same as list-children)                                                                   |
| Verify `.collab/` does not yet exist  | `GET /me/drive/items/{folderId}:/.collab/project.json` (expect 404)                                  | <https://learn.microsoft.com/en-us/graph/api/driveitem-get?view=graph-rest-1.0>           |
| Create `.collab` folder               | `POST /me/drive/items/{folderId}/children` with `{ name: ".collab", folder: {} }`                    | <https://learn.microsoft.com/en-us/graph/api/driveitem-post-children?view=graph-rest-1.0> |
| Write sentinel file                   | `PUT /me/drive/items/{collabFolderId}:/project.json:/content?@microsoft.graph.conflictBehavior=fail` | <https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0>   |

Headers: `Authorization: Bearer <token>`, `Content-Type:
application/json` (sentinel write). Retries: inherited from `GraphClient`
(429/503/504 with `Retry-After`). Throttle policy: same as section 4.6.

**Multiple root `.md` files are not an error.** The form lists every
`.md` at the folder root and lets the human select which one is
authoritative. Other root files (a stray `NOTES.md`, a `README.md`
created by GitHub habit) stay where they are; they simply aren't the
authoritative file. Only the layout under `/proposals`, `/drafts`,
`/attachments` is enforced downstream by the scope resolver (§4.6).

Error cases:

- `SessionAlreadyActiveError` — an active session already exists in this
  MCP instance. Tells the human to stop the MCP server.
- `BlockedScopeError` — folder is `/me/drive/root`, recycle bin pseudo,
  not a folder, in a "Shared with me" item without write access, or
  matches a current scope.
- `NoMarkdownFileError` — folder contains zero `.md` files at the
  root. (More than one is allowed and resolved by the form.)
- `FormPayloadInvalidError` — the form server received a `POST
/submit` whose JSON body was missing `authoritativeFileId` (or
  any other required field). The browser UI prevents this when
  N≥2 by disabling Submit until a radio is chosen, but a forged
  POST to the loopback could bypass the UI; this is the server-
  side defence. Returns 400 to the form caller and translates to
  a tool-level `FormPayloadInvalidError`. Audit
  `csrf_or_payload_rejection`.
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

| Step                         | Endpoint                                                             | Doc                                                                                     |
| ---------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Render "Shared with me" list | `GET /me/drive/sharedWithMe?$select=id,name,remoteItem`              | <https://learn.microsoft.com/en-us/graph/api/drive-sharedwithme?view=graph-rest-1.0>    |
| Resolve URL paste            | `GET /shares/{encoded-id}/driveItem`                                 | <https://learn.microsoft.com/en-us/graph/api/shares-get?view=graph-rest-1.0>            |
| Read sentinel                | `GET /me/drive/items/{remoteItem.id}:/.collab/project.json:/content` | <https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0> |
| Look up authoritative file   | `GET /me/drive/items/{authoritativeFileId}`                          | <https://learn.microsoft.com/en-us/graph/api/driveitem-get?view=graph-rest-1.0>         |

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

#### `session_recover_doc_id`

Recovery tool for the case where both the live frontmatter and the
local project metadata `doc_id` are gone (fresh machine + a human
wiped the YAML block in OneDrive web). Without this the next
`collab_write` to the authoritative file refuses with
`DocIdRecoveryRequiredError` (§3.1). That error is _recoverable_ —
this tool is the canonical recovery. The project is only
"effectively dead" if `session_recover_doc_id` itself fails with
`DocIdUnrecoverableError` (50 versions inspected, none parseable),
at which point no automated recovery is possible.

```ts
session_recover_doc_id(args: {}): Promise<ToolResult>
```

Procedure:

1. Require an active session (sentinel + pin already validated).
2. `GET /me/drive/items/{authoritativeFileId}/versions` — list every
   historical version, newest-first.
3. Walk the list **sequentially, newest-first, stop on first
   success** (do not parallelise — that would spend bandwidth on
   versions the typical case never reads). For each version,
   `GET .../versions/{vid}/content`, parse the YAML frontmatter
   with the read-path codec. Each GET is subject to the standard
   throttle/retry machinery (§4.5); retries apply per GET.
   Typical case: 1-2 GETs (the most recent version usually still
   has frontmatter). Worst case: 50 GETs.
4. The first version whose frontmatter parses cleanly and contains
   a `doc_id` wins. Extract `doc_id` and **stop immediately** — do
   not continue walking older versions for cross-checking.
5. Write `docId` back into `<configDir>/projects/<projectId>.json`
   (atomic save). **No body change. No `restoreVersion` call.** No
   destructive-budget cost. No write-budget cost (treated as a
   metadata operation analogous to `session_status`).
6. Audit `doc_id_recovered` with `{ recoveredFrom: "<versionId>",
recoveredAt, versionsInspected }`.
7. Return text confirming the recovered `doc_id` and the version it
   came from. Subsequent `collab_write` to the authoritative file
   re-injects this `doc_id` into the next emitted YAML block (§3.1
   recovery rules).

If **no** historical version contains parseable frontmatter with a
`doc_id` (the file pre-dated collab adoption, or every version has
been wiped), return `DocIdUnrecoverableError` carrying the count of
versions inspected. The human's only remaining option is to start
fresh: open `session_init_project` against a copy of the folder
under a new name, accept that the new project has a new id, and the
old audit log is archived rather than continued. Document this
clearly in the error message.

Graph endpoints:

| Step                  | Endpoint                                                           | Doc                                                                                             |
| --------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| List versions         | `GET /me/drive/items/{authoritativeFileId}/versions`               | <https://learn.microsoft.com/en-us/graph/api/driveitem-list-versions?view=graph-rest-1.0>       |
| Read a single version | `GET /me/drive/items/{authoritativeFileId}/versions/{vid}/content` | <https://learn.microsoft.com/en-us/graph/api/driveitemversion-get-contents?view=graph-rest-1.0> |

Reads are bounded: cap the walk at the most recent 50 versions
(OneDrive's default version retention is 25; 50 is a safety margin).
If none of the most recent 50 yield a `doc_id`, fail with
`DocIdUnrecoverableError`. Do not page deeper — at that point the
"recover and continue" story is implausible anyway.

Error cases:

- `NoActiveSessionError`, `SessionExpiredError`.
- `DocIdAlreadyKnownError` — local cache already has a `docId` and
  the live frontmatter parses; nothing to recover. Returns the
  current `docId` as informational, not as `isError: true`.
- `DocIdUnrecoverableError` — walked the version cap, no parseable
  frontmatter found.
- `GraphRequestError`, `AuthenticationRequiredError`.

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

| Step                 | Endpoint                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Authoritative file   | `GET /me/drive/items/{authoritativeFileId}` then `GET /me/drive/items/{authoritativeFileId}/content`                        |
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

Faithful directory listing for entries within scope. Returns one
group per canonical location (root, `/proposals`, `/drafts`,
`/attachments`). The authoritative file is **explicitly marked**
(`isAuthoritative: true`) so the agent can find it without guessing.
The sentinel folder `.collab/` is excluded.

The tool does **not** synthesise an "UNSUPPORTED" bucket. The root
may legitimately contain non-authoritative files (a stray
`README.md`, scratch notes, README from a GitHub-style template);
they are listed as ordinary entries. `/attachments/` is a junk drawer
by design (constraint) and may contain anything **at any depth**;
listed as a tree (§4.6 step 5 allows recursive paths under
attachments). Scope enforcement (§4.6) is what gates _write_ and
_read_ operations on individual paths; the listing tool is
intentionally honest about what's there.

Per-group depth follows §4.6 step 5: ROOT and PROPOSALS and DRAFTS
are listed flat (one level only — subfolders under proposals/drafts
would be refused by the scope resolver anyway and so are not shown).
ATTACHMENTS is listed recursively. The listing flags every entry's
relative path so the agent can pass it back to `collab_read` /
`collab_write` without reconstructing it.

Sample output shape (text):

```
ROOT (4 entries)
  README.md         5.2 KB  cTag=...   [authoritative]
  NOTES.md          1.1 KB  cTag=...
  todo.txt          0.3 KB  cTag=...
  drawing.png       45 KB   cTag=...

PROPOSALS (1 entry)
  01JCDEF...md      1.4 KB  cTag=...   target=intro

DRAFTS (0 entries)

ATTACHMENTS (3 entries)
  diagram.png                210 KB  cTag=...
  data.csv                   12 KB   cTag=...
  diagrams/architecture.png  340 KB  cTag=...
```

Graph endpoint: `GET /me/drive/items/{folderId}/children` for the
flat groups; recursive walk under attachments uses
`GET /me/drive/items/{attachmentsFolderId}/children` per directory
(no Graph delta or `:children?recursive=true`; OneDrive does not
expose a single-call recursive enumeration, so we fan out — bounded
by the §4.6 step 7 N=8 ancestry cap so a pathological tree cannot
blow up the response). Retries: inherited.

**Breadth cap.** Total entries returned across all groups is capped
at **500 per call**. The cap protects MCP response size (Claude
Desktop and VS Code Copilot both throttle large tool responses)
and protects the agent's context window. On overflow:

- The listing stops adding entries to the affected group(s),
  preserving newest-first within attachments and source-order
  elsewhere.
- The result includes `truncated: true` and a per-group breakdown
  of how many entries were omitted (e.g. `{"attachments":
{"omitted": 9612}}`).
- The agent should narrow with the `prefix` arg (already in the
  signature) or surface the truncation to the human, who can
  clean up the folder.

The cap is intentionally a flat 500, not configurable, to keep the
contract predictable; if real-world workloads need more, raise the
cap in v2 with explicit delta-polling support (§4.5 v2 trigger).

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
  frontmatter; if absent, the prior `doc_id` is recovered from
  `<configDir>/projects/<projectId>.json` and re-injected (see §3.1
  doc_id stability rules). This is the visible behaviour change
  called out in section 6.
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
- **`source` is recorded but not enforced.** v1 does not run a
  shingle-overlap heuristic against earlier `collab_read` content.
  Earlier draft included one; cut after review concluded it was
  noisy in both directions (false-positive on legitimate from-scratch
  rewrites; false-negative against any agent willing to quote one
  shingle of real content) and that post-hoc audit-log review is the
  correct surface for spotting `source: "project"` writes that don't
  match read patterns.

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

Lease on a section, recorded in the **leases sidecar**
`.collab/leases.json` (§3.2.1), not the authoritative-file
frontmatter. Acquire = read leases, ensure no active lease for this
`sectionId`, write back updated leases using `If-Match` on the
leases-file `cTag`. Section identity is **slug-only** here: the
caller passes a heading text or pre-computed slug, the tool
normalises through the GitHub-flavored algorithm (§3.1) and looks
for an exact match against the current headings of the authoritative
body. Acquire deliberately does **not** support the slug-drift
hash fallback used by `collab_apply_proposal` — leases are
short-lived (default 600 s, max 3600 s) and a heading rename mid-
lease is a rare-enough event that a hard refusal is the correct
UX (the agent re-reads, sees the new slug, re-acquires). The
authoritative file body and frontmatter are not touched.

```ts
collab_acquire_section(args: {
  sectionId: string;            // raw heading text or pre-computed slug
  ttlSeconds?: number;          // default 600, max 3600
  leasesCTag: string;           // returned by latest collab_read or session_status
}): Promise<ToolResult>
```

Graph: `GET /me/drive/items/{leasesFileId}/content` then `PUT
.../content` with `If-Match: <leasesCTag>` and
`@microsoft.graph.conflictBehavior=replace`. Headers and retry
policy as for `collab_write`. Not counted toward write budget
(constraint: leases are free). The leases file is small by design
(< 4 KB typical, hard cap 64 KB) so the throughput problem
discussed in Appendix B risk 2 disappears: a lease cycle ships
~16 KB total instead of 8 MiB.

Error cases:

- `NoActiveSessionError`, `SessionExpiredError`.
- `SectionNotFoundError` — `sectionId` does not match any heading
  slug in the current authoritative body. Carries the list of
  current heading slugs as a hint.
- `SectionAlreadyLeasedError` — carries the holder `agentId` and lease
  expiry.
- `LeasesFileMissingError` — `.collab/leases.json` not present;
  `collab_acquire_section` lazily creates it on first acquire (PUT
  byPath with `conflictBehavior=fail`). On race, retry once.
- `CollabCTagMismatchError` — leases changed under us; agent
  re-reads `.collab/leases.json` (or calls `session_status` which
  surfaces the current `leasesCTag`) and retries. Not diverted to
  proposal (leases never proposal-divert).
- `GraphRequestError`, `AuthenticationRequiredError`.

#### `collab_release_section`

Inverse. Same shape minus `ttlSeconds`. Releasing a stale lease (one
held by a different agent) is rejected with `LeaseNotHeldError`. No-op
if the lease is already absent. Free.

```ts
collab_release_section(args: {
  sectionId: string;
  leasesCTag: string;
}): Promise<ToolResult>
```

Error cases: as above plus `LeaseNotHeldError`.

**Graceful degradation when leases sidecar is gone.** If
`.collab/leases.json` returns 404 outside the lazy-create path, the
collab tools treat the project as having "no active leases" rather
than failing. A subsequent acquire will recreate the file. The
worst case is two agents acquiring the same section in the seconds
between the file being deleted and recreated — the
`SectionAlreadyLeasedError` race covers that. Leases are
coordination, not authentication; brief lease-amnesia is
acceptable. Sentinel and authoritative-file deletion remain hard
errors.

#### `collab_create_proposal`

Write a proposal body to `/proposals/<ulid>.md` and record proposal
metadata in the authoritative frontmatter. Two CAS writes total; the
proposal body write does not need a cTag (new file), the frontmatter
write does. The frontmatter entry records both the slug and a snapshot
hash of the target section's current content so that
`collab_apply_proposal` can recover the target across heading
renames (§2.3 anchor rules).

```ts
collab_create_proposal(args: {
  targetSectionId: string;       // section the proposal would replace; raw or pre-slugged
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

The frontmatter `proposals[]` entry persists `target_section_slug`
**and** `target_section_content_hash_at_create` (§3.1). On apply, the
slug-first / hash-fallback lookup uses the latter to survive heading
renames between proposal creation and apply.

Error cases: as `collab_write` plus `ProposalIdCollisionError`
(extremely unlikely but checked) and `SectionAnchorLostError` if the
target slug doesn't resolve at create time.

#### `collab_apply_proposal`

Merge a proposal into the authoritative file. Detects the destructive
case via authorship anchored on heading slug + content hash (see
§3.1 authorship schema) and triggers a re-approval form showing the
diff. Counts toward both write budget and (when destructive)
destructive-approval budget.

```ts
collab_apply_proposal(args: {
  proposalId: string;
  authoritativeCTag: string;
  intent?: string;
}): Promise<ToolResult>
```

Process:

1. Read proposal body and authoritative file.
2. Locate the target section in the current authoritative body.
   Lookup is **slug-first, content-hash fallback**:
   a. Compute the GitHub-flavored slug for every heading in the
   current body (§3.1 slug algorithm).
   b. Try the proposal's `targetSectionId` slug. If exactly one
   heading matches, that's the target.
   c. If zero matches (heading was renamed) **or** more than one
   matches (collision or duplicate heading inserted), fall back
   to the proposal's recorded `section_content_hash_at_create`.
   Hash every section in the current body and look for a match.
   d. Hash match wins; record an audit entry
   `slug_drift_resolved` with the old and new slugs.
   e. Neither slug nor hash matches → return
   `SectionAnchorLostError` (not the same as
   `SectionNotFoundError`; carries old slug, current heading
   slugs as a hint, and the proposal id so the agent can
   consider creating a new proposal).
3. Compute the current section's content hash (SHA-256 of the body
   between this heading and the next equal-or-higher level
   heading; for an unheaded prose section at the top of the file,
   the synthetic slug is `__preamble__` and the hash covers
   bytes 0 through the first heading).
4. Walk the authorship trail (§3.1) for entries that match either
   (a) the same `target_section_slug` **and** a `section_content_hash`
   that equals the current hash, or (b) the same slug with any hash
   when no exact-hash match exists, or (c) any slug with the same
   `section_content_hash` (catches a section that was renamed
   _and_ has authorship). The destructive check fires if any
   matching entry has `author_kind: "human"` or an
   `author_agent_id` other than the current agent.
5. If destructive: open destructive re-approval form. Form shows a
   unified diff (use the existing `diff` package, already a
   dependency at `package.json:52`) and the ULIDs.
6. PUT new authoritative content with `If-Match: <authoritativeCTag>`.
7. Append a fresh `authorship[]` entry for the new range with the
   newly computed `section_content_hash` and the new slug. Update
   `proposals[].status = "applied"` in frontmatter (same write).
8. Optionally delete the proposal file (skipped in v1; kept for
   audit). Marked `applied` in frontmatter.

Why slug + content hash, not line numbers: line numbers shift the
moment a human edits the OneDrive web UI to add a paragraph above the
section. Slug is stable across body insertions; the content hash
discriminates between "still the section the human wrote" and "we
already rewrote it" _and_ survives slug drift from heading renames or
duplicate-heading collisions. When the slug match exists but the hash
doesn't, the destructive check falls back to "treat as
already-touched" — the worst case is a spurious re-prompt, never a
silent destructive write. When the slug is gone but the hash matches,
we accept the rename, audit it, and proceed.

Error cases:

- `NoActiveSessionError`, `SessionExpiredError`,
  `BudgetExhaustedError`, `DestructiveBudgetExhaustedError`.
- `ProposalNotFoundError`, `ProposalAlreadyAppliedError`.
- `OutOfScopeError`, `CTagMismatchError`.
- `SectionAnchorLostError` — neither the proposal's slug nor its
  recorded content hash matches any current section. Distinct from
  `SectionNotFoundError` so the agent can react with a more
  helpful message: re-read the file, look at the diff, and either
  create a fresh proposal or ask the human.
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

| Tool                     | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
| ------------------------ | :------------: | :---------------: | :--------------: | :-------------: |
| `session_init_project`   |     false      |       false       |      false       |      true       |
| `session_open_project`   |     false      |       false       |      false       |      true       |
| `session_renew`          |     false      |       false       |       true       |      true       |
| `session_status`         |      true      |       false       |       true       |      false      |
| `session_recover_doc_id` |     false      |       false       |       true       |      false      |
| `collab_read`            |      true      |       false       |       true       |      false      |
| `collab_list_files`      |      true      |       false       |       true       |      false      |
| `collab_write`           |     false      |       false       |      false       |      false      |
| `collab_acquire_section` |     false      |       false       |      false       |      false      |
| `collab_release_section` |     false      |       false       |       true       |      false      |
| `collab_create_proposal` |     false      |       false       |      false       |      false      |
| `collab_apply_proposal`  |     false      |       true        |      false       |      false      |
| `collab_list_versions`   |      true      |       false       |       true       |      false      |
| `collab_restore_version` |     false      |       true        |      false       |      false      |
| `collab_delete_file`     |     false      |       true        |      false       |      false      |

`openWorldHint: true` on the four flow-opening tools because they
communicate with an external system (the user's browser) outside the
MCP transport.

### 2.5 Bounded set of typed error classes

The codebase prefers plain text for most errors (see
`src/tools/shared.ts:18-30` and the `MarkdownCTagMismatchError`
precedent at `src/graph/markdown.ts:667-679`). v1 introduces only the
errors that carry actionable structured data the agent or operator
needs. Everything else is a plain `Error` rendered by `formatError`.

| Class                          | Carries                                                                       | Used by                              |
| ------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------ |
| `NoActiveSessionError`         | nothing                                                                       | every collab tool                    |
| `SessionExpiredError`          | `expiresAt`, `renewalsRemaining`                                              | every collab tool                    |
| `BudgetExhaustedError`         | `budgetType: "write" \| "destructive"`, `used`, `total`                       | write tools                          |
| `OutOfScopeError`              | `attemptedPath`, `reason` enum (see §4.6)                                     | path-taking tools                    |
| `CollabCTagMismatchError`      | `currentCTag`, `currentRevision`, `currentItem`                               | write/lease tools                    |
| `SectionAlreadyLeasedError`    | `holderAgentId`, `expiresAt`                                                  | `collab_acquire_section`             |
| `SectionAnchorLostError`       | `proposalId`, `oldSlug`, `currentSlugs[]`                                     | `collab_apply_proposal`              |
| `SentinelTamperedError`        | `pinnedAuthoritativeFileId`, `currentSentinelAuthoritativeFileId`, `pinnedAt` | `session_open_project`               |
| `DocIdRecoveryRequiredError`   | `nextStep: "session_recover_doc_id"`                                          | `collab_write` against authoritative |
| `DocIdUnrecoverableError`      | `versionsInspected`, `nextStep: "init_fresh_project"`                         | `session_recover_doc_id`             |
| `BrowserApprovalDeclinedError` | `flowType`, `csrfTokenMatched: boolean`                                       | every approval form                  |

Everything else is a plain `Error` with a clear message — the test
suite asserts on message substrings, not on `instanceof`. The
following errors are mentioned across §2.2-§2.3 and are
**deliberately plain `Error`s, not in the table above**, because
they carry no actionable structured data the agent or operator
needs beyond the message itself:

- `RefuseDeleteAuthoritativeError`, `RefuseDeleteSentinelError`
  (§2.3 `collab_delete_file`)
- `PathLayoutViolationError` (§2.3, §4.6)
- `BrowserFormTimeoutError`, `BrowserFormCancelledError`,
  `FormBusyError`, `FormPayloadInvalidError` (§5.3)
- `FrontmatterRoundtripError`, `MultiDocFrontmatterRejectedError`
  (§3.1)
- `RenewalCapPerSessionError`, `RenewalCapPerWindowError` (§2.2)
- `SectionNotFoundError`, `LeaseNotHeldError`,
  `LeasesFileMissingError`, `LeasesFileTooLargeError` (§2.3, §3.2.1)
- `ProposalNotFoundError`, `ProposalAlreadyAppliedError`,
  `ProposalIdCollisionError` (§2.3)
- `MarkdownUnknownVersionError` (reused from existing
  `src/graph/markdown.ts:892`)
- `SchemaWriteError`, `SchemaVersionUnsupportedError` (§3.x)
- `SentinelMissingError`, `SentinelMalformedError`,
  `SentinelAlreadyExistsError`, `BlockedScopeError`,
  `NoWriteAccessError`, `NotAFolderError`,
  `AuthoritativeFileMissingError`, `NoMarkdownFileError`,
  `StaleRecentError`, `SessionAlreadyActiveError` (§2.2)
- `InvalidShareUrlError`, `ShareNotFoundError`,
  `ShareAccessDeniedError` (§4.4)
- `DocIdAlreadyKnownError` (§2.2 `session_recover_doc_id`,
  informational; not `isError: true`)
- `ExternalSourceDeclinedError`,
  `DestructiveApprovalDeclinedError` (§5.2)
- `FileNotFoundError` (§2.3 `collab_read`)

If implementation uncovers a need for structured data on any of
these (e.g. a UI wants to render a holder's display name), promote
the error to the typed-class table above and update §3.6 audit
columns accordingly. The default is plain `Error`.

## 3. Schemas

All schemas carry `version: 1` (constraint). Schemas use TypeScript
interface notation here for readability; runtime validation is via Zod.

### 3.1 Authoritative-file YAML frontmatter

```yaml
---
collab:
  version: 1
  doc_id: 01JABCDE0FGHJKMNPQRSTV0WXY # ULID, assigned on first write; stable for life of file
  created_at: "2026-04-19T05:30:00Z"
  sections:
    - id: "intro" # heading slug (GitHub algorithm; see slug rules below)
      title: "Introduction"
      # Leases for this section live in .collab/leases.json (§3.2.1).
  proposals:
    - id: 01JCDEF...
      target_section_slug: "intro"
      target_section_content_hash_at_create: "sha256:def56789..." # snapshot at create time; survives slug renames
      author_agent_id: "a3f2c891-..." # claimed; see "integrity" note below
      author_display_name: "Alice" # display only
      created_at: "2026-04-19T05:51:00Z"
      status: "open" # open | applied | superseded | withdrawn
      body_path: "proposals/01JCDEF....md"
      rationale: "tighten the wording"
      source: "chat"
  authorship: # append-only trail per section
    - target_section_slug: "intro" # heading slug at write time
      section_content_hash: "sha256:abcd1234..." # SHA-256 of section body at time of write
      author_kind: "agent" # agent | human
      author_agent_id: "..." # claimed; see "integrity" note below
      author_display_name: "..."
      written_at: "2026-04-19T05:50:00Z"
      revision: 17 # OneDrive revision after the write
---
# Project Title
...
```

**Heading slug algorithm.** GitHub-flavored, matches what every
markdown viewer (OneDrive, VS Code preview, GitHub) renders as the
clickable anchor. Inline pseudo-code:

1. Lowercase the heading text after stripping the leading `#`s and
   trim whitespace.
2. Drop everything that is not `[a-z0-9-_ ]` (Unicode letters/digits
   collapsed via NFKC then ASCII-folded with `String.prototype
.normalize("NFKD")` then a `[^\w\- ]` strip; matches GitHub
   exactly for ASCII headings, deviates only on rare CJK that
   GitHub itself handles inconsistently).
3. Replace runs of whitespace with a single `-`.
4. Empty result → synthetic slug `__heading__`.
5. **Collisions.** Walk the document in source order. If a slug
   already exists, append `-1`, `-2`, … until unique. Same as
   GitHub's anchor generator.
6. **Preamble.** Prose before the first heading uses the synthetic
   slug `__preamble__`. Tools that operate on it must opt in — the
   default `target_section_slug` validation rejects the
   double-underscore prefix unless the caller passes
   `allowSyntheticSlugs: true`.

Drift handling: when a human renames `## Introduction` to
`## Overview`, the slug changes from `introduction` to `overview`.
Authorship entries written before the rename keep their old slug;
the apply-time lookup tries the slug, then falls back to
`section_content_hash` to find the renamed section, and audits the
drift (§2.3 `collab_apply_proposal` step 2). When duplicate-heading
collisions cause silent slug renumbering (a new `## Introduction`
inserted above an existing one shifts the old from `introduction`
to `introduction-1`), the same fallback applies.

Notes:

- Block delimiter is the standard `---` / `---` pair so non-collab
  readers (VS Code preview, OneDrive web) treat it as YAML frontmatter
  and hide it from the rendered view.
- **`doc_id` is stable for the life of the authoritative file.**
  Assigned on the first write that finds no frontmatter. On subsequent
  reads:
  - If the YAML block is present and parseable, use the embedded
    `doc_id`.
  - If absent or malformed, recover the prior `doc_id` from
    `<configDir>/projects/<projectId>.json`. Re-inject it on the next
    write. Audit a `frontmatter_reset` entry.
  - **If both the embedded value and the local cache are gone**
    (fresh machine + wiped frontmatter), `collab_write` to the
    authoritative file refuses with `DocIdRecoveryRequiredError`.
    The error message names the canonical recovery path:
    **call `session_recover_doc_id`**, which walks
    `GET /versions` to find the most recent version with
    parseable frontmatter and writes its `doc_id` back to local
    metadata without touching the file (§2.2). If the version
    walk also turns up nothing
    (`DocIdUnrecoverableError`), the project is effectively dead
    and the human must `session_init_project` against a copy
    under a new name; the old audit log is archived. This trade
    is deliberate: a new `doc_id` would silently break the
    `(projectId, doc_id)` audit-log key invariant and orphan any
    references in the sentinel or local metadata. `doc_id` is an
    identifier that outlives individual writes; it is not a caching
    artefact.
- `authorship` is anchored on `target_section_slug` (GitHub-flavored
  heading slug at write time) + `section_content_hash` (SHA-256 of
  the section body at the time of the write). Slug survives most
  body insertions; the content hash survives heading renames and
  duplicate-heading collisions. Earlier draft used line numbers;
  rejected because any human edit in OneDrive web that adds a
  paragraph above the target shifts every subsequent line range
  and breaks destructive-detection. Append-only; trimming is out
  of scope for v1 (see open question 8 about long-term growth).
- Missing or malformed frontmatter returns defaults and writes
  `frontmatter_reset` to the audit log (constraint). The next write
  re-emits a freshly serialised block with the recovered `doc_id`.
- **Frontmatter byte-stability: the first write after any human
  frontmatter edit will produce a non-semantic reformat.** The `yaml`
  library normalises whitespace, quoting style, and key ordering in
  ways that are stable across `yaml` versions but not guaranteed to
  match what a human typed in OneDrive web. Trying to preserve exact
  bytes via CST mode or a custom splice is a rabbit hole, and the
  `frontmatter_reset` codepath already lands in reformat territory
  on every recovery. v1 **accepts** the reformat as expected behaviour
  and documents it for users:

  > Editing the YAML frontmatter directly in OneDrive web is fine.
  > The next write from graphdo will re-serialise it in canonical
  > form. Logical content is preserved; whitespace and quoting may
  > change. This shows up as a noisy diff in the OneDrive version
  > history once per human edit, then settles.

  The frontmatter writer must be **deterministic** — same input
  graph, same byte output, every time, on every machine — so that
  successive collab writes do not produce gratuitous diffs. The
  determinism contract:
  - Stable key order (the order declared in the Zod schema).
  - Always-quoted strings containing `:` or starting with a YAML
    sentinel character.
  - Two-space indent, no trailing spaces.
  - LF line endings (never CRLF).
  - One round-trip test in `test/collab/frontmatter.test.ts` asserts
    `serialise(parse(serialise(input))) === serialise(input)`.

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
pinning that is **rename-tolerant**:

1. On the **first** `session_open_project` for a given `projectId`,
   the local project metadata file
   `<configDir>/projects/<projectId>.json` (§3.3) records
   `pinnedAuthoritativeFileId`, `pinnedSentinelFirstSeenAt`, and
   `pinnedAtFirstSeenCTag`. The current `authoritativeFileName` is
   recorded separately as `displayAuthoritativeFileName` and is
   refreshed silently on every open.
2. On every **subsequent** `session_open_project`, the live sentinel's
   `authoritativeFileId` is compared against `pinnedAuthoritativeFileId`.
   Any divergence raises `SentinelTamperedError` carrying both the
   pinned and current ids. The session does **not** activate.
3. The pin **does not check the file name**. The originator may rename
   the authoritative file in OneDrive web (`spec.md` → `README.md`)
   and every collaborator's session continues to work. OneDrive
   preserves `driveItem.id` across renames; the canonical identifier
   is the id, not the name. The local
   `displayAuthoritativeFileName` is updated from the live sentinel
   on each successful open and is for display only.
4. The user must explicitly forget the project from recents (which
   clears the pinning) before re-opening with a _different file id_.
   This is a deliberate friction step that catches a real tamper but
   not a benign rename.
5. An `audit.type = "sentinel_changed"` entry is written before the
   refusal, including pinned vs current ids, so post-hoc analysis
   can spot tamper attempts even if the user later forgets the
   project.

Atomic write: same temp+rename strategy as `saveConfig`
(`src/config.ts:104-135`) cannot be used directly in OneDrive (no
rename-into-place primitive on Graph drive items). For the sentinel we
rely on `conflictBehavior=fail` to stop concurrent first writes
(constraint says it is the source of truth; corruption is a hard
error).

### 3.2.1 Leases sidecar `.collab/leases.json`

Separated from the sentinel in v1 to fix the throughput problem
identified in Appendix B risk 2: putting `sections[].lease` in the
authoritative-file frontmatter would force every lease cycle to ship
the full file body (~8 MiB worst case for a 4 MiB file). Leases are
coordination, not load-bearing for correctness, so a separate small
file is the right shape.

**Field-name convention across schemas.** The leases sidecar uses
`sectionSlug` (no `target_` prefix); the authoritative-file
frontmatter uses `target_section_slug` for `proposals[]` and
`authorship[]` entries. Different prefixes are deliberate: in the
leases sidecar each entry _is_ the section being held, so the
"target" qualifier adds no information; in the frontmatter
`proposals[]`/`authorship[]` arrays, each entry describes an
operation _targeting_ a section, so the "target" prefix
disambiguates from any future field describing the section
metadata itself. Both forms slugify through the same `slug.ts`
algorithm.

```json
{
  "schemaVersion": 1,
  "leases": [
    {
      "sectionSlug": "intro",
      "agentId": "a3f2c891-claude-desktop-01jabcde",
      "agentDisplayName": "Claude Desktop",
      "acquiredAt": "2026-04-19T05:50:00Z",
      "expiresAt": "2026-04-19T06:00:00Z"
    }
  ]
}
```

Properties:

- **Lazy-created.** First `collab_acquire_section` PUTs the file
  byPath with `conflictBehavior=fail`. Subsequent acquires/releases
  CAS via `If-Match` on the leases-file `cTag`. `session_status`
  surfaces the current `leasesCTag` so agents don't need a
  separate read.
- **Hard cap 64 KB.** Lease entries are tiny; 64 KB allows ~600
  active leases, which is two orders of magnitude beyond any
  realistic workload. Writes that would exceed the cap return
  `LeasesFileTooLargeError`.
- **Schema sealed.** Zod-validated on read; unknown top-level
  keys rejected. Schema bumps via `schemaVersion`.
- **Untrusted, like the sentinel.** A cooperator with folder write
  access can edit this file directly. Agents using leases are
  cooperating in good faith; the audit log is what records who
  _actually_ called `collab_acquire_section`. Lease integrity is
  not a security boundary.
- **No pinning.** Unlike the sentinel, the leases sidecar is not
  pinned in local metadata. It can be deleted and recreated
  freely; collab tools degrade to "no active leases" on 404. See
  the graceful-degradation note in §2.3 `collab_release_section`.
- **Expired-lease cleanup.** On every read, entries with
  `expiresAt < now` are dropped from the in-memory view. The next
  acquire/release CAS persists the cleanup. No background
  housekeeper.
- **Atomic write.** Same `If-Match` + `conflictBehavior=replace`
  pattern as `collab_write`. Concurrent acquires for different
  sections naturally race on `cTag` — the loser retries.

Sentinel and leases sidecar are independent. A reset of one does
not affect the other. The sentinel pin (§3.2) protects against
folder-id swap attacks; the leases sidecar carries no such
identity claim and needs no pin.

### 3.3 Local project metadata `<configDir>/projects/<projectId>.json`

```json
{
  "schemaVersion": 1,
  "projectId": "01JABCDE...",
  "folderId": "01FOLDER...",
  "folderPath": "/Documents/Project Foo",
  "driveId": "b!abc...",
  "pinnedAuthoritativeFileId": "01ABCDEF...",
  "pinnedSentinelFirstSeenAt": "2026-04-19T05:00:00Z",
  "pinnedAtFirstSeenCTag": "\"{...,1}\"",
  "displayAuthoritativeFileName": "README.md",
  "docId": "01JABCDE0FGHJKMNPQRSTV0WXY",
  "addedAt": "2026-04-19T05:00:00Z",
  "lastSeenSentinelAt": "2026-04-19T05:00:00Z",
  "lastSeenAuthoritativeCTag": "\"{...,17}\"",
  "lastSeenAuthoritativeRevision": "17",
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
check. `displayAuthoritativeFileName` is refreshed silently on every
open so a rename of the authoritative file in OneDrive web does not
brick collaborators (§3.2 rule 3). `docId` mirrors the
authoritative-file frontmatter `doc_id` for recovery when the
frontmatter is wiped (§3.1 rules). `lastSeen*` fields are pure
optimisation (constraint: losing them never breaks correctness). On
session resume, divergence between `lastSeenAuthoritativeCTag` and
the live cTag is logged as `audit.type = "external_change_detected"`
— a free out-of-band forensic signal, no behaviour change. `driveId`
is captured to make the §4.6 ancestry check cheap (we can refuse
anything from a different drive without an extra Graph call).

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

**Silent folder-path refresh.** On every successful
`session_open_project`, the open path re-resolves the folder via
`GET /drives/{driveId}/items/{folderId}?$select=parentReference,name`
and updates `folderPath` in the recents entry (and `folderPath` in
`<configDir>/projects/<projectId>.json`). No audit entry, no warning;
this catches the originator moving the folder to a different parent
in OneDrive web. The pin block (§3.3) is unchanged because
`pinnedAuthoritativeFileId` is unchanged. Folder _deletion_ still
trips `BlockedScopeError` via the existing scope-discovery checks.

### 3.5 Renewal counts `<configDir>/sessions/renewal-counts.json`

Keyed by `<userOid>/<projectId>` (full Entra `oid`, see §3.6 redaction
notes for why prefix is not used here). Each entry is a sliding window
of timestamps; entries older than 24h are pruned on read.

```json
{
  "schemaVersion": 1,
  "windows": {
    "00000000-0000-0000-0000-0000a3f2c891/01JABCDE...": {
      "renewals": ["2026-04-18T07:00:00Z", "2026-04-19T03:30:00Z"]
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

| `type`                     | Notable fields                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_start`            | `ttlSeconds`, `writeBudget`, `destructiveBudget`, `clientName`, `clientVersion`                                                                       |
| `session_end`              | `reason: "ttl" \| "budget" \| "mcp_shutdown" \| "manual_stop"`, `writesUsed`, `renewalsUsed`                                                          |
| `tool_call`                | `inputSummary` (allow-listed; see below), `cTagBefore`, `cTagAfter`, `revisionAfter`, `bytes` (writes only), `source` (writes only), `resolvedItemId` |
| `scope_denied`             | `reason` (see §4.6 enum), `attemptedPath`, `resolvedItemId?`                                                                                          |
| `destructive_approval`     | `tool`, `outcome: "approved" \| "declined" \| "timeout"`, `diffSummaryHash`, `csrfTokenMatched`                                                       |
| `renewal`                  | `windowCountBefore`, `windowCountAfter`, `sessionRenewalsBefore`, `sessionRenewalsAfter`                                                              |
| `external_source_approval` | `tool`, `path`, `outcome`, `csrfTokenMatched`                                                                                                         |
| `frontmatter_reset`        | `reason: "missing" \| "malformed"`, `previousRevision`, `recoveredDocId: boolean`                                                                     |
| `slug_drift_resolved`      | `proposalId`, `oldSlug`, `newSlug`, `matchedBy: "content_hash"`                                                                                       |
| `doc_id_recovered`         | `recoveredFrom: "<versionId>"`, `versionsInspected`                                                                                                   |
| `agent_name_unknown`       | `clientInfoPresent: boolean`, `agentIdAssigned` (warn-once-per-session)                                                                               |
| `sentinel_changed`         | `pinnedAuthoritativeFileId`, `currentAuthoritativeFileId`, `pinnedAtFirstSeenCTag`, `currentSentinelCTag`                                             |
| `external_change_detected` | `pinnedCTag`, `liveCTag`, `liveRevision`                                                                                                              |
| `error`                    | `errorName`, `errorMessage`, `graphCode?`, `graphStatus?`                                                                                             |

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
other on POSIX (POSIX guarantees atomic writes ≤ `PIPE_BUF`,
~4096 bytes, for `O_APPEND`). On crash a partial trailing line may
exist; the parser tolerates it. All writes are best-effort: an
audit failure does not fail the tool call (logged at `warn`).

**Windows caveat.** Windows has no `O_APPEND`. Node's
`fs.appendFile` on Windows opens, seeks-to-end, writes, closes —
**not atomic against another process.** Two MCP instances appending
to the same audit file on Windows can interleave bytes mid-line.
For v1 this is accepted as a fringe scenario (the typical user runs
one MCP host at a time per project), and the parser's partial-line
tolerance covers the corruption case: any line that fails JSON
parse is logged and skipped, never crashes the reader. Promoted to
§10 open question 8 so it stays visible. v2 mitigation candidates:
file-lock via `proper-lockfile` (adds a runtime dep), or a sidecar
queue file written by a single appender process. Out of scope for
v1.

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

**Stale-session pruning.** Sessions are not always cleanly ended
(process kill, OS reboot, transport drop without process exit),
so the `sessions` object would otherwise accumulate orphan
entries. On every read and every write of
`destructive-counts.json`, entries with `expiresAt < now - 24h`
are dropped from the in-memory view and the next persisted write
omits them. The 24h grace window covers the maximum TTL (8h) plus
a safety margin so a session paused mid-flight is not pruned.
Same pattern as the leases sidecar's expired-lease cleanup
(§3.2.1) — no background housekeeper, no migration, just
lazy-cleanup-on-touch.

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
- **412 on leases-sidecar or authoritative-frontmatter write**:
  another agent's CAS landed first. Surface
  `CollabCTagMismatchError` with the current cTag; the agent
  re-reads (the leases sidecar via `session_status`, or the
  authoritative file via `collab_read`) and retries. Lease
  acquires never divert to proposal (constraint).
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

### 4.5 Throttle handling for `collab_*`

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

> **Cut: delta polling.** Earlier draft included a `GET /me/drives/
{driveId}/root/delta` flow for opportunistic out-of-band change
> detection. Cut from v1 because the `lastSeenAuthoritativeCTag`
> comparison on session resume (§3.3) gives the same signal at
> session granularity, which is sufficient for the v1 use cases.
> Delta polling will be revisited in v2 against a concrete
> `tools/list_changed`-style live-refresh requirement.

### 4.6 Scope resolution algorithm

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
   - **Depth rules per top-level group:**
     - "proposals" and "drafts": **flat only.** segments.length must
       be exactly 2; segments[1] must end in ".md" (NFC-equal
       lowercase). Subdirectories under proposals/drafts are refused
       with reason "subfolder_in_flat_group".
     - "attachments": **recursive.** segments.length ≥ 2, no
       extension constraint (it is a junk drawer by design,
       constraint). Subfolders allowed at arbitrary depth, subject
       to the existing path-length and NFKC checks above. The
       defence-in-depth ancestry walk in step 7 already bounds
       traversal to N=8 hops so deeply pathological trees still
       cannot escape scope.

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

| Component                          | What we reuse                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| Local HTTP server with random port | `src/picker.ts` factory pattern (random port, `127.0.0.1`, body cap, abort wiring). |
| HTML shell (head, fonts, favicon)  | `pageLayout` / `pageHead` in `src/templates/layout.ts`.                             |
| Design tokens and CSS              | `src/templates/tokens.ts`, `src/templates/styles.ts`.                               |
| `openBrowser` injection            | `ServerConfig.openBrowser` (`src/index.ts:50`).                                     |
| Tab auto-close after submit        | `pickerSuccessHtml` countdown (`src/templates/picker.ts`).                          |
| Cancel handling                    | `UserCancelledError` (`src/errors.ts:12-17`).                                       |

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

| Field              | Type              | Notes                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Folder             | radio + URL paste | radio is populated from `GET /me/drive/root/children`; paste box resolves via `/shares` endpoint.                                                                                                                                                                                                                          |
| Authoritative file | radio             | populated when folder picked. **Always shown when ≥1 root `.md` file exists.** When N=1, the single option is pre-selected so the human only has to confirm via Submit; when N≥2, no default is selected and Submit is disabled until the human makes a deliberate choice. Greyed only if the folder has zero `.md` files. |
| TTL                | slider            | 15 min – 8 h, default 2 h.                                                                                                                                                                                                                                                                                                 |
| Write budget       | slider            | 10 – 500, default 50.                                                                                                                                                                                                                                                                                                      |
| Destructive budget | number            | default 10, hard cap 50.                                                                                                                                                                                                                                                                                                   |
| Renewal policy     | dropdown          | "manual" only in v1; future "auto-renew" placeholder visible but disabled.                                                                                                                                                                                                                                                 |

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

| Field                       | Type   | Notes                                                                                                   |
| --------------------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| Recents                     | list   | populated from `recent.json`; entries with `available: false` are shown disabled with the reason.       |
| Shared with me              | list   | populated from `GET /me/drive/sharedWithMe`. Only items with write access and `folder` set are enabled. |
| Paste a OneDrive folder URL | text   | resolved via `/shares` endpoint.                                                                        |
| TTL                         | slider | as above.                                                                                               |
| Write budget                | slider | as above.                                                                                               |
| Destructive budget          | number | as above.                                                                                               |

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
- **The lock is released on every terminal outcome.** Specifically:
  submit, cancel, timeout, transport abort, parent-signal abort
  (SIGINT/SIGTERM into `main()`'s controller), and any uncaught
  exception inside the form-server's handler chain. A finalisation
  block (`try { ... } finally { releaseLock() }`) wraps the entire
  form-completion flow. Failure to release the lock would deadlock
  every subsequent collab tool; it must not be conditional on
  outcome.
- **Forms do not consume throttle or retry budget while waiting.**
  A pending form is _not_ a Graph call. The throttle/retry
  primitives in `GraphClient` count only HTTP transactions. The
  tool call itself blocks awaiting the form's promise; from the
  Graph layer's perspective nothing is happening. Test row in §8.2
  asserts that an N-second form wait does not increment any
  retry counter and does not delay subsequent Graph calls.

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
  frontmatter inserts the `collab:` block with the recovered or
  freshly-generated `doc_id` (per §3.1 doc_id stability rules). This
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
  - `yaml` (constraint says yes; not `gray-matter`). - **Version pinning policy: `~` not `^`.** The `yaml` library
    has shipped minor releases that changed default serialisation
    (quoting of keys matching reserved words, line-break handling
    near block boundaries). The deterministic-emitter contract
    in §3.1 ("byte-stable across `yaml` versions") is
    aspirational, not guaranteed. Pin the exact minor with `~`
    (e.g. `"~2.5.0"`), accept patch-level upgrades only, and
    require a deliberate version bump to take a new minor. - **Snapshot test for byte-exact output.** Add
    `test/collab/frontmatter-snapshot.test.ts` that asserts
    byte-exact serialisation for a canonical fixture covering
    every field in §3.1 (doc_id, sections with mixed slugs,
    proposals with rationale containing special chars,
    authorship with hashes, multi-line strings, dates). When the
    `yaml` package bumps, this snapshot fails before users
    encounter the drift in noisy diffs. Treat any snapshot
    failure as a release-blocker. - **Pre-merge verification.** Run `npm audit` and check the
    GitHub Advisory Database for `yaml` advisories before lockfile
    commit. The plan author has done a mental check: the modern
    `yaml` library (eemeli/yaml) does not execute YAML tags by
    default and has no known prototype-pollution-class issues
    comparable to old `js-yaml`'s `!!js/function`. Verify
    empirically. - **Parse hardening.** Always call `parse(input, { prettyErrors:
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

> **Cut: optional logical `GraphScope.Collab` toggle.** Earlier draft
> proposed a separate logical scope so users could enable
> `markdown_*` without `collab_*` in the login picker. Cut from v1
> because the plan was already hedging on whether to add it; users
> who want to disable collab can omit the bundle. Revisit if real
> demand surfaces.

### 7.2 Tool visibility

Proposal: **always-visible after login**, with helpful errors when no
session is active. The MCP review suggested this could fight the
existing scope-driven enable/disable; the answer is that scope-driven
enable/disable is **orthogonal** to session state. The two states
combine like this:

| Scope granted? | Session active?  | Tool state                              |
| -------------- | ---------------- | --------------------------------------- |
| no             | n/a              | disabled (hidden in `tools/list`)       |
| yes            | no               | enabled, returns `NoActiveSessionError` |
| yes            | yes, not expired | enabled, runs                           |
| yes            | yes, expired     | enabled, returns `SessionExpiredError`  |

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
  `listProjectChildren`.
- `test/collab/session.test.ts` — TTL math, renewal-window math,
  budget counters, destructive counter persistence across simulated
  restart, **session survives transport reconnect within same
  process**.
- `test/collab/scope.test.ts` — every step of the §4.6 algorithm:
  pre-normalisation refusals, double-decode refusal, NFKC vs NFC,
  layout enforcement, byId vs `/me/drive/root` (asserted via mock
  Graph URL inspection), shortcut/redirect refusal, cross-drive
  refusal, ancestry walk, case-aliasing refusal.
- `test/collab/audit.test.ts` — JSONL append, schema, ≤4096-byte line
  cap, partial-line tolerance, redaction allow-list, `intent`
  truncation at 200 chars, `diffSummaryHash` length 16, **assertion
  that no audit line contains `"Bearer "` substring** even when
  Graph errors are logged.
- `test/collab/frontmatter.test.ts` — round-trip determinism
  (`serialise(parse(serialise(input))) === serialise(input)`),
  default injection, **`doc_id` recovery from local cache when
  frontmatter is wiped**, **refusal with `DocIdRecoveryRequiredError`
  when both frontmatter and local cache are gone**, refusal of
  multi-doc YAML inputs.
- `test/collab/authorship.test.ts` — slug + content-hash
  destructive detection: matching slug + matching hash → not
  destructive; matching slug + different hash → conservative match
  (treated as already-touched); slug missing but hash matches →
  audited as `slug_drift_resolved` and proceeds; both missing →
  `SectionAnchorLostError`. Plus slug-algorithm tests:
  ASCII heading produces matching GitHub slug; duplicate headings
  produce `slug`, `slug-1`, `slug-2`; rename of `## Introduction`
  to `## Overview` shifts slug and hash anchors find it; preamble
  uses `__preamble__` synthetic slug.
- `test/collab/leases.test.ts` — leases sidecar codec: lazy-create
  on first acquire; CAS via `If-Match`; expired-lease cleanup on
  read; 404 graceful degradation ("no active leases"); 64 KB cap
  enforced; concurrent acquires race naturally on `cTag`.
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

| Test                                         | Scenario                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-init-write-read-list.test.ts`            | `session_init_project` → `collab_write` → `collab_read` → `collab_list_files`. Asserts sentinel created, frontmatter `doc_id` assigned, audit entries written. `collab_list_files` shows root files faithfully (no UNSUPPORTED bucket) and marks the authoritative file.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `02-two-agents-different-sections.test.ts`   | Two MCP clients against the same mock Graph. Each acquires a different section, writes, releases. No cTag conflicts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `03-cTag-mismatch-proposal-fallback.test.ts` | Agent A writes successfully; agent B writes with `conflictMode: "proposal"` and stale cTag. Asserts proposal file created in `/proposals/`, frontmatter updated, no body overwrite.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `04-frontmatter-stripped.test.ts`            | Direct mock-Graph write that wipes frontmatter (simulates the OneDrive web UI). Next `collab_read` returns defaults; `frontmatter_reset` audit entry written with `recoveredDocId: true`. Next `collab_write` re-injects with the **same `doc_id`** recovered from `<configDir>/projects/<projectId>.json`. Variant: also delete the local project metadata; next `collab_write` returns `DocIdRecoveryRequiredError` and instructs the human to restore from `/versions`.                                                                                                                                                                                                                                                             |
| `05-source-external-reapproval.test.ts`      | `collab_write` with `source: "external"` triggers the re-prompt path. Browser spy approves; write completes. Audit records `external_source_approval`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `06-source-external-declined.test.ts`        | Same as above but spy declines; tool returns `ExternalSourceDeclinedError`. No write.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `07-destructive-apply-proposal.test.ts`      | Apply a proposal whose `target_section_slug` matches a current heading and whose authorship trail attributes the matching section to a human. Destructive re-prompt fires; on approve, write succeeds and destructive counter increments. **Variant A:** same slug with hash mismatch (an agent has already rewritten it) → still treated as destructive (conservative). **Variant B:** slug renamed in body but `section_content_hash_at_create` matches an existing section → `slug_drift_resolved` audited and apply proceeds. **Variant C:** neither slug nor hash matches → `SectionAnchorLostError` carrying old slug + current heading slugs.                                                                                   |
| `08-scope-traversal-rejected.test.ts`        | One row per refusal reason in §4.6: `..`, `..%2f`, `%2e%2e/`, double-encoded `%252e%252e`, full-width `．．/`, leading `/`, drive-letter `C:/`, control char `\u0001`, dot-prefixed `.collab/foo`, layout `random/foo.md`, `proposals/foo.txt` (wrong extension), `proposals/sub/foo.md` (subfolder under flat group → `subfolder_in_flat_group`), `attachments/sub/sub2/foo.png` (allowed; recursive group), `proposals/foo.md` resolved to a `remoteItem` (shortcut/redirect), cross-drive item, case-aliased `Proposals/foo.md`. Each refusal returns `OutOfScopeError` with the matching reason; the attachments-recursive case succeeds. No Graph call should be issued for pre-resolution refusals (mock asserts zero requests). |
| `09-budget-exhaustion.test.ts`               | Default 50 writes succeed; 51st returns `BudgetExhaustedError`. Reads continue to work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `10-ttl-expiry.test.ts`                      | Use a fake clock helper; advance past TTL; next call returns `SessionExpiredError`. `session_renew` resets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `11-renewal-caps.test.ts`                    | Cap-3-per-session: fourth `session_renew` returns `RenewalCapPerSessionError`. Cap-6-per-window: simulate 6 renewals across 23h then a 7th in the same window returns `RenewalCapPerWindowError`; advance to >24h, allowed again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `12-throttle-surfaced.test.ts`               | Mock Graph returns 429 with `Retry-After: 1` to all writes. Verify exactly `maxRetries + 1 = 4` attempts (per `src/graph/client.ts:204`), then `GraphRequestError` surfaced as tool error. No infinite retry. **Plus form-wait isolation row:** open a destructive form that takes 5 seconds to submit; assert no retry counter ticks during the wait and that subsequent Graph calls are not delayed.                                                                                                                                                                                                                                                                                                                                 |
| `13-form-xss-escaped.test.ts`                | `collab_write` with `intent: "<script>alert(1)</script>"` shown in the external-source re-prompt form. Assert form HTML contains `&lt;script&gt;` text, not raw tag. Repeat for `path`, `folderPath`, `authoritativeFileName`, and a diff body containing `<script>` markers.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `14-loopback-csrf-rejected.test.ts`          | Forge a `POST /submit` with missing CSRF token, wrong CSRF token, wrong `Host`, missing `Origin`, wrong `Content-Type`. Each must return 4xx and not advance form state. Audit records `csrfTokenMatched: false`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `15-sentinel-tamper-detected.test.ts`        | Open the project once (pin recorded). **Variant A (rename, allowed):** mutate sentinel `authoritativeFileName` while keeping the same `authoritativeFileId`. Re-open: succeeds, `displayAuthoritativeFileName` refreshed silently, no audit entry. **Variant B (real tamper):** mutate sentinel `authoritativeFileId`. Re-open: returns `SentinelTamperedError`; `sentinel_changed` audit entry written. "Forget project" then re-open: succeeds with new pin. **Variant C (folder moved):** move the project folder to a different parent in mock Graph; re-open succeeds and `folderPath` is silently refreshed in recents and local metadata.                                                                                       |
| `16-multiple-root-md.test.ts`                | **N=1 variant:** init folder with single root `.md` `spec.md` — form pre-selects it; spy submits without changing selection; sentinel records `spec.md`. **N=3 variant:** folder with `README.md`, `NOTES.md`, `spec.md` — form has no default; spy attempts submit with no selection (rejected client-side); spy then selects `spec.md` and submits; sentinel records `spec.md`; the other two remain unmodified and are visible in `collab_list_files` ROOT group as ordinary entries.                                                                                                                                                                                                                                               |
| `17-share-url-host-allowlist.test.ts`        | Paste `file:///etc/passwd`, `http://localhost`, `https://attacker.example`, `https://1drv.ms/foo` (allowed). First three return `InvalidShareUrlError` with no Graph call. Fourth proceeds to `/shares/u!…`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `18-form-busy-lock.test.ts`                  | Open the init form; while it's open, another tool call requests a destructive form. Second call returns `FormBusyError` carrying the URL of the in-flight form. After completing the first form, the second call succeeds. **Lock-release matrix:** the lock must release on every terminal outcome. Sub-tests cover submit, cancel (POST /cancel), timeout (form server's 120 s elapsed), transport abort (caller's signal aborted), and an uncaught exception thrown inside the form's submit handler. After each, a fresh form request must succeed.                                                                                                                                                                                |
| `19-session-survives-reconnect.test.ts`      | Active session in process P. Drop the stdio transport without exiting P. Open a new transport against P. Active session is the same `sessionId`; budgets and destructive counter unchanged. Variant: kill P; restart; session is gone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `20-doc-id-recovery.test.ts`                 | Three variants. **A (success):** wipe both frontmatter and local `docId`, then call `session_recover_doc_id` — walks mock-Graph versions, finds an old version with parseable frontmatter, writes `doc_id` back to local cache, audits `doc_id_recovered`; subsequent `collab_write` succeeds. **B (already known):** call `session_recover_doc_id` when both live frontmatter and local cache hold the same `doc_id` — returns `DocIdAlreadyKnownError` informational, not isError. **C (unrecoverable):** wipe everything plus history; call returns `DocIdUnrecoverableError` with `versionsInspected` count and the "init fresh project" guidance.                                                                                 |
| `21-agent-name-unknown.test.ts`              | Connect with an MCP `clientInfo` payload missing `name`. First tool call audits `agent_name_unknown` once, then proceeds with `agentId = <oid>-unknown-<sessionId>`. Subsequent tool calls in the same session do **not** repeat the warn (warn-once-per-session).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### 8.3 Helper additions

- Extend `test/mock-graph.ts` with handlers for `/shares/{id}/driveItem`,
  `/me/drive/sharedWithMe`, `/me/drive/items/{id}/versions`,
  `/me/drive/items/{id}/versions/{vid}/restoreVersion`, and
  `/me/drive/items/{id}/permissions`. Reuse the cTag/version logic
  from existing markdown handlers. Add request-recording so tests can
  assert "no Graph call was issued" for pre-resolution refusals.
- Extend `test/integration/helpers.ts` with `createTwoClients(env)`
  for the two-agent test, and a `reconnectTransport(client)` helper
  for test 19.
- Add `test/collab/clock.ts` — simple fake clock helper, injected
  through `ServerConfig.now?: () => Date` (proposed addition to
  `ServerConfig`; falls back to `() => new Date()` in production).
- Add `test/collab/forms-spy.ts` — a spy `openBrowser` that captures
  the form URL, fetches the rendered HTML for assertion, extracts the
  embedded CSRF token, and lets tests POST a forged or genuine
  submit. Required by tests 05, 06, 07, 13, 14, 16, 17, 18.
- **Add `GraphClient.stats` getter for test instrumentation.** Test
  12's "form-wait isolation from retry budget" assertion needs a
  way to observe that `GraphClient.performRequest`'s internal
  retry counter does not advance during a 5-second form wait.
  Approach: expose a read-only `stats: { totalRequests, totalRetries,
lastRetryAt, lastRequestAt }` getter on `GraphClient` (zero
  runtime overhead — already-tracked fields just made visible).
  Snapshot before form wait, snapshot after, assert equality on
  `totalRetries` and an unchanged `lastRetryAt`. Same getter
  doubles as a debugging aid for §1.5 throttle behaviour. The
  alternative — inspecting `test/mock-graph.ts` request-log timing
  gaps — is rejected because it would couple the test to mock
  internals and miss the case where retries happen _without_
  hitting the mock (e.g. an aborted request retried locally).

### 8.4 Expectations on existing tests

No changes. Constraint: `markdown_*` tools untouched. The shared
`GraphClient` retry behaviour does not change, so
`test/graph/client.test.ts` stays as-is.

## 9. Rollout plan

Definition-of-done bar for every milestone: lint clean, typecheck
clean, all new tests passing, no regressions in `npm run check`.

Plain markdown calendar; days are working days.

**Single blocking dependency: `userOid` plumbing.** The audit log,
renewal-counts file, agentId, and several integration tests all key
on it. The current `Authenticator` interface does not expose it (open
question 6). This is a cross-cutting change spanning `auth.ts`,
`MockAuthenticator`, and persisted `account.json`. **Do it first**,
before any sentinel/session work, so nothing else has to back-fill.

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
- **W0 Days 4–5 — buffer.** W0 was estimated optimistically the
  first time round; CSRF + Origin + Host + Content-Type +
  Sec-Fetch-Site + CSP test rows alone are ~300 LOC of tests
  (Appendix A correction). Use the buffer for that and for
  cross-host browser smoke (Claude Desktop, VS Code Copilot).

### Week 1 — auth + scaffolding

- **W1 Day 1 — `userOid` plumbing.** Surface `idTokenClaims.oid`
  via `Authenticator.accountInfo` (per OQ-6 round-3 decision; lands
  as ADR-006). Do **not** use `localAccountId` — they can differ in
  multi-tenant and B2B-guest setups, and we don't want that
  ambiguity in audit logs. Update `MockAuthenticator`,
  `account.json` persistence, `src/tools/status.ts`. DoD:
  `test/auth.test.ts` extended with an explicit assertion that
  `userOid === idTokenClaims.oid`; `userOid` reaches every collab
  consumer via `ServerConfig`; ADR-006 merged in the same PR.
- **W1 Day 2 — `ServerConfig` extensions + sentinel codec.** Add
  `now?: () => Date`. Sentinel reader/writer with Zod schema +
  `SentinelTamperedError` plumbing (no UI yet). DoD: sentinel
  round-trip unit test passes; `15-sentinel-tamper-detected.test.ts`
  rename variant passes.
- **W1 Day 3 — Module skeleton + `session_init_project` happy path.**
  `src/collab/`, `src/tools/session.ts`, `src/tools/collab.ts`. Init
  form HTML wired through the W0 form factory. Recents writer.
  DoD: `01-init-write-read-list.test.ts` reaches the sentinel-write
  step and asserts pin block written.
- **W1 Day 4 — Multi-root-md handling + `16-multiple-root-md.test.ts`.**
  Init form lists every root `.md`; spy selects one. DoD: test 16
  passes.
- **W1 Day 5 — `session_status` + persisted destructive counter
  (§3.7).** TTL math, budget counters in memory, persistence helper.
  DoD: status tool reports an active session and survives a
  simulated process restart.

### Week 2 — read path + scope + frontmatter

- **W2 Day 1 — Frontmatter codec.** Hardened `yaml` parse options,
  deterministic emitter (stable key order, LF, two-space indent).
  DoD: `test/collab/frontmatter.test.ts` round-trip determinism
  passes.
- **W2 Day 2 — `doc_id` recovery + `frontmatter_reset` audit.**
  Read path returns defaults on missing/malformed; recovery from
  local cache; `DocIdRecoveryRequiredError` when both gone. DoD:
  `04-frontmatter-stripped.test.ts` (both variants) passes.
- **W2 Day 3 — Scope resolution algorithm (§4.6 in full).** Path
  resolver under the project folder, all eight pre-resolution
  refusals, NFKC check, byId resolution, ancestry check,
  shortcut/redirect refusal, cross-drive refusal, case-aliasing
  refusal. DoD: every row in `08-scope-traversal-rejected.test.ts`
  passes.
- **W2 Day 4 — `collab_read` + `collab_list_files`.** Faithful
  listing with `isAuthoritative` marker. DoD: `01-init-write-read-
list.test.ts` end-to-end happy path.
- **W2 Day 5 — buffer.** Frontmatter determinism and scope are the
  two highest-risk surfaces in the doc. Catch overflow here, not
  by squeezing W3.

### Week 3 — write path

- **W3 Day 1 — `collab_write` Graph helper.** `writeAuthoritative`,
  `writeProjectFile` with `If-Match`/`conflictBehavior`. Reuses
  `requestRaw`. DoD: `test/graph/collab.test.ts` covers cTag
  mismatch, byPath create, byId replace.
- \*\*W3 Day 2 — `collab_write` tool registration + `source` parameter
  - external re-prompt.\*\* No shingle heuristic (cut). DoD: write
    happy path + cTag mismatch + external-source approve + decline.
- **W3 Day 3 — Audit writer + redaction allow-list.** Atomic
  appends, ≤4096-byte cap, `_unscoped.jsonl` fallback,
  `Bearer`-substring rejection. DoD: `audit.test.ts` passes; kill-
  mid-write test produces a parseable file.
- \*\*W3 Day 4 — `collab_acquire_section` + `collab_release_section`
  - leases sidecar codec.\*\* Free (no budget cost). Lease state in
    `.collab/leases.json` (§3.2.1), not in the authoritative-file
    frontmatter — fixes the round-2 throughput concern (8 MiB lease
    cycles). DoD: `02-two-agents-different-sections.test.ts` and
    `test/collab/leases.test.ts` pass.
- **W3 Day 5 — buffer.**

### Week 4 — proposals + open flow

- **W4 Day 1 — Slug codec + authorship-on-section codec.**
  GitHub-flavored slug with collision walk + preamble synthetic;
  slug + content-hash emit/read; slug-drift fallback. DoD:
  `test/collab/slug.test.ts` and `test/collab/authorship.test.ts`
  pass.
- **W4 Day 2 — `collab_create_proposal`.** Two-write flow;
  records `target_section_content_hash_at_create`. DoD:
  `03-cTag-mismatch-proposal-fallback.test.ts` passes.
- **W4 Day 3 — `collab_apply_proposal` (with destructive
  re-prompt).** Slug-first / hash-fallback lookup;
  `slug_drift_resolved` audit; `SectionAnchorLostError` only
  when both anchors fail. DoD: `07-destructive-apply-proposal
.test.ts` (all three variants) passes.
- **W4 Day 4 — `session_open_project` + sentinel pinning + silent
  folder-path refresh.** URL paste resolution (with host
  allow-list), shared-with-me listing, recents. Open form. DoD:
  `15-sentinel-tamper-detected.test.ts` (all three variants
  including folder-moved) and `17-share-url-host-allowlist
.test.ts` pass.
- **W4 Day 5 — `session_renew` + renewal caps.** Renewal counts
  file with rolling-window pruning. Fake-clock test infra. DoD:
  `11-renewal-caps.test.ts` passes.

### Week 5 — versions + delete + polish

- \*\*W5 Day 1 — `collab_list_versions` + `collab_restore_version`
  - `session_recover_doc_id`.\*\* Reuse `listDriveItemVersions`.
    Destructive re-prompt for authoritative restore. The recovery
    tool walks `/versions` for parseable frontmatter, capped at 50
    versions (§2.2). DoD: integration tests for restore on
    authoritative + on a draft file; `20-doc-id-recovery.test.ts`
    (all three variants) passes.
- **W5 Day 2 — `collab_delete_file`.** Always-destructive
  re-prompt; refuse authoritative and sentinel. DoD: integration
  test covers proposals, drafts, attachments, and explicit
  refusal cases.
- **W5 Day 3 — `19-session-survives-reconnect.test.ts` + scope-gate
  polish + agentId fallback.** Session survives MCP transport
  reconnect within same process; `buildInstructions` extension for
  collab; help text for `collab_*` tools when no session is active;
  warn-once `agent_name_unknown` audit when `clientInfo.name` is
  absent. DoD: tests 19 and 21 pass.
- **W5 Day 4 — Documentation.** README, CHANGELOG, `manifest.json`
  tool list, frontmatter-reformat note for users, leases-sidecar
  note, `doc_id`-recovery flow, attachments-recursive note.
- **W5 Day 5 — End-to-end `npm run check` + cross-host browser
  smoke + buffer.**

### Week 6 — slip absorption

Held in reserve. The previous draft estimated **3 weeks** for the
collab work; this revision is **5 weeks plus W0**, with three
explicit buffer days and one buffer week. The shift was driven by
two independent observations:

1. The earlier 3,700/3,700 LOC budget was understated. Revised to
   ~5,500/~5,500 (Appendix A). At sustained ~300 src LOC/day with
   tests that's ~18 working days for src; the original 15-day
   schedule had no slack.
2. Frontmatter determinism, scope algorithm, and authorship
   anchoring are each one-bug-away from a full week of debugging.
   Better to budget for it now than to rediscover it at code
   review.

If W1–W5 land on schedule, W6 is for follow-up issues found in
internal dogfooding before announcing v1.

Total estimate, stated arithmetically so it can't be misread:

- **W0 + W1 + W2 + W3 + W4 + W5 = 6 weeks (30 working days).** This
  is the "realistic" estimate. Every milestone has a
  definition-of-done; if all DoDs land on schedule the work is
  done at end of W5.
- **W6 reserve = +1 week (5 working days).** Total with reserve:
  **7 weeks (35 working days)**.

Stated this way because the previous "5–6 weeks" summary was
ambiguous — it didn't make clear whether W0 was inside or outside
the band. It is **inside**: realistic = 6 weeks including W0;
worst-case = 7 weeks including W6 reserve.

**Productivity assumption (stated explicitly, not implied).** The
6-week realistic figure assumes sustained throughput of roughly
**1,000 LOC/day combined (src + tests)** for a single engineer
working in this codebase. At ~12,000 LOC total (Appendix A: 5,920
src + 6,020 tests), that's ~12 working days of pure-coding time
plus the rest of the 30-day budget for design, debugging, code
review iteration, and the W0 hardening test rows. This is
**achievable but not casual**, and only achievable if:

- The engineer is **fluent in this codebase's existing patterns**:
  `GraphClient.request()`, `Zod` schemas, the picker/loopback
  template substrate, `ServerConfig` injection, `MockAuthenticator`
  conventions. A new engineer needs at least W0 to ramp up; they
  hit ~1,000 LOC/day around W1 Day 3.
- Heavily-templated code (tool registrations, Zod schemas, mock
  Graph handlers, audit type definitions) compensates for the
  algorithmically novel pieces (scope resolution algorithm,
  slug+hash authorship anchoring, deterministic YAML emit, leases
  sidecar CAS, doc-id recovery walk). These novel pieces will
  consume disproportionate time per LOC.

If the engineer is **not** fluent in this codebase, calendar
expansion is reasonable: **realistic 8-10 weeks**, worst-case
9-11 weeks. Set stakeholder expectations accordingly when staffing.

**Re-baseline triggers (no more than twice).** Velocity is
verified by progress-file evidence, not by feel:

- **End of W1.** If W0 + W1 milestones (10 working days) landed on
  schedule with passing CI, the 6-week calendar stands. If they
  slipped by ≥2 days, re-estimate W2-W5 in the same proportion
  and record the amendment as an ADR. Notify stakeholders of the
  new expected ship date.
- **End of W3.** Mid-point sanity check. If W2 + W3 added another
  ≥2 days of slip beyond the W1 baseline, do a second
  re-estimate. If the trend is worse than 2× the original
  estimate at W3, escalate: scope cut (drop a tool from v1) or
  add a second engineer to the W4 + W5 milestones.

No re-baselining beyond W3 — the runway is too short and the
overhead too high. After W3 we ship what's done at end of W5 +
W6, and any unfinished tools become v1.1.

## 10. Open questions

Items I could not resolve from the code alone. Items already addressed
in the plan body (§4.6 path algorithm, §3.2 sentinel pinning, §0
threat model) are no longer listed as questions.

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
   `"claude-code"`. I have not verified these in this repo. **Defined
   fallback behaviour:** if `clientInfo.name` is present, slugify it
   (`[a-z0-9-]`, runs collapsed to `-`, leading/trailing `-`
   stripped) and use it as the middle segment of `agentId`. If
   absent (empty, undefined, or all-non-slug-chars), use the literal
   `"unknown"` and emit a one-time `agent_name_unknown` audit entry
   per session (warn-once, not per-call — see test 21). The agentId
   format `<oidPrefix>-<clientSlug>-<sessionIdPrefix>` remains
   unique per session even with `unknown`; it just loses the
   client-distinction the original B6.17 design wanted. The MCP SDK
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
   APIs not currently surfaced. **Round-3 decision: use
   `idTokenClaims.oid`.** Rationale: standard Entra object
   identifier; matches `GET /me.id` in most cases; well-documented;
   works the same way for OneDrive personal and (eventual v2)
   business / B2B-guest scenarios. `localAccountId` _can_ differ
   from `oid` in multi-tenant and B2B-guest setups, and we don't
   want that ambiguity baked into agentIds that show up in audit
   logs. This pin lands as ADR-006 at W1 Day 1; coordinate with
   anyone touching `auth.ts`. Adding `userOid: string` to
   `AccountInfo` is a small change but spans `src/auth.ts`,
   `src/tools/status.ts`, and the `MockAuthenticator`.
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
10. **Audit-append concurrency on Windows.** §3.6 documents that
    `fs.appendFile` on Windows is not atomic against another
    process. Two MCP instances appending to the same audit file
    concurrently can interleave bytes mid-line. v1 accepts this
    fringe scenario (typical user runs one MCP host per project at
    a time) and relies on the parser's partial-line tolerance.
    v2 mitigation candidates: `proper-lockfile` for cross-process
    advisory locking, or routing audit through a dedicated child
    process with a single appender. Promoted from §3.6 to keep
    visible.

## 12. Execution discipline

This work is too large for one PR and too risky for direct merges
to `main`. The discipline below is the contract under which W0
starts.

### 12.1 Branching strategy

- **Long-lived integration branch: `feat/collab-v1`.** Branched off
  `main` at the start of W0. **Never force-pushed.** `main` never
  receives collab code directly during the build-out.
- **Per-milestone branches: `feat/collab-v1/w<N>-d<M>-<slug>`**
  branched off `feat/collab-v1`. Examples:
  `feat/collab-v1/w0-d1-escape-html`,
  `feat/collab-v1/w1-d1-user-oid`,
  `feat/collab-v1/w2-d3-scope-resolution`.
- Each per-milestone PR targets `feat/collab-v1`, **not `main`**.
- When all of W0-W5 has merged into `feat/collab-v1` and the W6
  reserve is either consumed or released, **a single final PR
  merges `feat/collab-v1` into `main`**. This PR is a formality;
  review happened milestone-by-milestone.

### 12.2 Per-PR rules

Every milestone PR follows the same shape so reviewers know what
to expect:

- **Scope: exactly one milestone from §9.** No sneaking W3 Day 2
  work into a W3 Day 1 PR. If extra related work surfaces, file a
  follow-up issue.
- **Size budget: aim for ≤800 LOC changed (src + tests).** If a
  milestone doesn't fit, split it and update §9 to match (via an
  ADR — see §12.4). **Hard ceiling 1,500 LOC**; anything larger
  blocks review.
- **DoD checklist in the PR description**, copied verbatim from
  the §9 milestone, with each item ticked before requesting
  review.
- **Progress-file update included in the same PR** (§12.3). The
  PR cannot merge without the progress-file change.
- **Every PR leaves `main` green.** Before each merge into
  `feat/collab-v1`, rebase the integration branch onto `main` so
  CI runs against current `main`. Use **merge commits, not
  squash**, so milestone history stays readable in
  `git log --first-parent`.
- **No PR references unreleased scope.** If a milestone references
  a schema field or tool that doesn't exist yet, either include
  the skeleton for it in this PR or defer the reference.

### 12.3 Progress tracking lives in the branch

Two files at `docs/plans/` track state:

1. **`docs/plans/collab-v1.md`** — the plan itself (this
   document). **Frozen** at the state at which W0 starts; updates
   only for decision amendments recorded as ADRs.
2. **`docs/plans/collab-v1-progress.md`** — the **live** progress
   file. Updated in the same PR as each milestone ships. Format
   is a markdown file with three tables: Completed, In flight,
   Not started. Each milestone row links to its PR and merge
   date. The bootstrap version of this file lives in the branch
   from day one with all milestones in Not started.

This file is the single source of truth for "where are we?".
Anyone picking up the work reads it first. It lives in the branch,
so it's always the view appropriate to `feat/collab-v1` state.
`main` never sees it until final merge.

### 12.4 Decision amendments as ADRs

The plan itself is frozen. Decisions that change during
implementation land as short ADRs under `docs/adr/`, numbered
sequentially. Each ADR:

- States the decision in one sentence.
- References the §N of the plan it amends.
- Is created **in the same PR** as the code change that embodies
  it.
- Must be approved by the human reviewer.

**Bootstrap ADR-005** at the start of W0 with the 20 locked
decisions from the three review rounds. Subsequent ADRs number
from 002. Minimum template: title, context (one paragraph),
decision (one paragraph), consequences (one paragraph). No epic
Nygard-style documents.

Round-3 already pre-commits two future ADRs:

- **ADR-006 at W1 Day 1:** `userOid = idTokenClaims.oid` (per OQ-6).
- **ADR-007 at W2 Day 1:** `yaml` pinned at `~2.x.y` with
  byte-exact snapshot test (per §6 dependency policy).

### 12.5 Handoff contract when work pauses

If the engineer pauses mid-milestone (illness, context switch, end
of sprint), the next person picks up from the progress file.
Handoff contract:

- The in-flight branch is **pushed to origin** (even if the PR is
  a draft).
- `docs/plans/collab-v1-progress.md` on the in-flight branch is
  updated with a note under "In flight" describing **exactly what
  is done and what the next step is**. "Scope-resolution
  pre-normalisation refusals complete; NFKC check in progress;
  byId resolution and ancestry walk not started" beats "partway
  through W2 Day 3."
- The draft PR has a checklist of sub-items in the description,
  ticked as they complete.

### 12.6 Rebase or merge?

- **Per-milestone PR → `feat/collab-v1`:** merge commit (not
  squash), so each milestone is one mergeable unit visible in
  history.
- **`feat/collab-v1` → `main` (final PR):** merge commit, so the
  full milestone history stays visible in `git log --first-parent`
  on `main`.
- **Rebase `feat/collab-v1` onto `main`** before each per-PR merge
  so CI is honest. Never rewrite history after push.

### 12.7 Green-light condition

W0 starts when:

- [ ] `feat/collab-v1` exists, branched from current `main`.
- [ ] `docs/plans/collab-v1-progress.md` exists on
      `feat/collab-v1` with all §9 milestones in Not started.
- [ ] `docs/adr/0005-collab-v1-decision-log.md` exists on
      `feat/collab-v1` with the 20 locked decisions.
- [ ] `npm run check` is green on `feat/collab-v1`.

The first three items land in a single bootstrap PR titled
"docs(collab): bootstrap v1 progress + ADR-005 decision log"; the
fourth is verified by CI on that PR. Only then does W0 Day 1
begin.

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
_cross-cutting non-tool, non-Graph utilities_ (session lifecycle, scope
resolution algorithm, frontmatter codec, audit writer, sentinel codec,
recents/renewal/destructive-counter persistence). Tool registration
stays in `src/tools/`, Graph helpers stay in `src/graph/`, templates
stay in `src/templates/` (matches existing `login.ts`, `picker.ts`,
`logout.ts` siblings). The form factory and form HTML live under
`src/tools/collab-forms.ts` (factory) and `src/templates/collab.ts`
(HTML), with no separate `src/forms/` directory.

Proposed new files:

| File                                                                                                                                                  | LOC estimate |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `src/collab/session.ts` (lifecycle, agentId with `clientInfo` slug + warn-once-unknown, currentSession, reconnect-survival)                           | 380          |
| `src/collab/scope.ts` (§4.6 algorithm, all eight refusals + post-resolution checks + flat-vs-recursive group rules)                                   | 380          |
| `src/collab/frontmatter.ts` (yaml round-trip, deterministic emit, doc_id recovery)                                                                    | 380          |
| `src/collab/slug.ts` (GitHub-flavored slug + collision walk + preamble synthetic)                                                                     | 100          |
| `src/collab/authorship.ts` (slug + content-hash anchoring, slug-drift fallback)                                                                       | 200          |
| `src/collab/leases.ts` (sidecar codec, lazy-create, expired-lease cleanup, graceful 404 degradation)                                                  | 220          |
| `src/collab/audit.ts` (writer, redaction, ≤4096-byte cap, Bearer-rejection)                                                                           | 240          |
| `src/collab/ulid.ts` (inlined)                                                                                                                        | 60           |
| `src/collab/sentinel.ts` (read, write, rename-tolerant pinning, tamper detection, silent folder-path refresh)                                         | 240          |
| `src/collab/recents.ts`                                                                                                                               | 120          |
| `src/collab/renewal.ts`                                                                                                                               | 160          |
| `src/collab/destructive-counter.ts` (§3.7 persistence)                                                                                                | 100          |
| `src/collab/doc-id-recovery.ts` (`/versions` walk, version cap, parseable-frontmatter detection)                                                      | 180          |
| `src/graph/collab.ts` (sentinel/authoritative/leases I/O, shares with host allow-list, sharedWithMe + permissions filter, attachments recursive walk) | 540          |
| `src/templates/collab.ts` (init/open/destructive/external form HTML; init form N=1 vs N≥2 default-selection logic)                                    | 560          |
| `src/templates/escape.ts` (`escapeHtml`)                                                                                                              | 40           |
| `src/tools/collab-forms.ts` (form factory + lock with finally-release contract + W0 hardening wrapper)                                                | 420          |
| `src/tools/session.ts` (5 session\_\* tools incl. `session_recover_doc_id`)                                                                           | 540          |
| `src/tools/collab.ts` (10 collab\_\* tools)                                                                                                           | 1 060        |

Test files:

| File                                                                                                                 | LOC estimate |
| -------------------------------------------------------------------------------------------------------------------- | ------------ |
| `test/graph/collab.test.ts`                                                                                          | 540          |
| `test/collab/*.test.ts` (8 files: session, scope, audit, frontmatter, slug, authorship, leases, sentinel)            | 1 460        |
| `test/integration/collab/*.test.ts` (21 files)                                                                       | 3 100        |
| `test/picker.test.ts` extensions (W0 hardening: CSRF + Host + Origin + Content-Type + Sec-Fetch-Site + CSP rows)     | 320          |
| `test/templates/*.test.ts` extensions (XSS rows for every interpolation)                                             | 180          |
| `test/mock-graph.ts` extensions (sharedWithMe, shares, versions, permissions, request recording, leases.json byPath) | 420          |

Modifications:

| File                                                                                                                                               | Δ LOC |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `src/index.ts` (register new tools, `now`, `userOid`)                                                                                              | +50   |
| `src/auth.ts` (`userOid` field, account.json plumbing)                                                                                             | +55   |
| `src/picker.ts` (W0 CSRF/Origin/Host/CSP hardening)                                                                                                | +130  |
| `src/loopback.ts` (W0 hardening parity)                                                                                                            | +60   |
| `src/tool-registry.ts` (`group` field, instructions block)                                                                                         | +35   |
| `src/tools/status.ts` (collab section incl. `leasesCTag`)                                                                                          | +50   |
| `src/tools/login.ts`, `src/tools/markdown.ts` (use form factory)                                                                                   | +50   |
| `src/templates/{login,picker,logout}.ts` (escapeHtml plumbing)                                                                                     | +40   |
| `manifest.json` (tool descriptions for 15 new tools)                                                                                               | +130  |
| `README.md`, `CHANGELOG.md` (frontmatter-reformat note, multi-root-md note, leases sidecar note, doc_id-recovery flow, attachments-recursive note) | +360  |

Rough total: **5 920 LOC src, 6 020 LOC tests** for v1. Up again
from the previous round's 5 540/5 400 because of the round-2
additions — slug codec, leases sidecar, doc-id-recovery walk,
attachments-recursive listing, two extra integration tests, and an
extra session tool. Drivers:

- W0 hardening test rows alone are ~320 LOC, not the +200 the
  earliest draft implied.
- Form HTML template (init/open/destructive/external + their submit/
  cancel/success states + N=1 auto-select logic) is closer to 560
  LOC than 420.
- `src/tools/collab.ts` carries 10 tools with non-trivial branching
  (path resolution, source re-prompt, conflict modes, destructive
  detection, slug-drift fallback); 1 060 LOC is realistic.
- Frontmatter codec needs deterministic emit + `doc_id` recovery +
  multi-doc rejection; 380 LOC.
- Slug codec is small (100 LOC) but its collision-walk and
  duplicate-heading semantics need a dedicated test file.
- Leases sidecar adds 220 LOC src + a dedicated 200 LOC test file
  but **removes** the round-1 fear of 8 MiB lease cycles
  triggering throttling — net win at higher accounting cost.
- `src/collab/doc-id-recovery.ts` is 180 LOC for the version walk
  and parseable-frontmatter detection.
- Integration test files average ~150 LOC each given the
  CSRF/spy/forge fixtures; 21 files × 150 ≈ 3 100.

Compensating cuts vs the previous Appendix A:

- **Removed** `src/collab/source-cache.ts` (–100 LOC) — source
  heuristic dropped in round 1.
- **Removed** `src/scopes.ts` change for the optional `Collab`
  toggle (–20 LOC) — toggle dropped in round 1.
- **Removed** `src/graph/collab.ts` delta-polling code (–~100 LOC)
  — delta polling dropped in round 1.
- **Removed** init form soft-warn UI (–~40 LOC) — soft-warn dropped
  in round 1.
- **Removed** the round-1 hypothesis that lease writes round-trip
  the authoritative file — the leases sidecar replaces that path
  entirely. Net structural improvement at modest LOC cost.

These cuts cancel ~250 LOC; the rest of the increase is honest
re-budgeting.

**Calendar reconciliation.** Net change vs round 1: **+380 LOC src,
+620 LOC tests, ~+750 LOC total after cuts.** At the planned
sustained pace of ~300 src LOC/day with ~1:1 test ratio (i.e. ~150
src LOC/day net once tests are written alongside), the round-2
addition costs roughly **5 working days**. Absorbed as follows:

- **Within the existing buffer days** (W2 Day 5, W3 Day 5, W5 Day 5
  = 3 buffer days inside W1–W5): ~3 days.
- **W0 Days 4–5 buffer** is held for the ~300 LOC W0 hardening
  test correction noted in the W0 section, not for round-2
  scope.
- **Remainder (~2 days)** dips into W6 reserve. W6 was always 5
  days of reserve; consuming 2 of them for round-2 scope leaves
  3 days for genuine slip. This is acceptable.

**Bottom line: 6 weeks realistic stands; 7 weeks worst-case stands;
the realistic estimate now has slightly less slack inside it (~2
days instead of ~5) but is still believable.** If round 3 adds
significant scope, the calendar will need re-baselining rather
than further W6 raids.

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
   proposal metadata in YAML inside the file means _every_ CAS-write
   round-trips the entire file body. For files near the 4 MiB cap,
   a chatty agent can burn the write budget on metadata. Byte-
   stability across our own writes is mandatory (deterministic
   emitter contract, §3.1) but byte-stability across human edits in
   OneDrive web is **explicitly accepted as not-a-property**: the
   first write after any human frontmatter edit will reformat to
   canonical form, producing one noisy diff in version history per
   human edit. This trade is locked and documented for users in the
   README so it doesn't surprise anyone in the field.
3. **Browser form UX during background sessions.** Mid-session
   re-prompts (destructive, source:external) interrupt the agent
   conversation. If the user is not at the keyboard, the agent
   stalls until the form times out. With a 2-hour TTL the form
   timeout (default 120 s) is much shorter than the session, which
   is correct, but the agent's UX needs careful messaging
   ("waiting for the user to approve in the browser..."). Clear
   audit entries help post-hoc diagnosis but do not fix the live
   stall.
