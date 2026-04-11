# graphdo-ts

A TypeScript [MCP server](https://modelcontextprotocol.io) that gives AI agents scoped, low-risk access to Microsoft Graph.

The design intentionally limits blast radius - agents can only mail _you_, only touch tasks in a single configured list, and never see resources outside the scopes you've granted. Current capabilities cover email and Microsoft To Do; more Graph surfaces may be added over time.

This is the successor to [graphdo](https://github.com/co-native-ab/graphdo) (the Go CLI, now deprecated). Both share the same Azure AD app registration.

---

## Features

graphdo-ts currently exposes **11 MCP tools**:

| Tool            | Description                                                                          |
| --------------- | ------------------------------------------------------------------------------------ |
| `login`         | Authenticate via browser login (with device code fallback)                           |
| `logout`        | Clear cached tokens and sign out                                                     |
| `auth_status`   | Check authentication status, current user, and configuration                         |
| `mail_send`     | Send an email to yourself (from and to your Microsoft account)                       |
| `todo_config`   | Configure which Microsoft To Do list to use (opens browser for human-only selection) |
| `todo_list`     | List todos with pagination                                                           |
| `todo_show`     | Show a single todo with full details                                                 |
| `todo_create`   | Create a new todo                                                                    |
| `todo_update`   | Update an existing todo (title and/or body)                                          |
| `todo_complete` | Mark a todo as completed                                                             |
| `todo_delete`   | Delete a todo                                                                        |

---

## Installation

graphdo-ts is distributed as an [MCPB](https://github.com/anthropics/mcpb) bundle - a self-contained package that includes the server and a bundled Node.js runtime. No separate Node.js installation required.

### Download

Download the latest MCPB bundle from [GitHub Releases](https://github.com/co-native-ab/graphdo-ts/releases/latest).

### Claude Desktop

Add the following to your Claude Desktop MCP configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "graphdo": {
      "type": "mcpb",
      "bundle_path": "/path/to/graphdo-ts-v0.1.0.mcpb"
    }
  }
}
```

Replace the path with the actual path to the downloaded bundle.

---

## Authentication

graphdo-ts uses MSAL to authenticate with Microsoft. When the agent calls the `login` tool:

1. The tool first tries **interactive browser login** - opens your default browser to Microsoft's sign-in page
2. You authenticate in the browser, which redirects to a local server that captures the auth code
3. Login completes immediately - no manual code entry needed

If a browser cannot be opened (headless environments, SSH, containers), the tool automatically falls back to **device code flow**:

1. Returns a URL and code: _"Visit https://microsoft.com/devicelogin and enter code: ABC123"_
2. If the client supports [MCP elicitation](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/elicitation), a form prompt is shown with the URL and code - confirm once you've signed in
3. Otherwise the tool returns the message as text
4. You authenticate in any browser on any device

Use the `auth_status` tool to check whether you are logged in and see the current user and configuration.

Tokens are automatically refreshed using the cached refresh token. To sign out and clear cached tokens, use the `logout` tool.

The Azure AD client ID (`b073490b-a1a2-4bb8-9d83-00bb5c15fcfd`) is built into the server. No client-side configuration is needed unless your organization uses a custom app registration.

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

When you first use the `login` tool, Microsoft may tell you that you need admin approval. This means your IT administrator needs to grant graphdo permission to access your email and tasks on behalf of your organization.

**What to tell your IT admin:**

> "I'd like to use an AI tool called graphdo that helps me send emails to myself and manage my todo list. It needs admin consent for these permissions: User.Read, Mail.Send, Tasks.ReadWrite, and offline_access. The application ID is `b073490b-a1a2-4bb8-9d83-00bb5c15fcfd` and it's published by Co-native AB."

### For IT administrators

graphdo uses a multi-tenant application published by Co-native AB. To grant consent for your organization:

1. Go to the [Azure Portal](https://portal.azure.com) → **Microsoft Entra ID** → **Enterprise applications**.
2. Click **New application** → **All applications** → search for the application ID: `b073490b-a1a2-4bb8-9d83-00bb5c15fcfd`.
3. If the app doesn't appear, a user can trigger the consent flow by calling the `login` tool — this will create a service principal in your tenant.
4. Go to **Permissions** and click **Grant admin consent for [your organization]**.
5. Review and approve the following delegated permissions:

   | Permission       | Type      | Description                                                                    |
   | ---------------- | --------- | ------------------------------------------------------------------------------ |
   | `User.Read`      | Delegated | Read the signed-in user's basic profile                                        |
   | `Mail.Send`      | Delegated | Send mail as the signed-in user                                                |
   | `Tasks.ReadWrite`| Delegated | Read and write the signed-in user's tasks                                      |
   | `offline_access` | Delegated | Maintain access to data you have given it access to (enables refresh tokens)   |

6. Once consent is granted, all users in your organization can use the `login` tool without further approval.

**Security notes:**
- graphdo can **only send emails to the signed-in user themselves** — it cannot send to other recipients.
- graphdo only accesses the user's **own tasks** in Microsoft To Do.
- The source code is open at [github.com/co-native-ab/graphdo-ts](https://github.com/co-native-ab/graphdo-ts).

---

## Troubleshooting

**"I need admin approval"**
Your organization's IT administrator needs to approve graphdo. See [Organization Setup](#organization-setup) for what to tell them.

**"The login code expired"**
Call the `login` tool again. The device code is valid for about 15 minutes, so complete the sign-in promptly.

**"No todo lists found"**
Create a list in Microsoft To Do first. Open [to-do.office.com](https://to-do.office.com), create a list, then call `todo_config` again.

**"The browser didn't open"**
The `login` tool automatically falls back to device code flow when a browser cannot be opened. In headless environments (SSH, containers), this is expected.

---

## Privacy & Security

- 🔒 graphdo only accesses **your own** email and tasks. It cannot access anyone else's.
- 📧 It can **only send emails to yourself** — it cannot send emails to other people.
- 💻 Your login credentials are cached **locally on your computer** and nowhere else.
- 🌐 No data is sent anywhere except to **Microsoft's official servers** (the same ones Outlook and To Do use).
- 📖 The source code is **fully open** at [github.com/co-native-ab/graphdo-ts](https://github.com/co-native-ab/graphdo-ts) — anyone can review exactly what it does.

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
npm run build       # Build with esbuild (dist/index.js)
npm run lint        # ESLint (strict + stylistic)
npm run typecheck   # tsc --noEmit
npm run test        # Run tests via vitest
npm run check       # lint + typecheck + test (all three)
npm run mcpb        # Build + create MCPB bundle
```

### Environment Variables

| Variable               | Description                                  | Default                            |
| ---------------------- | -------------------------------------------- | ---------------------------------- |
| `GRAPHDO_DEBUG`        | Enable debug logging (`true`/`false`)        | `false`                            |
| `GRAPHDO_CONFIG_DIR`   | Override config directory                    | OS default                         |
| `GRAPHDO_GRAPH_URL`    | Override Graph API base URL                  | `https://graph.microsoft.com/v1.0` |
| `GRAPHDO_ACCESS_TOKEN` | Skip MSAL auth and use a static Bearer token | -                                  |

---

## Architecture

```
Claude Desktop / MCP Client
  │
  │  stdio (JSON-RPC)
  ▼
MCP Server (StdioServerTransport)
  │
  ├─── MSAL Auth (browser + device code) ──→ Azure AD
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
- **MSAL authentication** - interactive browser login with device code fallback, tokens cached locally
- **Graph client** - lightweight wrapper around `fetch` (no Microsoft Graph SDK)
- **Minimal dependencies** - three runtime deps: `@modelcontextprotocol/sdk`, `zod`, `@azure/msal-node`

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding standards, and PR process.

---

## License

MIT
