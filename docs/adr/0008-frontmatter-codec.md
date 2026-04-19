---
title: "ADR-0008: Frontmatter Codec — `yaml ~2.x.y` + Deterministic Emitter"
status: "Accepted"
date: "2026-04-19"
authors: "co-native-ab"
tags: ["architecture", "collab-v1", "dependencies", "determinism"]
supersedes: ""
superseded_by: ""
---

# ADR-0008: Frontmatter Codec — `yaml ~2.x.y` + Deterministic Emitter

## Status

**Accepted**

## Context

The collab v1 design (`docs/plans/collab-v1.md` §3.1) makes the YAML
frontmatter at the top of the authoritative `.md` file the on-drive
coordination state for the project: `doc_id`, `sections[]`,
`proposals[]`, and the append-only `authorship[]` trail all live there.
Every collab read decodes this block; every collab write re-emits it.
That puts two concerns directly on the codec:

1. **Byte stability across consecutive writes.** Two writes that pass
   the same logical input must produce the same bytes. Without this,
   every `collab_write` would generate a noisy diff in OneDrive's
   version history even when no data changed, drowning real edits in
   reformat noise.
2. **Hardening.** Frontmatter arrives over the network from any
   cooperator with folder-write access. Unbounded parsers (`js-yaml`'s
   classic `!!js/function` tag, multi-document inputs that confuse
   downstream readers, prototype-pollution via `__proto__`) are
   well-known failure modes of YAML implementations.

`collab-v1.md` §6 already pre-committed the dependency choice — `yaml`
(eemeli/yaml), not `gray-matter` — and §6 / §3.1 enumerated the
parse-hardening and emitter-determinism requirements. This ADR
codifies the resulting code shape and locks in the version-pinning
policy that makes byte stability a release gate rather than an
aspiration.

The W2 Day 1 milestone in `collab-v1.md` §9 budgets this codec as the
first PR before any read- or write-path code lands, precisely so
subsequent milestones (`collab_read`, `collab_write`,
`session_recover_doc_id`) can rely on the contract.

## Decision

`yaml` is added as a runtime dependency, pinned with `~` (current pin:
`~2.8.0`). A new module `src/collab/frontmatter.ts` owns:

1. **Strict Zod schema** for the §3.1 `collab:` block — top-level keys,
   per-section / per-proposal / per-authorship keys, all `.strict()` so
   unknown fields fail loudly. Default-empty arrays for `sections`,
   `proposals`, and `authorship` so first-write callers can omit them.
2. **Hardened parser** (`parseFrontmatter`) using `yaml.parseDocument`
   with `prettyErrors: true`, `strict: true`, `customTags: []`, and
   `schema: "core"`. Both `errors[]` **and** `warnings[]` are escalated
   to `FrontmatterParseError` (yaml's default surfaces unresolved tags
   as `console.warn` and returns a degraded value — that is precisely
   the hardening hole §6 calls out). A pre-parse string check rejects
   any input containing a `---` or `...` document separator so
   multi-document YAML never reaches the parser. After parse, the root
   value's prototype is asserted to be exactly `Object.prototype` to
   reject alias / tag tricks that surface as class instances. A
   `FRONTMATTER_MAX_BYTES = 256 KiB` guard short-circuits before
   parsing.
3. **Deterministic emitter** (`serializeFrontmatter`):
   - Stable key order: every emit rebuilds the input via a private
     `canonicalise` helper that lays the schema's declared keys out in
     fixed order, so a hand-constructed input cannot drift the output.
   - `yaml.stringify` with `indent: 2`, `lineWidth: 0`,
     `minContentWidth: 0`, `defaultStringType: "QUOTE_DOUBLE"`,
     `defaultKeyType: "PLAIN"`, `directives: false`, `schema: "core"`.
   - Belt-and-braces round-trip: the output is parsed and re-emitted
     once before being returned; a mismatch raises
     `FrontmatterRoundtripError`. The round-trip and byte-exact
     snapshot tests catch any drift before this branch ever fires in
     production.
