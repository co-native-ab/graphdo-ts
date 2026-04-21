# Two-Instance Collab End-to-End Playbook

> **What this is:** the single document you point GitHub Copilot CLI at
> after configuring two MCP server instances on one machine. Copilot
> reads this file, spawns two sub-agents (Alice and Bob), and drives
> the full multi-agent collab v1 surface end-to-end against your real
> Microsoft account. You only intervene at the explicitly-marked yellow
> checkpoints.
>
> **Pre-requisites:** Copilot CLI installed (`copilot --version`); a
> Microsoft account with OneDrive (work / school or personal); ability
> to create one OneDrive folder.
>
> **Time budget:** ~30 minutes wall time; ~10 of those are human input
> (8 browser clicks + 1 OneDrive rename, spread across the run).
>
> **Related docs:**
>
> - [`docs/adr/0009-test-persona-override.md`](../adr/0009-test-persona-override.md) — the security model behind `GRAPHDO_AGENT_PERSONA`.
> - [`docs/plans/two-instance-e2e-copilot-prompt.md`](./two-instance-e2e-copilot-prompt.md) — the sub-agent orchestration prompt Copilot must follow.
> - [`docs/plans/collab-v1.md`](./collab-v1.md) — the underlying collab v1 design.

---

## §1 Pre-flight (you do this **once**, before invoking Copilot)

### 1.1 OneDrive setup

1. In OneDrive, create a folder anywhere convenient called
   `graphdo-collab-smoke/`. The `session_init_project` picker now
   supports drilling into subfolders and accepts a pasted OneDrive
   share URL, so the folder can live anywhere in your OneDrive
   tree — but a top-level folder is the simplest path.
2. Inside it, create a single markdown file `spec.md` with at least
   three `##` headings, e.g.:

   ```markdown
   # graphdo collab smoke

   ## Introduction

   Initial intro body.

   ## Methodology

   Initial method body.

   ## Results

   Initial results body.
   ```

3. Right-click the `graphdo-collab-smoke/` folder → **Copy link** →
   note the **share URL**. You will paste this into Bob's
   `session_open_project` form during scenario S2.

### 1.2 Disjoint config directories

Each MCP instance MUST get its own `<configDir>` — the MSAL token
cache, destructive-counts sidecar, and project metadata files cannot
be shared. The instance lock-file in `<configDir>/instance.lock`
refuses startup if you try.

```bash
mkdir -p ~/.graphdo-personas/alice ~/.graphdo-personas/bob
```

### 1.3 Copilot CLI MCP server entries

Add two MCP server entries to your Copilot CLI MCP config (typically
`~/.copilot/mcp.json` or `~/.config/copilot-cli/mcp.json` depending on
version — run `copilot mcp list --help` if unsure):

```json
{
  "mcpServers": {
    "graphdo-alice": {
      "command": "npx",
      "args": ["-y", "@co-native-ab/graphdo-ts"],
      "env": {
        "GRAPHDO_CONFIG_DIR": "/Users/YOU/.graphdo-personas/alice",
        "GRAPHDO_AGENT_PERSONA": "persona:alice"
      }
    },
    "graphdo-bob": {
      "command": "npx",
      "args": ["-y", "@co-native-ab/graphdo-ts"],
      "env": {
        "GRAPHDO_CONFIG_DIR": "/Users/YOU/.graphdo-personas/bob",
        "GRAPHDO_AGENT_PERSONA": "persona:bob"
      }
    }
  }
}
```

Replace `/Users/YOU` with `$HOME` expanded; Copilot CLI does not
expand `~` inside JSON values.

> **Security note:** the `GRAPHDO_AGENT_PERSONA` value changes the
> _label_ collab uses for authorship, leases, and audit. It does NOT
> change the authenticated user — both instances log in as you, and
> Microsoft Graph attributes every actual write to your real account.
> See [ADR-0009](../adr/0009-test-persona-override.md) for the full
> threat model.

### 1.4 Verification

```bash
copilot mcp list
```

Expected: both `graphdo-alice` and `graphdo-bob` appear and report
healthy. Then call `auth_status` against each (e.g. via Copilot's
`/mcp` slash-command or by asking Copilot to call the tool directly):

```
graphdo v0.0.0

WARN: Test persona active: persona:alice (GRAPHDO_AGENT_PERSONA override; real user OID unchanged)

Status: Not logged in
Use the "login" tool to authenticate with Microsoft.
```

The **WARN** line confirms the persona override is wired correctly.
If it is missing, the env var is not propagating — check
`copilot mcp list --verbose` for the env block.

### 1.5 Pre-flight self-check

The orchestrator agent (see §3) runs this check before scenario S1
starts. The check refuses the run if any of the following is wrong:

