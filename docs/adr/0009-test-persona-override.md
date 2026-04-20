---
title: "ADR-0009: Test-Persona Override (GRAPHDO_AGENT_PERSONA)"
status: "Accepted"
date: "2026-04-20"
authors: "co-native-ab"
tags: ["architecture", "security", "collab-v1", "testing"]
supersedes: ""
superseded_by: ""
---

# ADR-0009: Test-Persona Override (`GRAPHDO_AGENT_PERSONA`)

## Status

**Accepted**

## Context

`docs/plans/two-instance-e2e.md` ships a manual / Copilot-CLI smoke
playbook that exercises every multi-agent collab path end-to-end:
different sections, same-section conflict + proposal fallback,
destructive re-approval, lease handoff, sentinel tamper, share-URL
onboarding, renewal caps, version restore, draft delete. The playbook
runs on a real Microsoft account against real OneDrive, and needs **two
collaborators** to drive the cross-agent paths.

Today the project only has one production-shaped flavour of "agent
identity": every session derives an
`agentId = <oidPrefix>-<clientSlug>-<sessionPrefix>` per ADR-0006 + §B6.17
of `collab-v1.md`. The ephemeral `<sessionPrefix>` already makes two
sessions on the same Microsoft account look like two distinct
collaborators to the destructive classifier — but it is **ephemeral**
(restarts the session = restarts the prefix), client-name-dependent,
and gives no human-readable label. None of those are acceptable for a
playbook that runs across both Alice's MCP instance and Bob's MCP
instance and needs to grep the audit log for "anything Alice did".

We need a way to give a single Microsoft user **two stable, named,
distinguishable collab labels** so the playbook can run as one human
on one machine.

## Decision

Add a single environment variable read **once** in `main()`:

```
GRAPHDO_AGENT_PERSONA=persona:alice
```

Format: `^persona:[a-z0-9-]{1,32}$`. When set:

- `ServerConfig.agentPersona = { id, rawEnvValue, source: "env" }` is
  threaded into `createMcpServer()`.
- The session registry, on `start()`, uses the persona id as the
  authoritative `agentId` instead of the derived
  `<oidPrefix>-<clientSlug>-<sessionPrefix>`. `userOid` is **preserved
  verbatim** on the snapshot.
- `session_start` audit envelopes get two additive fields:
  `mode: "test-persona"` and `agentPersona: { id, source: "env" }`.
- `auth_status` and `session_status` print a high-visibility
  `WARN: Test persona active: persona:alice (...; real user OID
unchanged)` line.
- Startup logs one structured `warn` so a log scrape can pick it up:
  `agent persona override active env=GRAPHDO_AGENT_PERSONA id=persona:alice config_dir=...`.

When unset, behaviour is byte-identical to today: no extra fields on
the audit envelope, no WARN line, no behaviour change anywhere.
Existing tests 19 + 21 stay green.

A second piece (`src/instance-lock.ts`) refuses startup when another
graphdo-ts process is already pointed at the same `<configDir>` — see
`docs/plans/two-instance-e2e.md` §1 for why each persona must use a
distinct `GRAPHDO_CONFIG_DIR`.

## Threat model

The override could in principle be abused for spoofing, privilege
escalation, or audit forgery if we get it wrong. The mitigations:

