---
title: "ADR-0006: userOid Sourced from idTokenClaims.oid"
status: "Accepted"
date: "2026-04-19"
authors: "co-native-ab"
tags: ["architecture", "security", "authentication", "collab-v1"]
supersedes: ""
superseded_by: ""
---

# ADR-0006: `userOid` Sourced from `idTokenClaims.oid`

## Status

**Accepted**

## Context

The collab v1 design (`docs/plans/collab-v1.md`) introduces a stable
per-user identifier — `userOid` — that flows through every collab
consumer:

- The `agentId` derivation (`<oidPrefix>-<clientSlug>-<sessionIdPrefix>`)
  uses the first 8 characters of `userOid` as the user-distinguishing
  prefix (§3.6, §10 OQ-4).
- The session/leases/recents sidecars are keyed by
  `<userOid>/<projectId>` (§3.5).
- The audit JSONL surfaces `userOid` (suffix-redacted) on every
  destructive operation (§3.6 redaction allow-list).

MSAL Node exposes two candidate identifiers on
`AuthenticationResult.account`:

1. **`localAccountId`** — MSAL's normalised account-id concept. For
   most signed-in users on a single-tenant app, this equals the Entra
   `oid`. For B2B-guest scenarios and certain multi-tenant
   configurations, MSAL synthesises `localAccountId` from a different
   tenant's view of the user, and it can diverge from the Entra
   object id of the home account.
2. **`idTokenClaims.oid`** — the standard Entra **object identifier**
   claim from the id token. Stable per user across every tenant the
   user appears in. Documented as the canonical Microsoft Graph
   `User.id` for v1.0 endpoints in most cases, and the value
   recommended by Microsoft's own audit-log guidance for "who did
   this".

The `oid` claim is also present inside the access token, but per
OAuth 2.0 / OIDC the access token is opaque to the client — only
the resource server (Microsoft Graph) is supposed to read it, and
Microsoft documents that v2.0 access tokens may be encrypted and
must not be parsed by client applications. The id token, by
contrast, is the OIDC artifact designed precisely for the client
to learn about the signed-in user, and MSAL Node already parses it
into `AuthenticationResult.idTokenClaims` for free. See the
"Read `oid` from the access token instead of the id token"
alternative below for the full rationale.

The collab v1 `docs/plans/collab-v1.md` §10 OQ-6 closed Round 3
with the explicit decision to pin `userOid = idTokenClaims.oid`.
ADR-0005 (decision 15) records that choice; this ADR codifies the
implementation that surfaces it.

Today, prior to this ADR, `Authenticator.accountInfo` returns only
`{ username }`. Every collab tool that needs `userOid` would have to
re-derive it independently, multiplying the surface area for the
"which identifier?" mistake. The W1 Day 1 milestone in
`collab-v1.md` §9 budgets this plumbing as a single PR before any
collab read/write code lands, precisely so subsequent milestones
can rely on `userOid` being available.

## Decision

`userOid` is sourced from `idTokenClaims.oid` and surfaced through
the existing `Authenticator.accountInfo()` API. Specifically:

### 1. Extract `oid` at login time

`MsalAuthenticator.login` reads `result.idTokenClaims.oid` from the
`AuthenticationResult` returned by
`PublicClientApplication.acquireTokenInteractive`. As a fallback,
when `idTokenClaims` is attached to `result.account` instead of the
top-level result (as happens in some MSAL-cached paths), the same
helper consults `result.account.idTokenClaims.oid`. The value is
required: if neither source provides a non-empty string, login
**fails** rather than silently producing an account record with a
made-up or missing identifier.

### 2. Persist `userOid` alongside the MSAL account record

`account.json` continues to contain the MSAL `AccountInfo` verbatim,
plus a new top-level `userOid: string` field. The schema validated on
read (`AccountInfoSchema`) requires `userOid` to be a non-empty
string. Pre-ADR-0006 account files (which lack `userOid`) fail
validation; `accountInfo()` returns `null` for those, prompting the
user to re-authenticate via `login`. This is acceptable because
graphdo-ts is pre-1.0 and the migration window is bounded.

### 3. Surface `userOid` on `AccountInfo`

