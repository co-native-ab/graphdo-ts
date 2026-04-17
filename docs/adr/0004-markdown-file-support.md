---
title: "ADR-0004: Markdown File Support on OneDrive"
status: "Accepted"
date: "2026-04-17"
authors: "co-native-ab"
tags: ["architecture", "graph", "markdown", "onedrive"]
supersedes: ""
superseded_by: ""
---

# ADR-0004: Markdown File Support on OneDrive

## Status

**Accepted**

## Context

AI agents frequently need to read and write short-to-medium-length text documents — notes, drafts, outlines, prompt templates, conversation transcripts, research summaries. Storing these in Microsoft Graph alongside the user's mail and tasks keeps agent-produced artefacts in a familiar, backed-up, user-controlled location without introducing a new storage dependency.

Microsoft Graph exposes a file system via OneDrive (`/me/drive`). Extending graphdo-ts with markdown-file tools is a natural next Graph surface to cover, but it introduces new forces that do not apply to mail or To Do:

- **Arbitrary content**: unlike a todo title or mail subject, a markdown document can be of arbitrary length. Graph places a hard 4 MB limit on single-request transfers to the `/content` endpoint. Larger files require a **resumable upload session**, which is a multi-request protocol: create a session, stream chunks of up to 60 MiB with precise Content-Range headers, retry partial failures, and finalise the session. Implementing this well requires byte-accurate streaming, chunk-level retry logic, progress reporting, and session teardown on abort.
- **Scope of access**: OneDrive access ranges from `Files.Read` (read-only, all files) down to `Files.ReadWrite.AppFolder` (read/write in a single app-owned folder). The scope choice sets both the capability and the blast radius: an agent with `Files.ReadWrite` can — absent further constraints — reach every file in the user's drive, which is a meaningfully larger blast radius than mail-to-self or a single todo list (see [ADR-0001](./0001-minimize-blast-radius.md)).
- **"Which file?" ambiguity**: for mail and todo items, an ID-based API is enough. For files the agent frequently knows the human-readable name ("open my `ideas.md`") before it knows any ID, so the tool surface must support name-based addressing while keeping IDs as the canonical reference.
- **Consistency with existing design**: graphdo-ts already has a well-worn pattern for "scope agent access to a single container chosen by the human via the browser" — the To Do list picker. Reusing that pattern is strongly preferred to inventing a new one.

## Decision

graphdo-ts adds five MCP tools for markdown file management, scoped to a single OneDrive folder the user selects through the browser.

### 1. Delegated `Files.ReadWrite` Scope

We add `Files.ReadWrite` as a new optional scope. It grants read/write access to the signed-in user's OneDrive (not `Files.ReadWrite.All`, which extends to files shared with the user, and not the narrower `.AppFolder` variant, which requires a registered app folder that the user cannot casually browse into).

The Graph API has no native way to pre-restrict a delegated token to a single folder — that restriction is enforced by graphdo-ts in its tool layer, not by Entra ID. The token itself permits read/write to the whole OneDrive, so the in-process scoping (see decision 2) is the only thing keeping the agent confined.

### 2. Browser-Picked Root Folder, Persisted to Config

On first use the agent calls `markdown_select_root_folder`, which opens a browser picker listing the top-level folders in the user's OneDrive. The user clicks one, and the chosen drive item ID is stored in `markdown.rootFolderId` in `config.json`. All subsequent file tools operate **only** on children of that folder.

This mirrors the existing `todo_config` design exactly: the picker runs on a local HTTP server, browser launch is injected via `ServerConfig.openBrowser`, and selection is a human-only action (the agent cannot call a hidden "set root folder" API path). Calling the tool again overwrites the stored folder.

The picker lists a **flat** top-level folder listing rather than supporting recursive navigation. This keeps parity with the todo list picker and avoids building a generalised folder-tree UI. For usability at scale, the generic picker (used by both `markdown_select_root_folder` and `todo_config`) provides: a client-side filter/search box; a refresh button that calls `GET /options` on the picker server to re-run the provider; and an optional "Create new …" link that opens the underlying service (OneDrive, Microsoft To Do) in a new tab so users can create a new folder/list without leaving the flow. Refreshing replaces the server's set of valid selections, so a selection can never resolve to a stale option that is no longer offered.

