---
title: "ADR-0003: Browser-Only Authentication"
status: "Accepted"
date: "2026-04-11"
authors: "co-native-ab"
tags: ["architecture", "security", "authentication"]
supersedes: ""
superseded_by: ""
---

# ADR-0003: Browser-Only Authentication

## Status

**Accepted**

## Context

graphdo-ts is a TypeScript MCP server designed to run on a user's workstation where a browser is available. Authentication with Microsoft Entra ID previously supported three interaction patterns:

1. **Browser-based login via loopback server**: MSAL opens the user's default browser to the Microsoft login page, and a local HTTP server on `127.0.0.1` captures the authorization code redirect. This is the primary, preferred flow.
2. **Device code flow as fallback**: For headless environments where a browser cannot be opened, MSAL generates a device code and the user manually navigates to `microsoft.com/devicelogin` to enter it. This required background promise tracking, polling for token completion, and a separate pending login state.
3. **MCP elicitation prompts**: When device code flow was active, graphdo-ts used MCP elicitation to present the device code and URL to the user within the MCP client, adding another code path that depended on client-side elicitation support.

Key forces at play:

- **Codebase complexity**: The device code flow introduced pending login tracking, background promises that had to be resolved or rejected on subsequent tool calls, and polling logic — all of which were separate code paths from the browser flow.
- **MCP elicitation fragility**: Elicitation support varies across MCP clients. Some clients do not implement it, and the specification is still evolving. Relying on elicitation for a critical flow like authentication created a fragile dependency on client behavior.
- **Security concerns**: Device code flow is a known phishing vector — an attacker can trick a user into entering a device code on the legitimate Microsoft login page, granting the attacker a token. Removing it reduces the attack surface.
- **UX inconsistency**: Three different authentication paths meant three different user experiences, making the tool harder to understand and support. Users could encounter different flows depending on their environment and MCP client capabilities.
- **Design intent**: graphdo-ts is a local workstation tool. It is not designed to run in headless infrastructure, SSH sessions, or containers where no browser is available.

## Decision

graphdo-ts uses **browser-only authentication**. All authentication flows go through the user's browser via the custom loopback server.

### 1. Remove Device Code Flow

The device code flow and all associated infrastructure are removed: no device code callbacks, no pending login state tracking, no background promise management, no polling for token completion. MSAL is configured exclusively for interactive browser authentication via the loopback redirect.

### 2. Remove MCP Elicitation for Login

MCP elicitation prompts for presenting device codes or confirming login status are removed. The login tool no longer branches based on client elicitation capabilities. Authentication is handled entirely outside the MCP protocol — in the browser.

### 3. Browser-Only Interactive Login

The `login` tool opens the user's default browser to the Microsoft Entra ID login page. A local HTTP server on `127.0.0.1` with a random port listens for the authorization code redirect. After successful authentication, the server displays a success page and shuts down. This is the only authentication path.

### 4. Graceful Fallback When Browser Cannot Open

If the browser cannot be opened (e.g., the `open` command fails), the login tool returns an MCP error containing the full authorization URL. The user can copy and paste this URL into any browser to complete authentication. There is no device code, no polling, and no background state — just a URL.

### 5. Browser-Based Logout

Logout now opens a browser confirmation page consistent with the browser-only UX, rather than silently clearing tokens. This gives the user a clear visual confirmation that they have been logged out.

## Consequences

### Positive

- **POS-001**: Significant codebase simplification — removes pending login tracking, device code callback registration, elicitation branching logic, and background promise management. Fewer code paths means fewer bugs and easier maintenance.
- **POS-002**: Reduces attack surface by eliminating device code flow, which is a known phishing vector where attackers can trick users into entering codes that grant unauthorized access.
- **POS-003**: One consistent UX path — every authentication interaction goes through the browser, making the tool predictable and easy to explain. Users never encounter different flows depending on their MCP client or environment.
- **POS-004**: No dependency on MCP client elicitation support — authentication works identically regardless of which MCP client is used, since the browser handles all user interaction.
- **POS-005**: Aligns the authentication design with graphdo-ts's intended deployment model as a local workstation tool where a browser is always expected to be available.

### Negative

