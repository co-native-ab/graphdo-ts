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

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