| Check                                                                             | Why                                            |
| --------------------------------------------------------------------------------- | ---------------------------------------------- |
| `auth_status` on `graphdo-alice` shows `WARN: Test persona active: persona:alice` | confirms env var propagated                    |
| `auth_status` on `graphdo-bob` shows `WARN: Test persona active: persona:bob`     | confirms env var propagated                    |
| Alice and Bob report **different** persona ids                                    | guards against the single-persona misconfig    |
| Alice and Bob report **distinct config dirs**                                     | enforced by `instance.lock` but checked too    |
| Both instances report `Status: Not logged in`                                     | clean slate; tokens cleared from previous runs |

If any check fails, the orchestrator prints a `🔴 ISSUE` block and
stops. Re-running after correcting the config is safe — the lock-file
recovers stale PIDs automatically.

---

## §2 Run (one command)

Paste exactly this into Copilot CLI:

```
Read docs/plans/two-instance-e2e.md and execute the playbook end to end.
Use the sub-agent orchestration described in docs/plans/two-instance-e2e-copilot-prompt.md.
Write the results file to ~/.graphdo-personas/results-<UTC-ISO>.md.
Stop on the first 🔴 ISSUE; never auto-retry; never bypass 🟡 HUMAN INPUT NEEDED checkpoints.
```

Copilot's orchestrator agent will then execute the scenarios in §4 in
order, spawning sub-agents that may **only** call tools on their
assigned MCP server. The orchestrator is the only agent that may
print `🟡` blocks, write the results file, or escalate `🔴` issues.

---

## §3 Sub-agent orchestration (read by Copilot)

This section is also the canonical content of
[`two-instance-e2e-copilot-prompt.md`](./two-instance-e2e-copilot-prompt.md);
the prompt file is a self-contained extract that you can drop into a
Copilot custom-agent definition without dragging the rest of the
playbook with it.

### 3.1 Roles

| Role             | May call tools on    | May print 🟡 / 🔴 blocks | May write results file  |
| ---------------- | -------------------- | ------------------------ | ----------------------- |
| **orchestrator** | none directly        | yes (only allowed role)  | yes (only allowed role) |
| **alice-agent**  | `graphdo-alice` only | no                       | no                      |
| **bob-agent**    | `graphdo-bob` only   | no                       | no                      |

The orchestrator coordinates: it dispatches each scenario's tool calls
to the correct sub-agent, collects the result, decides PASS / FAIL,
emits the formatted block, appends to the results file, and decides
whether to advance to the next scenario or stop.

**Sub-agent dispatch is mandatory.** The orchestrator MUST spawn
`alice-agent` and `bob-agent` via Copilot CLI's `task` tool (typically
as `general-purpose` agents in `mode: "background"`) and route every
MCP tool call through them. The orchestrator MUST NOT call a
`graphdo-alice-*` or `graphdo-bob-*` tool itself, even when the call
is "obvious" or "trivial" (e.g. `auth_status`). Each dispatch is a
focused prompt to the sub-agent of the form:

> "Call `graphdo-alice-<tool>` with arguments `<X>`. Return the
> verbatim tool result. Do not retry."

If the orchestrator cannot find a sub-agent for the target instance,
spawn one before proceeding — never fall back to a direct call.

### 3.2 Tool-roster gate after every login

Some MCP servers register additional tools only after authentication
completes. The orchestrator MUST re-enumerate the available tool list
for each instance immediately after its `login` call returns, and MUST
NOT advance to S2 until both rosters include every tool listed in
playbook §4 S2-S10. Acceptable verification methods, in order of
preference:

1. Inspect `<tools_changed_notice>` system messages emitted by the
   Copilot CLI runtime since the previous turn.
2. Ask the relevant sub-agent (`alice-agent` / `bob-agent`) to list
   the tools it can call on its bound MCP server and return the list
   verbatim.
3. As a last resort, call a known no-op tool (e.g. `auth_status`) via
   the sub-agent to trigger any pending tool-list refresh.

If the expected tools are still absent after a successful login, that
is a 🔴 ISSUE. **Never** conclude tools "do not exist" based on a
roster snapshot taken before login completed — that has caused at
least one false abort.

### 3.3 Block formats

**Human-input checkpoint:**

```
🟡 HUMAN INPUT NEEDED
scenario: <id>
instance: <graphdo-alice|graphdo-bob>
action: <one-sentence imperative for the human>
url: <loopback URL when applicable, otherwise n/a>
blocking: yes
```

**Issue (failure):**

```
🔴 ISSUE
scenario: <id>
step: <tool name + which sub-agent>
expected: <one sentence>
actual: <one sentence + tool error text>
evidence: |
  <last ~30 lines of stderr / audit JSONL / tool output>
suggested-fix: <which file / module to look at>
```

### 3.4 Stop conditions