4. **Envelope helpers** (`splitFrontmatter` / `joinFrontmatter`) that
   peel and re-wrap the `---\n…\n---\n` block. `splitFrontmatter`
   normalises CRLF input to LF; `joinFrontmatter` requires its YAML
   argument to end with a newline so the wrap is unambiguous.

### Version pinning policy: `~` not `^`

`yaml` minor releases have changed default serialisation in the past
(quoting of keys matching reserved words, line-break handling near
block boundaries). `~2.8.0` accepts patch upgrades only; a minor bump
requires a deliberate version change in `package.json` and a fresh
`npm run check`. The byte-exact snapshot test
(`test/collab/frontmatter-snapshot.test.ts`) is the canary — if it
fails after a `yaml` upgrade, the upgrade is reverted, an ADR
amendment is filed, and only then is the snapshot updated.

### Always-quoted strings

`defaultStringType: "QUOTE_DOUBLE"` quotes every emitted string,
including those that would parse fine unquoted. The §3.1 determinism
contract calls for quoting "strings containing `:` or starting with a
YAML sentinel character"; quoting _every_ string is a strict superset,
costs only a handful of bytes per field, and removes the entire class
of "did the parser pick this up as a number, timestamp, or null?"
ambiguity that has burned other collab-style YAML formats. Numeric
fields (`version`, `revision`) are emitted unquoted because the schema
types them as `number`, not `string`.

## Consequences

### Positive

- **POS-001:** Byte-stable consecutive writes. Two `collab_write`
  calls with the same logical input produce the same bytes, so
  OneDrive version history surfaces only real edits.
- **POS-002:** Single hardened parse path. Every collab read goes
  through `parseFrontmatter`; the §6 hardening checklist is enforced
  in one place rather than re-derived per-tool.
- **POS-003:** Snapshot-driven release gate on `yaml` upgrades.
  Drift fails CI before users see a noisy diff in OneDrive.
- **POS-004:** Schema-defaulted arrays (`sections`/`proposals`/
  `authorship`) let first-write callers pass a minimal object without
  knowing the full §3.1 surface.

### Negative

- **NEG-001:** Always-quoted strings make the YAML slightly noisier
  than a hand-typed file. Acceptable per §3.1 — humans editing in
  OneDrive web are explicitly told the next collab write will
  re-serialise the block.
- **NEG-002:** A new runtime dependency. `yaml` has a clean
  advisory-DB record at the time of this decision (see References),
  is the eemeli/yaml maintained line (not the deprecated `js-yaml`),
  and is already a transitive dependency via `vite` so npm dedupes
  it. Net new install footprint is therefore zero.
- **NEG-003:** A `yaml` minor bump that re-formats output now
  blocks CI until a human reviews. This is the intended behaviour but
  carries a small toil tax on routine dependency updates.

## Alternatives Considered

### `gray-matter`

- **ALT-001a:** **Description**: The de-facto Node.js library for
  YAML/TOML/JSON frontmatter, used by every static-site generator.
  Bundles `js-yaml` and exposes a single `gray-matter(content)` call
  that returns `{ data, content }`.
- **ALT-001b:** **Rejection Reason**: Pulls additional transitive
  dependencies, obscures parse errors behind its own wrapper
  (harder to surface as `FrontmatterParseError` with context), and
  is built on `js-yaml`, which is exactly the historical RCE surface
  §6 hardening sets out to avoid. The plan explicitly cuts it.

### Hand-rolled YAML emitter

- **ALT-002a:** **Description**: Skip a YAML library entirely and emit
  the limited subset we need (mappings, sequences, double-quoted
  strings, integers) by hand. Determinism is trivial because the
  emitter is the only writer.
