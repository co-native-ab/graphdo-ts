# graphdo-ts

A TypeScript [MCP server](https://modelcontextprotocol.io) that gives AI agents scoped, low-risk access to Microsoft Graph.

The design intentionally minimizes blast radius — agents can only mail _you_, only touch tasks in a single configured list, and never see resources outside the scopes you've granted. Critical decisions like signing in and choosing which list to operate on require a human in the loop via the browser. Using an AI agent is never risk-free, but graphdo-ts is designed to keep the exposure as small as possible while still being useful. Current capabilities cover email and Microsoft To Do; more Graph surfaces will be added over time with the same focus on minimizing risk.

---

## Features

graphdo-ts currently exposes **24 MCP tools**:

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

| Scope             | Purpose                                            |
| ----------------- | -------------------------------------------------- |
| `Mail.Send`       | Send emails as the signed-in user                  |
| `Tasks.ReadWrite` | Read and write the user's Microsoft To Do tasks    |
| `Files.ReadWrite` | Read and write markdown files in a OneDrive folder |
| `User.Read`       | Read the signed-in user's basic profile            |
| `offline_access`  | Enable refresh tokens for persistent sessions      |

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
- 🧑 **Human-in-the-loop** — signing in, selecting which todo list to use, and selecting which OneDrive folder to use all require **human interaction via the browser**. The AI agent cannot perform these actions programmatically.
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
npm run check        # format:check + lint + typecheck + test (all four)
npm run mcpb         # Build + create MCPB bundle
```

### Environment Variables

| Variable               | Description                                                            | Default                                |
| ---------------------- | ---------------------------------------------------------------------- | -------------------------------------- |
| `GRAPHDO_DEBUG`        | Enable debug logging (`true`/`false`)                                  | `false`                                |
| `GRAPHDO_CLIENT_ID`    | Azure AD (Entra ID) application client ID                              | `b073490b-a1a2-4bb8-9d83-00bb5c15fcfd` |
| `GRAPHDO_TENANT_ID`    | Azure AD tenant ID (`common`, `organizations`, `consumers`, or a GUID) | `common`                               |
| `GRAPHDO_CONFIG_DIR`   | Override config directory                                              | OS default                             |
| `GRAPHDO_GRAPH_URL`    | Override Graph API base URL                                            | `https://graph.microsoft.com/v1.0`     |
| `GRAPHDO_ACCESS_TOKEN` | Skip MSAL auth and use a static Bearer token                           | -                                      |

When installed via [MCPB](https://github.com/modelcontextprotocol/mcpb), `GRAPHDO_DEBUG`, `GRAPHDO_CLIENT_ID`, and `GRAPHDO_TENANT_ID` are exposed as configurable settings in the extension UI and automatically passed as environment variables.

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
- **Minimal dependencies** - five runtime deps: `@modelcontextprotocol/sdk`, `zod`, `@azure/msal-node`, `diff`, `open`

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding standards, and PR process.

---

## License

MIT