- First 🔴 ISSUE → stop, print summary, exit non-zero.
- Any unexpected tool result → 🔴 ISSUE.
- Any human declines a 🟡 prompt → mark the scenario `SKIPPED-HUMAN-DECLINED`, continue to next scenario.
- Never auto-POST to a loopback `/select` endpoint to satisfy a 🟡 prompt — the human must click the browser button.
- The orchestrator calling a `graphdo-*` tool directly (instead of via a sub-agent) → 🔴 ISSUE labelled `protocol-violation`; the run is invalid and must be re-started.
- Concluding "tool not implemented" without first completing the §3.2 tool-roster gate → 🔴 ISSUE labelled `false-negative-tool-detection`.

### 3.5 Output contract

The orchestrator writes
`~/.graphdo-personas/results-<UTC-ISO>.md` containing one section per
scenario in the form:

```
## S<N> <short title>
status: PASS | FAIL | SKIPPED-HUMAN-DECLINED
duration: <seconds>
trace:
  - alice-agent → graphdo-alice.<tool>(<args>) → <one-line result>
  - bob-agent   → graphdo-bob.<tool>(<args>)   → <one-line result>
audit-envelopes:
  - <last 1–3 envelopes from the relevant audit JSONL>
issues: <none | reference to 🔴 block above>
```

A final section lists every 🔴 block in execution order plus a
copy-paste GitHub Issues template for filing them.

---

## §4 Scenarios

> All scenarios assume `auth_status` on each instance reports
> `Status: Not logged in` at the start of S1, and `Logged in` from
> S2 onwards until S10.

### S1 — Login both instances

| who         | tool    | args | expected                                                                |
| ----------- | ------- | ---- | ----------------------------------------------------------------------- |
| alice-agent | `login` | `{}` | tool returns success URL; **🟡 HUMAN INPUT NEEDED** for browser sign-in |
| bob-agent   | `login` | `{}` | same as Alice; second browser window                                    |

After both 🟡 prompts complete, orchestrator calls `auth_status` on
each side and verifies `Status: Logged in` plus the persona WARN line
remains present.

**🟡 HUMAN INPUT NEEDED ×2** — complete browser sign-in for each
instance against the **same** Microsoft account.

### S2 — Onboard same project from two instances

| who         | tool                   | args                                           | expected                                                                  |
| ----------- | ---------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| alice-agent | `session_init_project` | `{}` then click folder + file pickers          | sentinel written; `agentId: persona:alice` in success text                |
| bob-agent   | `session_open_project` | `{}` then paste the share URL from §1.1 step 3 | session activated; `Agent ID: persona:bob`; sentinel pin recorded locally |

**🟡 HUMAN INPUT NEEDED ×3** — two browser pickers for Alice (folder
then file) + one URL paste for Bob.

### S3 — Different sections, no conflict

| who         | tool                     | args                                               | expected                       |
| ----------- | ------------------------ | -------------------------------------------------- | ------------------------------ |
| alice-agent | `collab_acquire_section` | `{ sectionId: "Methodology", leasesCTag: "" }`     | acquired                       |
| bob-agent   | `session_status`         | `{}`                                               | leasesCTag captured            |
| bob-agent   | `collab_acquire_section` | `{ sectionId: "Results", leasesCTag: <captured> }` | acquired; `activeLeases: 2`    |
| alice-agent | `collab_write`           | rewrite the Methodology body                       | success; no destructive prompt |
| bob-agent   | `collab_write`           | rewrite the Results body                           | success; no destructive prompt |

Audit on both sides records `agentId: persona:alice` / `persona:bob`
respectively, both with the same `userOid`. **No 🟡 prompts.**

### S4 — Same-section cTag conflict → proposal fallback

| who         | tool                    | args                                                                          | expected                                                          |
| ----------- | ----------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| alice-agent | `collab_write`          | edit `## Introduction` (orchestrator captures the new authoritative cTag)     | success; `agentId: persona:alice` in the new authorship entry     |
| bob-agent   | `collab_write`          | edit `## Introduction` with the **stale** cTag and `conflictMode: "proposal"` | success with `kind: diverted`; new proposal id                    |
| alice-agent | `collab_apply_proposal` | apply Bob's proposal                                                          | destructive form opens (because the section's last author is Bob) |

**🟡 HUMAN INPUT NEEDED ×1** — click **Approve** in the destructive
re-prompt form. The diff shown should attribute the prior author to
`persona:bob`.

### S5 — Lease handoff

| who         | tool                     | args                                                   | expected                                                                               |
| ----------- | ------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| alice-agent | `collab_release_section` | `{ sectionId: "introduction", leasesCTag: <current> }` | released                                                                               |
| bob-agent   | `session_status`         | `{}`                                                   | new leasesCTag                                                                         |
| bob-agent   | `collab_acquire_section` | `{ sectionId: "introduction", leasesCTag: <new> }`     | acquired (now held by `persona:bob`)                                                   |
| bob-agent   | `collab_write`           | rewrite introduction                                   | success; **no destructive prompt** because Alice's prior write was just ratified by S4 |
| bob-agent   | `collab_release_section` | release introduction                                   | released                                                                               |