The `AccountInfo` interface gains a required `userOid: string` field.
`MsalAuthenticator.accountInfo()` returns it from the persisted
account record. The mock and static authenticators return synthetic
deterministic UUIDs (`11111111-…` for tests, `00000000-…` for the
static-token escape hatch) so they are never confused with real
Entra `oid` values.

### 4. Single delivery channel — `ServerConfig.authenticator`

Collab consumers obtain `userOid` via
`config.authenticator.accountInfo(signal).userOid`. We deliberately
do **not** add a separate `userOid` field to `ServerConfig` because
the value is mutable across login/logout and would have to be
re-read on every consumer call anyway — funnelling all reads through
`accountInfo()` keeps a single source of truth.

### 5. `auth_status` exposes `userOid`

The `auth_status` tool prints the full `userOid` on a dedicated
`User OID:` line so operators can confirm identity end-to-end during
diagnosis. Audit-log redaction (suffix only — see §3.6) is the
responsibility of the audit-writer landing in W3 Day 3 and is not
relevant to `auth_status`, which runs on the user's own workstation.

## Consequences

### Positive

- **POS-001**: One canonical user identifier throughout collab v1 —
  no per-tool re-derivation, no risk of one tool keying on
  `localAccountId` and another on `oid` for the same user.
- **POS-002**: Consistent behaviour for B2B-guest and multi-tenant
  users — `oid` is stable per home identity, while `localAccountId`
  can vary by tenant view.
- **POS-003**: Audit entries refer to a Microsoft-documented user
  identifier matching Graph `/me.id` in the common case, simplifying
  forensic correlation against Entra audit logs.
- **POS-004**: Login fails loudly when the id token lacks an `oid`
  claim, rather than silently degrading. Easier to detect and
  diagnose misconfigured app registrations.

### Negative

- **NEG-001**: Existing `account.json` files written before this
  change will no longer satisfy schema validation; affected users
  must re-run the `login` tool. Acceptable in pre-release.
- **NEG-002**: Strict schema validation means a corrupted or
  hand-edited `account.json` that lacks `userOid` becomes "not
  logged in" from the server's perspective, even if the MSAL token
  cache is otherwise intact. The remediation is a fresh `login`
  call.
- **NEG-003**: The synthetic `userOid` for `StaticAuthenticator`
  (`00000000-0000-0000-0000-000000000000`) collides for every
  static-token user. Acceptable — the static-token mode is for CI
  and developer loopback testing, not multi-user audit scenarios.

## Alternatives Considered

### Use `localAccountId`

- **ALT-001**: **Description**: Read `account.localAccountId` from the
  MSAL `AccountInfo` directly. Simplest possible plumbing — no
  id-token claim parsing.
- **ALT-002**: **Rejection Reason**: `localAccountId` and
  `idTokenClaims.oid` can diverge in B2B-guest and multi-tenant
  setups. Anchoring audit identity on a value that can shift between
  tenant views of the same user is precisely the ambiguity the
  collab v1 audit design wants to eliminate.

### Derive identity from Graph `/me.id`

- **ALT-003**: **Description**: Call `GET /me` after login and use
  the returned `User.id` (which equals the Entra `oid` for v1.0
  endpoints) as `userOid`.
- **ALT-004**: **Rejection Reason**: Adds a network round-trip on
  every login, depends on `User.Read` being granted at the moment
  of login (true today, but couples auth-plumbing to a specific
  scope grant), and provides no information beyond what is already
  in the id token MSAL just parsed. The id-token claim is
  authoritative and free.

### Read `oid` from the access token instead of the id token

- **ALT-005a**: **Description**: The `oid` claim is also present in
  the access token issued by Entra. We could decode the access
  token's JWT body and read `oid` from there, removing any
  dependency on the id token (and thereby on the `openid` /
  `profile` scopes that produce one).
