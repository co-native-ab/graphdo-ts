---
title: "ADR-0009: Versioned Config with Forward-Only Migrations"
status: "Accepted"
date: "2026-04-23"
authors: "co-native-ab"
tags: ["architecture", "config", "persistence", "migrations"]
supersedes: ""
superseded_by: ""
---

# ADR-0009: Versioned Config with Forward-Only Migrations

## Status

**Accepted**

## Context

graphdo-ts persists user-controlled state in `config.json` under the OS
config directory: today the selected todo list and the markdown root
folder, with more fields (cross-drive workspace identity, future Graph
surfaces) likely to follow.

Until this ADR there was no explicit version on disk and no migration
story. The schema was implicit in `ConfigSchema` in `src/config.ts`, and
the only "migration" available was Zod stripping unknown fields. That
worked while the schema only ever grew, but it gives us no safe way to:

1. Rename or restructure existing fields (e.g. flattening `markdown.*` or
   adding `markdown.workspace.driveId`).
2. Roll out the snake_case-on-disk policy from ADR-0010 without
   clobbering existing users on first launch.
3. Detect and reject a `config.json` written by a _newer_ build of
   graphdo-ts (e.g. an MCPB upgrade rolled back).
4. Recover (or at least not destroy) a hand-edited file that no longer
   parses.

We could keep stacking optional fields and best-effort coercions, but
each round adds a "this used to mean X, but if Y is set then Z" branch
that nothing tests. A small amount of structure now makes future config
changes routine.

## Decision

**Persist an explicit `config_version` on disk and migrate forward only,
through an ordered table of pure functions, with the current build's
schema validating both the input and the output of every step.**

Concretely, in `src/config.ts`:

- Export `CURRENT_CONFIG_VERSION` (currently `2`).
- For each version `N`, register a Zod schema `ConfigFileSchemaVN` that
  describes the on-disk shape for that version.
- Maintain `MIGRATIONS: readonly Migration[]` in version order, where
  each `{ from, to, migrate }` entry takes `vFrom`-validated data and
  returns a value that must validate against `vTo`'s schema.
- `parseConfigFile(raw)` performs: detect → validate-against-`vN` →
  apply migrations until `CURRENT_CONFIG_VERSION` → map snake_case to
  the in-memory camelCase `Config`. Returns `{ config, migrated }`.
- `loadConfig(dir)` wraps this with I/O: rewrites the file atomically
  via `writeJsonAtomic` only when `migrated === true`; on corrupt JSON
  it backs the original up to `config.json.invalid-<timestamp>` and
  returns `null` so callers can surface the "not configured" error
  rather than crash.
- A `config_version` higher than `CURRENT_CONFIG_VERSION` is a hard
  error (`"config.json was written by a newer graphdo-ts ..."`). The
  file is never rewritten in that case.

Migrations are required to be **pure**: no I/O, no clocks, no Graph
calls, no logging beyond a single `logger.info("migrating config", { from, to })`
emitted by the pipeline. This is what makes them unit-testable and
deterministic, and lets us check them into source with confidence.

## Alternatives Considered

1. **Best-effort silent parsing of any shape.** Cheapest to write,
   worst to debug — every field becomes implicitly two-valued (raw vs
   coerced) and renames are forever ambiguous. Rejected.
2. **Auto-resolve missing fields by calling Graph during load** (e.g.
   look up the user's default drive when `drive_id` is missing).
   Rejected: makes loading non-deterministic, races with auth/network
   state, and turns "open the app" into a synchronous Graph dependency.
   The user re-running the picker once is cheaper than this complexity.
3. **Keep deprecated keys around indefinitely with a "compat" branch.**
   Two sources of truth, easy to test the wrong one, hard to ever
   delete. Rejected.
4. **Generic recursive case converter / schema diff tool.** Opaque on
   keys that contain numbers or already-mixed casing, and gives us no
   place to write the per-version semantic decisions ("the legacy
   markdown block is dropped because v2 requires `drive_id` which v1
   never gathered"). Rejected in favour of explicit per-version
   mappers that read like a changelog.

## Consequences

- Every future breaking config change has a single, obvious workflow:
  add `ConfigFileSchemaVN+1`, register it in `SCHEMAS`, bump
  `CURRENT_CONFIG_VERSION`, retarget the `CurrentConfigSchema` cast,
  add a `MIGRATIONS` entry, add a fixture under
  `test/fixtures/config/vN+1/`, add a row to the round-trip matrix in
  `test/config-migrations.test.ts`. The contributor docs (the
  `Adding a new version` block at the top of `src/config.ts` and the
  matching section of `schemas/README.md`) mirror this. The in-memory
  `Config` type is derived from `CurrentConfigFile` via a
  `SnakeToCamelDeep` mapped type, so new schema fields appear on
  `Config` automatically and the compiler then flags `toInMemory` /
  `serialiseConfigFile` until both sides of the casing boundary are
  wired up.
- Migration tests own correctness: round-trip per version, byte-stable
  load → save → load, "newer than current" refusal, corrupt-file
  backup, schema enforcement on migration output.
- `loadConfig` is no longer "schema check or throw"; it is "parse →
  migrate → optionally rewrite". The atomic rewrite means a user pays
  the migration cost once on first load with the new build.
- The migration table doubles as the rename table — the snake_case
  cutover from ADR-0010 is just the v1 → v2 entry.
- We accept that newer-than-current files refuse to load. That is the
  right failure mode for a downgrade: never silently lose data.