**No 🟡 prompts.**

### S6 — Sentinel tamper detected

For the manual run, the orchestrator instructs the human to
**rename the authoritative `spec.md` in OneDrive web** (right-click →
Rename → `spec-renamed.md` → Enter), then revert the rename after the
test. This triggers `§3.5 path C` — sentinel `authoritativeFileId` no
longer matches the local pin.

| who         | tool          | args | expected                                                 |
| ----------- | ------------- | ---- | -------------------------------------------------------- |
| alice-agent | `collab_read` | `{}` | `SentinelTamperedError` (authoritative file id mismatch) |
| bob-agent   | `collab_read` | `{}` | `SentinelTamperedError`                                  |

**🟡 HUMAN INPUT NEEDED ×2** — rename `spec.md` to `spec-renamed.md`,
then after the orchestrator records both errors, rename it back.

### S7 — Renewal caps

| who       | tool                | args | expected                                                                |
| --------- | ------------------- | ---- | ----------------------------------------------------------------------- |
| bob-agent | `session_renew` ×3  | `{}` | each opens a browser approval form; **🟡 ×3** human approves; success   |
| bob-agent | `session_renew` (4) | `{}` | refused with `RenewalCapPerSessionError` **without** opening a 4th form |

**🟡 HUMAN INPUT NEEDED ×3** — click **Approve** in the renewal form
three times.

### S8 — Restore version

| who         | tool                     | args                      | expected                                                        |
| ----------- | ------------------------ | ------------------------- | --------------------------------------------------------------- |
| alice-agent | `collab_list_versions`   | `{}`                      | list of revisions; pick the oldest visible                      |
| alice-agent | `collab_restore_version` | `{ versionId: <oldest> }` | destructive form opens; **🟡** human approves; restore succeeds |
| bob-agent   | `collab_read`            | `{}`                      | body matches the restored revision; `eTag`/cTag updated         |

**🟡 HUMAN INPUT NEEDED ×1.**

### S9 — Delete a draft

| who       | tool                 | args                                         | expected                                                         |
| --------- | -------------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| bob-agent | `collab_write`       | create `drafts/bob-scratch.md` with any text | success                                                          |
| bob-agent | `collab_delete_file` | `{ path: "drafts/bob-scratch.md" }`          | destructive form opens; **🟡** human approves; deletion succeeds |
| bob-agent | `collab_list_files`  | `{ prefix: "/drafts" }`                      | `bob-scratch.md` no longer present                               |

**🟡 HUMAN INPUT NEEDED ×1.**

### S10 — Logout both, sentinel survives

| who          | tool           | args | expected                                                                           |
| ------------ | -------------- | ---- | ---------------------------------------------------------------------------------- |
| alice-agent  | `logout`       | `{}` | success; `auth_status` reports `Not logged in`                                     |
| bob-agent    | `logout`       | `{}` | same                                                                               |
| orchestrator | (manual check) | n/a  | `.collab/project.json` and `.collab/leases.json` still exist in OneDrive untouched |

**No 🟡 prompts** (logout opens the browser confirmation page on a
best-effort basis; close it when you see it).

---

## §5 Total human input summary

| scenario | input                                                          | count |
| -------- | -------------------------------------------------------------- | ----- |
| S1       | Browser sign-in × 2 instances                                  | 2     |
| S2       | Folder picker + file picker for Alice; share-URL paste for Bob | 3     |
| S4       | Approve destructive re-prompt for proposal apply               | 1     |
| S6       | Rename `spec.md` in OneDrive, then revert                      | 2     |
| S7       | Approve renewal form ×3                                        | 3     |
| S8       | Approve restore-version destructive prompt                     | 1     |
| S9       | Approve draft-delete destructive prompt                        | 1     |

Total: ~13 interactive moments spread across ~30 minutes. Most of the
run is the orchestrator working autonomously between checkpoints —
walk away from the keyboard during the long stretches.

---

## §6 What success looks like

At the end of a clean run the results file contains 10 sections all
marked `PASS`, no `🔴 ISSUE` blocks, and a final summary like:

```
## Summary
- 10 / 10 scenarios passed
- 0 issues
- duration: 28m 14s
- audit envelopes captured: 47 (alice: 24, bob: 23)
- distinct agentIds observed in audit: { "persona:alice", "persona:bob" }
- distinct userOids observed in audit: 1 (your real user)
```

If you see this, the two-instance collab path is healthy on your
machine. If you see any 🔴 block, file an issue using the template at
the bottom of the results file (the orchestrator generates one
automatically for each failure).
