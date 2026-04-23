# Contributing to graphdo-ts

Thanks for considering a contribution! This document covers the basics.

## Prerequisites

- Node.js 22+
- npm (ships with Node.js)

## Getting Started

```bash
git clone https://github.com/co-native-ab/graphdo-ts.git
cd graphdo-ts
npm install
```

## Development Workflow

```bash
npm run lint         # ESLint (strict + stylistic)
npm run typecheck    # tsc --noEmit
npm run test         # Run tests via vitest
npm run format       # Format code with Prettier
npm run format:check # Check formatting without writing
npm run check        # format:check + lint + typecheck + test (all four)
npm run build        # Build with esbuild (dist/index.js)
```

Always run `npm run check` before submitting a PR.

## Branching & PRs

1. Create a feature branch from `main`
2. Make your changes in small, focused commits
3. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages:
   - `feat:` — new feature
   - `fix:` — bug fix
   - `docs:` — documentation only
   - `refactor:` — code change that neither fixes a bug nor adds a feature
   - `test:` — adding or updating tests
   - `chore:` — maintenance (dependencies, CI, etc.)
4. Open a pull request against `main`
5. CI runs lint, typecheck, tests, and build automatically

## Code Style

- TypeScript strict mode with `noUncheckedIndexedAccess`, `noImplicitOverride`, and `noPropertyAccessFromIndexSignature`
- ES modules — all imports use `.js` extensions
- No `any` types — enforced by ESLint
- Early returns over nested conditionals
- Structured logging via `logger.debug/info/warn/error()`

See [AGENTS.md](AGENTS.md) for detailed architecture and design decisions.

## Testing

- **Unit tests** go in `test/` alongside the module they test (e.g., `test/config.test.ts`)
- **Graph layer tests** go in `test/graph/` using the mock server from `test/helpers.ts`
- **Integration tests** go in `test/integration/` using shared helpers from `test/integration/helpers.ts`
- Use `vitest` — no global test variables (`globals: false`)
- Mock HTTP via the `node:http`-based mock server, not mocking libraries

## Adding New Tools

1. Add Graph operations in `src/graph/`
2. Register the tool in `src/tools/`
3. Wire it up in `src/index.ts`
4. Add both graph-layer and integration tests
5. Run `npm run check`

See the [Adding New Tools](AGENTS.md#adding-new-tools) section in AGENTS.md for the full pattern.

## Config Naming & Migrations

`config.json` keys are **`snake_case`** on disk; the in-memory `Config`
type stays `camelCase`. The mapping happens in exactly one place
(`parseConfigFile` / `serialiseConfigFile` in `src/config.ts`). See
[ADR-0009](docs/adr/0009-versioned-config-and-migrations.md) and
[ADR-0010](docs/adr/0010-snake-case-persisted-config.md).

To add a new config field:

1. Add the camelCase field to the `Config` interface in `src/config.ts`.
2. Add the snake_case field to `ConfigFileSchemaV{CURRENT}` and to the
   `serialiseConfigFile` / `toInMemory` mappings.

To make a **breaking** config change (renaming a field, changing nesting,
dropping a field):

1. Bump `CURRENT_CONFIG_VERSION` in `src/config.ts`.
2. Add `ConfigFileSchemaV{N+1}` describing the new on-disk shape
   (snake_case, includes `config_version: N+1`).
3. Append a `MIGRATIONS` entry `{ from: N, to: N+1, migrate }`. The
   `migrate` function must be **pure** — no I/O, no clocks, no Graph
   calls. Its output is re-validated against `ConfigFileSchemaV{N+1}`.
4. Update `serialiseConfigFile` / `toInMemory` if the in-memory shape
   changed.
5. Add a fixture under `test/fixtures/config/v{N+1}/` and a row to the
   round-trip matrix in `test/config-migrations.test.ts`.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
