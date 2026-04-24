# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

### Previous Releases

This project uses version stamps from git tags (e.g., `v0.1.0`). See [GitHub Releases](https://github.com/co-native-ab/graphdo-ts/releases) for prior release notes.
