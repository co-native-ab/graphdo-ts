---
title: "ADR-0001: Minimize Blast Radius for AI Agent Access"
status: "Accepted"
date: "2025-07-16"
authors: "co-native-ab"
tags: ["architecture", "security", "ai-agents", "microsoft-graph"]
supersedes: ""
superseded_by: ""
---

# ADR-0001: Minimize Blast Radius for AI Agent Access

## Status

**Accepted**

## Context

graphdo-ts is a TypeScript MCP server that gives AI agents scoped, low-risk access to Microsoft Graph API. Current capabilities cover email and Microsoft To Do, with more Graph surfaces planned.

AI agents acting on behalf of users inherently carry risk — they can make mistakes, be manipulated via prompt injection, or behave unexpectedly. An agent with broad access to a user's Microsoft account could send emails to arbitrary recipients, read sensitive mail, delete important data, or access resources the user did not intend to expose. The design must minimize the damage an agent can cause while still enabling useful work.

Key forces at play:

- **Agent unpredictability**: AI agents may misinterpret instructions, hallucinate actions, or be manipulated by adversarial content in emails, documents, or tool outputs.
- **Microsoft Graph breadth**: Graph API provides access to mail, calendar, files, contacts, teams, and more — each surface area increases potential exposure.
- **User trust**: users need confidence that granting an AI agent access to their Microsoft account will not result in unintended consequences (e.g., emails sent to their boss, tasks deleted from the wrong list).
- **Organizational compliance**: IT administrators must be able to evaluate and approve the application's access scope before granting tenant-wide consent.
- **Usability vs. security**: overly restrictive access renders the agent useless; overly permissive access creates unacceptable risk.

## Decision

graphdo-ts follows a **"minimize blast radius"** principle across all design decisions. Every capability is evaluated through the lens of: _what is the worst thing that could happen if the agent misuses this, and how do we limit that?_

### 1. Scoped Permissions (Delegated Only)

Only delegated permissions are requested: `User.Read`, `Mail.Send`, `Tasks.ReadWrite`, `offline_access`. The agent acts as the signed-in user, never as an application with broader access. No application-level permissions are used. This means the agent can never access resources beyond what the specific signed-in user has access to, and an IT administrator can see exactly what is requested during consent.

### 2. Constrained Actions

Each capability is scoped as narrowly as possible beyond what the permission model alone enforces:

- **Email**: the `mail_send` tool retrieves the signed-in user's profile via `GET /me` and sends the email **to that same address** (`user.mail`). The tool accepts no recipient parameter — the agent can only email the signed-in user themselves. This prevents the agent from sending emails to arbitrary recipients even though the `Mail.Send` scope technically allows it.
- **To Do**: the agent can only access tasks in **one specific list**, selected by the user via a browser picker. The selected list ID is stored in the local config file. The agent cannot enumerate or access other lists.

### 3. Human-in-the-Loop for Critical Decisions

Operations that change the agent's access scope require human interaction via the browser, ensuring the AI agent cannot perform them programmatically:

- **Login**: the `login` tool opens a browser for interactive MSAL authentication (or falls back to device code flow where the user manually enters a code at `microsoft.com/devicelogin`). The agent cannot authenticate without a human completing the sign-in.
- **List selection**: the `todo_config` tool starts a local HTTP server and opens a browser picker where the user clicks the list to use. The agent cannot programmatically change which list it operates on — the picker is served as an HTML page that requires a human click.

### 4. Minimal Permissions

Only the permissions strictly needed for current capabilities are requested. The scope list (`Mail.Send`, `Tasks.ReadWrite`, `User.Read`, `offline_access`) is the minimum required for the 11 tools currently exposed. As new Graph surfaces are added, each new scope must be justified individually and evaluated for blast radius impact.

### 5. No Application Permissions

All permissions are delegated (user-level). The Azure AD app registration does not request or use any application-level permissions. The application never acts independently of a signed-in user, and tokens are always scoped to a specific user session.

## Consequences

### Positive

- **POS-001**: An agent mistake or prompt injection attack is contained — the worst case for email is the user receives an unwanted email from themselves; the worst case for To Do is modifications to a single chosen list.
- **POS-002**: IT administrators can confidently grant tenant-wide consent because the requested permissions are minimal and all delegated — no application-level permissions that could affect other users.
- **POS-003**: The human-in-the-loop pattern for login and list selection ensures the agent cannot escalate its own access or silently change its operating scope.
- **POS-004**: The principle scales to future Graph surfaces — each new capability is evaluated against the same blast radius criteria, preventing scope creep.
- **POS-005**: Users can audit exactly what the agent has access to: one email address (their own), one todo list (the one they picked), and nothing else.

### Negative