The markdown picker and its subtitle explicitly mention OneDrive — this is the one human-facing surface where naming the storage provider is useful, so the user understands _where_ the folder will live. The agent-facing tool descriptions keep the generic "markdown storage" framing from decision 7.

### 2a. Strict Root-Folder ID Validation on Load

`markdown.rootFolderId` must always be a non-empty opaque drive item ID pointing to a single existing top-level folder. To make this invariant a property of every tool call (not just of the picker's write path), `loadAndValidateMarkdownConfig` re-validates the stored value on every tool invocation and refuses: empty strings, `"/"` or `"\\"` (which could otherwise be misinterpreted as "the drive root"), any value containing `/` or `\\` (which could alias to a subdirectory path), and any value containing whitespace. A configured-but-invalid root folder produces a distinct error from "not configured" (e.g. `"markdown root folder invalid (contains a path separator …)"`) and in both cases the error directs the user back to `markdown_select_root_folder`. This closes the hole where a hand-edited or corrupted `config.json` could silently escalate the tools' reach from one folder to a whole drive or a deep path.

### 3. Flat, Non-Recursive File Listing

`markdown_list_files` returns `.md` files **directly** under the configured folder — not recursively. This:

- Matches the mental model of a dedicated "notes folder" set by the user.
- Keeps the blast radius obvious: the agent can only touch files at exactly one level.
- Avoids unbounded page-through of large drive subtrees.

Filtering is primarily client-side: Graph's `$filter` on drive items does not reliably support the string functions needed to test a file extension. `$top=200` bounds the request; pagination is not exposed because the design is scoped to a user's own notes folder where a single page is expected to cover the common case.

### 4. Hard 4 MB Limit on Content Transfers

Both `markdown_get_file` and `markdown_upload_file` use direct `GET` / `PUT` against `/content`. The Microsoft Graph documented limit for a single request is 4 MiB = 4,194,304 bytes; larger payloads require an upload session. We deliberately do **not** implement upload sessions.

Concretely:

- `markdown_upload_file` checks `Buffer.byteLength(content, "utf-8")` **before** making any network call and returns a structured `MarkdownFileTooLargeError` if over 4 MiB.
- `markdown_get_file` reads the target's `size` via a metadata request first and refuses to download when it exceeds 4 MiB; it also re-checks the received body length as a defence-in-depth measure.

Rationale for the hard limit:

- **Scope fit**: markdown documents above 4 MiB are extremely rare in practice. The 99th-percentile note, draft, or outline is well under 100 KiB.
- **Complexity**: upload sessions require chunked streaming with precise Content-Range headers, chunk-level retries, progress reporting, and session lifecycle management (create / resume / cancel / complete). Every one of those adds code paths and error conditions.
- **Matches the project philosophy**: graphdo-ts exists to give agents _scoped, low-risk_ Graph access, not to be a full document-management tool. A clear "this is for notes, not bulk uploads" ceiling is a feature, not a limitation.

### 5. ID-or-Name Addressing

`markdown_get_file` and `markdown_delete_file` accept either a `itemId` (canonical drive item ID) or a `fileName` (case-insensitive match against files in the configured root folder, subject to the naming rules in decision 7). Name-only calls perform a listing and match locally — this keeps the API ergonomic for agents that rarely remember opaque IDs and avoids fragile URL encoding of names with special characters. `markdown_upload_file` is keyed by `fileName` only, since Graph's path-style `PUT` (`/items/{parent}:/filename:/content`) is the natural create-or-overwrite endpoint.

### 6. Raw-Body Request Path in `GraphClient`

The existing `GraphClient.request` always JSON-encodes the body and sets `Content-Type: application/json`. OneDrive `/content` uploads require a **raw** request body with a non-JSON content type. We add `GraphClient.requestRaw(method, path, body, contentType, signal)` that shares the retry, auth, and timeout logic via a common private `performRequest` helper, and keeps the JSON path unchanged. This is the minimum viable extension to the HTTP client — it does not introduce a streaming API, since upload sessions are not supported.

### 7. Strict, Cross-OS-Safe File Names with UNSUPPORTED Classification on Listing

All tools that accept a markdown file name enforce a conservative allow-list: names must end in `.md` (case-insensitive), contain only letters, digits, space, dot, underscore, and hyphen, start with a letter or digit, be at most 255 characters, must not contain path separators or subdirectory segments, must not be a Windows reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`, `LPT0`–`LPT9`), and must not have leading/trailing whitespace or a trailing dot before `.md`. The full rule set lives in `validateMarkdownFileName` and is also exported as a human-readable `MARKDOWN_FILE_NAME_RULES` string embedded verbatim in each tool's description.

Enforcement points:

- **`markdown_upload_file`**: validated at the zod-schema layer so the MCP SDK rejects bad names before the handler runs. The agent receives a structured `Invalid arguments` error whose message reproduces the specific violated rule.
- **`markdown_get_file` / `markdown_delete_file` by name**: validated explicitly in the handler so the agent sees the same error message style as upload.
- **`markdown_get_file` / `markdown_delete_file` by itemId**: the resolved drive item is re-validated after fetch. Subdirectories (drive items with a `folder` facet) are rejected with a dedicated "subdirectory is not supported" message; files whose _stored_ name violates the rules — which can happen if a file was created or renamed outside graphdo — are rejected with the specific rule that was violated. This closes the loophole where a valid-looking itemId could bypass the name validation that guards the by-name path.
- **`findMarkdownFileByName`** (internal): re-validates its input argument and only searches among names that pass validation, so a name-based lookup can never silently resolve to a file whose stored name is unsupported.

Rationale for this specific allow-list:

- **Portability first**: the allow-list is the intersection of what works unchanged on Linux, macOS, and Windows. This matters because users sync these files locally, and files that fail to materialise on a Windows machine are worse than files that were never created.
- **No subdirectories**: rejecting path separators (and reserving the folder facet check in the resolver) means the agent _cannot_ introduce a directory structure via the markdown tools — even if the user's underlying storage supports it. The configured root folder is always the exact and only place the agent writes to.
- **No leading dot / underscore / hyphen**: leading `.` produces hidden files on Unix (which agents rarely want but users rarely audit); leading `-` looks like a CLI flag when the file name is piped into a shell; leading `_` is banned on symmetry with the other two.
- **No Windows reserved names**: `CON.md`, `NUL.md`, etc. are legal on Linux but impossible to create/open on Windows. Rejecting them at write time means everything readable by the agent remains readable on every platform.
- **Length limit of 255**: matches the `NAME_MAX` limit on most filesystems (ext4, HFS+, NTFS per-segment).

Listings take a different tack: rather than hide things that fail validation, `markdown_list_files` surfaces them under an `UNSUPPORTED` section with the specific reason (`"subdirectory — only files directly inside the configured root folder are supported"`, `"unsupported file name: ..."`). The reasoning is that the agent needs to know those entries exist — to avoid picking a file name that would collide with an existing-but-inaccessible file, and to answer questions like "what's in the folder?" accurately — but it must not be able to read, write, or delete them. Non-markdown files (e.g. `photo.jpg`) are not markdown-tool concerns and are omitted from the listing entirely.

## Consequences

### Positive

- **POS-001**: Adds a high-value Graph surface (markdown notes in OneDrive) without weakening the "minimize blast radius" principle — the agent can still only touch a single, user-chosen folder.
- **POS-002**: Reuses the existing browser-picker pattern and config persistence model, keeping graphdo-ts conceptually coherent and keeping the user's mental model ("I pick a container, the agent lives in it") intact.
- **POS-003**: The 4 MB hard limit keeps the codebase small. No session management, no chunked streaming, no progress reporting, no resume logic. Fewer code paths means fewer bugs and easier security review.
- **POS-004**: ID-or-name addressing makes the tools ergonomic for agents without compromising correctness: internally operations always resolve to an ID before acting.
- **POS-005**: The raw-body request path in `GraphClient` generalises cleanly to any future non-JSON Graph surface (e.g., images, ICS files) without requiring another rewrite.
- **POS-006**: Strict, cross-OS-safe naming and the subdirectory ban make the blast radius of a compromised or misbehaving agent bounded _at the file-name layer_, not only at the folder layer. An agent cannot create `../../secrets.md`, `../archive/overwrite.md`, or `CON.md`; it also cannot address such a file even if it already exists on disk.
- **POS-007**: Listings expose unsupported entries explicitly rather than hiding them, so agents planning filenames have an accurate view of the folder and humans reading the listing are not surprised by "missing" files.

### Negative

- **NEG-001**: Token scope is broader than the effective capability. `Files.ReadWrite` grants the agent access to the whole OneDrive at the token layer; the folder restriction lives in graphdo-ts code. A future bug, a tool-routing error, or a malicious fork could bypass it. The mitigation is: this codebase is open source, the restriction point is a single small module, and the picker is human-only.
- **NEG-002**: Files larger than 4 MiB cannot be read or written. Users with that use case must use a different tool. We accept this on the grounds that markdown notes exceeding 4 MiB are well outside the intended use case.
- **NEG-003**: Flat (non-recursive) listing means users who organise notes into nested folders see only one level. They can still re-point the root folder via `markdown_select_root_folder` to a different subtree.
- **NEG-004**: Name-based lookups require a list request, so operating on a file by name costs one extra Graph call compared to operating by ID.
- **NEG-005**: Files created outside graphdo with names that fail the naming rules are visible in listings (under `UNSUPPORTED`) but unreadable and undeletable by the tools. Users who need to manipulate such files must rename them in their storage provider first, or use a different tool. We accept this because the alternative — relaxing the rules — would undo the cross-OS and blast-radius guarantees.

## Alternatives Considered

### Full Upload Session Support

- **ALT-001**: **Description**: Implement Graph's resumable upload session protocol so files of arbitrary size can be uploaded and downloaded.
- **ALT-002**: **Rejection Reason**: Requires significant streaming and chunk-management code (session create, chunked PUT with Content-Range, partial-failure retry, session cancel on abort, session complete). Adds per-chunk error paths that must be tested and maintained. The benefit is real but serves an out-of-scope use case (bulk file transfer); the scoped "markdown notes" use case is already fully served by the 4 MiB direct path.

### `Files.ReadWrite.AppFolder` Instead of `Files.ReadWrite`

- **ALT-003**: **Description**: Use the narrower AppFolder scope, which restricts the token to a `/me/drive/special/approot` folder owned by the app registration.
- **ALT-004**: **Rejection Reason**: AppFolder is tied to the Entra app registration; it cannot live in an arbitrary user-chosen folder, and the folder is not readily browseable from the OneDrive web UI (it sits under `Apps/<app-name>`). The "human picks the folder they want me to work in" UX — a core part of graphdo-ts's design — is not expressible with AppFolder. The delegated `Files.ReadWrite` scope plus in-tool folder pinning preserves that UX at the cost of a broader token scope (see NEG-001).

### Recursive Folder Listing / Search

- **ALT-005**: **Description**: Let `markdown_list_files` recurse into subfolders, or expose a search tool that locates markdown files anywhere under the configured root.
- **ALT-006**: **Rejection Reason**: Recursion reintroduces the "how deep does the blast radius reach?" question that the flat design deliberately closes off. Users who want more than a single level can always pick a higher-level folder as the root, at the cost of also widening the agent's reach.

### Pagination-Aware File Listing

- **ALT-007**: **Description**: Implement `$top` / `@odata.nextLink` paging for `markdown_list_files` so folders with more than ~200 items are fully listable.
- **ALT-008**: **Rejection Reason**: The design scope ("a notes folder") does not produce folders with thousands of markdown files in practice; the extra complexity is not warranted now. If a future use case calls for it, pagination can be added without breaking the tool contract.

### Store Full Paths in Config Instead of IDs

- **ALT-009**: **Description**: Persist the selected folder as a human-readable path (e.g. `/Notes`) rather than a drive item ID.
- **ALT-010**: **Rejection Reason**: Paths are mutable — users rename and move folders in OneDrive — but drive item IDs are stable. Persisting the ID guarantees the configured folder keeps working across renames. We keep the path as a display-only field in config.

### Looser / Platform-Specific File-Name Rules

- **ALT-011**: **Description**: Accept any Unicode name that happens to be valid on the user's own OS, or accept the broader set that OneDrive itself allows, rather than the strict cross-OS-safe allow-list.
- **ALT-012**: **Rejection Reason**: An agent running on Linux would happily create `emoji 😀.md` or `a:b.md`, which then breaks the moment the file is synced to a Windows machine or checked into a git repo on a case-sensitive filesystem. Worse, any relaxed rule has to answer the question "can the agent create a subdirectory via `..` or `/` in the name" — and every relaxed answer opens attack surface. The strict allow-list is small, easy to describe in one sentence, and makes "what can the agent create?" trivially answerable.

### Hiding Unsupported Entries from Listings

- **ALT-013**: **Description**: Have `markdown_list_files` return only supported files and silently drop everything else.
- **ALT-014**: **Rejection Reason**: Silence causes collisions: an agent asked "is `notes.md` available?" would get "yes" even if an unsupported-named `notes.md` already exists at a different casing or with unsafe characters, and the subsequent upload would overwrite it. Surfacing unsupported entries with their reason lets the agent reason about the full folder contents without being able to _act_ on them. The cost is a few extra lines in the listing output.

## Implementation Notes

- **IMP-001**: New scope `Files.ReadWrite` is added to `GraphScope` and `AVAILABLE_SCOPES` with `required: false`, matching the design of `Mail.Send` and `Tasks.ReadWrite`. Tool registration uses the existing `requiredScopes` mechanism so markdown tools are hidden until the user consents to the scope.
- **IMP-002**: Config is extended with an optional `markdown: { rootFolderId, rootFolderName, rootFolderPath }` object. A new `updateConfig` helper performs load-merge-save so writing the markdown config does not clobber the todo config and vice versa. `hasMarkdownConfig` and `loadAndValidateMarkdownConfig` mirror the existing todo helpers.
- **IMP-003**: Graph operations live in `src/graph/markdown.ts` and cover folder listing, file listing with `.md` filter, metadata fetch, content download, content upload, and delete. The 4 MiB constant is exported as `MAX_DIRECT_CONTENT_BYTES`. A dedicated `MarkdownFileTooLargeError` class surfaces size-limit violations without being conflated with network or authorization errors.
- **IMP-004**: `GraphClient` gains a `requestRaw` method that sends a raw string / `Uint8Array` body with a caller-specified `Content-Type`. The retry / auth / timeout loop is extracted into a private `performRequest` helper reused by `request` and `requestRaw`.
- **IMP-005**: Five MCP tools live in `src/tools/markdown.ts`: `markdown_select_root_folder`, `markdown_list_files`, `markdown_get_file`, `markdown_upload_file`, `markdown_delete_file`. The picker tool reuses `startBrowserPicker` from `src/picker.ts`. All tools return a friendly "not configured — use `markdown_select_root_folder`" error when `markdown.rootFolderId` is missing.
- **IMP-006**: Success criteria: (a) all five tools are registered and scope-gated, (b) size-limit enforcement is exercised by unit tests on both the download and upload paths, (c) the picker persists the selection without overwriting unrelated config, (d) the mock Graph server models the `/me/drive/...` endpoints sufficiently for full end-to-end integration tests against an in-process MCP client, and (e) the strict file-name rules are enforced at every entry point and tested for all rejection classes (path separators, non-portable characters, control chars, reserved device names, leading-dot/hyphen/underscore, trailing dot/whitespace, length limit, subdirectory entries, and itemId-based access to files with unsafe stored names).

## References

- **REF-001**: [ADR-0001: Minimize Blast Radius for AI Agent Access](./0001-minimize-blast-radius.md) — the overarching security principle that motivates single-folder scoping and the narrow scope selection.
- **REF-002**: [Microsoft Graph — Upload or replace the contents of a driveItem](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content) — the direct `PUT` endpoint used for uploads, including the 4 MiB documented limit.
- **REF-003**: [Microsoft Graph — Upload large files with an upload session](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession) — the session-based protocol deliberately not implemented in this ADR.
- **REF-004**: [Microsoft Graph — driveItem resource type](https://learn.microsoft.com/en-us/graph/api/resources/driveitem) — the shape of the `DriveItem` entities consumed by this module.
- **REF-005**: [Microsoft Graph permissions reference — Files](https://learn.microsoft.com/en-us/graph/permissions-reference#files-permissions) — the set of OneDrive permission variants considered when selecting `Files.ReadWrite`.
