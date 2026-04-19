# Collab v1 progress

Last updated: W0 Days 4–5 — buffer in flight; cross-host browser smoke checklist published at [`cross-host-browser-smoke.md`](./cross-host-browser-smoke.md)
Current milestone: W0 Days 4–5 — buffer (cross-host browser smoke checklist; absorb any leftover hardening test rows)
Next milestone: W1 Day 1 — `userOid` plumbing (lands ADR-006)

This file is the single source of truth for "where are we?" in the
collab v1 build-out. It is updated **in the same PR as each
milestone ships** (see `collab-v1.md` §12.3). Anyone picking up the
work reads this file first.

## Completed

| Milestone | PR                                                        | Merged | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------- | --------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W0 Day 1  | [#33](https://github.com/co-native-ab/graphdo-ts/pull/33) | merged | `src/templates/escape.ts` extracted; `login.ts` and `picker.ts` re-pointed; `escapeHtml` removed from `styles.ts`; `test/templates/escape.test.ts` + picker XSS rows added.                                                                                                                                                                                                                                                                                                  |
| W0 Day 2  | [#34](https://github.com/co-native-ab/graphdo-ts/pull/34) | merged | `src/loopback-security.ts` (CSRF, header pins, hardened CSP); `picker.ts` + `loopback.ts` enforce Host/Origin/Sec-Fetch-Site/Content-Type pins + per-request CSP nonce; `landingPageHtml`/`pickerPageHtml`/`layoutHtml` thread `csrfToken` + `nonce`. New `test/loopback-security.test.ts` + §5.4 hardening rows on `test/picker.test.ts` + `test/loopback.test.ts`.                                                                                                         |
| W0 Day 3  | [#35](https://github.com/co-native-ab/graphdo-ts/pull/35) | merged | `src/tools/collab-forms.ts` form-factory with module-level single-flight slot + `try { ... } finally { slot.release() }` contract; `FormBusyError` (`src/errors.ts`) carries the in-flight URL + kind. `login` and `todo_select_list` migrated to acquire the slot around their browser flows. New `test/tools/collab-forms.test.ts` covers the §8 row-18 lock-release matrix (submit / cancel / timeout / transport abort / uncaught exception) against an early-stub form. |

## In flight

| Milestone   | Branch                                   | PR        | Started    | Sub-status                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | ---------------------------------------- | --------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W0 Days 4–5 | `copilot/continue-collab-implementation` | _this PR_ | 2026-04-19 | Buffer days. The §5.4 hardening test rows landed in PRs #34 and #35 are already at the `~320 LOC` figure called for in `collab-v1.md` §11 (W0 hardening test correction), so the buffer is being consumed by publishing [`cross-host-browser-smoke.md`](./cross-host-browser-smoke.md) — the manual checklist that gates the W0 → W1 transition (and is re-used at W5 Day 5). No source/behavioural code changes in this PR. |

## Not started

Remaining milestones from `collab-v1.md` §9, in order. Each links
back to its DoD in the plan.

### Week 0 (prerequisite hardening)

- [x] **W0 Day 1** — `escapeHtml` helper + template audit _(complete in [#33](https://github.com/co-native-ab/graphdo-ts/pull/33))_
- [x] **W0 Day 2** — Loopback hardening on `src/picker.ts` and `src/loopback.ts` _(complete in [#34](https://github.com/co-native-ab/graphdo-ts/pull/34))_
- [x] **W0 Day 3** — Form-factory module (`src/tools/collab-forms.ts`) _(complete in [#35](https://github.com/co-native-ab/graphdo-ts/pull/35))_
- [ ] **W0 Days 4–5** — buffer (cross-host browser smoke per [`cross-host-browser-smoke.md`](./cross-host-browser-smoke.md); absorb any leftover hardening test rows)

### Week 1 — auth + scaffolding

- [ ] **W1 Day 1** — `userOid` plumbing _(ADR-006 lands here: `userOid = idTokenClaims.oid`)_
- [ ] **W1 Day 2** — `ServerConfig` extensions + sentinel codec
- [ ] **W1 Day 3** — Module skeleton + `session_init_project` happy path
- [ ] **W1 Day 4** — Multi-root-md handling (`16-multiple-root-md.test.ts`)
- [ ] **W1 Day 5** — `session_status` + persisted destructive counter

### Week 2 — read path + scope + frontmatter

- [ ] **W2 Day 1** — Frontmatter codec _(ADR-007 lands here: `yaml ~2.x.y` + byte-exact snapshot)_
- [ ] **W2 Day 2** — `doc_id` recovery + `frontmatter_reset` audit
- [ ] **W2 Day 3** — Scope resolution algorithm (§4.6 in full)
- [ ] **W2 Day 4** — `collab_read` + `collab_list_files`
- [ ] **W2 Day 5** — buffer

### Week 3 — write path

- [ ] **W3 Day 1** — `collab_write` Graph helper
- [ ] **W3 Day 2** — `collab_write` tool registration + `source` parameter
- [ ] **W3 Day 3** — Audit writer + redaction allow-list
- [ ] **W3 Day 4** — `collab_acquire_section` + `collab_release_section` + leases sidecar codec
- [ ] **W3 Day 5** — buffer

### Week 4 — proposals + open flow

- [ ] **W4 Day 1** — Slug codec + authorship-on-section codec
- [ ] **W4 Day 2** — `collab_create_proposal`
- [ ] **W4 Day 3** — `collab_apply_proposal` (with destructive re-prompt)
- [ ] **W4 Day 4** — `session_open_project` + sentinel pinning + silent folder-path refresh
- [ ] **W4 Day 5** — `session_renew` + renewal caps

### Week 5 — versions + delete + polish

- [ ] **W5 Day 1** — `collab_list_versions` + `collab_restore_version` + `session_recover_doc_id`
- [ ] **W5 Day 2** — `collab_delete_file`
- [ ] **W5 Day 3** — `19-session-survives-reconnect.test.ts` + scope-gate polish + agentId fallback
- [ ] **W5 Day 4** — Documentation (README, CHANGELOG, manifest.json, user-facing notes)
- [ ] **W5 Day 5** — End-to-end `npm run check` + cross-host browser smoke + buffer

### Week 6 — slip absorption (reserve)

- [ ] **W6** — Held in reserve. Consume only if W1–W5 milestones slip.

## Calendar checkpoints

Re-baseline triggers per `collab-v1.md` §9:

- [ ] **End of W1 checkpoint:** if W0 + W1 (10 working days) landed
      on schedule with passing CI, the 6-week realistic calendar
      stands. If slipped by ≥2 days, re-estimate W2–W5 and record
      the amendment as an ADR. Notify stakeholders.
- [ ] **End of W3 checkpoint:** if W2 + W3 added another ≥2 days
      of slip beyond the W1 baseline, do a second re-estimate. If
      the trend is worse than 2× the original at W3, escalate
      (scope cut or add a second engineer for W4 + W5).

No re-baselining beyond W3 — runway is too short.

## ADR ledger

ADRs accumulate under `docs/adr/`. The current set:

- **ADR-005** — Decision log (the 20 locked decisions from the
  three review rounds). Bootstrap; lands in this PR.
- **ADR-006** _(pending W1 Day 1)_ — `userOid = idTokenClaims.oid`.
- **ADR-007** _(pending W2 Day 1)_ — `yaml` pinned at `~2.x.y`
  with byte-exact snapshot test.

Subsequent ADRs are added as decisions are made; each lands in the
same PR as the code change that embodies it.

## Handoff notes

If you are picking up this work mid-flight, follow the handoff
contract in `collab-v1.md` §12.5. The "In flight" table above
should describe the exact sub-step the previous engineer reached
and what the next step is — concretely, not "partway through W2
Day 3".