- **ALT-005b**: **Rejection Reason**: Per the OAuth 2.0 / OpenID
  Connect contract, **access tokens are opaque to the client**. The
  id token is the artifact OIDC defines for the client to learn
  about the signed-in user; the access token is for the resource
  server (Microsoft Graph in our case). Microsoft documents this
  explicitly for v2.0 endpoints: client applications **must not**
  inspect or take a dependency on the access-token format, and
  Entra reserves the right to encrypt access tokens (and already
  does for some resources, in which case the token is not even a
  readable JWT from the client's side). MSAL Node already parses
  the id token for us and exposes the result as
  `AuthenticationResult.idTokenClaims` — no JWT decoding, no
  signature-validation gymnastics. Reading `oid` from the id token
  is therefore both the conventional and the lower-risk path: it
  uses the artifact OIDC designed for this purpose, costs zero
  extra parsing, and stays correct even if Microsoft starts
  encrypting Graph access tokens for our app. The `openid` scope is
  always implicitly requested (MSAL Node adds it for any
  interactive flow), so an id token is always present in the
  responses we already get.

### Add `userOid` directly to `ServerConfig`

- **ALT-005**: **Description**: Have `createMcpServer` resolve
  `userOid` once and stash it on `ServerConfig`, so collab tools can
  read `config.userOid` synchronously without going through the
  authenticator.
- **ALT-006**: **Rejection Reason**: `userOid` is mutable across
  login/logout cycles within the lifetime of a single MCP server
  instance. A snapshot on `ServerConfig` would either be stale or
  require a mutation channel, both of which violate the "single
  source of truth" invariant. Funnelling reads through
  `accountInfo()` keeps the data flow obvious.

## Implementation Notes

- **IMP-001**: The `oid` extractor lives next to the `AccountInfo`
  type in `src/auth.ts` (`readUserOidFromResult`) and consults
  `result.idTokenClaims.oid` first, then
  `result.account.idTokenClaims.oid`. This ordering matches MSAL's
  own behaviour: fresh interactive results carry `idTokenClaims` at
  the top level, while silent-cache results may attach them to the
  account.
- **IMP-002**: `account.json` schema validation upgrades from "must
  have `username`" to "must have `username` and non-empty `userOid`".
  The schema remains `.loose()` so additional MSAL fields round-trip
  unchanged.
- **IMP-003**: The W1 Day 1 DoD (`collab-v1.md` §9) requires an
  explicit `test/auth.test.ts` assertion that
  `userOid === idTokenClaims.oid`. The test
  `"surfaces userOid === idTokenClaims.oid after login (ADR-0006)"`
  in `test/auth.test.ts` satisfies that DoD: it wires a known `oid`
  through the mocked MSAL `AuthenticationResult`, calls
  `auth.login()`, then asserts the resolved `accountInfo().userOid`
  equals the source claim.
- **IMP-004**: A negative test
  (`"rejects login when id token has no oid claim"`) asserts that
  `MsalAuthenticator.login` throws when the id token omits `oid`.
- **IMP-005**: `MockAuthenticator` accepts an optional `userOid`
  constructor parameter (defaults to a deterministic UUID) so future
  collab integration tests can pin a stable identifier without
  reaching into MSAL internals.

## References

- **REF-001**: [ADR-0005: collab v1 decision log](./0005-collab-v1-decision-log.md) — decision 15 (`userOid = idTokenClaims.oid`) is the parent decision codified by this ADR.
- **REF-002**: [`docs/plans/collab-v1.md`](../plans/collab-v1.md) §9 W1 Day 1 — DoD that this ADR satisfies; §10 OQ-6 — Round-3 rationale.
- **REF-003**: [Microsoft Entra — id token claims reference (`oid`)](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference) — canonical definition of the `oid` claim used as `userOid`.
- **REF-004**: [MSAL Node — `AccountInfo`](https://learn.microsoft.com/en-us/javascript/api/@azure/msal-node/) — surface that exposes `localAccountId` and (optionally) `idTokenClaims`; clarifies why we prefer the latter.
- **REF-005**: [Microsoft identity platform — access tokens (v2.0)](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens) — documents that access tokens are opaque to client applications, may be encrypted, and must not be parsed by clients. Motivates reading `oid` from the id token rather than the access token.
- **REF-006**: [OpenID Connect Core 1.0 — ID Token](https://openid.net/specs/openid-connect-core-1_0.html#IDToken) — the OIDC artifact designed for the client to learn about the signed-in user; the conventional surface for claims like `oid`/`sub`.
