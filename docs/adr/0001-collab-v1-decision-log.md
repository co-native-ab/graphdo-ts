# ADR-001: collab v1 decision log

- **Status:** Accepted
- **Date:** 2026-04-19 (bootstrap of `feat/collab-v1`)
- **Amends:** `docs/plans/collab-v1.md` — anchors the 20 cross-cutting decisions reached over three review rounds.

## Context

The collab v1 plan went through three rounds of human review.
Each round closed with an explicit decision on a contested point
(or a deliberate non-decision deferred to v2). Those decisions are
scattered across `collab-v1.md`'s body. This ADR consolidates them
into one place so they survive even if a future reviewer skims the
plan.

This ADR is **bootstrap**: it does not introduce new decisions, it
records the ones already settled. Subsequent ADRs (002+) record
decisions made during implementation.

## Decision

The following 20 decisions are locked for v1. Each is followed by
the section of `collab-v1.md` that elaborates on it.

1. **Agent lies about `source` are out of scope for runtime
   enforcement.** Audit-log post-hoc review is the surface. (§0
   threat model; §2.3 `collab_write` source policy)
2. **Frontmatter is untrusted for authorization.** UI says
   "claimed by", never "verified". (§0 threat model item 4; §3.1
   integrity note)
3. **`cTag`, not `eTag`.** Consistency with existing
   `markdown_update_file`. (§1.2; §4.2)
4. **Leases live in `.collab/leases.json`, not in authoritative
   frontmatter.** Throughput trumps consolidation; lease cycles
   ship ~16 KB instead of ~8 MiB. (§3.2.1; §2.3)
5. **`doc_id` is stable for the life of the file.** Missing →
   recover via `session_recover_doc_id`; unrecoverable
   (`DocIdUnrecoverableError`) → `session_init_project` against a
   renamed copy. (§2.2; §3.1)
6. **Slug algorithm is GitHub-flavored.** Collisions walk `-1`,
   `-2`, `-3`. Preamble (prose before any heading) gets the
   synthetic slug `__preamble__`. (§3.1 slug rules)
7. **Attachments recursive; proposals/drafts flat.** Subfolder
   under proposals/drafts → `subfolder_in_flat_group` refusal.
   (§4.6 step 5; §2.3 `collab_list_files`)
8. **Client-side enforcement only.** Selected permissions / Graph-
   side enforcement is v2. (§7; §11)
9. **Personal OneDrive only in v1.** SharePoint Teams sites are v2.
   (§0; §11)
10. **Destructive approvals have a separate counter (10/session).**
    Independent of write budget (50/session). (§2.1; §3.7)
11. **Renewal caps: 3/session and 6/user/project/24h rolling
    window.** (§2.2 `session_renew`; §3.5)
12. **No `session_revoke` tool in v1.** Killing the MCP server is
    the only revocation. (§11)
13. **No idle expiry; hard TTL only.** TTL is renewable; idle
    behaviour explicitly out. (§11; §2.2)
14. **Audit JSONL is plain append-only.** No hash chain, no
    signing. Tamper-evidence comes from operator review. (§3.6;
    §0 threat model)
15. **`userOid = idTokenClaims.oid`.** Not `localAccountId` —
    they can differ in multi-tenant and B2B-guest setups, and we
    don't want that ambiguity in audit logs. (§10 OQ-6; W1 Day 1
    DoD; codified by ADR-002 when W1 Day 1 lands.)
16. **Form approvals via browser loopback only.** No MCP
    elicitation. The agent cannot influence the form. (§5; §0)
17. **Mid-session destructive and `source: "external"` ops trigger
    fresh browser re-prompts.** Pre-approval at session-start does
    not cover them. (§5.2.3; §5.2.4)
18. **Write budget counts content-changing operations only.** Reads
    do not count; lease CAS does not count. (§2.1; §2.3)
19. **Session survives MCP transport reconnect within the same OS
    process; dies on process exit.** Matches Claude Desktop's
    transport behaviour. (§9 W5 Day 3 test 19; §1.6)
20. **No `markdown_*` tool changes in v1.** Their handler bodies,
    schemas, and folder-config dependency stay as-is. (§6
    migration; §11)

## Consequences

- These decisions are **frozen** for v1. Any change requires a new
  ADR that explicitly references the item being amended (e.g. an
  ADR titled "ADR-007: revisit decision 4 (leases location)").
- The plan body of `collab-v1.md` is also frozen as of the
  bootstrap of `feat/collab-v1`. Body updates land only via ADR
  amendment per §12.4.
- Future ADRs (002, 003, …) record decisions made during
  implementation. Two are already pre-committed:
  - **ADR-002** at W1 Day 1: codifies decision 15 with the actual
    code change that surfaces `idTokenClaims.oid`.
  - **ADR-003** at W2 Day 1: pins `yaml` at `~2.x.y` and
    introduces the byte-exact snapshot test (per §6 dependency
    policy).
- The progress file (`docs/plans/collab-v1-progress.md`) tracks
  the live state; this ADR ledger tracks the decision history.
  The two files together are the canonical view of the work.
