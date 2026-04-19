# Collab v1 progress

Last updated: W3 Day 1 — `collab_write` Graph helper
Current milestone: W3 Day 1 — `collab_write` Graph helper (this PR)
Next milestone: W3 Day 2 — `collab_write` tool registration + `source` parameter

This file is the single source of truth for "where are we?" in the
collab v1 build-out. It is updated **in the same PR as each
milestone ships** (see `collab-v1.md` §12.3). Anyone picking up the
work reads this file first.

## Completed

| Milestone   | PR                                                        | Merged | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | --------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W0 Day 1    | [#33](https://github.com/co-native-ab/graphdo-ts/pull/33) | merged | `src/templates/escape.ts` extracted; `login.ts` and `picker.ts` re-pointed; `escapeHtml` removed from `styles.ts`; `test/templates/escape.test.ts` + picker XSS rows added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| W0 Day 2    | [#34](https://github.com/co-native-ab/graphdo-ts/pull/34) | merged | `src/loopback-security.ts` (CSRF, header pins, hardened CSP); `picker.ts` + `loopback.ts` enforce Host/Origin/Sec-Fetch-Site/Content-Type pins + per-request CSP nonce; `landingPageHtml`/`pickerPageHtml`/`layoutHtml` thread `csrfToken` + `nonce`. New `test/loopback-security.test.ts` + §5.4 hardening rows on `test/picker.test.ts` + `test/loopback.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| W0 Day 3    | [#35](https://github.com/co-native-ab/graphdo-ts/pull/35) | merged | `src/tools/collab-forms.ts` form-factory with module-level single-flight slot + `try { ... } finally { slot.release() }` contract; `FormBusyError` (`src/errors.ts`) carries the in-flight URL + kind. `login` and `todo_select_list` migrated to acquire the slot around their browser flows. New `test/tools/collab-forms.test.ts` covers the §8 row-18 lock-release matrix (submit / cancel / timeout / transport abort / uncaught exception) against an early-stub form.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| W0 Days 4–5 | _(buffer — see "Smoke run log")_                          | merged | Buffer days. Cross-host browser smoke checklist published (`cross-host-browser-smoke.md`); first smoke run green on Linux + GitHub Copilot CLI for S1–S7. Two findings (F1 — `logout` form-busy slot; F2 — Copilot CLI conditional tool exposure) tracked below. F1 resolved before W1 Day 1 landed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| W1 Day 1    | [#38](https://github.com/co-native-ab/graphdo-ts/pull/38) | merged | `userOid` plumbing complete: `AccountInfo.userOid` added; `MsalAuthenticator.login` requires + persists `idTokenClaims.oid`; `accountInfo()` surfaces it; `auth_status` prints `User OID:`; ADR-0006 written. `MockAuthenticator` accepts an optional `userOid`. New `test/auth.test.ts` rows: explicit `userOid === idTokenClaims.oid` DoD assertion + missing-`oid` rejection + legacy `account.json` rejection. `npm run check` green (729 → 732 tests, +3 new).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| W1 Day 2    | [#39](https://github.com/co-native-ab/graphdo-ts/pull/39) | merged | `ServerConfig.now?: () => Date` plumbed (default `() => new Date()` in `main()`). New `src/collab/sentinel.ts` carries the strict Zod schema for `.collab/project.json`, pure `parseSentinel`/`serializeSentinel` codec, Graph helpers `readSentinel`/`writeSentinel` (`@microsoft.graph.conflictBehavior=fail` on the write), and the rename-tolerant `verifySentinelAgainstPin` comparator. `SentinelTamperedError` added to `src/errors.ts` carrying pinned vs. live `authoritativeFileId` + pinned-at timestamp. New `test/collab/sentinel.test.ts` (round-trip + strict-schema rejection + comparator) and `test/integration/15-sentinel-tamper-detected.test.ts` (Variant A passes; B/C `it.todo` pending W4 Day 4). `npm run check` green (732 → 753 tests, +21 new; 2 todo).                                                                                                                                                                                                                                                                 |
| W1 Day 3    | [#40](https://github.com/co-native-ab/graphdo-ts/pull/40) | merged | Module skeleton landed: `src/collab/ulid.ts` (Crockford-base32 generator with deterministic clock injection), `src/collab/projects.ts` (strict Zod schemas + atomic writers for `<configDir>/projects/<projectId>.json` and `recent.json`), `src/collab/graph.ts` (`listRootMarkdownFiles`, `findChildFolderByName`, `createChildFolder`, `getDriveItem`). New `session_init_project` MCP tool (`src/tools/session.ts`, Files.ReadWrite scope-gated, acquires the W0 form-factory slot, single-root-md happy path; multi-md → W1 Day 4). Empty `src/tools/collab.ts` skeleton wired into `src/index.ts`. Mock Graph extended with `POST /me/drive/items/{id}/children` create-folder + `conflictBehavior=fail`. `NoMarkdownFileError` + `ProjectAlreadyInitialisedError` added to `src/errors.ts`. New `test/integration/01-init-write-read-list.test.ts` (3 happy/error rows + 2 `it.todo` for downstream `collab_*` tools), `test/collab/ulid.test.ts`, `test/collab/projects.test.ts`. `npm run check` green (753 → 776 tests, +21 new + 2 todo). |
| W1 Day 4    | [#41](https://github.com/co-native-ab/graphdo-ts/pull/41) | merged | Multi-root-md handling. `runInitProject` now opens a second browser picker (W0 form-factory slot, slot URL re-pointed) for the authoritative `.md` file selection — shown for every folder with ≥1 root `.md` files (zero-`.md` continues to throw `NoMarkdownFileError`; the multi-md interim "future version" message is gone). Picker option-set check rejects any submitted id that is not in the file list. Tool description + opening message updated to reflect the two-form flow. New `test/integration/16-multiple-root-md.test.ts` covers N=1, N=3, and a smuggle test. `npm run check` green (764 → 767 tests, +3 new).                                                                                                                                                                                                                                                                                                                                                                                                                   |

| W1 Day 5 | [#42](https://github.com/co-native-ab/graphdo-ts/pull/42) | merged | `session_status` MCP tool + in-memory `SessionRegistry` (`src/collab/session.ts`) + destructive-counter persistence helper (`src/collab/session-counts.ts`, `<configDir>/sessions/destructive-counts.json`, §3.7 — strict Zod schema, atomic write, lazy-prune of entries with `expiresAt < now - 24h`). `ServerConfig.sessionRegistry` plumbed; `session_init_project` now refuses (`SessionAlreadyActiveError`) when a session already exists, then activates one with §5.2.1 defaults (TTL 2h, write 50, destructive 10) on success. New `test/collab/session.test.ts` + `test/integration/session-status.test.ts`. `npm run check` green (767 → 792 tests, +25 new). |

| W2 Day 1 | [#43](https://github.com/co-native-ab/graphdo-ts/pull/43) | merged | Frontmatter codec landed. `yaml ~2.8.0` runtime dep, `src/collab/frontmatter.ts` strict Zod schema + hardened parser + deterministic emitter + envelope helpers, `test/collab/frontmatter.test.ts` (27 rows) + `test/collab/frontmatter-snapshot.test.ts` (4 rows), ADR-0008. `npm run check` green (792 → 823 tests, +31 new). |

| W2 Day 2 | [#44](https://github.com/co-native-ab/graphdo-ts/pull/44) | merged | Read-path codec helpers for the §3.1 `doc_id` stability contract. `DocIdRecoveryRequiredError` (typed-error table §2.6, carries `nextStep: "session_recover_doc_id"`) + `DocIdAlreadyKnownError` (informational, §2.2) added to `src/errors.ts`. `src/collab/frontmatter.ts` extended with `readMarkdownFrontmatter` (returns `{ kind: "parsed" }` or `{ kind: "reset", reason: "missing" \| "malformed" }` with body preserved + LF-normalised; `parseError` surfaced for diagnostic logging only), `resolveDocId` (frontmatter wins; otherwise local-cache fallback; otherwise throws), and the typed `FrontmatterResetAudit` envelope shape consumed by the W3 Day 3 audit writer. New `test/collab/frontmatter-recovery.test.ts` (13 rows). `test/integration/04-frontmatter-stripped.test.ts` scaffolded with three `it.todo` rows (lit up alongside `collab_read` W2 Day 4 + `collab_write` W3 Day 2 + the §3.6 audit writer W3 Day 3). `npm run check` green (823 → 836 tests, +13 new + 3 todo). |

| W2 Day 3 | [#45](https://github.com/co-native-ab/graphdo-ts/pull/45) | merged | §4.6 scope resolution algorithm landed in full. New `OutOfScopeError` (typed-error table §2.6, carries `attemptedPath` + 19-value `OutOfScopeReason` enum + optional `resolvedItemId`) in `src/errors.ts`. New `src/collab/scope.ts` exports `validateScopedPathSyntax` (steps 1–5: pre-resolution refusals, single URL-decode, NFC/NFKC equality, segment validation, layout enforcement with depth rules per group) and `resolveScopedPath` (full algorithm: byId path resolution at `/me/drive/items/{folderId}:/{joined}:`, ancestry walk capped at N=8, `remoteItem` / `cross_drive` / `case_aliasing` defences). `DriveItem` schema extended with `parentReference.{id,driveId}` + `remoteItem` so the post-resolution checks can read them. Mock Graph extended with byPath GET (case-insensitive segment match like real OneDrive), full ancestor-aware `parentReference` on every drive-item view, and an append-only `requestLog` so tests can assert on call patterns. New `test/collab/scope.test.ts` (40 rows covering steps 1–5) + `test/integration/08-scope-traversal-rejected.test.ts` (18 rows: 12 zero-Graph-call refusal reasons + 3 post-resolution defences + 3 happy paths; tool-layer row lands with W2 Day 4). `npm run check` green (836 → 894 tests, +58 new). |

| W2 Day 4 | [#46](https://github.com/co-native-ab/graphdo-ts/pull/46) | merged | `collab_read` + `collab_list_files` landed. New `src/collab/graph.ts` helpers: `getDriveItemContent` (4 MiB guard via `MarkdownFileTooLargeError`), `listChildren` promoted to export, `walkAttachmentsTree` (depth-capped at 8). New MCP tools in `src/tools/collab.ts`: `collab_read` (path or itemId, authoritative frontmatter envelope, scope-checked), `collab_list_files` (ROOT/PROPOSALS/DRAFTS/ATTACHMENTS groups, `[authoritative]` marker, `.collab/` exclusion, 500-entry breadth cap with truncation). New `SessionExpiredError`, `FileNotFoundError`, `PathLayoutViolationError` in `src/tools/collab.ts`. New `test/collab/graph.test.ts` (8 rows). `test/integration/01-init-write-read-list.test.ts` W2 Day 4 row lit up. `test/integration/08-scope-traversal-rejected.test.ts` tool-layer row lit up. Tool counts updated in `test/integration/login.test.ts` and `test/integration/dynamic-tools.test.ts` (27 → 29). `npm run check` green (894 → 904 tests, +10 new). |

| W2 Day 5 | _(buffer — released unconsumed)_ | n/a | No overflow surfaced from W2 Days 1–4 (all DoDs green, no F-findings open against W2 work). Buffer day **released** — proceeding straight to W3 Day 1. The W3 Day 5 and W5 Day 5 buffers remain available; W6 reserve untouched. Per the W2 Day 4 cross-host smoke note in `cross-host-browser-smoke.md`, S1–S7 are green on Linux + Copilot CLI; the new scope-gated `collab_*` tools have not yet been smoke-tested on a real host but are exercised in-process by `01-init-write-read-list.test.ts` and `08-scope-traversal-rejected.test.ts`. |

## In flight

| Milestone | Branch                                    | PR        | Started    | Sub-status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------- | ----------------------------------------- | --------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W3 Day 1  | `copilot/collab-implementation-milestone` | _this PR_ | 2026-04-19 | `collab_write` Graph helper landed. New `CollabCTagMismatchError` (typed-error table §2.6, carries `itemId`, `suppliedCTag`, `currentCTag`, `currentRevision` (`= currentItem.version`), `currentItem`) in `src/errors.ts`. New helpers in `src/collab/graph.ts`: `writeAuthoritative(itemId, cTag, content, signal)` (byId PUT, `text/markdown`, `If-Match` + `conflictBehavior=replace`, 4 MiB cap, 412 → `CollabCTagMismatchError`) and `writeProjectFile(target, content, signal)` (discriminated `target`: `kind: "create"` byPath with `conflictBehavior=fail` → 409 raises new `ProjectFileAlreadyExistsError`, `kind: "replace"` byId with `If-Match` + `conflictBehavior=replace` → 412 raises `CollabCTagMismatchError`). Three exported MIME constants: `COLLAB_CONTENT_TYPE_MARKDOWN` / `_JSON` / `_BINARY`. Both helpers reuse `MarkdownFileTooLargeError` from `src/graph/markdown.ts`; `writeProjectFile` accepts `string \| Uint8Array`. New rows in `test/collab/graph.test.ts` cover cTag mismatch (412), byPath create (201) + 409 (`ProjectFileAlreadyExistsError`), byId replace (200) + 412, empty-cTag rejection on both helpers, 4 MiB cap on both targets, Uint8Array binary acceptance, byPath name-validation guards (path separators, control chars, `.` / `..`). `npm run check` green (904 → 916 tests, +12 new). |

## Not started

Remaining milestones from `collab-v1.md` §9, in order. Each links
back to its DoD in the plan.

### Week 0 (prerequisite hardening)

- [x] **W0 Day 1** — `escapeHtml` helper + template audit _(complete in [#33](https://github.com/co-native-ab/graphdo-ts/pull/33))_
- [x] **W0 Day 2** — Loopback hardening on `src/picker.ts` and `src/loopback.ts` _(complete in [#34](https://github.com/co-native-ab/graphdo-ts/pull/34))_
- [x] **W0 Day 3** — Form-factory module (`src/tools/collab-forms.ts`) _(complete in [#35](https://github.com/co-native-ab/graphdo-ts/pull/35))_
- [x] **W0 Days 4–5** — buffer (cross-host browser smoke per [`cross-host-browser-smoke.md`](./cross-host-browser-smoke.md); first run green on Linux + GitHub Copilot CLI; Claude Desktop / VS Code Copilot / S8 headless deferred to W5 Day 5)

### Week 1 — auth + scaffolding

- [x] **W1 Day 1** — `userOid` plumbing _(ADR-0006 lands here: `userOid = idTokenClaims.oid`; this PR)_
- [x] **W1 Day 2** — `ServerConfig` extensions + sentinel codec _(this PR; 15 rename variant green, B/C `it.todo` until W4 Day 4)_
- [x] **W1 Day 3** — Module skeleton + `session_init_project` happy path _(this PR; happy + zero-md + already-initialised rows green; multi-md → W1 Day 4)_
- [x] **W1 Day 4** — Multi-root-md handling (`16-multiple-root-md.test.ts`) _(complete in [#41](https://github.com/co-native-ab/graphdo-ts/pull/41))_
- [x] **W1 Day 5** — `session_status` + persisted destructive counter _(complete in [#42](https://github.com/co-native-ab/graphdo-ts/pull/42))_

### Week 2 — read path + scope + frontmatter

- [x] **W2 Day 1** — Frontmatter codec _(complete in [#43](https://github.com/co-native-ab/graphdo-ts/pull/43); ADR-0008 lands here: `yaml ~2.8.0` + deterministic emitter + byte-exact snapshot)_
- [x] **W2 Day 2** — `doc_id` recovery + `frontmatter_reset` audit _(complete in [#44](https://github.com/co-native-ab/graphdo-ts/pull/44); codec helpers `readMarkdownFrontmatter` + `resolveDocId` + `FrontmatterResetAudit` + `DocIdRecoveryRequiredError`/`DocIdAlreadyKnownError`; integration test 04 scaffolded as `it.todo` until `collab_read` W2 Day 4 + `collab_write` W3 Day 2 + audit writer W3 Day 3 land)_
- [x] **W2 Day 3** — Scope resolution algorithm (§4.6 in full) _(complete in [#45](https://github.com/co-native-ab/graphdo-ts/pull/45); `src/collab/scope.ts` + `OutOfScopeError` + 19-value `OutOfScopeReason` enum; `test/integration/08-scope-traversal-rejected.test.ts` covers 12 zero-Graph-call refusal reasons + 3 post-resolution defences + 3 happy paths; tool-layer wiring landed with `collab_read` in W2 Day 4)_
- [x] **W2 Day 4** — `collab_read` + `collab_list_files` _(complete in [#46](https://github.com/co-native-ab/graphdo-ts/pull/46); `src/tools/collab.ts` + scope wrapper + new graph helpers in `src/collab/graph.ts`; `test/integration/01-init-write-read-list.test.ts` + `test/integration/08-scope-traversal-rejected.test.ts` tool-layer rows lit up)_
- [x] **W2 Day 5** — buffer _(released unconsumed — no overflow surfaced from W2 Days 1–4)_

### Week 3 — write path

- [x] **W3 Day 1** — `collab_write` Graph helper _(this PR; `writeAuthoritative` + `writeProjectFile` in `src/collab/graph.ts`; new `CollabCTagMismatchError` + `ProjectFileAlreadyExistsError`; `test/collab/graph.test.ts` covers cTag mismatch, byPath create + 409, byId replace + 412, 4 MiB cap, binary content)_
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

| Date       | Host               | OS    | Browser        | Result                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | ------------------ | ----- | -------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-04-19 | GitHub Copilot CLI | Linux | system default | S1–S7 ✅, S8 ⏭️ deferred | Findings F1 + F2 below. DNS-rebinding sanity (S3) returned `403 Forbidden: invalid Host header` against the live loopback — §5.4 Host pin verified end-to-end. Picker port observed 46781 (login) / 46133 (todo).                                                                                                                                                                                                                                                                                            |
| 2026-04-19 | GitHub Copilot CLI | Linux | system default | S7a ✅ (both orderings)  | F1 fix verification re-run on the rebuilt bundle (commit `f9b2715`). Picker-in-flight → `logout` returned `Another approval form is already open at http://127.0.0.1:41291 (todo_select_list).`; logout-in-flight → `todo_select_list` returned `Another approval form is already open (still starting) (logout).` (the second tool fired before the logout loopback finished binding, confirming the slot is held during startup). Lock released cleanly after each in-flight form was completed/cancelled. |

### Open follow-ups from smoke runs

- **F1 — `logout` does not acquire the form-busy slot.** _Resolved._
  `src/tools/login.ts` now wraps the `logout` handler in
  `acquireFormSlot("logout")` around the call into
  `MsalAuthenticator.logout` (which opens the branded
  confirmation page). A concurrent `logout` while a picker /
  login is in flight now returns `FormBusyError` carrying the
  in-flight URL instead of opening a second browser tab. The
  cheap "Not logged in" pre-check stays outside the slot since
  it never opens a browser. New integration tests in
  `test/integration/login.test.ts` cover both paths. The smoke
  checklist gains S7a to exercise the cross-tool case
  manually. No ADR required — this is a straightforward
  consistency fix; the §5.3 single-in-flight contract already
  documents the intent. Verified end-to-end by the S7a smoke
  on 2026-04-19 in both orderings (picker → logout and
  logout → picker); see the smoke run log row for the exact
  error strings observed.
- **F2 — Conditional tool exposure in GitHub Copilot CLI.** _Documented._
  Captured in `cross-host-browser-smoke.md` under the
  pre-flight "GitHub Copilot CLI tool visibility" note so
  future smoke runs explicitly wait for `tools_changed_notice`
  before interleaving scope-gated tools with login/logout. No
  source change — this is intended dynamic-tools behaviour.

## ADR ledger

ADRs accumulate under `docs/adr/`. The current set:

- **ADR-005** — Decision log (the 20 locked decisions from the
  three review rounds). Bootstrap; lands in this PR.
- **ADR-006** — `userOid = idTokenClaims.oid` _(merged in [#38](https://github.com/co-native-ab/graphdo-ts/pull/38) — codifies decision 15 with the actual code change that surfaces `idTokenClaims.oid` via `Authenticator.accountInfo`)_.
- **ADR-007** — Validated Graph IDs (branded `string` newtype). Lifts ID validation into the type system; landed alongside the W1 Day 3 module skeleton.
- **ADR-008** — Frontmatter codec: `yaml` pinned at `~2.x.y` with hardened parser, deterministic emitter, and byte-exact snapshot test _(this PR — codifies the §6 dependency policy and §3.1 determinism contract for `src/collab/frontmatter.ts`)_.

Subsequent ADRs are added as decisions are made; each lands in the
same PR as the code change that embodies it.

## Handoff notes

If you are picking up this work mid-flight, follow the handoff
contract in `collab-v1.md` §12.5. The "In flight" table above
should describe the exact sub-step the previous engineer reached
and what the next step is — concretely, not "partway through W2
Day 3".
