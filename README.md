# graphdo-ts

A TypeScript [MCP server](https://modelcontextprotocol.io) that gives AI agents scoped, low-risk access to Microsoft Graph.

The design intentionally minimizes blast radius — agents can only mail _you_, only touch tasks in a single configured list, and never see resources outside the scopes you've granted. Critical decisions like signing in and choosing which list to operate on require a human in the loop via the browser. Using an AI agent is never risk-free, but graphdo-ts is designed to keep the exposure as small as possible while still being useful. Current capabilities cover email and Microsoft To Do; more Graph surfaces will be added over time with the same focus on minimizing risk.

---

## Features

graphdo-ts currently exposes **20 MCP tools**:

| Tool                          | Description                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `login`                       | Authenticate via browser login                                                       |
| `logout`                      | Clear cached tokens and sign out                                                     |
| `auth_status`                 | Check authentication status, current user, and configuration                         |
| `mail_send`                   | Send an email to yourself (from and to your Microsoft account)                       |
| `todo_config`                 | Configure which Microsoft To Do list to use (opens browser for human-only selection) |
| `todo_list`                   | List todos with pagination, filtering, and sorting                                   |
| `todo_show`                   | Show a single todo with full details including checklist steps                       |
| `todo_create`                 | Create a new todo with optional due date, importance, reminder, and recurrence       |
| `todo_update`                 | Update an existing todo (title, body, importance, due date, reminder, recurrence)    |
| `todo_complete`               | Mark a todo as completed                                                             |
| `todo_delete`                 | Delete a todo                                                                        |
| `todo_steps`                  | List all checklist steps (sub-items) within a todo                                   |
| `todo_add_step`               | Add a new checklist step to a todo                                                   |
| `todo_update_step`            | Update a checklist step — rename it, check it off, or uncheck it                     |
| `todo_delete_step`            | Delete a checklist step from a todo                                                  |
| `markdown_select_root_folder` | Configure which OneDrive folder to use for markdown files (human-only selection)     |
| `markdown_list_files`         | List `.md` files in the configured OneDrive folder                                   |
| `markdown_get_file`           | Read a markdown file's content (by drive item ID or file name, max 4 MB)             |
| `markdown_upload_file`        | Create or overwrite a markdown file in the configured folder (max 4 MB)              |
| `markdown_delete_file`        | Delete a markdown file from the configured folder                                    |

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

Before using todo tools, select which Microsoft To Do list to use. Call the `todo_config` tool - it opens a browser window with your available lists. Click the one you want, and the configuration is saved.

**Security:** This is a human-only action. The AI agent cannot programmatically change which list it operates on - only you can make this selection through the browser.

If a browser cannot be opened automatically, the tool displays a URL you can visit manually.

The configuration is stored in the OS config directory:

- **Linux:** `~/.config/graphdo-ts/config.json`
- **macOS:** `~/Library/Application Support/graphdo-ts/config.json`
- **Windows:** `%APPDATA%/graphdo-ts/config.json`

### Markdown Files (OneDrive)

Before using the markdown tools, select which OneDrive folder graphdo should use as the root for markdown files. Call the `markdown_select_root_folder` tool — it opens a browser window listing the top-level folders in your OneDrive. Click the one you want, and the configuration is saved to `markdown.rootFolderId` in `config.json`. Calling the tool again overwrites the selection.

**Security:** This is a human-only action. The AI agent cannot programmatically change which folder it operates on — only you can make this selection via the browser. All markdown tools are confined to the children of that one folder.

Once a root folder is set, four tools operate on `.md` files directly inside it:

- `markdown_list_files` — list the `.md` files, including name, drive item ID, last modified timestamp, and size in bytes.
- `markdown_get_file` — read a file by drive item ID **or** by file name (case-insensitive, must end in `.md`) and return its UTF-8 content.
- `markdown_upload_file` — create or overwrite a file by name using a direct `PUT` to `/content`.
- `markdown_delete_file` — permanently delete a file by drive item ID or name.

**4 MB limit.** `markdown_get_file` and `markdown_upload_file` enforce a hard 4 MB (4,194,304 bytes) limit per request. This is the Microsoft Graph limit for direct content transfers. graphdo-ts deliberately does not support resumable upload sessions — markdown notes are expected to be well under this limit, and avoiding the complexity of session-based uploads keeps the tool surface small. Files over 4 MB return a clear error.

See [ADR-0004: Markdown File Support on OneDrive](./docs/adr/0004-markdown-file-support.md) for the rationale behind the 4 MB limit, the folder picker approach, and the Graph API constraints.

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
Create a list in Microsoft To Do first. Open [to-do.office.com](https://to-do.office.com), create a list, then call `todo_config` again.

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
- **Minimal dependencies** - three runtime deps: `@modelcontextprotocol/sdk`, `zod`, `@azure/msal-node`

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding standards, and PR process.

---

## License

MIT
