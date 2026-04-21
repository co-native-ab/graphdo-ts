---
title: "ADR-0007: Validated Graph IDs (Branded String Newtype)"
status: "Accepted"
date: "2026-04-19"
authors: "co-native-ab"
tags: ["architecture", "security", "graph", "types"]
supersedes: ""
superseded_by: ""
---

# ADR-0007: Validated Graph IDs (Branded String Newtype)

## Status

**Accepted**

## Context

graphdo-ts threads opaque Microsoft Graph identifiers — drive item IDs,
drive item version IDs, To Do list / task / checklist item IDs — through
URL templates such as:

```ts
`/me/drive/items/${itemId}``/me/todo/lists/${listId}/tasks/${taskId}`;
```

A confused or hostile caller that passes `"a/b"` or
`"abc?$expand=children"` as one of these IDs can splice arbitrary path
segments or query parameters into the URL we issue against Graph. We
already ship two unrelated mitigations:

1. **`encodeURIComponent` at the wire layer.** Most helpers in
   `src/graph/markdown.ts` percent-encode IDs before interpolation.
   This blocks the actual injection — `/` becomes `%2F` — but only
   where it is remembered.
2. **`assertValidGraphId` at the helper boundary.** Defined in
   `src/graph/markdown.ts` (length cap, no whitespace, no control
   characters, no path separators, ASCII-only). Called inline at the
   start of each `markdown_*` helper.

Both are per-helper conventions, and the W1 Day 3 review of the collab
surface surfaced two concrete consequences:

- **`src/graph/todo.ts` was missing both mitigations.** Every helper
  (`listTodos`, `getTodo`, `createTodo`, `updateTodo`, `completeTodo`,
  `deleteTodo`, `listChecklistItems`, `createChecklistItem`,
  `updateChecklistItem`, `deleteChecklistItem`) interpolated `listId`,
  `taskId`, and step `itemId` into the URL **without
  `encodeURIComponent`** and only checked for empty strings.
- **`src/collab/graph.ts` and `src/collab/sentinel.ts`** had
  `encodeURIComponent` but only checked for empty strings — no length
  cap, no character whitelist.

The deeper problem is that all ID-bearing parameters are typed `string`,
so the type system gives no signal at the call site about which values
have been validated. Reviewers cannot tell, from a function signature,
whether a helper expects a validated ID or trusts the caller. New
helpers reliably forget the inline `assertValidGraphId` call because
nothing forces them to remember.

This ADR records the decision to lift the validation guarantee into the
type system.

## Decision

Introduce a single **branded `string` newtype**, `ValidatedGraphId`, in a
new module `src/graph/ids.ts`:

```ts
declare const validatedGraphIdBrand: unique symbol;
export type ValidatedGraphId = string & { readonly [validatedGraphIdBrand]: true };
```

The brand symbol is module-private; the only ways to obtain a value of
type `ValidatedGraphId` are:

| Function                           | Use                                                                |
| ---------------------------------- | ------------------------------------------------------------------ | ---------- |
| `validateGraphId(label, value)`    | Throwing validator. Used at every I/O boundary.                    |
| `tryValidateGraphId(label, value)` | Non-throwing variant returning `{ ok, value                        | reason }`. |
| `unsafeAssumeValidatedGraphId(v)`  | **Loud-named** escape hatch for known-good values; grep-auditable. |

Every Graph helper that interpolates an opaque ID into a URL changes
its parameter type from `string` to `ValidatedGraphId`. Below the I/O
boundary, helpers drop their inline `assertValidGraphId` calls — the
type guarantees them — but **continue to call `encodeURIComponent` on
the wire**. The two concerns are kept separate:

- `validateGraphId` is **structural defence in depth**: catch an
  obviously malformed value loudly at the boundary, before it produces
  a confusing 404 / 400 from Graph, and prove statically that no helper
  has been forgotten.
- `encodeURIComponent` is **wire encoding**: belt and braces against a
  brand that is, after all, only enforced at compile time.

### Where `ValidatedGraphId` is minted

The convention codified by this ADR: **only the I/O boundary may produce
a `ValidatedGraphId`.** Specifically:

1. **MCP tool handlers** receive raw `string` arguments from the SDK
   and call `validateGraphId(...)` immediately, then pass the branded
   value to every Graph helper. No tool reaches into a Graph helper
   with a freshly-Zod-parsed `string`.
2. **Graph response parsers** (`DriveItemSchema`, `TodoListSchema`,
   etc.). IDs surfaced by Graph itself are trusted _at the shape level
   only_ (Zod confirms the field exists and is a string) and re-validated
   via `validateGraphId` before being threaded back into a URL. This is
   cheap, defends against a buggy mock server, and makes the same
   `unsafeAssumeValidatedGraphId` audit story work end-to-end.
3. **Persisted config.** `loadAndValidateTodoConfig` validates
   `todoListId` once on read; if the on-disk file has been hand-edited
   into an invalid state, the tool fails with a clear message instead
   of splicing the bad value into a URL.