- **NEG-001**: Headless environments (SSH sessions, containers, remote servers without display) lose the ability to authenticate interactively. Users in these environments cannot complete the login flow.
- **NEG-002**: If the browser fails to open automatically, the fallback requires the user to manually copy and paste a URL — this is a degraded experience compared to the automatic browser launch.
- **NEG-003**: Future use cases that might benefit from headless authentication (e.g., CI/CD pipelines, server-side agents) are explicitly not supported and would require revisiting this decision.
- **NEG-004**: MCP clients that had invested in elicitation support for graphdo-ts login will see that code path disappear. Any client-side logic for handling device code elicitation becomes dead code.

## Alternatives Considered

### Keep Device Code Flow as Fallback

- **ALT-001**: **Description**: Retain the device code flow as a fallback when the browser cannot be opened, maintaining support for headless environments. The browser flow remains primary, and device code activates only when browser launch fails.
- **ALT-002**: **Rejection Reason**: Maintaining two authentication paths doubles the testing surface and keeps the complexity that this decision aims to eliminate — pending login state, background promises, polling logic, and device code callbacks all remain in the codebase. The device code flow also retains the phishing attack surface. Since graphdo-ts is designed for workstations with browsers, the fallback addresses a deployment scenario outside the tool's design intent.

### Keep MCP Elicitation for Browser URL Delivery

- **ALT-003**: **Description**: Remove device code flow but use MCP elicitation to present the browser login URL to the user within the MCP client, rather than returning it as an error when the browser cannot open.
- **ALT-004**: **Rejection Reason**: Elicitation support is inconsistent across MCP clients and the specification is still evolving. Using elicitation for URL delivery creates a dependency on client capabilities that may not be present. Returning the URL as an MCP error is universally supported by all MCP clients — every client can display error messages — making it a more reliable delivery mechanism.

### Support Multiple Authentication Strategies via Configuration

- **ALT-005**: **Description**: Allow users to configure their preferred authentication method (browser, device code, or elicitation) via a configuration file or environment variable, keeping all three implementations in the codebase.
- **ALT-006**: **Rejection Reason**: Configuration-driven authentication multiplies the code paths that must be maintained and tested. Each strategy has distinct error handling, state management, and UX implications. The added flexibility serves a deployment scenario (headless) that is outside graphdo-ts's design intent, while imposing ongoing maintenance cost for all scenarios.

## Implementation Notes

- **IMP-001**: The MSAL `PublicClientApplication` is configured with only the interactive browser authentication flow. The `acquireTokenInteractive` method uses a custom loopback client that starts a local HTTP server on `127.0.0.1` with a random available port to capture the authorization code redirect.
- **IMP-002**: When the browser cannot be opened, the login tool returns `{ isError: true }` with a message containing the full authorization URL. The user can navigate to this URL manually in any browser to complete authentication. No background state is created — if the user does not complete authentication, the next `login` call starts a fresh attempt.
- **IMP-003**: The logout tool opens a browser page confirming the logout action, consistent with the browser-only pattern. Token cache is cleared locally regardless of whether the browser page loads successfully.
- **IMP-004**: All device code flow infrastructure is removed: the `DeviceCodeRequest` callback, pending login promise tracking, the `completePendingLogin` helper, and any elicitation-related branching in the login handler.
- **IMP-005**: Success criteria: the `login` tool has exactly one authentication code path (browser), the codebase contains no references to device code flow or MCP elicitation for authentication, and all existing tests pass with the simplified flow.

## References

- **REF-001**: [ADR-0001: Minimize Blast Radius for AI Agent Access](./0001-minimize-blast-radius.md) — the overarching security principle that motivates reducing attack surface, including removal of the device code phishing vector.
- **REF-002**: [Microsoft identity platform and the OAuth 2.0 device authorization grant flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code) — documentation for the device code flow being removed, including Microsoft's own guidance on phishing risks.
- **REF-003**: [MSAL Node — Interactive browser authentication](https://learn.microsoft.com/en-us/entra/msal/node/) — the MSAL library's support for the loopback server pattern used by the remaining authentication flow.
- **REF-004**: [Model Context Protocol — Elicitation](https://modelcontextprotocol.io) — the MCP elicitation mechanism that was previously used for device code delivery, now removed from the authentication flow.
- **REF-005**: [Device code phishing — CISA advisory](https://www.cisa.gov/news-events/cybersecurity-advisories/aa25-050a) — US government advisory documenting device code phishing as an active threat vector used by nation-state actors.