| Concern                                                                                    | Mitigation                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persona override could be used to forge a real other Microsoft user in audit / authorship  | The override never touches `userOid` or `account.json`. Audit + authorship records both `userOid` (real) and `agentPersona.id` (synthetic). Any persona id is prefixed `persona:` and the schema rejects values that look like a GUID/OID, so it cannot collide with a real Entra `oid` at any layer.                 |
| Override could confuse the destructive classifier or bypass re-prompts in production       | The env var is **only** read in `main()`, surfaced in `auth_status` + `session_status`, stamped into every `session_start` audit envelope as `mode: "test-persona"`, and warn-logged once at startup. Forensic readers identify affected sessions trivially. Destructive re-prompts still require a real human click. |
| Two instances racing on the same `<configDir>` could corrupt MSAL cache or sidecars        | `src/instance-lock.ts` refuses to start a second instance pointed at the same `<configDir>`. Stale locks (PID gone) are silently recovered. Each persona MUST get a distinct `GRAPHDO_CONFIG_DIR`; the playbook enforces this in pre-flight.                                                                          |
| Loopback servers from two instances could collide on a port                                | Already random-port; no change. Verified by existing loopback tests.                                                                                                                                                                                                                                                  |
| Override could escalate Graph permission                                                   | Impossible: Graph requests still use the same MSAL token from the same MSAL cache. `agentPersona.id` is a collab-layer label only and never reaches Microsoft Graph. There is no code path that places it in a request body, header, or query param.                                                                  |
| Persona could be smuggled into frontmatter `authorship[]` to claim a real user             | The frontmatter `authorship` writer always uses the resolved `agentId` from the active session snapshot, never client-supplied input. The Zod schema rejects anything outside `^persona:[a-z0-9-]{1,32}$`, so even a malicious agent cannot inject a value that looks like a real Entra `oid`.                        |
| `GRAPHDO_AGENT_PERSONA` could leak via process listing                                     | Same risk profile as `GRAPHDO_ACCESS_TOKEN`; documented in README + manifest. Persona ids are not secrets.                                                                                                                                                                                                            |
| Copilot CLI sub-agents could be tricked into bypassing destructive re-prompts via override | The override only controls labelling; it does not widen tool surface. Destructive re-prompts still happen and still require a real human click in the browser. The playbook tells Copilot explicitly not to bypass yellow checkpoints.                                                                                |

**Net: the override changes labels, not authority. Treat it like a
debug `--name` flag.**

## Why an env var (not a config-file flag)

Env vars cannot be silently mutated by an MCP client at runtime, are
visible in `ps`, and naturally die with the process. A config-file
persistence model would break the "this is debug only" contract — a
forgotten `agentPersona: ...` left in `config.json` would persist
across restarts and the operator would lose the audit-grep handle that
flags affected sessions.

## Why a `persona:` prefix

The prefix is defence-in-depth against confusion with a real Entra
`oid` UUID. GUIDs contain hyphens but never the literal substring
`persona:`. Audit readers can filter on the prefix alone to identify
test-persona sessions; future audit query tooling can route on it.

## Consequences

### Positive

- Two MCP server processes on one machine, on one Microsoft account,
  appear as two distinct collaborators to collab. The §2.3
  destructive classifier, §3.1 authorship trail, §3.2.1 lease sidecar,
  and §3.6 audit log all key off the persona id.
- The playbook (`docs/plans/two-instance-e2e.md`) becomes runnable end
  to end without inventing a parallel "test mode" that would diverge
  from production code.
- Forensic operators can grep audit JSONL for `"mode":"test-persona"`
  and exclude (or include) those sessions trivially.

### Negative / mitigations

- One more env var to document. Mitigated by `manifest.json`,
  `README.md`, and this ADR.
- Authorship trails written under a persona refer to a synthetic id,
  so a future tooling change that joins authorship to a real-user
  directory would have to ignore `persona:*` entries. This is
  exactly the bound we want: the persona id is not a real user, and
  no future code should treat it as one.
- The §2.2 derived-`agentId` shape (`<oidPrefix>-<clientSlug>-<sessionPrefix>`)
  still applies when no persona is set, so the existing
  `agent_name_unknown` warn-once continues to fire on production
  instances — the override path naturally skips it because the
  `segments[1] === "unknown"` heuristic is bypassed.

## References

- `src/persona.ts` — schema + parser + `effectiveAgentId` helper.
- `src/instance-lock.ts` — per-`configDir` startup lock.
- `src/collab/session.ts` — `SessionStartInput.agentPersonaId` plumb.
- `src/collab/audit.ts` — `SessionStartDetails` + `mode` + `agentPersona` fields.
- `src/index.ts` — `main()` reads + validates the env var; warn-once log.
- `src/tools/status.ts`, `src/tools/session.ts` — WARN-line surfacing.
- `test/persona.test.ts` — schema acceptance / rejection matrix.
- `test/instance-lock.test.ts` — lock-file unit tests.
- `test/integration/22-two-personas-same-config.test.ts` — full
  two-process E2E with mock Graph.
- `docs/plans/two-instance-e2e.md` — the playbook this ADR enables.
- `docs/plans/two-instance-e2e-copilot-prompt.md` — sub-agent
  orchestration prompt used by Copilot CLI.
- ADR-0006 — `userOid` from `idTokenClaims.oid`. Unchanged by this ADR.