4. **Test fixtures** call `validateGraphId("test", "list-1")` at the
   construction seam, or — for clearly safe constants —
   `unsafeAssumeValidatedGraphId("list-1")` with a one-line comment.

## Consequences

- **Compile-time guarantee.** Every Graph helper signature now spells
  out which arguments are validated. A future engineer adding a new
  helper cannot accidentally interpolate an unvalidated `string` into
  a URL without an explicit cast.
- **Single source of truth.** The validation rules (length cap,
  character whitelist) live in `ids.ts` and only there. The previous
  `assertValidGraphId` lives on as a thin re-export from `ids.ts` for
  the duration of the migration, then is removed.
- **Zero runtime cost.** A `ValidatedGraphId` is a `string` at runtime.
  No allocation, no `.value` accessor, no change to template-literal
  or `encodeURIComponent` ergonomics. Existing call sites stay
  one-liners.
- **Reviewable escape hatch.** `unsafeAssumeValidatedGraphId` is the
  only way to fabricate a `ValidatedGraphId` without validation. It is
  loudly named so a `grep` for the function returns every site that
  bypasses the rule, and each use is required to carry a one-line
  rationale comment.
- **Migration is mechanical but wide.** Every Graph helper, every
  caller, and every test fixture is touched once. After that, future
  helpers inherit the discipline for free.
- **The existing `assertValidGraphId` test in `markdown.test.ts`** is
  replaced by `test/graph/ids.test.ts` which covers the validator
  directly; the per-helper "guards every Graph helper" assertion
  becomes redundant because the type system prevents the invalid call.

## Alternatives considered

- **Runtime `class GraphId { readonly value: string }`.** Rejected:
  every URL template would need `${id.value}` or a `toString()`
  override, every existing test fixture would need rewriting, and
  there is no behaviour to attach to the class beyond the validator we
  already have. The brand gives us the type-system guarantee at zero
  ergonomic cost.
- **Zod `.brand()` on a `z.string()` schema.** Rejected: the validation
  is much narrower than a Zod schema (no need for the full schema
  parsing pipeline at every helper call), and we want a single
  non-schema entrypoint that can be called by both schema parsers and
  tool handlers.
- **Per-resource brands (`TodoListId`, `DriveItemId`, `TaskId`,
  `VersionId`, `StepId`, …).** Rejected for v1: every Graph ID we
  handle has the same character class, the same `encodeURIComponent`
  treatment, and the same length cap. Per-resource brands would double
  the number of branded types and force a `_castListIdToTaskId`-style
  conversion at every site that takes both. Revisitable if a real
  cross-resource swap bug appears (e.g. accidentally passing a
  `taskId` where a `listId` is expected) — but no such bug has been
  observed, and the cost of catching it would be borne everywhere.
- **Defer to runtime `assertValidGraphId` only.** That's the status quo
  and is exactly what produced the gap this ADR closes — every new
  helper has to remember the call.

## Migration

The migration is staged across one PR with focused commits, each
run through `npm run check`:

1. Land `src/graph/ids.ts`, `test/graph/ids.test.ts`, and this ADR.
2. Migrate `src/graph/todo.ts` first — that's where the actual
   unencoded interpolation gap exists. Add `encodeURIComponent` at
   every URL interpolation while we're there.
3. Migrate `src/graph/markdown.ts`. Re-export `assertValidGraphId` from
   `ids.ts` for the existing import path, then drop the inline calls.
4. Migrate `src/collab/graph.ts` and `src/collab/sentinel.ts`.
5. Validate at the tool boundary in `src/tools/todo.ts`,
   `src/tools/todo-steps.ts`, `src/tools/markdown.ts`,
   `src/tools/session.ts`. Validate `todoListId` in
   `loadAndValidateTodoConfig`.
6. Update all impacted Graph-layer tests to call `validateGraphId` (or
   the loud escape hatch) at fixture seams. The existing per-helper
   "rejects bad IDs" assertion in `test/graph/markdown.test.ts` is
   replaced by the dedicated `test/graph/ids.test.ts` because the
   type system now prevents the offending calls.

### Guidance for new tools

When you add a Graph helper that interpolates an ID into a URL:

1. Type the parameter as `ValidatedGraphId`, not `string`.
2. Continue to wrap each interpolation in `encodeURIComponent`.
3. Do not call `validateGraphId` inside the helper — the type does it.
4. In the registering tool handler, call `validateGraphId("paramName",
args.paramName)` once before the helper call.

## Out of scope

- **Markdown file names.** `validateMarkdownFileName` covers a
  different rule set (must end in `.md`, no Windows reserved names,
  display-friendly characters) and is not unified here.
- **Project / session ULIDs.** Already validated by a ULID regex; could
  opt into the same brand later, but they are not the URL-injection
  surface this ADR addresses.
- **A separate `VersionId` brand.** Drive item version IDs satisfy the
  same character class as drive item IDs. Per the per-resource-brand
  alternative above, we keep a single `ValidatedGraphId` for v1.
