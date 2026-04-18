# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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

- `openBrowser` now accepts `https://` URLs to any host (still rejects plain `http://` to non-localhost) so deep-link tools like `markdown_preview_file` can launch external URLs
- Standardized Node.js version to >=22 across `manifest.json`, `README.md`, `build.mjs`, and `package.json` ([TD-012])
- Split 1,249-line integration test file into focused test modules with shared helpers ([TD-022])

### Fixed

- Removed `eslint-disable` for non-null assertion in `loopback.ts` by extracting server to local variable ([TD-021])

### Previous Releases

This project uses version stamps from git tags (e.g., `v0.1.0`). See [GitHub Releases](https://github.com/co-native-ab/graphdo-ts/releases) for prior release notes.
