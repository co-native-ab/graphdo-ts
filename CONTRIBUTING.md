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
npm run check        # format:check + icons:check + schemas:check + lint + typecheck + test (all six)
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
type stays `camelCase`. The `Config` type is **derived** from the
current on-disk Zod schema (`CurrentConfigSchema` in `src/config.ts`)
via a `SnakeToCamelDeep` mapped type, so adding a field to the schema
makes it appear on `Config` automatically. The two casing-boundary
functions (`parseConfigFile` / `serialiseConfigFile` in
`src/config.ts`) are the single point where camelCase ↔ snake_case
conversion happens. See
[ADR-0009](docs/adr/0009-versioned-config-and-migrations.md) and
[ADR-0010](docs/adr/0010-snake-case-persisted-config.md).

To add a new (non-breaking) config field:

1. Add the snake_case field to `ConfigFileSchemaV{CURRENT}` in
   `src/config.ts` with a `.describe()` block.
2. Wire the new field into the `serialiseConfigFile` / `toInMemory`
   mappings — TypeScript will flag both sides until they match.
3. Run `npm run schemas:generate` to refresh
   `schemas/config-v{CURRENT}.json` (or let `npm run check` tell you
   it drifted).

The camelCase `Config` shape updates automatically — you do not edit
the `Config` type directly.

To make a **breaking** config change (renaming a field, changing
nesting, dropping a field):

1. Add `ConfigFileSchemaV{N+1}` describing the new on-disk shape
   (snake_case, includes `config_version: z.literal(N+1)` and a
   `.meta({ $id: configSchemaUrl(N+1), title, description })` block).
2. Register it in `SCHEMAS` and bump `CURRENT_CONFIG_VERSION`.
3. **Retarget the `CurrentConfigSchema` cast** in `src/config.ts` to
   `as typeof ConfigFileSchemaV{N+1}`. This is the only line that
   names a specific version after the bump — the in-memory `Config`
   type, the migration pipeline's terminal type, and the serialiser's
   re-validation all follow automatically.
4. Append a `MIGRATIONS` entry `{ from: N, to: N+1, migrate }`. The
   `migrate` function must be **pure** — no I/O, no clocks, no Graph
   calls. Its output is re-validated against `ConfigFileSchemaV{N+1}`.
5. Update `serialiseConfigFile` / `toInMemory` if the on-disk →
   in-memory mapping changed (the compiler will tell you).
6. Run `npm run schemas:generate` to emit
   `schemas/config-v{N+1}.json`, then copy it to
   `test/fixtures/schemas-frozen/config-v{N+1}.json` (the snapshot
   test refuses to run without it) and add a row to the version table
   in [`schemas/README.md`](schemas/README.md).
7. Add a fixture under `test/fixtures/config/v{N+1}/` and a row to
   the round-trip matrix in `test/config-migrations.test.ts`.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
