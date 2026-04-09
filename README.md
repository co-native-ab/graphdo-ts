# graphdo-ts

A TypeScript [MCP server](https://modelcontextprotocol.io) that gives AI agents scoped, low-risk access to Microsoft Graph.

The design intentionally limits blast radius — agents can only mail _you_, only touch tasks in a single configured list, and never see resources outside the scopes you've granted. Current capabilities cover email and Microsoft To Do; more Graph surfaces may be added over time.

This is the MCP-native counterpart to [graphdo](https://github.com/co-native-ab/graphdo) (the Go CLI). Unlike the Go version, graphdo-ts is a pure MCP server with HTTP transport — it has no CLI, no built-in OAuth flow, and no login command. OAuth is delegated entirely to the MCP client (e.g. Claude Desktop), which provides Bearer tokens that the server forwards to the Graph API.

---

## Features

graphdo-ts currently exposes **8 MCP tools** covering email and task management:

| Tool | Description |
|------|-------------|
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

Download the latest MCPB bundle from [GitHub Releases](https://github.com/co-native-ab/graphdo-ts/releases/latest):

- **macOS (Apple Silicon):** `graphdo-darwin-arm64.mcpb`
- **macOS (Intel):** `graphdo-darwin-x64.mcpb`
- **Linux (x64):** `graphdo-linux-x64.mcpb`
- **Windows (x64):** `graphdo-win32-x64.mcpb`

### Claude Desktop

Add the following to your Claude Desktop MCP configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "graphdo": {
      "type": "mcpb",
      "bundle_path": "/path/to/graphdo.mcpb"
    }
  }
}
```

Replace `/path/to/graphdo.mcpb` with the actual path to the downloaded bundle.

---

## Configuration

### OAuth

OAuth is handled entirely by the MCP client. graphdo-ts never sees or stores credentials — it receives Bearer tokens via the `Authorization` header, validates them against Azure AD's JWKS (signature, expiry, issuer, audience, authorized party), and forwards them to Microsoft Graph API.

When no token is present, the server returns `401` with a `WWW-Authenticate` header pointing to the Protected Resource Metadata endpoint (`/.well-known/oauth-protected-resource`), following the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) and [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728). The metadata tells the MCP client which authorization server to use and which scopes to request.

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
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `3000` |
| `GRAPHDO_DEBUG` | Enable debug logging (`true`/`false`) | `false` |
| `GRAPHDO_CONFIG_DIR` | Override config directory | OS default |
| `GRAPHDO_GRAPH_URL` | Override Graph API base URL | `https://graph.microsoft.com/v1.0` |

---

## Architecture

```
MCP Client (Claude Desktop, etc.)
  │
  │  HTTP + Bearer token
  ▼
HTTP Server (Express)
  │
  │  Streamable HTTP transport (/mcp)
  ▼
MCP Server (@modelcontextprotocol/sdk)
  │
  │  Per-session server + tool registration
  ▼
Graph Client (native fetch)
  │
  │  Bearer token forwarding
  ▼
Microsoft Graph API (v1.0)
```

- **HTTP server** — Express with cors middleware and session management
- **Streamable HTTP transport** — MCP sessions tracked by `Mcp-Session-Id` header
- **Token validation** — JWT access tokens verified via `jose` against Azure AD JWKS (signature, expiry, issuer, audience, authorized party)
- **Protected Resource Metadata** — `/.well-known/oauth-protected-resource` endpoint per [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) and the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- **Per-request auth** — tokens extracted from the `Authorization` header, validated, then forwarded to Graph; never stored
- **Graph client** — lightweight wrapper around `fetch` (no Microsoft Graph SDK)
- **Minimal dependencies** — five runtime deps: `@modelcontextprotocol/sdk`, `zod`, `express`, `cors`, and `jose`

---

## License

MIT
