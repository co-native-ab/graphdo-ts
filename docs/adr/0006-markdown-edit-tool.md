---
title: "ADR-0006: markdown_edit Tool — Targeted In-Place Edits with cTag Concurrency"
status: "Accepted"
date: "2026-04-22"
authors: "co-native-ab"
tags: ["architecture", "graph", "markdown", "onedrive", "tools"]
supersedes: ""
superseded_by: ""
---

# ADR-0006: `markdown_edit` Tool — Targeted In-Place Edits with cTag Concurrency

## Status

**Accepted**

## Context

[ADR-0004](./0004-markdown-file-support.md) introduced markdown file support
in OneDrive. The current write surface is `markdown_update_file`, which
overwrites the entire file content in one shot under cTag-based optimistic
concurrency. For any non-trivial edit the agent must:

1. Call `markdown_get_file` to fetch the full file and its `cTag`.
2. Reconstruct the entire new content in the model's reply.
3. Call `markdown_update_file` with the full new content + `cTag`.

This works, but every edit pushes the whole file — possibly multiple
kilobytes — back through the tool boundary as a model-generated string. The
cost and risk both scale with file size:

- **Tokens.** The new content is materialised in the model's output for
  every edit, even a one-line change.
- **Truncation / corruption.** Long string outputs from a model are far more
  prone to silent edits, dropped lines, smart-quote substitution, or trailing
  whitespace changes than short ones.
- **Reviewability.** A reviewer reading the agent's actions sees a wall of
  text rather than a focused change.

Reference MCP servers solve this with an `edit_file` style tool that takes
an array of `{ oldText, newText }` operations and applies them in place.
The `modelcontextprotocol/servers` filesystem server's `applyFileEdits` is
the canonical example. We adopt the same shape, but the surrounding context
is meaningfully different from a local-filesystem server:

- Files live in OneDrive, not on disk. The `If-Match: <cTag>` round trip is
  the only concurrency primitive — there is no `flock`, no inode, no atomic
  rename.
- The repository already has an established cTag-mismatch contract
  (`MarkdownCTagMismatchError`, "current Revision" surfaced in the error,
  reconcile-via-`markdown_diff_file_versions`). A new write tool must reuse
  that contract verbatim.
- The repository already depends on `diff@^9` (used by
  `markdown_diff_file_versions`) — unified-diff responses cost no new
  dependency.
- Per [ADR-0005](./0005-validated-graph-ids.md), every Graph ID parameter
  must be a `ValidatedGraphId` minted at the tool boundary.

## Decision

Add `markdown_edit` to the `markdown_*` family. It performs N targeted
substring substitutions on a OneDrive markdown file in a single
read-modify-write round trip protected by the existing cTag flow, and
returns a unified diff plus the new cTag.

### 1. Tool surface

```
markdown_edit(
  file_id?: string,        // exactly one of file_id or file_name (idOrNameShape)
  file_name?: string,
  edits: Array<{
    old_string: string,
    new_string: string,
    replace_all?: boolean   // default false
  }>,
  dry_run?: boolean         // default false
)
```

- **`snake_case` parameters** match the existing `markdown_*` tools
  (`fromVersionId` is the lone outlier and is not a precedent we extend).
  We accept `old_string` / `new_string` / `replace_all` / `dry_run` —
  this also matches the conventions other agent toolchains have adopted.
- **`file_id` or `file_name`** mirrors `markdown_get_file` /
  `markdown_update_file` via the existing `idOrNameShape` helper.
- **`edits`** is non-empty (`z.array(...).min(1)`).
- **`dry_run`** stays a parameter rather than becoming a separate
  `markdown_edit_preview` tool. The reference server made the same call;
  splitting would duplicate the entire input schema and double the surface
  for one boolean. The tool's annotations are computed for the worst case
  (`readOnlyHint: false`); a `dry_run` request still earns a clear
  "(dry run)" prefix in the response text.