- **NEG-001**: Some useful features are intentionally excluded or constrained — for example, the agent cannot send email to other recipients, which limits its utility as a general-purpose email assistant.
- **NEG-002**: Adding new capabilities requires careful evaluation and may be slower than in a less security-conscious design — each new scope and action must be justified against blast radius.
- **NEG-003**: The human-in-the-loop pattern adds friction for initial setup (browser login, list selection), though this only needs to happen once per session or configuration change.
- **NEG-004**: Constraining actions beyond what the permission model enforces (e.g., email-to-self only) requires application-level enforcement in tool code, which must be maintained and tested as new tools are added.
- **NEG-005**: Using an AI agent is never risk-free — this design minimizes but does not eliminate risk. A compromised or misbehaving agent could still spam the user's own inbox or corrupt tasks in the selected list.

## Alternatives Considered

### Broad Delegated Permissions with Full Graph Access

- **ALT-001**: **Description**: Request broad delegated permissions (e.g., `Mail.ReadWrite`, `Calendars.ReadWrite`, `Files.ReadWrite.All`) and expose the full range of Graph API actions — send email to anyone, access all todo lists, read/write calendar events, manage files.
- **ALT-002**: **Rejection Reason**: Maximizes blast radius. A single agent mistake or prompt injection could send emails to arbitrary recipients, delete calendar events, or modify files. The damage potential is unbounded and unacceptable for an AI agent that may act unpredictably.

### Application-Level Permissions (No User Required)

- **ALT-003**: **Description**: Use application permissions instead of delegated permissions, allowing the server to act on behalf of any user in the organization without requiring individual sign-in.
- **ALT-004**: **Rejection Reason**: Fundamentally violates the principle of least privilege. Application permissions grant access to all users' data in the tenant, making the blast radius organization-wide rather than scoped to a single user. No human-in-the-loop is possible since no user sign-in occurs.

### No Constraints Beyond Permission Scopes

- **ALT-005**: **Description**: Request only the current scopes (`Mail.Send`, `Tasks.ReadWrite`, `User.Read`, `offline_access`) but allow the agent to use them without application-level constraints — e.g., let `mail_send` accept a recipient parameter, let the agent access any todo list.
- **ALT-006**: **Rejection Reason**: The permission model alone is insufficient. `Mail.Send` allows sending to any recipient, and `Tasks.ReadWrite` allows access to all lists. Without application-level constraints, the blast radius is determined by the permission scope rather than the minimum needed for the use case. The email-to-self and single-list constraints are deliberate reductions that the permission model cannot express.

### Require Human Approval for Every Action

- **ALT-007**: **Description**: Require explicit human confirmation (e.g., via MCP elicitation or a browser prompt) before every tool call — every email sent, every task created, every task updated.
- **ALT-008**: **Rejection Reason**: Destroys the utility of having an AI agent. The value of an agent is that it can act autonomously within safe boundaries. Requiring approval for every action reduces the agent to a verbose CLI tool. The chosen approach instead defines safe boundaries (email to self, single list) within which the agent can act freely.

## Implementation Notes

- **IMP-001**: The `mail_send` tool enforces the email-to-self constraint by fetching the user profile (`getMe`) and using `user.mail` as the recipient — the tool's input schema does not accept a recipient parameter.
- **IMP-002**: The `todo_config` tool uses the generic browser picker (`src/picker.ts`) which starts a local HTTP server on `127.0.0.1` with a random port, serves clickable options, and waits for a human selection (2-minute timeout). The selected list ID is persisted to `config.json` in the OS config directory.
- **IMP-003**: When adding new Graph surfaces (e.g., Calendar, OneDrive), developers must document which new scopes are required, what constraints limit blast radius, and whether any operations require human-in-the-loop confirmation. This ADR should be referenced in the PR.
- **IMP-004**: All tool handlers follow the pattern of catching errors and returning `{ isError: true }` rather than throwing — this prevents agent confusion from unhandled exceptions and ensures error messages guide the agent toward correct usage (e.g., "Please use the login tool first").
- **IMP-005**: Success criteria for this principle: no tool should allow the agent to affect resources outside the explicitly configured scope (the user's own email address and the selected todo list) without human interaction.

## References

- **REF-001**: [Model Context Protocol specification](https://modelcontextprotocol.io) — the protocol graphdo-ts implements for AI agent communication.
- **REF-002**: [Microsoft Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference) — documentation for delegated vs. application permission types.
- **REF-003**: [MSAL Node documentation](https://learn.microsoft.com/en-us/entra/msal/node/) — the authentication library used for interactive browser login and device code flow.
- **REF-004**: [graphdo-ts README — Privacy & Security](../README.md) — user-facing documentation of the blast radius minimization approach.
- **REF-005**: [OWASP Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/) — industry guidance on risks specific to AI/LLM-powered applications, including prompt injection and excessive agency.
