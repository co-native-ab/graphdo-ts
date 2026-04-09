# graphdo-ts

A TypeScript [MCP server](https://modelcontextprotocol.io) that gives AI agents scoped, low-risk access to Microsoft Graph.

The design intentionally limits blast radius — agents can only mail _you_, only touch tasks in a single configured list, and never see resources outside the scopes you've granted. Current capabilities cover email and Microsoft To Do; more Graph surfaces may be added over time.

This is the MCP-native counterpart to [graphdo](https://github.com/co-native-ab/graphdo) (the Go CLI). Both share the same Azure AD app registration and MSAL device code authentication flow.

---

## Features

graphdo-ts currently exposes **10 MCP tools**:

| Tool | Description |
|------|-------------|
| `login` | Authenticate via MSAL device code flow |
| `logout` | Clear cached tokens and sign out |
| `mail_send` | Send an email to yourself (from and to your Microsoft account) |
| `todo_config` | Configure which Microsoft To Do list to use (human-in-the-loop picker) |
| `todo_list` | List todos with pagination |
| `todo_show` | Show a single todo with full details |
| `todo_create` | Create a new todo |
| `todo_update` | Update an existing todo (title and/or body) |
| `todo_complete` | Mark a todo as completed |
| `todo_delete` | Delete a todo |

---

## Installation

graphdo-ts is distributed as an [MCPB](https://github.com/anthropics/mcpb) bundle — a self-contained package that includes the server and a bundled Node.js runtime. No separate Node.js installation required.

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

graphdo-ts uses MSAL's [device code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code) to authenticate. When the agent calls the `login` tool:

1. The server initiates a device code request with Azure AD
2. The tool returns a message: _"Visit https://microsoft.com/devicelogin and enter code: ABC123"_
3. You authenticate in any browser on any device
4. Once complete, tokens are cached locally and used for all subsequent Graph API calls

Tokens are automatically refreshed using the cached refresh token. To sign out and clear cached tokens, use the `logout` tool.

The Azure AD client ID (`b073490b-a1a2-4bb8-9d83-00bb5c15fcfd`) is built into the server. No client-side configuration is needed unless your organization uses a custom app registration.

### Required Scopes

These scopes reflect the current set of capabilities. Additional scopes may be required as new Graph surfaces are added.

| Scope | Purpose |
|-------|---------|
| `Mail.Send` | Send emails as the signed-in user |
| `Tasks.ReadWrite` | Read and write the user's Microsoft To Do tasks |
| `User.Read` | Read the signed-in user's basic profile |
| `offline_access` | Enable refresh tokens for persistent sessions |

### Todo List Selection

Before using todo tools, select which Microsoft To Do list to use:

1. Call `todo_config` without arguments → returns available lists
2. Call `todo_config` with a `listId` → saves the selection

The configuration is stored in the OS config directory:
- **Linux:** `~/.config/graphdo-ts/config.json`
- **macOS:** `~/Library/Application Support/graphdo-ts/config.json`
- **Windows:** `%APPDATA%/graphdo-ts/config.json`

---

## Organization Setup

> Personal Microsoft accounts (@outlook.com, @hotmail.com) can skip this section.

For work or school accounts, your IT administrator may need to grant admin consent for the application. The app ID is `b073490b-a1a2-4bb8-9d83-00bb5c15fcfd`, published by Co-native AB. See the [graphdo README](https://github.com/co-native-ab/graphdo#organization-setup) for detailed admin consent instructions — the same app registration is shared between both projects.

---

## Development

### Prerequisites

- Node.js 24+

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

| Variable | Description | Default |
|----------|-------------|---------|
| `GRAPHDO_DEBUG` | Enable debug logging (`true`/`false`) | `false` |
| `GRAPHDO_CONFIG_DIR` | Override config directory | OS default |
| `GRAPHDO_GRAPH_URL` | Override Graph API base URL | `https://graph.microsoft.com/v1.0` |
| `GRAPHDO_ACCESS_TOKEN` | Skip MSAL auth and use a static Bearer token | — |

---

## Architecture

```
Claude Desktop / MCP Client
  │
  │  stdio (JSON-RPC)
  ▼
MCP Server (StdioServerTransport)
  │
  ├─── MSAL Device Code Auth ──→ Azure AD
  │
  ├─── Graph Client (native fetch)
  │         │
  │         │  Bearer token
  │         ▼
  │    Microsoft Graph API (v1.0)
  │
  └─── Config (OS config dir)
```

- **Stdio transport** — communicates via stdin/stdout JSON-RPC (designed for MCPB)
- **MSAL authentication** — device code flow via `@azure/msal-node`, tokens cached locally
- **Graph client** — lightweight wrapper around `fetch` (no Microsoft Graph SDK)
- **Minimal dependencies** — three runtime deps: `@modelcontextprotocol/sdk`, `zod`, `@azure/msal-node`

---

## License

MIT