- **`markdown_insert` is deferred.** Pure insertion is already expressible
  as `{ old_string: "anchor", new_string: "anchor\n…" }`, and adding it
  prematurely creates a second tool whose semantics overlap with `edit`
  (where does the anchor go? what if it doesn't exist?). Revisit if real
  usage shows the workaround is awkward.

### 2. Matching semantics — strict, byte-exact, with `replace_all` opt-in

We deliberately diverge from the reference server's lenient line-by-line
fallback (which trims whitespace per line and re-indents the replacement).

- **Exact substring match.** No fuzzy matching. No per-line whitespace
  normalisation. No re-indenting of `new_string` to match the file. The
  only normalisation is line endings (see decision 3).
- **Default uniqueness.** `old_string` must occur exactly once in the
  current in-memory content. Zero matches and >1 matches are both errors,
  with distinct messages (see decision 7).
- **`replace_all: true`** is the explicit escape hatch for the legitimate
  multi-occurrence case (e.g. rename a token throughout the file).
- **Reject `old_string === new_string`.** A no-op edit is almost certainly
  a model bug; failing loudly is cheaper than silently adding it to the
  history.
- **Reject empty `old_string`.** Two independent reasons, either of which
  is sufficient: (a) `String.prototype.includes("")` returns `true` and
  `split("").join(new_string)` would interleave `new_string` between
  every character — a catastrophic substitution; (b) `"abc".indexOf("",
0)` returns `0`, so the occurrence-counting `indexOf` loop in
  decision 7 would not advance and would spin forever without a
  `needle.length > 0` guard. Rejecting empty `old_string` upstream
  removes the need for the guard at all.

**Rationale for strict over lenient.** The reference server's lenient
line-by-line path exists to paper over model quirks (extra trailing
whitespace, indentation drift) when editing source code in a local repo. In
our context the cost of "the model has to be slightly more careful about
whitespace" is much smaller than the cost of "an edit silently lands on a
not-quite-identical line and corrupts a markdown document we cannot easily
diff back." Strict matching is also predictable, trivially implementable
with `String.prototype.indexOf` / `split` / `join`, and easy to test. If
strictness proves painful in practice we can add a flag later; we cannot
remove flexibility once added.

### 3. Line-ending normalisation: LF on read, LF on write

OneDrive / SharePoint round trips can introduce CRLF where the model
produced LF and vice versa. We normalise once, at the boundary:

1. After download, replace `\r\n` with `\n` to produce the in-memory string
   we match against.
2. Normalise both `old_string` and `new_string` to LF before searching /
   substituting.
3. Write the resulting LF content back. The graphdo-ts cap on file size
   (decision 6) is applied to the normalised content.

We do **not** detect-and-preserve the file's original line ending. Mixed
line endings inside one file (also possible) would make "preserve" itself
ill-defined, and re-emitting CRLF would offer the agent no value while
adding an entire dimension of test cases. Markdown files in OneDrive are
also not source code where toolchains care about line endings; the
normalisation is invisible to humans and to the SharePoint preview.

This is the same `normalizeLineEndings` step the reference server uses
inside `applyFileEdits`. We apply it slightly more aggressively (also to
the persisted result, not just to the in-memory comparison).

### 4. Batched edits — sequential, all-or-nothing, single round trip

- Edits are applied **sequentially** against the evolving in-memory
  content. Edit _N_ sees the result of edits _0…N-1_. This matches the
  reference server and lets the agent compose multi-step refactors in one
  call.
- **Atomic failure.** If any edit fails (no match, multiple matches with
  `replace_all` off, no-op, post-edit size cap breach), the entire batch
  is rejected and nothing is written. The error message identifies which
  edit failed by zero-based index.
- **One Graph round trip pair, not one per edit.** Read once, mutate in
  memory, write once. This is also the only sane way to keep cTag
  semantics meaningful — we do not want to interleave reads and writes
  inside the loop.

### 5. Concurrency — reuse the cTag contract verbatim

The tool must:

1. Resolve the file (id-or-name → `DriveItem`) the same way every other
   markdown tool does (`resolveDriveItem`), validating the resolved id
   into a `ValidatedGraphId` per ADR-0005.
2. Read the current content. We use the existing `downloadMarkdownContent`
   helper, but the tool also needs the file's current `cTag` to write
   back. The cleanest fit is a small new `src/graph/markdown.ts` helper
   `downloadMarkdownContentWithItem(client, itemId, signal): { item:
DriveItem, content: string }` that returns both — `getDriveItem` is
   already called inside `downloadMarkdownContent` for the size check, so
   this is a refactor not a new round trip. The existing
   `downloadMarkdownContent` continues to return just the string for its
   read-only callers.
3. Apply the edits in memory.
4. Call the existing `updateMarkdownFile(client, itemId, cTag, content,
signal)`. That helper already issues the conditional PUT with
   `If-Match: <cTag>` and converts a 412 into `MarkdownCTagMismatchError`
   carrying the new `DriveItem`.
5. The tool catches `MarkdownCTagMismatchError` and renders the **same**
   user-facing message shape that `markdown_update_file` already uses (the
   "Current Revision: …, last modified at …, suggest re-read" format),
   pointing at `markdown_get_file` for the re-read and at
   `markdown_diff_file_versions` for the reconcile. We do not invent a
   second cTag UX.

We do not add an `expected_ctag` parameter. The tool reads-then-writes in
one call; carrying the model's earlier cTag through would only re-introduce
the ambiguity the cTag was supposed to remove ("did the model see the
file the _tool_ read?"). Concurrent writers between the tool's own GET
and PUT are caught by the `If-Match` PUT exactly the same way as today.

The explicit consequence of this choice: **the agent cannot use
`markdown_edit` to assert "the file I saw earlier is still current."**
If the file changed between the agent's last `markdown_get_file` and the
`markdown_edit` call, the edits will either still apply cleanly against
the new content (because the anchor strings still mean what the agent
thought) or fail the uniqueness / not-found check (because they no
longer do). Both outcomes are correct. Agents that genuinely need a
freshness assertion can call `markdown_get_file` immediately before
`markdown_edit` — but in practice the uniqueness check is a stronger
guarantee than a stale cTag would have been, because it is content-aware
rather than revision-aware.

### 6. Size limits

- The post-edit content is checked against the existing 4 MiB markdown cap
  (`MAX_DIRECT_CONTENT_BYTES`) using `Buffer.byteLength(result, "utf-8")`,
  not `result.length`. The check is performed once after the batch is
  applied and before the conditional PUT. `updateMarkdownFile` re-applies
  the same check — the duplication is intentional defence in depth and
  also produces a clearer, edit-tool-specific error.
- We do **not** introduce a separate per-payload cap on individual
  `old_string` / `new_string`. The post-edit total is what actually
  matters for the OneDrive cap; an internal per-string cap would just
  trade one error for a different one, and Microsoft's `text/markdown`
  PUT path is the real ceiling. We do reject `old_string === ""`
  (decision 2) for the catastrophic-substitution reason, not for size.
- The pre-edit downloaded content is already capped by
  `downloadMarkdownContent`, so the tool inherits the read-side limit
  without re-implementing it.

### 7. JavaScript substitution footguns

- **Use `split(oldText).join(newText)`** for both single and "all"
  replacement. This avoids `String.prototype.replace`'s interpretation of
  `$&`, `$1`, `` $` ``, `$'`, and `$$` inside `newText`, which would
  otherwise let any model-emitted `$&` corrupt the replacement. It also
  gives us the occurrence count for free as
  `split(oldText).length - 1`, which the decision 2 uniqueness check
  consumes directly — uniqueness counting and substitution share the
  same primitive, removing any chance of the two getting out of sync.
- **Equivalently safe alternative** is `replace(oldText, () => newText)`
  (function-form replacement bypasses pattern interpretation), but
  `split` / `join` reads more obviously and unifies the count and the
  substitution.
- **Never build a `RegExp` from `old_string`.** Even with escaping, this
  is an unnecessary attack surface and a future maintenance trap.
- **`indexOf`-loop spelling for the count** is documented for clarity
  rather than as a second counting mechanism; in code we use
  `split(oldText).length - 1` per the bullet above. The equivalent
  long-form is:

  ```
  let count = 0, from = 0, idx;
  while ((idx = haystack.indexOf(needle, from)) !== -1) {
    count++;
    from = idx + needle.length;
  }
  ```

  Either spelling produces the same overlap-free count provided
  `needle.length > 0` (decision 2 guarantees this by rejecting empty
  `old_string`).

### 8. Error reporting

Every error path returns a single text content item with `isError: true`,
matching the rest of the `markdown_*` family.

- **No match (count = 0).** `Edit #<i>: old_string was not found in the
current file content. Make old_string longer or include more
surrounding context to match exactly one location. Looked for:
<JSON.stringify(old_string)>`.
- **Multiple matches (count > 1, `replace_all` off).** `Edit #<i>:
old_string matched <count> locations. Pass replace_all: true to replace
every occurrence, or extend old_string with surrounding context until
it matches exactly one location. Looked for: <JSON.stringify(...)>`.
- **No-op edit.** `Edit #<i>: old_string and new_string are identical.
Edits must change the file.`
- **Empty `old_string`.** `Edit #<i>: old_string must not be empty.`
- **Post-edit size breach.** `Edits would produce <bytes> bytes, which
exceeds the <limit>-byte graphdo-ts markdown size cap (tool-side
limit, not a Microsoft Graph API limit).`
- **412 cTag mismatch.** Same wording as today's
  `markdown_update_file` mismatch error, including the new cTag and
  pointing the agent at `markdown_get_file` (re-read) and
  `markdown_diff_file_versions` (reconcile). The agent should not rerun
  the same edits blindly — the cTag mismatch implies the file changed
  underneath us and the anchor strings may no longer mean what the agent
  thought they meant.

`JSON.stringify` is sufficient for whitespace-visible rendering of the
offending `old_string` (it escapes `\n`, `\t`, `\r`, control chars,
quotes) and avoids adding any dependency.

### 9. Response format — unified diff + new cTag, plus structuredContent mirror

On success the tool returns both a text body (authoritative for human
reviewers) and a `structuredContent` mirror (machine-readable for the
agent's next call).

**Text body:**

```
Edited <fileName> (<itemId>)
New cTag: <cTag>
Size: <bytes> bytes
Edits applied: <n>
---
<unified diff produced by createTwoFilesPatch(fileName, fileName,
  before, after, "before", "after", { context: 1 })>
```

**`structuredContent`:**

```ts
{
  fileName: string,
  itemId: string,
  cTag?: string,        // omitted on dry_run
  sizeBytes: number,
  editsApplied: number,
  diff: string,         // unified diff, same content as the text body
}
```

On `dry_run: true` the text body gains a leading `(dry run — no changes
were written)` line, and `structuredContent.cTag` is **omitted** (no PUT
happened, the cTag the agent already holds is still valid). Everything
present in `structuredContent` is also present in the text body — the
text body is authoritative for humans, and `structuredContent` exists
only to spare the agent a regex pass over the header for chained calls.
The unified diff is **mirrored into `structuredContent.diff`** so MCP
clients that prioritise `structuredContent` over the text content body
(common when an `outputSchema` is declared) still surface the diff to
the agent and the user without forcing a follow-up
`markdown_diff_file_versions` round trip. The text body remains the
authoritative human-readable surface; `structuredContent.diff` is a
verbatim mirror, not a second source of truth.

**Rationale.**

- Returning the **full new content** would defeat the entire point of the
  tool — the savings come from not shipping the whole file back through
  the model.
- Returning **only a success summary** would force the agent to call
  `markdown_get_file` to verify what landed, which is wasteful.
- A **unified diff** is compact, human-readable, lines up with what
  `markdown_diff_file_versions` returns (so the agent has one mental
  model for "what changed"), and makes review of the agent's actions
  trivial. The reference server made the same call.
- We tighten the diff context from the conventional `3` down to `1`. The
  agent has just authored the edits and does not need three lines of
  surrounding markdown to orient itself; the response's job is "confirm
  what landed," not "help a cold reviewer understand the file." Markdown
  paragraphs can be long, so three lines of context can easily balloon a
  one-line semantic change into many hundreds of bytes. We can revisit
  empirically once we have real edits to measure.
- The new `cTag` is essential so a follow-up edit can run without an
  intervening `markdown_get_file`. Without it the tool would force the
  agent into a useless re-read.
- `markdown_edit` is the one tool in the markdown family where the
  agent most often wants to chain immediately into another call (next
  edit, diff, list versions). That's the specific reason to break the
  text-only precedent of the other markdown tools and emit
  `structuredContent` here, rather than retrofitting later.

## Consequences

- **Smaller, cheaper edits.** Token cost per edit drops from O(file size)
  to O(diff size) on the response side, and from O(file size) to O(edit
  payload) on the request side.
- **Same concurrency story as `markdown_update_file`.** No new failure
  modes for the agent to learn — a 412 from `markdown_edit` looks and
  behaves like a 412 from `markdown_update_file`, and the same
  `markdown_get_file` / `markdown_diff_file_versions` reconcile loop
  applies.
- **One small refactor in `src/graph/markdown.ts`.** Factor out a
  `downloadMarkdownContentWithItem` so the edit tool can read content +
  cTag in the single GET it already does. `downloadMarkdownContent` keeps
  its current signature and becomes a thin wrapper.
- **Strict matching shifts care to the agent.** Models occasionally
  produce edits that fail uniqueness or fail to match. The error messages
  (decision 8) name the count and show the offending string verbatim, so
  the agent can adapt within the same turn. We accept this cost for the
  predictability and reviewability gains.
- **Test surface grows by one tool.** Graph-layer tests for the new
  helper, integration tests for: single-edit happy path; multi-edit
  sequential composition; `replace_all: true` with multiple matches;
  `replace_all: true` with zero matches → error (the uniqueness rule's
  zero-match branch fires regardless of `replace_all`, on the principle
  that a "replace all" that touches nothing is almost certainly a model
  bug); ambiguous match → error; no match → error; no-op → error; empty
  `old_string` → error; CRLF input normalised; size-cap-breach → error;
  `dry_run` returns diff but does not write and omits cTag from
  `structuredContent`; 412 cTag mismatch surfaces correctly;
  `structuredContent` shape on success.
- **No new runtime dependency.** `diff@^9` is already pinned and used by
  `markdown_diff_file_versions`.

## Reuse vs. adaptation from the MCP filesystem reference server

| Reference (`applyFileEdits` in `modelcontextprotocol/servers`)               | graphdo-ts `markdown_edit`                                                                                                                                                  |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ oldText, newText }` edit shape                                            | **Adopted** as `{ old_string, new_string, replace_all? }` (snake_case + escape hatch)                                                                                       |
| Sequential application of multiple edits in one call                         | **Adopted verbatim**                                                                                                                                                        |
| `dryRun` boolean parameter                                                   | **Adopted** as `dry_run`                                                                                                                                                    |
| Unified-diff response via `diff` package                                     | **Adopted**; we use the same `createTwoFilesPatch` already in use for `markdown_diff_file_versions`                                                                         |
| `normalizeLineEndings` on read & inputs                                      | **Adopted**, and we additionally persist as LF                                                                                                                              |
| Lenient line-by-line fallback that trims whitespace and re-indents `newText` | **Rejected** — strict byte-exact matching only; see decision 2                                                                                                              |
| First-match `String.prototype.replace` (no uniqueness check)                 | **Rejected** — we require exactly one match unless `replace_all: true`; uniqueness counting and substitution share the same `split`/`join` primitive; see decisions 2 and 7 |
| Default unified-diff context width of `3`                                    | **Tightened to `1`** — the agent authored the edits and does not need three lines of surrounding markdown to orient itself; see decision 9                                  |
| Text-only response                                                           | **Augmented** with a `structuredContent` mirror so chained edits do not have to parse the text header; text body remains authoritative; see decision 9                      |
| Local filesystem `fs.writeFile` with no concurrency control                  | **N/A** — replaced by the existing `If-Match: <cTag>` PUT and `MarkdownCTagMismatchError` flow; see decision 5                                                              |
| MCP tool registration via raw `server.registerTool`                          | **Adapted** to the project's `defineTool` + static `ToolDef` split (`markdown-defs.ts` + `markdown-register.ts`)                                                            |

## Alternatives considered

- **A separate `markdown_edit_preview` tool instead of `dry_run`.**
  Rejected: doubles the registration surface for one boolean, and the
  reference server's `dryRun` precedent is well-established.
- **Lenient line-by-line matching with whitespace flexibility (the
  reference server's fallback path).** Rejected for predictability /
  reviewability reasons; see decision 2.
- **Returning the full new file content.** Rejected — eliminates the
  primary motivation for the tool.
- **Per-edit `expected_ctag` to assert the agent's view of the file
  matches.** Rejected — the tool reads-then-writes in one call, so the
  conditional PUT against the just-read cTag already provides the
  guarantee. An agent-supplied cTag would only express "the file the
  model saw earlier should match what the tool reads now," which is
  outside the tool's contract.
- **Building a regex from `old_string` for `replace_all`.** Rejected —
  see decision 7. `split` / `join` is safer and clearer.
- **Adding `markdown_insert` in the same change.** Deferred — the use
  case is already expressible; revisit when real usage shows it's
  awkward.
- **A separate per-payload size cap for `old_string` / `new_string`.**
  Rejected — the post-edit total against the existing 4 MiB cap is what
  matters; a per-payload cap would add a second error class without
  preventing any real failure mode.

## Out of scope

- **Insert / append / prepend tools** (`markdown_insert`,
  `markdown_append`). Deferred per decision 1.
- **Patch-format input** (a unified diff supplied by the model). The
  `oldText`/`newText` shape is more robust to model output than
  hand-rolled patches; revisit only if real friction appears.
- **Cross-file edits.** Out of scope — one tool call edits one file.
- **Edits to historical revisions.** OneDrive does not support writing
  to a prior revision; the agent must use `markdown_get_file_version` +
  `markdown_create_file` / `markdown_update_file` to fork from history.

## Follow-up — `markdown_append` (the deferred tool ships)

> **Status:** Accepted as a follow-up to this ADR.
> **Date:** 2026-04-22

The "Out of scope" entry above explicitly deferred
`markdown_insert` / `markdown_append` / `markdown_prepend` on the
grounds that pure insertion is expressible via `markdown_edit`. After
re-evaluating actual append-style workflows (journals, daily notes,
running todo logs, append-only changelogs) we concluded that one of
those three — **`markdown_append`** — is worth shipping immediately,
and that the remaining two stay deferred for the reasons originally
stated.

### Why `markdown_append` specifically

The `markdown_edit` workaround for end-of-file append is `{ old_string:
<last bytes of file>, new_string: <last bytes of file> + <new content> }`.
That requires the agent to **first read the file** to discover the tail
bytes, which defeats the very token-savings rationale for which
`markdown_edit` exists. Append-style workflows are also the case where
the tool would otherwise pay off the most (one tiny payload per
journal entry, repeated all day).

The "where does the anchor go? what if it doesn't exist?" worry that
deferred `markdown_insert` does not apply to append at all: the
insertion site is always "after the last byte of the file." Append has
zero anchor ambiguity, no markdown parser dependency, and no level-aware
section-boundary semantics to design.

### Research — how other MCP servers handle this

| Server                                                | Insertion surface                                                                                                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `modelcontextprotocol/servers` filesystem (reference) | No insert/append/prepend. Single `edit_file` with `{ oldText, newText }` — the same shape this ADR adopted for `markdown_edit`.                                                                                                |
| `MarkusPfundstein/mcp-obsidian` (community)           | Two tools: a simple `obsidian_append_content` for whole-file append; and a richer `obsidian_patch_content` with `operation: append \| prepend \| replace` × `target_type: heading \| block \| frontmatter` for anchored edits. |

We adopt the simple-append shape from `mcp-obsidian` (one obvious
insertion site, no anchor parsing) and explicitly **defer** the
heading-anchored variant. Heading-anchored insertion is more powerful
but is a separate design conversation: choice of markdown parser /
heading-detection algorithm, frontmatter handling, level-aware section
boundaries, and "what if the heading doesn't exist?" disambiguation —
all material enough to deserve their own ADR rather than be smuggled in
as a sub-bullet of this one.

### Tool surface

```
markdown_append(
  file_id?: string,        // exactly one of file_id or file_name (idOrNameShape)
  file_name?: string,
  content: string,         // non-empty after LF normalisation
  dry_run?: boolean        // default false
)
```

Same `idOrNameShape` resolver as the rest of the markdown family.

### Separator policy — auto-LF at the join boundary, never elsewhere

If (and only if) the existing file is **non-empty** and **does not end
with `\n`**, the tool inserts exactly one `\n` between the existing
tail and `content`. Otherwise nothing is inserted. The trailing
newline of `content` itself is preserved verbatim — the tool never
adds a final newline that was not there in the input.

This is the POSIX "every line ends with `\n`" convention. It is
invisible in the common case (file already ends with `\n`) and saves
the agent from having to track whether a trailing newline exists in
order to avoid producing `## Heading` followed by `next line` glued
together as `## Headingnext line`. We deliberately do **not**
auto-add a `\n` after `content` — that would make the tool surreptitiously
modify the agent's payload, and would make round-trip-stable
behaviour ("append then preview then append again") impossible to
reason about.

We do not introduce a configurable separator parameter. The only two
defensible behaviours are "ensure exactly one `\n` at the join" and
"insert nothing"; if an agent really wants to control the join
explicitly it can include the leading `\n` in `content` itself —
the policy is "exactly one `\n` at the join", so an additional
leading `\n` would in fact be visible and persisted as a blank line.

### Reused verbatim from `markdown_edit`

Everything below is the same code path as `markdown_edit`, used
without modification or new wrapper helpers:

- **Concurrency** — `downloadMarkdownContentWithItem` to read content
  - cTag in one GET, then `updateMarkdownFile` for the conditional PUT.
    The same `MarkdownCTagMismatchError` reconcile message format
    (`Current cTag` / `Current Revision` / `Modified` / `Size`, plus the
    three numbered next-step instructions pointing at
    `markdown_get_file` and `markdown_diff_file_versions`).
- **Line-ending normalisation** — `normalizeLineEndings` on the
  downloaded content, on `content`, and on the persisted result. LF
  on read, LF on input, LF on write.
- **Size cap** — `MAX_DIRECT_CONTENT_BYTES` (4 MiB) defence-in-depth
  re-check on the post-append byte length, with an
  append-tool-specific error message before the conditional PUT
  (consistent with how `markdown_edit` reports its own breach).
- **`dry_run`** — same `(dry run — no changes were written)` header,
  same omission of `cTag` from `structuredContent` when no PUT
  happened.
- **Response shape** — text body authoritative for humans, plus a
  `structuredContent` mirror for chained calls. Unified diff via
  `createTwoFilesPatch` with `context: 1` (mirrored into
  `structuredContent.diff`).
- **Annotations** — `readOnlyHint: false`, `idempotentHint: false`,
  `openWorldHint: false`. Same pessimistic-readOnlyHint convention
  rather than splitting `dry_run` into a separate read-only tool.

### Validation rules unique to `markdown_append`

- **`content` must be non-empty after LF normalisation.** Same
  rationale as decision 2 of this ADR (a no-op append is almost
  certainly a model bug; failing loudly is cheaper than silently
  adding it to the history). Enforced both at the zod layer and as
  defence-in-depth in the handler.
- **Subdirectory / unsupported-name guards** — same `item.folder !==
undefined` and `validateMarkdownFileName(item.name)` checks the rest
  of the markdown family applies.
- **`structuredContent.bytesAppended`** is `Buffer.byteLength(after) -
Buffer.byteLength(before)` and so reflects both the
  LF-normalised `content` **and** the auto-inserted separator (when
  applied). The agent does not need to compute the separator's
  contribution itself.

### Still deferred

- **`markdown_prepend`.** Symmetric to append in implementation but
  not in usefulness: most markdown files have a metadata header
  / title line at the top; prepending raw content at byte 0
  produces broken docs more often than not. The `markdown_edit`
  workaround `{ old_string: <first line>, new_string: <new content>
  - <first line> }` already works and the failure mode (anchor not
    found) is well-defined. Revisit only if real usage shows the
    workaround is awkward.
- **`markdown_insert`** (heading- or block-anchored). Defer to a
  separate ADR as discussed above — the design surface (parser
  choice, frontmatter handling, level-aware boundaries, "what if the
  heading doesn't exist?") is large enough to deserve its own
  conversation rather than being a sub-bullet here.

### Test surface

Mirrors the `markdown_edit` integration tests with the cases that
are unique to append: separator policy under each of the three
existing-content shapes (empty, non-empty without trailing `\n`,
non-empty with trailing `\n`); preservation of `content`'s own
trailing-newline-or-lack-thereof; CRLF normalisation of both stored
content and `content`; empty-content rejection; subdirectory guard;
size-cap breach (atomic, no write); `dry_run` (no write, no cTag in
`structuredContent`, diff present); 412 cTag mismatch reconcile
wording; sequential calls; `itemId` addressing parity; happy path with
full `structuredContent` shape assertions.
