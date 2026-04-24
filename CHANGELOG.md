# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.6] — 2026-04-24

### Fixed

- `markdown_preview_file` on Windows + Claude Desktop: the SharePoint preview URL was being mangled before reaching the browser (`&parent=…` silently dropped because `cmd.exe` treats `&` as a command separator, and unreserved characters `_`, `-`, `.` re-encoded as `%5F`, `%2D`, `%2E` by ShellExecute), and the tool falsely reported "could not open browser" even when it did. Browser launch now goes through the `open` package, which uses PowerShell `Start-Process` on Windows so the URL is passed verbatim and the launch result is reliable. See [ADR-0011](docs/adr/0011-use-open-package-for-browser-launch.md).

### Changed

- `src/browser/open.ts` delegates to the `open` package after URL validation, replacing the hand-rolled per-platform `execFile` branches (`open` on macOS, `xdg-open` on Linux, `wslview` on WSL detected via `/proc/version`, `cmd.exe /c start ""` on Windows). The public `openBrowser(url)` shim and its DI thread through `ServerConfig.openBrowser` are unchanged. See [ADR-0011](docs/adr/0011-use-open-package-for-browser-launch.md).
- Added `open` as a runtime dependency.

## [0.2.5] — 2026-04-24

### Added

- `markdown_edit` tool — apply a unified-diff hunk to an existing markdown file with eTag-based optimistic concurrency, so agents can make targeted line-level edits without re-uploading the whole file. See [ADR-0006](docs/adr/0006-markdown-edit-tool.md).
- `markdown_append` tool — append a UTF-8 chunk to the end of an existing markdown file with eTag-based optimistic concurrency (ADR-0006 deferred follow-up).
- `markdown_preview_file` tool — opens a markdown file from the configured workspace in the user's browser using the SharePoint / OneDrive web preview deep-link (renders the markdown nicely instead of triggering a download).
- Browser-based **workspace navigator** (`markdown_select_workspace`) — replaces the old root-folder picker with a token-driven UI that supports browsing the user's OneDrive, switching between accessible drives (incl. SharePoint document libraries), pasting share links, breadcrumb navigation, client-side filtering with `/` shortcut, and pagination (page size 25).
- `Files.ReadWrite.All` and `Sites.Read.All` Graph scopes to support workspaces hosted in SharePoint document libraries in addition to the user's personal OneDrive.
- `DriveScope` plumbing in the Graph layer (`src/graph/drives.ts`) including `resolveShareLink`, so all markdown tools operate against the workspace's drive instead of assuming `/me/drive`.
- Pending config migrations now run at **server startup** (in addition to the existing lazy migration on first config-using tool call), so a freshly upgraded server immediately rewrites old `config.json` files to the current `config_version` and refreshes the embedded `$schema` URL.
- `$filter` and `$orderby` support for `todo_list` tool ([TD-020]).
- Dependabot configuration for automated npm and GitHub Actions dependency updates ([TD-013]).
- Test coverage reporting in CI with configurable thresholds ([TD-019]).
- `engines` field in `package.json` requiring Node.js >=22 ([TD-017]).
- `CONTRIBUTING.md` and `CHANGELOG.md` ([TD-014]).
- Body size limit (1 MB) on picker POST handler to prevent memory exhaustion ([TD-016]).
- Zod runtime validation in `loadConfig()` replacing unsafe `JSON.parse` cast ([TD-018]).
- New `docs-writer` agent for project documentation tasks.
- Versioned `config.json` schema with explicit `config_version` field and a forward-only migration pipeline (see [ADR-0009](docs/adr/0009-versioned-config-and-migrations.md)).
- ADR-0006 (`markdown_edit` Tool), ADR-0007 (Per-File Tool Descriptor Pattern), ADR-0008 (Browser Flow Pattern), ADR-0009 (Versioned Config with Forward-Only Migrations), and ADR-0010 (snake_case for All Persisted Config).
- Corrupt `config.json` files are now backed up to `config.json.invalid-<timestamp>` on next load instead of crashing tools.
- Public, version-pinned JSON Schemas for `config.json` under [`schemas/`](schemas/README.md) (`config-v1.json`, `config-v2.json`, `config-v3.json`), **generated from the per-version Zod schemas in `src/config.ts`** by [`scripts/generate-schemas.ts`](scripts/generate-schemas.ts). Generation is wired into `npm run build`; `npm run schemas:check` (part of `npm run check` and CI) fails on any drift from the Zod source of truth. A frozen-history snapshot test (`test/schemas-generated.test.ts` + `test/fixtures/schemas-frozen/`) forces a visible PR diff — and ideally a `config_version` bump — whenever an already-published schema would change. Every saved `config.json` now embeds a `$schema` field pointing at the current schema on `main`, so editors (VS Code, JetBrains, …) get completion and validation when the user hand-edits the file.

