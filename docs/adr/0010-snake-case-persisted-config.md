---
title: "ADR-0010: snake_case for All Persisted Config"
status: "Accepted"
date: "2026-04-23"
authors: "co-native-ab"
tags: ["architecture", "config", "persistence", "naming"]
supersedes: ""
superseded_by: ""
---

# ADR-0010: snake_case for All Persisted Config

## Status

**Accepted**

## Context

Until v2 of the config schema (see ADR-0009), `config.json` mirrored the
in-memory TypeScript shape verbatim: `todoListId`, `todoListName`,
`markdown.rootFolderId`, etc. That was convenient — `JSON.stringify` of
the in-memory object _was_ the file format — but it conflated three
different audiences:

1. **TypeScript code in `src/`**, which uses camelCase per existing
   style and ESLint rules.
2. **Microsoft Graph payloads**, which use camelCase per Microsoft's
   contract; we never want to "fix" those because then we'd have to
   re-translate on every request.
3. **Persisted config files we own**, which are read by humans (`vim
~/.config/graphdo-ts/config.json`), inspected by `jq`, and likely
   to be touched by future shell tooling. None of those audiences care
   about JS naming conventions.

When we introduced the v1 → v2 migration we had a free moment to pick
a single convention for persisted config and stick to it.

## Decision

**All keys in `config.json` (and any future config file that graphdo-ts
itself owns) use `snake_case`. The in-memory `Config` type stays
camelCase. The mapping happens in exactly one place: `parseConfigFile`
and `serialiseConfigFile` in `src/config.ts`.**

Specifically:

- The on-disk Zod schema (`ConfigFileSchemaV2`) declares snake_case
  keys only and rejects camelCase as "unknown" (Zod `.strip()`).
- The in-memory `Config` type and every other consumer in the
  codebase (`config.todoListId`, `config.markdown?.rootFolderId`)
  remain camelCase.
- The mapping is hand-written per version, not a generic recursive
  case-converter (see ADR-0009 alternative 4 for why).
- Structured logger output also uses snake_case keys
  (`{ todo_list_id, root_folder_id }`) because logger output is
  parseable text consumed by humans and pipelines, not in-memory state.
- Every saved `config.json` embeds a `$schema` field (always emitted as
  the first key) pointing at the version-pinned JSON Schema published in
  this repo under [`schemas/`](../../schemas/README.md) — e.g.
  `https://raw.githubusercontent.com/co-native-ab/graphdo-ts/main/schemas/config-v2.json`.
  Editors that understand JSON Schema (VS Code, JetBrains, neovim with
  `coc-json`, …) then offer completion and validation on hand-edits with
  zero per-user setup. The Zod loader `.strip()`s `$schema` back out so
  it never leaks into the in-memory `Config`. The `$` prefix is a
  recognised JSON Schema convention, so it does not violate the
  snake_case rule above.

This explicitly does **not** apply to:

- `msal_cache.json` and `account.json` — managed by MSAL; we don't
  control the schema.
- Graph API request/response payloads or `src/graph/types.ts` — those
  are Microsoft's contract and stay camelCase on the wire and in the
  TypeScript bindings.
- TypeScript code inside `src/` — internal types, fields, function
  parameters, locals, imports, exports all stay camelCase per the
  existing ESLint config.

## Alternatives Considered

1. **Keep camelCase on disk.** No behaviour benefit and perpetuates
   the ambiguity at the disk boundary; a hand-edit producing
   `todo_list_id` would silently get stripped today, the same way
   `todoListId` would be stripped under v2. We're already breaking the
   schema with the v2 cutover, so this is the cheapest moment to
   standardise. Rejected.
2. **kebab-case** (`todo-list-id`). Uncommon for JSON, awkward in `jq`
   (`.["todo-list-id"]`), and no real ecosystem precedent. Rejected.
3. **Generic recursive case-converter** at the I/O boundary. Opaque on
   keys with embedded numbers or already-mixed casing, and removes the
   per-field control we need during migrations (e.g. renaming
   `root_folder_id` → `workspace.item_id` is a 3-line diff in an
   explicit mapper, untrackable in a generic one). Rejected.

## Consequences

- Every new config field requires both a TypeScript field on `Config`
  and an explicit snake_case entry in `serialiseConfigFile` /
  `toInMemory`. That's a small ongoing cost but pays for itself on the
  first rename.
- The migration table doubles as the rename table: the v1 → v2
  migration in ADR-0009 is _exactly_ the camelCase → snake_case
  cutover.
- A user who hand-edits `config.json` and writes camelCase keys will
  see them silently dropped on the next load (Zod `.strip()`). The
  warning shape ("config.json failed schema validation") in the logs
  points back to this ADR / the README so the recovery is obvious.
- Logger output for config-related fields is also snake_case, keeping
  the on-disk and on-stderr representations consistent for log
  pipelines.