- **ALT-002b:** **Rejection Reason**: We still need a _parser_ — humans
  edit the frontmatter in OneDrive web and we must accept their
  reformatted output without confusion. Maintaining one half of a
  YAML implementation in-tree to avoid a maintained 80 KB dependency
  is bad value, especially when the parser side has the harder
  security profile (custom tags, anchors, multi-doc) that we want a
  battle-tested library to handle.

### `yaml` with `^` pinning

- **ALT-003a:** **Description**: Pin with `^2.8.0` to take any 2.x
  minor automatically. Matches the project's general dependency
  posture.
- **ALT-003b:** **Rejection Reason**: `yaml` minor releases are the
  exact bumps that have historically changed default serialisation.
  The byte-exact snapshot would still catch the drift in CI, but
  Renovate / Dependabot would open the PR every minor instead of
  every patch — predictable noise for no benefit. `~` exposes only
  patches automatically.

### Keep the parser permissive (allow custom tags)

- **ALT-004a:** **Description**: Use yaml's defaults
  (`customTags: undefined`) so common tags like `!!timestamp` are
  resolved automatically. Slightly less code in the codec.
- **ALT-004b:** **Rejection Reason**: §6 explicitly forbids custom
  tags, and treating timestamps as strings is the right call —
  Zod (not the YAML parser) enforces RFC 3339 datetimes. Permissive
  parsing also leaves the door open for future regressions if
  cooperator-supplied content includes an unexpected tag.

## Implementation Notes

- **IMP-001:** `src/collab/frontmatter.ts` is the only module that
  imports from `yaml`. Downstream code consumes the typed
  `CollabFrontmatter` shape and the `serialize`/`parse`/
  `splitFrontmatter`/`joinFrontmatter` API.
- **IMP-002:** `parseFrontmatter` accepts the YAML body **without** the
  surrounding `---` delimiter lines. Use `splitFrontmatter` to peel the
  envelope first; this keeps the codec testable on a focused input
  shape and reuses the same parse path for `session_recover_doc_id`'s
  `/versions` walk (W2 Day 2 / W5 Day 1).
- **IMP-003:** `splitFrontmatter` normalises CRLF input to LF on the
  way in. The codec emits LF only on the way out. End-to-end this
  guarantees we never PUT CRLF to OneDrive even if a Windows editor
  saved the file with `\r\n`.
- **IMP-004:** The byte-exact snapshot fixture in
  `test/collab/frontmatter-snapshot.test.ts` exercises every §3.1
  field, including a Unicode display name (`Åsa Müller-O'Brien`), a
  rationale containing both `:` and `#` sentinel characters, and a
  collision-suffixed slug (`design-1`). A future snapshot diff that
  changes only quoting style still fails the test, surfacing the
  drift before users see it.
- **IMP-005:** W2 Day 2 (`doc_id` recovery + `frontmatter_reset`
  audit) is the next milestone and the first consumer of these
  primitives. Its `04-frontmatter-stripped.test.ts` exercises the
  defaults-on-missing path and the recover-on-next-write path against
  the codec landed here.

## References

- **REF-001:** [`docs/plans/collab-v1.md`](../plans/collab-v1.md) §3.1
  — frontmatter shape, determinism contract, and the
  byte-stability / reformat trade-off.
- **REF-002:** [`docs/plans/collab-v1.md`](../plans/collab-v1.md) §6
  — `yaml` dependency policy, `~` vs. `^`, parse-hardening checklist,
  byte-exact snapshot requirement.
- **REF-003:** [`docs/plans/collab-v1.md`](../plans/collab-v1.md) §9
  W2 Day 1 — DoD that this ADR satisfies.
- **REF-004:** [ADR-0005: collab v1 decision log](./0005-collab-v1-decision-log.md)
  — pre-commits the introduction of ADR-007/008-class records during
  collab v1 implementation.
- **REF-005:** [eemeli/yaml documentation](https://eemeli.org/yaml/)
  — `parseDocument`, `stringify`, hardening options used here.
- **REF-006:** GitHub Advisory Database — clean record for `yaml@2.8.3`
  at the time of this decision (verified pre-merge per §6).