### Changed

- **Breaking (config file format):** `config.json` is now written in `snake_case` with a top-level `config_version` field (current: `3`), and per-subsystem keys are nested into objects (`todo: { list_id, list_name }`, `markdown: { workspace: { … } }`) so disk and in-memory shapes mirror each other. Existing `config.json` files written in the legacy flat camelCase format, or in v2 with the old `markdown.root_folder_*` shape, are migrated automatically on first load (todo and markdown selections are preserved where possible). See [ADR-0010](docs/adr/0010-snake-case-persisted-config.md) for the rationale.
- **Breaking (tool rename):** `markdown_select_root_folder` → `markdown_select_workspace`. The new flow selects a full workspace (drive + folder) instead of just a folder under `/me/drive`.
- All markdown tools now operate against the configured workspace's `DriveScope` (which may be the user's OneDrive or a SharePoint document library) rather than always against `/me/drive`.
- `auth_status` now reports the configured workspace (drive + folder) instead of the legacy root-folder name.
- All MCP tools refactored to use a per-file Tool descriptor pattern (named top-level `inputSchema` / `def` / `handler` exports per tool file), see [ADR-0007](docs/adr/0007-tool-descriptor-pattern.md).
- The three near-duplicate local HTTP server implementations (login loopback, picker, logout confirmation) have been consolidated onto a single `runBrowserFlow` primitive with per-flow descriptors under `src/browser/flows/`. See [ADR-0008](docs/adr/0008-browser-flow-pattern.md).
- Tools and tests reorganized by domain (`src/tools/{auth,mail,markdown,todo}/`, mirrored under `test/`).
- `loadConfig()` no longer throws on unparseable JSON — it backs the file up to `config.json.invalid-<timestamp>` and returns `null`, letting tools surface the standard "not configured" error rather than crash.
- `loadConfig()` refuses to load a `config.json` whose `config_version` is newer than the current build; the file is left untouched (no silent downgrade).
- `openBrowser` now accepts `https://` URLs to any host (still rejects plain `http://` to non-localhost) so deep-link tools like `markdown_preview_file` can launch external URLs.
- Standardized Node.js version to >=22 across `manifest.json`, `README.md`, `build.mjs`, and `package.json` ([TD-012]).
- Split 1,249-line integration test file into focused test modules with shared helpers ([TD-022]).

### Fixed

- `markdown_edit` now mirrors its unified-diff result into `structuredContent` so MCP clients that prefer structured output see the diff alongside the text content.
- Published JSON Schemas under `schemas/` now allow the `$schema` key on the root object, so a `config.json` whose embedded `$schema` URL points at the schema itself no longer fails strict validators.
- Workspace navigator UI: rendered styles are now driven entirely from the design tokens / `BASE_STYLE` (per [ADR-0002](docs/adr/0002-html-template-and-design-system.md)), with a proper `prefers-color-scheme: dark` block, SVG folder/chevron/home icons, a `/`-focused filter input, pagination, and a fix for the `/ / Foo` breadcrumb rendering bug.
- Removed `eslint-disable` for non-null assertion in `loopback.ts` by extracting server to local variable ([TD-021]).

## [0.2.4] — 2026-04-21

### Added

- Clean process-lifecycle handling: graceful shutdown on stdin close, `SIGHUP`, `SIGINT`, and `SIGTERM` (`test/shutdown-signals.test.ts`).
- Loopback hardening for the MSAL login flow: CSRF token, per-request CSP nonce, and pinned `Host` / `Origin` / `Sec-Fetch-Site` / `Content-Type` headers (`src/loopback-security.ts`, `src/loopback.ts`, `src/auth.ts`).
- MSAL response-field allow-list, hardened bearer-token scrubber, and `tenantId` validation in the auth layer.
- Branded logout-confirmation page that mirrors the login landing page (`src/templates/logout.ts`).
- `ValidatedGraphId` branded type (`src/graph/ids.ts`) — applied to `src/graph/todo.ts` with `encodeURIComponent` defence in depth (precursor to ADR-0005).
- Centralised HTML-escape helper adopted across the `layout`, `login`, `logout`, `picker`, and `styles` templates (`src/templates/escape.ts`).
- Reusable filesystem helpers (`src/fs-options.ts`).

