# graphdo-ts

A TypeScript [MCP server](https://modelcontextprotocol.io) that gives AI agents scoped, low-risk access to Microsoft Graph.

The design intentionally minimizes blast radius — agents can only mail _you_, only touch tasks in a single configured list, and never see resources outside the scopes you've granted. Critical decisions like signing in and choosing which list to operate on require a human in the loop via the browser. Using an AI agent is never risk-free, but graphdo-ts is designed to keep the exposure as small as possible while still being useful. Current capabilities cover email and Microsoft To Do; more Graph surfaces will be added over time with the same focus on minimizing risk.

---

## Features

graphdo-ts currently exposes **15 MCP tools**:

| Tool               | Description                                                                          |
| ------------------ | ------------------------------------------------------------------------------------ |
| `login`            | Authenticate via browser login                                                       |
| `logout`           | Clear cached tokens and sign out                                                     |
| `auth_status`      | Check authentication status, current user, and configuration                         |
| `mail_send`        | Send an email to yourself (from and to your Microsoft account)                       |
| `todo_config`      | Configure which Microsoft To Do list to use (opens browser for human-only selection) |
| `todo_list`        | List todos with pagination, filtering, and sorting                                   |
| `todo_show`        | Show a single todo with full details including checklist steps                       |
| `todo_create`      | Create a new todo with optional due date, importance, reminder, and recurrence       |
| `todo_update`      | Update an existing todo (title, body, importance, due date, reminder, recurrence)    |
| `todo_complete`    | Mark a todo as completed                                                             |
| `todo_delete`      | Delete a todo                                                                        |
| `todo_steps`       | List all checklist steps (sub-items) within a todo                                   |
| `todo_add_step`    | Add a new checklist step to a todo                                                   |
| `todo_update_step` | Update a checklist step — rename it, check it off, or uncheck it                     |
| `todo_delete_step` | Delete a checklist step from a todo                                                  |

---

## Installation

graphdo-ts is distributed as an [MCPB](https://github.com/modelcontextprotocol/mcpb) bundle - a self-contained package that includes the server and a bundled Node.js runtime. No separate Node.js installation required.

### Download

Download the latest MCPB bundle from [GitHub Releases](https://github.com/co-native-ab/graphdo-ts/releases/latest).

### Claude Desktop

Install the bundle using one of these methods:

1. **Double-click** the downloaded `.mcpb` file — Claude Desktop will open and install it automatically.
2. **Or** open Claude Desktop → **Settings** → **Extensions** → **Install Extension**, then select the `.mcpb` file.

After installation, graphdo appears in your extensions list. You can configure optional settings (debug logging, custom client ID, tenant ID) through the extension settings UI.

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

| Scope             | Purpose                                         |
| ----------------- | ----------------------------------------------- |
| `Mail.Send`       | Send emails as the signed-in user               |
| `Tasks.ReadWrite` | Read and write the user's Microsoft To Do tasks |
| `User.Read`       | Read the signed-in user's basic profile         |
| `offline_access`  | Enable refresh tokens for persistent sessions   |

### Todo List Selection

Before using todo tools, select which Microsoft To Do list to use. Call the `todo_config` tool - it opens a browser window with your available lists. Click the one you want, and the configuration is saved.

**Security:** This is a human-only action. The AI agent cannot programmatically change which list it operates on - only you can make this selection through the browser.

If a browser cannot be opened automatically, the tool displays a URL you can visit manually.

The configuration is stored in the OS config directory:

- **Linux:** `~/.config/graphdo-ts/config.json`
- **macOS:** `~/Library/Application Support/graphdo-ts/config.json`
- **Windows:** `%APPDATA%/graphdo-ts/config.json`

---

## Organization Setup

> **Personal Microsoft accounts** (like @outlook.com or @hotmail.com) can skip this section entirely. This is only relevant for work or school accounts managed by an organization.

### For regular users

When you first use the `login` tool, Microsoft may tell you that you need admin approval. This means your IT administrator needs to grant graphdo-ts permission to access your email and tasks on behalf of your organization.

**What to tell your IT admin:**

> "I'd like to use an AI tool called graphdo-ts that helps me send emails to myself and manage my todo list. It needs admin consent for the following **delegated** permissions: User.Read, Mail.Send, Tasks.ReadWrite, and offline_access. The application ID is `b073490b-a1a2-4bb8-9d83-00bb5c15fcfd` and it's published by Co-native AB."

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
   | `offline_access`  | Delegated | Maintain access to data you have given it access to (enables refresh tokens) |

6. Once consent is granted, all users in your organization can use the `login` tool without further approval.

**Security — minimizing blast radius:**

graphdo-ts is designed to keep AI agent access as limited as possible while still being useful. Using an AI agent with access to your Microsoft account is never risk-free, but the following measures minimize the exposure:

- **Scoped permissions** — only delegated permissions are used (User.Read, Mail.Send, Tasks.ReadWrite, offline_access). The agent acts as the signed-in user, never as an application with broader access.
- **Email to self only** — the agent can only send emails to the signed-in user themselves, not to other recipients.
- **Single todo list** — the agent can only access tasks in one specific list, chosen by you.
- **Human-in-the-loop for critical decisions** — signing in and selecting which todo list to use both require human interaction via the browser. The AI agent cannot perform these actions programmatically.
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
- 🧑 **Human-in-the-loop** — signing in and selecting which todo list to use both require **human interaction via the browser**. The AI agent cannot perform these actions programmatically.
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
