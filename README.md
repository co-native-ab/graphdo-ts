# graphdo-ts

A TypeScript [MCP server](https://modelcontextprotocol.io) that gives AI agents scoped, low-risk access to Microsoft Graph.

The design intentionally minimizes blast radius — agents can only mail _you_, only touch tasks in a single configured list, and never see resources outside the scopes you've granted. Critical decisions like signing in and choosing which list to operate on require a human in the loop via the browser. Using an AI agent is never risk-free, but graphdo-ts is designed to keep the exposure as small as possible while still being useful. Current capabilities cover email and Microsoft To Do; more Graph surfaces will be added over time with the same focus on minimizing risk.

---

## Features

graphdo-ts currently exposes **40 MCP tools**:

| Tool                          | Description                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `login`                       | Authenticate via browser login                                                                        |
| `logout`                      | Clear cached tokens and sign out                                                                      |
| `auth_status`                 | Check authentication status, current user, and configuration                                          |
| `mail_send`                   | Send an email to yourself (from and to your Microsoft account)                                        |
| `todo_select_list`            | Select which Microsoft To Do list to use (opens browser for human-only selection)                     |
| `todo_list`                   | List todos with pagination, filtering, and sorting                                                    |
| `todo_show`                   | Show a single todo with full details including checklist steps                                        |
| `todo_create`                 | Create a new todo with optional due date, importance, reminder, and recurrence                        |
| `todo_update`                 | Update an existing todo (title, body, importance, due date, reminder, recurrence)                     |
| `todo_complete`               | Mark a todo as completed                                                                              |
| `todo_delete`                 | Delete a todo                                                                                         |
| `todo_steps`                  | List all checklist steps (sub-items) within a todo                                                    |
| `todo_add_step`               | Add a new checklist step to a todo                                                                    |
| `todo_update_step`            | Update a checklist step — rename it, check it off, or uncheck it                                      |
| `todo_delete_step`            | Delete a checklist step from a todo                                                                   |
| `markdown_select_root_folder` | Select which folder to use for markdown files in the signed-in user's OneDrive (human-only selection) |
| `markdown_list_files`         | List `.md` files in the configured folder; subdirectories and bad-name files appear as UNSUPPORTED    |
| `markdown_get_file`           | Read a markdown file's current content, cTag, and Revision (by file ID or strict-validated name)      |
| `markdown_create_file`        | Create a new markdown file — fails with a clear error if a file with that name already exists         |
| `markdown_update_file`        | Overwrite an existing markdown file using `If-Match` cTag for safe optimistic concurrency             |
| `markdown_delete_file`        | Delete a markdown file from the configured folder                                                     |
| `markdown_list_file_versions` | List historical versions that OneDrive retained for a markdown file (newest first)                    |
| `markdown_get_file_version`   | Read the UTF-8 content of a specific prior version of a markdown file                                 |
| `markdown_diff_file_versions` | Compute a unified diff between two revisions of a markdown file server-side (via jsdiff)              |
| `markdown_preview_file`       | Open a markdown file in the user's browser using the SharePoint OneDrive web preview                  |
| `session_init_project`        | Start a new collaboration project in a OneDrive folder (originator; opens browser pickers)            |
| `session_open_project`        | Join an existing collaboration project as a collaborator (opens browser form: recents / shared / URL) |
| `session_status`              | Report active session, agent identity, TTL, and write / destructive / renewal counters (read-only)    |
| `session_renew`               | Reset the session TTL via a browser approval form (per-session and per-window caps)                   |
| `session_recover_doc_id`      | Recover the project's `doc_id` from `/versions` history when both live + cached copies are gone       |
| `collab_read`                 | Read a file in the active project's scope (path or itemId); authoritative file returns frontmatter    |
| `collab_list_files`           | List project files grouped into ROOT / PROPOSALS / DRAFTS / ATTACHMENTS (attachments is recursive)    |
| `collab_write`                | Create or update a project file with optimistic concurrency; canonical frontmatter on the auth file   |
| `collab_create_proposal`      | Propose a replacement body for one section without overwriting the authoritative file                 |
| `collab_apply_proposal`       | Merge a proposal into the authoritative file (destructive applies open a browser re-approval form)    |
| `collab_acquire_section`      | Lease a section heading so cooperating agents avoid concurrent writes (free; section-slug identity)   |
| `collab_release_section`      | Release a previously-acquired section lease (free; refuses to release another agent's lease)          |
| `collab_list_versions`        | List historical versions of a project file (defaults to the authoritative file)                       |
| `collab_restore_version`      | Roll a project file back to a previous revision (destructive when the target is the authoritative)    |
| `collab_delete_file`          | Permanently delete a non-authoritative project file (always opens a browser re-approval form)         |

---

## Installation

graphdo-ts is distributed in three formats:

### MCPB Bundle (Recommended for Claude Desktop)

The [MCPB](https://github.com/modelcontextprotocol/mcpb) bundle is self-contained — it includes the server and a bundled Node.js runtime. No separate Node.js installation required.

Download the latest `.mcpb` file from [GitHub Releases](https://github.com/co-native-ab/graphdo-ts/releases/latest).

**Claude Desktop:** Double-click the `.mcpb` file, or open Claude Desktop → **Settings** → **Extensions** → **Install Extension** and select the file.

After installation, graphdo appears in your extensions list. You can configure optional settings (debug logging, custom client ID, tenant ID) through the extension settings UI.

### npm (Recommended for other MCP clients)

Requires [Node.js](https://nodejs.org/) 22 or later.

```bash
npx @co-native-ab/graphdo-ts
```

Configure in your MCP client:

```json
{
  "command": "npx",
  "args": ["@co-native-ab/graphdo-ts"]
}
```

### Standalone JS Bundle

Download `graphdo-ts-vX.Y.Z.js` from [GitHub Releases](https://github.com/co-native-ab/graphdo-ts/releases/latest) and run directly with Node.js:

```bash
node graphdo-ts-vX.Y.Z.js
```

---

## Authentication

graphdo-ts uses MSAL to authenticate with Microsoft. When the agent calls the `login` tool:

1. The tool opens **interactive browser login** - your default browser navigates to Microsoft's sign-in page
2. You authenticate in the browser, which redirects to a local server that captures the auth code
3. Login completes immediately - no manual code entry needed

If a browser cannot be opened automatically, the tool returns the login URL as an error message. You can copy and paste this URL into any browser to complete authentication.

When you use the `logout` tool, cached tokens are cleared and a confirmation page opens in the browser.

Use the `auth_status` tool to check whether you are logged in and see the current user and configuration.

Tokens are automatically refreshed using the cached refresh token. To sign out and clear cached tokens, use the `logout` tool.

The Azure AD client ID (`b073490b-a1a2-4bb8-9d83-00bb5c15fcfd`) is built into the server. No client-side configuration is needed unless your organization uses a custom app registration. If you need to use your own app registration, set `GRAPHDO_CLIENT_ID` and optionally `GRAPHDO_TENANT_ID` (see [Environment Variables](#environment-variables)). When installed via MCPB, these can also be configured through the extension settings UI.

### Required Scopes

These scopes reflect the current set of capabilities. Additional scopes may be required as new Graph surfaces are added.

| Scope             | Purpose                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `Mail.Send`       | Send emails as the signed-in user                                  |
| `Tasks.ReadWrite` | Read and write the user's Microsoft To Do tasks                    |
| `Files.ReadWrite` | Read and write markdown files and collab project files in OneDrive |
| `User.Read`       | Read the signed-in user's basic profile                            |
| `offline_access`  | Enable refresh tokens for persistent sessions                      |

### Todo List Selection

Before using todo tools, select which Microsoft To Do list to use. Call the `todo_select_list` tool - it opens a browser window with your available lists. The picker provides a filter/search box, a refresh button (useful after you create a new list), and a link to open Microsoft To Do in a new tab so you can create a new list without leaving the flow. Click the one you want, and the configuration is saved.

**Security:** This is a human-only action. The AI agent cannot programmatically change which list it operates on - only you can make this selection through the browser.

If a browser cannot be opened automatically, the tool displays a URL you can visit manually.

The configuration is stored in the OS config directory:

- **Linux:** `~/.config/graphdo-ts/config.json`
- **macOS:** `~/Library/Application Support/graphdo-ts/config.json`
- **Windows:** `%APPDATA%/graphdo-ts/config.json`

### Markdown Files

Before using the markdown tools, select which folder graphdo should use as the root for markdown files. Call the `markdown_select_root_folder` tool — it opens a browser window listing the top-level folders available. The picker supports:

- a filter/search box so you can narrow large folder lists quickly,
- a refresh button that re-fetches the list (useful after you create a new folder),
- a link to open OneDrive in a new tab so you can create a new top-level folder without leaving the flow.

Click the folder you want, and the configuration is saved to `markdown.rootFolderId` in `config.json`. Calling the tool again overwrites the selection. (Under the hood, the storage is a OneDrive folder accessed via Microsoft Graph — see [ADR-0004](./docs/adr/0004-markdown-file-support.md).)

**Security:** This is a human-only action. The AI agent cannot programmatically change which folder it operates on — only you can make this selection via the browser. All markdown tools are confined to the children of that one folder. If `markdown.rootFolderId` is missing, empty, `/`, or contains any path separator or whitespace (e.g. someone edits `config.json` by hand), every markdown tool refuses to run and directs you back to `markdown_select_root_folder`. The root is always a single top-level folder — never the drive root, never a subdirectory.

Once a root folder is set, the markdown tools operate on `.md` files directly inside it:

- `markdown_list_files` — list the supported `.md` files (name, file ID, last modified timestamp, size in bytes). Subdirectories and `.md` files whose names violate the strict naming rules are reported alongside as `UNSUPPORTED`, so the agent knows they exist but cannot operate on them.
- `markdown_get_file` — read a file by file ID **or** by file name (strict naming rules apply) and return its UTF-8 content along with the current `cTag` and a `Revision` ID. The cTag is OneDrive's content-only entity tag — it is what `markdown_update_file` uses for safe concurrency, and because it bumps only on content changes (not on rename, share, indexing, or preview generation) it does not trigger spurious 412s. The Revision ID is an opaque identifier that lines up with the IDs returned by `markdown_list_file_versions` so the same value can be passed to `markdown_diff_file_versions`.
- `markdown_create_file` — create a new file by name. Fails with a clear error if a file with the same name already exists in the folder. Uses OneDrive's `@microsoft.graph.conflictBehavior=fail` so the distinction from update is server-enforced, not just a client-side check.
- `markdown_update_file` — overwrite an existing file. Requires the `cTag` previously returned by `markdown_get_file` (or `markdown_create_file` / `markdown_update_file`). The update is sent with an `If-Match` header carrying the cTag and succeeds only when the supplied cTag matches the file's current cTag. Because cTag is content-only, unrelated metadata changes (rename, share, indexing, preview generation) do not invalidate it. If the file's content has changed since you last read it, the call fails with structured reconcile guidance: the error includes the new `Current Revision` and points the agent straight at `markdown_diff_file_versions` (so the agent does not have to diff by hand) to compute a unified diff between the revision originally read and the current revision. The agent then re-reads, reconciles, and calls update again — or asks the user how to proceed when the intent no longer fits.
- `markdown_delete_file` — permanently delete a file by file ID or name.
- `markdown_list_file_versions` — list the historical versions OneDrive retained for a file (newest first). OneDrive automatically snapshots prior content whenever a file is overwritten; this tool surfaces that history with each version's opaque ID, timestamp, size, and — when available — the name of the user who last modified it.
- `markdown_get_file_version` — read the UTF-8 content of a specific prior version returned by `markdown_list_file_versions`. This is read-only; it does _not_ restore the file. To promote an older version back to current, pass its content to `markdown_update_file`.
- `markdown_diff_file_versions` — return a unified diff between any two revisions of a file, computed server-side using `jsdiff`. Each of `fromVersionId` / `toVersionId` can be either a historical version ID from `markdown_list_file_versions` or the current Revision from `markdown_get_file` / `markdown_create_file` / `markdown_update_file` (including the `Current Revision` reported in a cTag-mismatch error).
- `markdown_preview_file` — open a markdown file in the user's default browser using SharePoint's web preview (the `/my?id=…&parent=…` deep-link), which renders the markdown nicely instead of triggering a download. The preview URL is constructed from the drive's `webUrl` plus the file's parent path, so it always lands on the user's own OneDrive (work / school / sovereign) — no hardcoded host. The URL is also returned as text so the agent can re-share it. Consumer OneDrive (`onedrive.live.com`) uses a different URL scheme that this tool does not implement and is rejected with a clear error.

#### Strict file-name rules

All markdown tool calls that accept a file name enforce a strict, cross-OS-safe naming rule. The goal is to make sure the agent can never create subdirectories, never use characters that only work on some operating systems, and never overwrite files whose names only _look_ like markdown files.

A file name is accepted **only when all of the following hold:**

- Ends in `.md` (case-insensitive).
- Contains only letters (A–Z, a–z), digits, space, dot (`.`), underscore (`_`), and hyphen (`-`).
- Starts with a letter or digit (no leading dot, space, or hyphen).
- Does not contain path separators (`/`, `\`) or any subdirectory segments.
- Does not contain control characters.
- Is not a Windows reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`, `LPT0`–`LPT9`).
- Has no leading or trailing whitespace, and no trailing dot before `.md`.
- Is no longer than 255 characters.

Requests with invalid names are rejected with a clear error that states which rule was violated. This enforcement applies to every markdown tool that accepts a file name (`markdown_create_file`, `markdown_update_file`, `markdown_get_file`, `markdown_delete_file`, `markdown_list_file_versions`, `markdown_get_file_version`, `markdown_diff_file_versions`) — both at the MCP schema layer (before the handler runs) and again after resolving drive item IDs, so a file whose stored remote name is unsupported also cannot be operated on.

**4 MiB size cap (tool-side policy).** `markdown_get_file`, `markdown_create_file`, `markdown_update_file`, `markdown_get_file_version`, and `markdown_diff_file_versions` enforce a hard 4 MiB (4,194,304 bytes) cap per file. **This is a graphdo-ts policy limit, not a Microsoft Graph limit** — Microsoft Graph's `/content` endpoint accepts simple PUT uploads up to 250 MB ([driveItem: PUT content](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0&tabs=http)) and resumable upload sessions extend that further. The cap exists to keep the markdown surface focused on hand-written notes and small documents rather than bulk file storage, and to keep agent payloads bounded. The limit is a single constant (`MAX_DIRECT_CONTENT_BYTES` in `src/graph/markdown.ts`) and can be raised in the future if a concrete need appears; until then, it is intentionally conservative. Files over 4 MiB return a clear error explaining the cap.

See [ADR-0004: Markdown File Support on OneDrive](./docs/adr/0004-markdown-file-support.md) for the rationale behind the 4 MiB cap, the folder picker approach, the Graph API constraints, and the strict file-name rules.

### Collaborative Editing (Collab v1)

Collab v1 lets one or more AI agents and humans cooperate on a structured project folder in OneDrive. The design extends the same blast-radius philosophy from the markdown tools — **scoped access, human-in-the-loop for anything destructive, every approval recorded** — into a multi-agent workflow with explicit budgets, optimistic concurrency, and an append-only audit trail.

**A collab project is a OneDrive folder containing:**

- Exactly one **authoritative `.md` file** at the root — the document everyone is editing.
- A `.collab/` sentinel folder with a `project.json` (binds the project to a stable id, the authoritative file, the originator, and the schema version) and a lazily-created `leases.json` (per-section advisory leases).
- Optional sub-folders the agent may write to: `proposals/`, `drafts/`, `attachments/`.

Agents can only operate inside this folder. The `.collab/` sentinel folder is **never writable from collab tools** — it is managed by graphdo-ts itself.

#### Starting and joining a project

There are two entry points, both human-driven through the browser:

- **`session_init_project`** — call this as the **originator**. Two browser pickers run back-to-back: pick the OneDrive folder, then pick the authoritative `.md` (auto-confirmed when only one root `.md` is present). graphdo-ts writes the `.collab/project.json` sentinel and activates a session.
- **`session_open_project`** — call this as a **collaborator**. One browser form with three entry points: recents (projects you have opened before), "shared with me" (folders shared into your OneDrive), or paste a OneDrive share URL. graphdo-ts reads the sentinel, validates write access, pins the authoritative file id on first open, and verifies the pin on every subsequent open (so a swapped or renamed authoritative file is detected and refused).

Use `session_status` at any time to see the active project, current TTL, and remaining budgets. The agent does not pick a project — only the human does.

#### Sessions, budgets, and renewal

Every session carries three explicit limits to bound how much an agent can do without checking back in with the human:

- **Write budget** (default 50 writes per session) — every `collab_write`, proposal write, apply, restore, and delete counts. `collab_read`, `collab_list_files`, `collab_list_versions`, `session_status`, and the lease tools are **free**.
- **Destructive-approval budget** (default 10 per session) — counts only when an action overwrites another author's section, restores an old version, or deletes a file. The destructive counter is **persisted across renewals** in `<configDir>/sessions/destructive-counts.json` so it survives a restart.
- **TTL** (default 2h) — past TTL, every collab tool reports the session as expired and the agent must call **`session_renew`**.

`session_renew` opens a browser approval form. On approve, `expiresAt` is reset to now + the original TTL; counters are preserved. Renewal is itself rate-limited: **max 3 renewals per session** and **max 6 renewals per user per project per rolling 24-hour window** (the sliding window is persisted in `<configDir>/sessions/renewal-counts.json`).

#### Authoritative-file frontmatter (and what to do if you reformat it)

The authoritative `.md` file always carries a YAML `collab:` block at the top:

```markdown
---
collab:
  doc_id: 01J... # stable ULID for this document
  schema: 1
  proposals: [] # open / applied proposals
  authorship: [] # per-section author trail
---

# Document body starts here…
```

graphdo-ts treats the `collab:` block as machine-managed. The body underneath is yours.

> **Frontmatter reformat note.** It is safe to reformat or even delete the `collab:` block by hand in OneDrive web, VS Code, or any editor. The next `collab_write` will:
>
> - re-inject a canonical, deterministically-emitted YAML block (so byte-exact diffs stay clean across writes),
> - recover the `doc_id` from the **local project metadata cache** when you stripped it,
> - emit a `frontmatter_reset` audit entry recording what happened.
>
> If both the live frontmatter and your local cache are gone (e.g. you started on a fresh machine and a co-author wiped the YAML in OneDrive web), call **`session_recover_doc_id`**. It walks the authoritative file's `/versions` history newest-first (capped at 50 versions) and writes the first recoverable `doc_id` back to the local cache. No body change, no `restoreVersion` call, and no budget cost. If no historical version yields a parseable `doc_id`, it errors with `DocIdUnrecoverableError` and you can either decide to mint a fresh id (next write) or restore an older version manually.

#### Read, list, write

- **`collab_read`** — read any file in scope by `path` (e.g. `spec.md`, `proposals/foo.md`, `attachments/diagram.png`) or by `itemId`. The authoritative file returns parsed frontmatter + body separately, plus the cTag you'll need for the next write.
- **`collab_list_files`** — list project files grouped into **ROOT** (top-level files), **PROPOSALS** (`proposals/*.md`), **DRAFTS** (`drafts/*.md`), and **ATTACHMENTS**. The authoritative file is marked `[authoritative]`. The total is capped at 500 entries; on overflow the response shows which groups were truncated.
  - **Attachments are listed recursively.** Unlike `proposals/` and `drafts/` (which are flat by design), `attachments/` is treated as a junk drawer for arbitrary files and sub-folders — so `collab_list_files` walks the tree under `attachments/` and reports every nested file with its full scope-relative path. Scope enforcement still applies: nothing outside `attachments/` (and outside the project folder) is ever readable or writable.
- **`collab_write`** — create or update a file in scope. Pass `content` (UTF-8, ≤ 4 MiB) and `source`:
  - `chat` — the human just typed it,
  - `project` — you read it via `collab_read` in this same session,
  - `external` — anything else (web fetch, another file, paste from clipboard). `source: "external"` **always** opens a browser re-approval form before any Graph round-trip; cancel returns `ExternalSourceDeclinedError` and nothing is written.

  For existing files supply the `cTag` from `collab_read` — graphdo-ts uses an `If-Match` header so concurrent edits raise `CollabCTagMismatchError` instead of silently overwriting. Use `conflictMode: "proposal"` to divert a cTag mismatch into a proposal write instead of failing.

#### Proposals (cross-author edits)

When you want to change a section that has prior history from a human or a different agent, write a **proposal** instead of overwriting:

- **`collab_create_proposal`** — writes the proposed body to `/proposals/<ulid>.md` and records a `proposals[]` entry in the authoritative frontmatter. The entry pins both the target section's slug (e.g. `## Introduction` → `introduction`) **and** a hash of the section's content at create time, so a heading rename between create and apply is recovered automatically.
- **`collab_apply_proposal`** — locates the target section by slug first, falling back to the content hash. Consults the `authorship[]` trail to decide whether the apply is destructive — if any prior author of that section is a human or a different agent, a browser **re-approval form is opened showing a unified diff** of the proposed change. On approve, the section body is replaced, an `authorship[]` entry is appended, and the matching `proposals[]` entry is marked `applied`; the file is CAS-written with the supplied `authoritativeCTag`.

#### Section leases (cooperating agents)

`.collab/leases.json` is a sidecar JSON file holding per-section advisory leases. It is created lazily on first `collab_acquire_section`, capped at 64 KB, and updated via cTag-protected CAS writes. Leases are **free** — they never cost write or destructive budget.

- **`collab_acquire_section`** — reserve a section heading (`## Introduction`) so cooperating agents don't both write to it concurrently. Refuses with `SectionAlreadyLeasedError` (carrying the holder + expiry) when another agent holds it.
- **`collab_release_section`** — release a lease you hold. No-op when the lease is already absent; refuses to release somebody else's lease.

`session_status` reports the current `leasesCTag` — pass it to acquire/release for the CAS replace. A stale cTag raises `CollabCTagMismatchError`; re-read and retry.

Leases are **advisory** — they do not block `collab_write`. They are a coordination signal between cooperating agents that respect them. Humans editing in OneDrive web are unaffected.

#### Versions, restore, delete

- **`collab_list_versions`** — list a file's `/versions` history, newest first. Defaults to the authoritative file. Read-only and free.
- **`collab_restore_version`** — roll a file back to a previous revision via OneDrive's `restoreVersion` API. When the target is the authoritative file the restore is destructive and a re-approval form opens with a unified diff between the current and the target revision. Counts as 1 write always; +1 destructive only when the target is the authoritative file. Requires `authoritativeCTag` on the auth path for safety.
- **`collab_delete_file`** — permanently delete a non-authoritative project file. **Always destructive** — a re-approval form opens for every call, the destructive budget is decremented on approve. The authoritative `.md` file and the `.collab/` sentinel folder are always refused.

#### Audit log

Every session start, every approval form (Approved or Cancelled), every `frontmatter_reset`, every renewal, every successful tool call, and every `agent_name_unknown` event is appended to a per-project audit log under `<configDir>/projects/<projectId>/audit.log`. Writes are best-effort `O_APPEND` (so concurrent agents can append without coordination), each envelope is capped at 4096 bytes (with redaction cascade if necessary), and Bearer tokens are rejected at the codec layer. Diffs are recorded by SHA-256 hash, never as the raw body.

#### Storage layout

| Where                                               | What                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `<projectFolder>/.collab/project.json` (OneDrive)   | Sentinel: project id, schema, originator, authoritative file id (the "pin")            |
| `<projectFolder>/.collab/leases.json` (OneDrive)    | Advisory section leases (lazily created, 64 KB cap, cTag-CAS)                          |
| `<projectFolder>/<authoritativeFile>.md` (OneDrive) | The document, with the canonical `collab:` YAML frontmatter block                      |
| `<configDir>/projects/<projectId>.json`             | Per-project metadata cache (recovered `doc_id`, last-seen authoritative cTag/revision) |
| `<configDir>/projects/recent.json`                  | Recently-opened projects, surfaced in the `session_open_project` browser form          |
| `<configDir>/projects/<projectId>/audit.log`        | Append-only audit envelopes                                                            |
| `<configDir>/sessions/destructive-counts.json`      | Persisted destructive-approval counters (survive restart, lazy-pruned after 24h)       |
| `<configDir>/sessions/renewal-counts.json`          | Sliding 24-hour renewal window counters per `(userOid, projectId)`                     |

See `docs/plans/collab-v1.md` for the full design and ADRs 0005–0008 for locked decisions (decision log, `userOid` derivation, validated Graph IDs, frontmatter codec).

---

## Organization Setup

> **Personal Microsoft accounts** (like @outlook.com or @hotmail.com) can skip this section entirely. This is only relevant for work or school accounts managed by an organization.

### For regular users

When you first use the `login` tool, Microsoft may tell you that you need admin approval. This means your IT administrator needs to grant graphdo-ts permission to access your email and tasks on behalf of your organization.

**What to tell your IT admin:**

> "I'd like to use an AI tool called graphdo-ts that helps me send emails to myself, manage my todo list, and manage markdown notes in OneDrive. It needs admin consent for the following **delegated** permissions: User.Read, Mail.Send, Tasks.ReadWrite, Files.ReadWrite, and offline_access. The application ID is `b073490b-a1a2-4bb8-9d83-00bb5c15fcfd` and it's published by Co-native AB."

### For IT administrators

graphdo-ts uses a multi-tenant application published by Co-native AB. To grant consent for your organization:

1. Go to the [Azure Portal](https://portal.azure.com) → **Microsoft Entra ID** → **Enterprise applications**.
2. Click **New application** → **All applications** → search for the application ID: `b073490b-a1a2-4bb8-9d83-00bb5c15fcfd`.
3. If the app doesn't appear, a user can trigger the consent flow by calling the `login` tool — this will create a service principal in your tenant.
4. Go to **Permissions** and click **Grant admin consent for [your organization]**.
5. Review and approve the following delegated permissions:

   | Permission        | Type      | Description                                                                  |
   | ----------------- | --------- | ---------------------------------------------------------------------------- |
   | `User.Read`       | Delegated | Read the signed-in user's basic profile                                      |
   | `Mail.Send`       | Delegated | Send mail as the signed-in user                                              |
   | `Tasks.ReadWrite` | Delegated | Read and write the signed-in user's tasks                                    |
   | `Files.ReadWrite` | Delegated | Read and write the signed-in user's OneDrive files                           |
   | `offline_access`  | Delegated | Maintain access to data you have given it access to (enables refresh tokens) |

6. Once consent is granted, all users in your organization can use the `login` tool without further approval.

**Security — minimizing blast radius:**

graphdo-ts is designed to keep AI agent access as limited as possible while still being useful. Using an AI agent with access to your Microsoft account is never risk-free, but the following measures minimize the exposure:

- **Scoped permissions** — only delegated permissions are used (User.Read, Mail.Send, Tasks.ReadWrite, Files.ReadWrite, offline_access). The agent acts as the signed-in user, never as an application with broader access.
- **Email to self only** — the agent can only send emails to the signed-in user themselves, not to other recipients.
- **Single todo list** — the agent can only access tasks in one specific list, chosen by you.
- **Single markdown folder** — the agent can only read and write `.md` files in one OneDrive folder, chosen by you.
- **Human-in-the-loop for critical decisions** — signing in, selecting which todo list to use, and selecting which OneDrive folder to use all require human interaction via the browser. The AI agent cannot perform these actions programmatically.
- **Open source** — the source code is available at [github.com/co-native-ab/graphdo-ts](https://github.com/co-native-ab/graphdo-ts) for review.

As new Graph surfaces are added, the same principle applies: minimize blast radius, require human confirmation for sensitive operations, and request only the scopes that are strictly needed.

---

## Troubleshooting

**"I need admin approval"**
Your organization's IT administrator needs to approve graphdo-ts. See [Organization Setup](#organization-setup) for what to tell them.

**"No todo lists found"**
Create a list in Microsoft To Do first. Open [to-do.office.com/tasks/](https://to-do.office.com/tasks/), create a list, then call `todo_select_list` again.

**"The browser didn't open"**
The `login` tool will return the login URL in its error message. Copy and paste the URL into your browser to complete authentication.

---

## Privacy & Security

graphdo-ts is designed around the principle of **minimizing blast radius** — keeping AI agent access as narrow as possible while still enabling useful work. Using an AI agent is never risk-free, but the following measures reduce the exposure:

- 🔒 **Scoped access** — graphdo-ts only accesses **your own** email and tasks. It cannot access anyone else's data.
- 📧 **Email to self only** — the agent can **only send emails to yourself**. It cannot send to other recipients.
- 📋 **Single todo list** — the agent operates on **one specific list** that you choose via the browser. It cannot switch lists on its own.
- 📝 **Single markdown folder** — the agent operates on **one OneDrive folder** that you choose via the browser. It cannot switch folders on its own.
- 🤝 **Scoped collab projects** — collab tools operate on **one project folder at a time**, chosen via the browser. The `.collab/` sentinel folder is never writable from collab tools, the authoritative file is pinned by item id (a swap or rename is detected), and every destructive change opens a browser re-approval form showing a unified diff before any write.
- 💸 **Bounded budgets** — every collab session has an explicit write budget, destructive-approval budget, and TTL. Renewing the TTL itself opens a browser approval form and is rate-limited per session and per rolling 24-hour window.
- 🧑 **Human-in-the-loop** — signing in, selecting which todo list to use, selecting which OneDrive folder to use, opening or creating a collab project, renewing a session, approving any destructive collab action, and accepting any `external` content for collab writes all require **human interaction via the browser**. The AI agent cannot perform these actions programmatically.
- 📜 **Audited** — every collab session start, approval form (Approved or Cancelled), renewal, and successful tool call is appended to a local per-project audit log.
- 💻 **Local credentials** — your login credentials are cached **locally on your computer** and nowhere else.
- 🌐 **Microsoft only** — no data is sent anywhere except to **Microsoft's official servers** (the same ones Outlook and To Do use).
- 📖 **Open source** — the source code is **fully open** at [github.com/co-native-ab/graphdo-ts](https://github.com/co-native-ab/graphdo-ts) — anyone can review exactly what it does.

As new capabilities are added, the same principle applies: minimize blast radius, require human confirmation for sensitive operations, and request only the permissions that are strictly needed.

---

## Development

### Prerequisites

- Node.js 22+

### Setup

```bash
git clone https://github.com/co-native-ab/graphdo-ts.git
cd graphdo-ts
npm install
```

### Scripts

```bash
npm run build        # Build with esbuild (dist/index.js)
npm run lint         # ESLint (strict + stylistic)
npm run typecheck    # tsc --noEmit
npm run test         # Run tests via vitest
npm run format       # Format code with Prettier
npm run format:check # Check formatting without writing
npm run check        # format:check + icons:check + lint + typecheck + test (all five)
npm run mcpb         # Build + create MCPB bundle
```

### Environment Variables

| Variable                | Description                                                                                                       | Default                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `GRAPHDO_DEBUG`         | Enable debug logging (`true`/`false`)                                                                             | `false`                                |
| `GRAPHDO_CLIENT_ID`     | Azure AD (Entra ID) application client ID                                                                         | `b073490b-a1a2-4bb8-9d83-00bb5c15fcfd` |
| `GRAPHDO_TENANT_ID`     | Azure AD tenant ID (`common`, `organizations`, `consumers`, or a GUID)                                            | `common`                               |
| `GRAPHDO_CONFIG_DIR`    | Override config directory                                                                                         | OS default                             |
| `GRAPHDO_GRAPH_URL`     | Override Graph API base URL                                                                                       | `https://graph.microsoft.com/v1.0`     |
| `GRAPHDO_ACCESS_TOKEN`  | Skip MSAL auth and use a static Bearer token                                                                      | -                                      |
| `GRAPHDO_AGENT_PERSONA` | **Test-only** persona override label for collab (`^persona:[a-z0-9-]{1,32}$`). See "Running two instances" below. | unset                                  |

When installed via [MCPB](https://github.com/modelcontextprotocol/mcpb), `GRAPHDO_DEBUG`, `GRAPHDO_CLIENT_ID`, and `GRAPHDO_TENANT_ID` are exposed as configurable settings in the extension UI and automatically passed as environment variables.

### Running two instances (smoke test)

You can configure two graphdo-ts MCP server instances on the same
machine, both authenticated as the same Microsoft user, and have
collab treat them as **two distinct collaborators** for authorship,
leases, audit, and destructive re-prompts. This is the supported way
to drive the multi-agent collab paths end-to-end on a single machine.

Each instance MUST get its own `GRAPHDO_CONFIG_DIR` (the MSAL token
cache, destructive-counts sidecar, and project metadata files cannot
be shared — a startup lock-file refuses sharing). Each instance also
needs a distinct `GRAPHDO_AGENT_PERSONA` label, e.g.:

```bash
mkdir -p ~/.graphdo-personas/alice ~/.graphdo-personas/bob
GRAPHDO_CONFIG_DIR=~/.graphdo-personas/alice GRAPHDO_AGENT_PERSONA=persona:alice npx @co-native-ab/graphdo-ts &
GRAPHDO_CONFIG_DIR=~/.graphdo-personas/bob   GRAPHDO_AGENT_PERSONA=persona:bob   npx @co-native-ab/graphdo-ts &
```

The persona label changes how collab identifies the instance — it does
**not** change which Microsoft user is authenticated. Both instances
still log in as you; Microsoft Graph attributes every actual write to
your real account. See
[`docs/adr/0009-test-persona-override.md`](docs/adr/0009-test-persona-override.md)
for the full threat model.

For a turn-key Copilot CLI playbook that drives the full multi-agent
collab surface end-to-end (10 scenarios, ~13 yellow human-input
checkpoints, ~30 minutes wall time), see
[`docs/plans/two-instance-e2e.md`](docs/plans/two-instance-e2e.md).

---

## Architecture

```
Claude Desktop / MCP Client
  │
  │  stdio (JSON-RPC)
  ▼
MCP Server (StdioServerTransport)
  │
  ├─── MSAL Auth (browser-only) ──→ Azure AD
  │
  ├─── Graph Client (native fetch)
  │         │
  │         │  Bearer token
  │         ▼
  │    Microsoft Graph API (v1.0)
  │
  └─── Config (OS config dir)
```

- **Stdio transport** - communicates via stdin/stdout JSON-RPC (designed for MCPB)
- **MSAL authentication** - interactive browser login only, tokens cached locally
- **Graph client** - lightweight wrapper around `fetch` (no Microsoft Graph SDK)
- **Minimal dependencies** - three runtime deps: `@modelcontextprotocol/sdk`, `zod`, `@azure/msal-node`

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding standards, and PR process.

---

## License

MIT