### Changed

- Pure refactor of `src/tools/markdown.ts` into `markdown-defs.ts`, `markdown-helpers.ts`, and `markdown-register.ts` (precursor to the per-file Tool descriptor pattern in [ADR-0007](docs/adr/0007-tool-descriptor-pattern.md)).
- Test infrastructure improvements (`test/helpers.ts`, `test/integration/helpers.ts`, picker / template assertions).

### Internal

- v0.2.4 was a curated backport of non-collab improvements from the `feat/collab-v1` branch onto `main` (PR [#67](https://github.com/co-native-ab/graphdo-ts/pull/67)). All collab v1 / session / persona / instance-lock functionality was deliberately excluded.

## [0.2.3] — 2026-04-18

### Fixed

- `markdown` tools now backfill the current revision identifier from the `/versions` endpoint when the OneDrive `driveItem` omits it, so `markdown_get_file` always returns a usable Revision (PR [#31](https://github.com/co-native-ab/graphdo-ts/pull/31)).

## [0.2.2] — 2026-04-18

### Fixed

- `markdown` tools now use the OneDrive `cTag` for optimistic-concurrency `If-Match` checks instead of the regular `eTag`. The `eTag` changes on metadata-only updates (e.g., view counters), which produced spurious mismatch errors on otherwise-unchanged content (PR [#30](https://github.com/co-native-ab/graphdo-ts/pull/30)).

## [0.2.1] — 2026-04-18

### Added

- `markdown_preview_file` tool — opens a markdown file from the configured root folder in the user's browser using the SharePoint / OneDrive web preview deep-link (PR [#29](https://github.com/co-native-ab/graphdo-ts/pull/29)).

### Fixed

- `markdown` tools handle absent `item.version` gracefully and ship size-cap boundary tests; tool docs now clarify that the 4 MiB cap is a graphdo-ts tool-side cap, not a Microsoft Graph API limit (PR [#28](https://github.com/co-native-ab/graphdo-ts/pull/28)).

## [0.2.0] — 2026-04-18

### Added

- Initial **markdown file tools** for OneDrive: list, create, get, update, delete, list-versions, get-version, diff-versions. Includes generic framing, strict cross-OS file-name validation, hardened root-folder selection, and picker UX improvements (PR [#24](https://github.com/co-native-ab/graphdo-ts/pull/24)).
- `markdown_select_root_folder` browser picker for selecting the workspace root folder under `/me/drive`.

### Changed

- Bumped `actions/dependency-review-action` (4.7.1 → 4.9.0), `softprops/action-gh-release` (2.6.1 → 3.0.0), and the `npm-minor-patch` group (7 updates) via Dependabot (PRs [#25](https://github.com/co-native-ab/graphdo-ts/pull/25), [#26](https://github.com/co-native-ab/graphdo-ts/pull/26), [#27](https://github.com/co-native-ab/graphdo-ts/pull/27)).

## [0.1.4] — 2026-04-15

### Added

- Required `AbortSignal` parameter on every async function in the codebase, `HttpMethod` enum, `GraphClient.request()` overloads (with/without body), and `SIGINT` / `SIGTERM` clean-shutdown wiring in `main()` (PR [#23](https://github.com/co-native-ab/graphdo-ts/pull/23)).

### Changed

- Multi-agent codebase review: fixes across security, CI hardening, code quality, and tests (PR [#22](https://github.com/co-native-ab/graphdo-ts/pull/22)).

## [0.1.3] — 2026-04-13

### Added

- Dynamic, scope-based MCP tool discovery — only tools whose required Graph scopes have been granted are advertised to the MCP client (PR [#21](https://github.com/co-native-ab/graphdo-ts/pull/21)).

## [0.1.2] — 2026-04-12

### Changed

- npm publishing pipeline finalised. Republish of v0.1.1 to fix release-job wiring (PR [#20](https://github.com/co-native-ab/graphdo-ts/pull/20)).

## [0.1.1] — 2026-04-12

### Added

- Automated npm publishing for the `@co-native-ab/graphdo-ts` package via OIDC Trusted Publishing (no tokens stored). Triggered by the same `v*` tags that drive the GitHub Release (PR [#20](https://github.com/co-native-ab/graphdo-ts/pull/20)).

## [0.0.5] — 2026-04-11

### Added

- 15 GitHub Copilot custom-agent files under `.github/agents/` (PR [#4](https://github.com/co-native-ab/graphdo-ts/pull/4)).
- Branded HTML template system with design tokens (per [ADR-0002](docs/adr/0002-html-template-and-design-system.md)) — extracted from inline HTML across the login, logout, and picker pages (PR [#13](https://github.com/co-native-ab/graphdo-ts/pull/13)).
- MCPB manifest configuration entries for `GRAPHDO_DEBUG`, `client_id`, and `tenant_id` (PR [#15](https://github.com/co-native-ab/graphdo-ts/pull/15)).
- Confirm / cancel buttons on all interactive browser pages (login landing, logout confirmation) (PR [#14](https://github.com/co-native-ab/graphdo-ts/pull/14)).
- Prettier formatter and PR coverage reports (PR [#17](https://github.com/co-native-ab/graphdo-ts/pull/17)).
- Inline Entra ID / organization setup, blast-radius philosophy, and [ADR-0001](docs/adr/0001-minimize-blast-radius.md) (PR [#11](https://github.com/co-native-ab/graphdo-ts/pull/11)).

### Changed

- **Breaking (auth):** authentication simplified to **browser-only**. The MCP elicitation prompt and the device-code fallback have been removed; if the browser cannot be opened, the `login` tool returns the URL for manual navigation. See [ADR-0003](docs/adr/0003-browser-only-authentication.md) (PR [#14](https://github.com/co-native-ab/graphdo-ts/pull/14)).
- Multi-agent codebase review: security fixes, tech-debt cleanup, CI hardening, MCP improvements (PR [#5](https://github.com/co-native-ab/graphdo-ts/pull/5)).
- Tech-debt remediation across two batches addressing all 22 items from the original `TECH_DEBT.md` (PRs [#6](https://github.com/co-native-ab/graphdo-ts/pull/6), [#7](https://github.com/co-native-ab/graphdo-ts/pull/7)).
- Documentation accuracy fixes for `README.md` and `CONTRIBUTING.md` (PR [#18](https://github.com/co-native-ab/graphdo-ts/pull/18)).
- General fine-tuning across tools, manifest, and templates (PR [#19](https://github.com/co-native-ab/graphdo-ts/pull/19)).
- Bumped `actions/upload-artifact` (4.6.2 → 7.0.1), `actions/setup-node` (4.4.0 → 6.3.0), and `@types/node` in the `npm-minor-patch` group via Dependabot (PRs [#8](https://github.com/co-native-ab/graphdo-ts/pull/8), [#9](https://github.com/co-native-ab/graphdo-ts/pull/9), [#10](https://github.com/co-native-ab/graphdo-ts/pull/10)).

### Fixed

- Removed hallucinated MCPB installation instructions from the README (PR [#16](https://github.com/co-native-ab/graphdo-ts/pull/16)).

## [0.0.4] — 2026-04-10

### Changed

- Release-pipeline shake-out only; no functional changes relative to `v0.0.3`.

## [0.0.3] — 2026-04-10

### Added

- Branded login UX, improved manifest and tool descriptions, per-request timeouts, and an Edge account-picker fix (PR [#3](https://github.com/co-native-ab/graphdo-ts/pull/3)).

## [0.0.2] — 2026-04-10

### Added

- Generic browser picker (`src/picker.ts`) — a local HTTP server with clickable options used by `todo_select_list` for human-only list selection.
- Enhanced Microsoft To Do support: `importance`, reminder fields, due date, and recurrence on `todoTask`.
- Checklist-step CRUD tools (`todo_step_*`) backed by the `/tasks/{taskId}/checklistItems` Graph sub-resource (PR [#2](https://github.com/co-native-ab/graphdo-ts/pull/2)).

## [0.0.1] — 2026-04-09

### Added

- First public release. TypeScript MCP server giving AI agents scoped, low-risk access to Microsoft Graph: stdio transport, MSAL browser login with a custom loopback client, mail (`mail_send`) and Microsoft To Do tools (`todo_list`, `todo_show`, `todo_create`, `todo_update`, `todo_complete`, `todo_delete`), `todo_select_list` configuration tool, `auth_status` diagnostic tool, MCPB bundle distribution, GitHub Releases pipeline.
