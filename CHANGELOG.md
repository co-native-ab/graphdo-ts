# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Collab v1 — collaborative editing on OneDrive project folders.** Fifteen new MCP tools (`session_init_project`, `session_open_project`, `session_status`, `session_renew`, `session_recover_doc_id`, `collab_read`, `collab_list_files`, `collab_write`, `collab_create_proposal`, `collab_apply_proposal`, `collab_acquire_section`, `collab_release_section`, `collab_list_versions`, `collab_restore_version`, `collab_delete_file`) plus the supporting infrastructure:
  - `.collab/project.json` sentinel pinning project id, schema, originator, and authoritative file id; rename-tolerant pin verification on every open
  - Canonical YAML `collab:` frontmatter codec on the authoritative file with deterministic emission, hardened parser, and recovery-on-reset (rebuilds from local cache, audits as `frontmatter_reset`)
  - `session_recover_doc_id` walks `/versions` history (capped at 50) when both the live frontmatter and the local cache are gone
  - Section proposals (`/proposals/<ulid>.md`) with slug-first / content-hash-fallback section anchoring; destructive applies open a browser re-approval form showing a unified diff
  - `.collab/leases.json` advisory section leases (free, lazy-create, 64 KB cap, cTag-CAS)
  - Recursive listing under `attachments/`; flat under `proposals/` and `drafts/`
  - Explicit per-session **write budget** (50), **destructive-approval budget** (10, persisted across renewals), and **TTL** (2h) with `session_renew` rate-limited per session (3) and per rolling 24-hour window per `(userOid, projectId)` (6)
  - `external` content source on `collab_write` and `collab_create_proposal` triggers a browser re-approval form before any Graph round-trip
  - Append-only per-project audit log under `<configDir>/projects/<projectId>/audit.log` (best-effort `O_APPEND`, 4 KB per envelope, redaction cascade, Bearer-token rejection, diffs recorded as SHA-256 hashes)
  - Hardened scope resolver (single URL-decode, NFC/NFKC equality, layout enforcement, ancestry walk capped at 8, `remoteItem` / cross-drive / case-aliasing defences)
  - Loopback security hardening (CSRF, Host/Origin/Sec-Fetch-Site/Content-Type pins, per-request CSP nonce) and a single-flight form-factory slot so concurrent browser approval forms cannot collide
  - Custom branded MSAL loopback landing page replacing the default loopback server
  - `userOid` plumbed from `idTokenClaims.oid` and surfaced in `auth_status` and audit envelopes (ADR-0006)
- ADR-0005 (collab v1 decision log), ADR-0006 (`userOid = idTokenClaims.oid`), ADR-0007 (validated Graph IDs as branded `string` newtype), ADR-0008 (frontmatter codec — `yaml ~2.x` pinned, deterministic emitter, byte-exact snapshot)
- `yaml` (`~2.8.0`) runtime dependency for the frontmatter codec
- `markdown_preview_file` tool — opens a markdown file from the configured root folder in the user's browser using the SharePoint OneDrive web preview deep-link (renders the markdown nicely instead of triggering a download)
- `$filter` and `$orderby` support for `todo_list` tool ([TD-020])
- Dependabot configuration for automated npm and GitHub Actions dependency updates ([TD-013])
- Test coverage reporting in CI with configurable thresholds ([TD-019])
- `engines` field in `package.json` requiring Node.js >=22 ([TD-017])
- `CONTRIBUTING.md` and `CHANGELOG.md` ([TD-014])
- Body size limit (1 MB) on picker POST handler to prevent memory exhaustion ([TD-016])
- Zod runtime validation in `loadConfig()` replacing unsafe `JSON.parse` cast ([TD-018])
- New `docs-writer` agent for project documentation tasks

### Changed

- README updated with the 15 new collab tools, a new **Collaborative Editing (Collab v1)** section, and refreshed Privacy & Security bullets covering scoped projects, bounded budgets, browser re-approval for destructive actions, and the audit log
- `npm run check` now also runs `icons:check` (five steps total: `format:check` + `icons:check` + `lint` + `typecheck` + `test`)
- `openBrowser` now accepts `https://` URLs to any host (still rejects plain `http://` to non-localhost) so deep-link tools like `markdown_preview_file` can launch external URLs
- Standardized Node.js version to >=22 across `manifest.json`, `README.md`, `build.mjs`, and `package.json` ([TD-012])
- Split 1,249-line integration test file into focused test modules with shared helpers ([TD-022])

### Fixed

- Removed `eslint-disable` for non-null assertion in `loopback.ts` by extracting server to local variable ([TD-021])

### Previous Releases

This project uses version stamps from git tags (e.g., `v0.1.0`). See [GitHub Releases](https://github.com/co-native-ab/graphdo-ts/releases) for prior release notes.
