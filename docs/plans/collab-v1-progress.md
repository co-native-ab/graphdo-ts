# Collab v1 progress

Last updated: W0 Days 4–5 — first smoke run (Linux dev box + GitHub Copilot CLI) green on S1–S7; S8 + Claude Desktop / VS Code Copilot deferred as follow-ups
Current milestone: W0 Days 4–5 — buffer (smoke partially complete; ready to enter W1 with deferred follow-up smokes tracked)
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

| Milestone   | Branch                                   | PR        | Started    | Sub-status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------- | ---------------------------------------- | --------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W0 Days 4–5 | `copilot/continue-collab-implementation` | _this PR_ | 2026-04-19 | Buffer days. The §5.4 hardening test rows landed in PRs #34 and #35 are already at the `~320 LOC` figure called for in `collab-v1.md` §11 (W0 hardening test correction), so the buffer has been spent on (a) publishing [`cross-host-browser-smoke.md`](./cross-host-browser-smoke.md) and (b) running it. **First smoke run — 2026-04-19, Linux dev box + GitHub Copilot CLI + system default browser:** S1 login happy path ✅ (zero CSP console errors at `127.0.0.1:46781/`, success page rendered, `simon@co-native.com` returned; tab does not auto-close because the page wasn't `window.open`-ed — expected); S2 login cancel ✅; S3 DNS-rebinding sanity ✅ (forged `POST /cancel` with `Host: evil.example` → `403 Forbidden: invalid Host header`; legitimate sign-in still completed afterward); S4 `todo_select_list` happy path ✅ (`config.json` updated atomically); S5 `todo_select_list` cancel ✅ (`config.json` unchanged); S6 form-busy lock ✅ (second `todo_select_list` returned `Another approval form is already open at http://127.0.0.1:46133 (todo_select_list).`; lock released after first picker completed); S7 logout ✅ (branded confirmation page; subsequent login required fresh interactive sign-in); S8 headless fallback ⏭️ deferred (not applicable to this desktop run). **Deferred follow-up smokes (W5 Day 5 will re-run the full matrix):** Claude Desktop on macOS+Win, VS Code Copilot on macOS+Win, S8 headless. **Findings to track (not failures):** (1) `logout` does not acquire the form-busy slot — only `login` and `todo_select_list` do — so a concurrent logout while a picker is in flight opens a separate confirmation page rather than surfacing `FormBusyError`; needs a design discussion / ADR follow-up on whether `logout` should participate in the lock. (2) GitHub Copilot CLI exposes the todo / markdown tools conditionally after login (visible via `tools_changed_notice`); future tests that interleave them with login/logout in that host need to account for the visibility transition. No source/behavioural code changes in this PR. |

## Not started

Remaining milestones from `collab-v1.md` §9, in order. Each links
back to its DoD in the plan.

### Week 0 (prerequisite hardening)

- [x] **W0 Day 1** — `escapeHtml` helper + template audit _(complete in [#33](https://github.com/co-native-ab/graphdo-ts/pull/33))_
- [x] **W0 Day 2** — Loopback hardening on `src/picker.ts` and `src/loopback.ts` _(complete in [#34](https://github.com/co-native-ab/graphdo-ts/pull/34))_
- [x] **W0 Day 3** — Form-factory module (`src/tools/collab-forms.ts`) _(complete in [#35](https://github.com/co-native-ab/graphdo-ts/pull/35))_
- [x] **W0 Days 4–5** — buffer (cross-host browser smoke per [`cross-host-browser-smoke.md`](./cross-host-browser-smoke.md); first run green on Linux + GitHub Copilot CLI; Claude Desktop / VS Code Copilot / S8 headless deferred to W5 Day 5)

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

## Smoke run log

Append one row per cross-host browser smoke run. Reference:
[`cross-host-browser-smoke.md`](./cross-host-browser-smoke.md).

| Date       | Host               | OS    | Browser        | Result                   | Notes                                                                                                                                                                                                             |
| ---------- | ------------------ | ----- | -------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-04-19 | GitHub Copilot CLI | Linux | system default | S1–S7 ✅, S8 ⏭️ deferred | Findings F1 + F2 below. DNS-rebinding sanity (S3) returned `403 Forbidden: invalid Host header` against the live loopback — §5.4 Host pin verified end-to-end. Picker port observed 46781 (login) / 46133 (todo). |

### Open follow-ups from smoke runs

- **F1 — `logout` does not acquire the form-busy slot.** Only
  `login` and `todo_select_list` acquire via `acquireFormSlot`
  (see `src/tools/login.ts` and `src/tools/config.ts`); `logout`
  opens its branded confirmation page outside the lock. Concurrent
  `logout` while a picker is in flight therefore opens a second
  browser page instead of returning `FormBusyError`. Needs a
  design discussion: should `logout` participate in the lock for
  consistency, or is "logout always wins" the intended UX? Capture
  the resolution as an ADR if non-trivial. Tracked for W1 review.
- **F2 — Conditional tool exposure in GitHub Copilot CLI.** That
  host exposes the todo / markdown tools only after login, surfaced
  via a `tools_changed_notice`. Not a defect — but any future
  collab integration test or smoke matrix that interleaves those
  tools with `login` / `logout` in Copilot CLI needs to wait for
  the notice before assuming the tool list is stable.

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
