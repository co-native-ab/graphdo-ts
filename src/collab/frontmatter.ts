// Frontmatter codec for the authoritative `.md` file (collab v1 §3.1).
//
// Owns the strict `collab:` YAML schema, hardened parser, deterministic
// emitter, and the `---` envelope split/join helpers. Every collab read
// path reaches the live file through these primitives; every collab
// write path reaches OneDrive through them. The downstream contract
// (per §3.1):
//
//   serialize(parse(serialize(input))) === serialize(input)
//
// holds for every well-formed input. The matching round-trip and
// byte-exact snapshot tests live in `test/collab/frontmatter.test.ts`
// and `test/collab/frontmatter-snapshot.test.ts`. ADR-0008 records
// the `yaml ~2.x.y` pinning policy that makes byte-stability a release
// gate rather than a hope.
//
// Hardening (per §6 of `collab-v1.md`):
//
// 1. Single-document parser only. Multi-document YAML (`---` between
//    bodies) is treated as malformed before Zod even sees it — multi-doc
//    inputs are a parser-confusion vector and have no place in our
//    frontmatter format.
// 2. No custom tags (`!!js/function`, `!!python/object`, ...). The
//    parser is configured with `customTags: []`.
// 3. Plain-object root only. After parsing we verify
//    `Object.getPrototypeOf(root) === Object.prototype` to reject any
//    YAML alias / tag tricks that produce class instances or arrays
//    at the top level. Zod then enforces the shape.
// 4. Strict Zod schema (`.strict()` everywhere). Unknown keys at any
//    level fail loudly — silent extras would let a cooperator smuggle
//    fields past every consumer that does not happen to read them.
// 5. Maximum body size guard before parsing. The shape is compact in
//    practice (single-digit KiB even with hundreds of authorship
//    entries); anything noticeably larger is a sign of misuse.
//
// Determinism (per §3.1):
//
// - Stable key order: each collection in the schema is emitted in the
//   declared order, regardless of the runtime insertion order of the
//   input object. The codec rebuilds the object before stringifying so
//   a hand-constructed input cannot drift the output.
// - Always-quoted strings (`defaultStringType: "QUOTE_DOUBLE"`). The
//   determinism contract calls for quoting every string containing `:`
//   or starting with a YAML sentinel character; quoting *every* string
//   is a strict superset, costs only a handful of bytes, and removes
//   the entire class of "did the parser pick this up as a number /
//   timestamp / null?" ambiguity.
// - Two-space indent, LF-only line endings (`lineWidth: 0` to disable
//   yaml's word-wrap), no directives header (`directives: false`).
// - The wrapper that callers most often touch (`serializeFrontmatter`)
//   appends a trailing LF so the output drops cleanly into a
//   `---\n…\n---\n` envelope.

import { stringify as yamlStringify, parseDocument as yamlParseDocument } from "yaml";
import { z } from "zod";

import { DocIdRecoveryRequiredError } from "../errors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Schema version this codec emits and accepts on the `collab.version` field. */
export const COLLAB_FRONTMATTER_VERSION = 1;

/**
 * Hard upper bound on the YAML body length the parser will look at. Real
 * frontmatter is well under 64 KiB even with hundreds of authorship
 * entries — anything noticeably larger is malformed input or a
 * resource-exhaustion attempt and is rejected before parsing.
 */
const FRONTMATTER_MAX_BYTES = 256 * 1024;

/** Open / close delimiter line for the YAML envelope. */
const FRONTMATTER_DELIMITER = "---";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * One entry in `collab.sections[]`. Carries the GitHub-flavored heading
 * slug (`id`) and the human-readable heading text (`title`). Lease state
 * lives in `.collab/leases.json` per §3.2.1, not on the section.
 */
export const FrontmatterSectionSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
  })
  .strict();
export type FrontmatterSection = z.infer<typeof FrontmatterSectionSchema>;

/**
 * Source of a proposal entry — the channel through which the proposing
 * agent received the request. Mirrors the `collab_create_proposal`
 * `source` parameter (W4 Day 2).
 */
export const FrontmatterProposalSourceSchema = z.enum(["chat", "file", "agent"]);

/**
 * Lifecycle state of a proposal entry. `applied`/`superseded`/`withdrawn`
 * are terminal; `open` is the only state whose body should be considered
 * for re-application.
 */
export const FrontmatterProposalStatusSchema = z.enum([
  "open",
  "applied",
  "superseded",
  "withdrawn",
]);

/**
 * One entry in `collab.proposals[]`. See §3.1 for the field-by-field
 * contract; key points for the codec are that `author_agent_id` is a
 * **claim** (frontmatter is untrusted for authorization, ADR-0005
 * decision 2) and `target_section_content_hash_at_create` is the
 * snapshot used by `collab_apply_proposal` to detect drift.
 */
export const FrontmatterProposalSchema = z
  .object({
    id: z.string().min(1),
    target_section_slug: z.string().min(1),
    target_section_content_hash_at_create: z.string().min(1),
    author_agent_id: z.string().min(1),
    author_display_name: z.string().min(1),
    created_at: z.iso.datetime({ offset: true }),
    status: FrontmatterProposalStatusSchema,
    body_path: z.string().min(1),
    rationale: z.string(),
    source: FrontmatterProposalSourceSchema,
  })
  .strict();
export type FrontmatterProposal = z.infer<typeof FrontmatterProposalSchema>;

/**
 * Author kind for an authorship entry — `agent` for tool-driven writes,
 * `human` for OneDrive-web edits surfaced through the audit reconciler.
 */
export const FrontmatterAuthorKindSchema = z.enum(["agent", "human"]);

/**
 * One entry in `collab.authorship[]`. Append-only per §3.1.
 * `target_section_slug` is the slug at write time; `section_content_hash`
 * is the SHA-256 of the section body at write time and survives slug
 * renames per §3.1 drift handling.
 */
export const FrontmatterAuthorshipSchema = z
  .object({
    target_section_slug: z.string().min(1),
    section_content_hash: z.string().min(1),
    author_kind: FrontmatterAuthorKindSchema,
    author_agent_id: z.string().min(1),
    author_display_name: z.string().min(1),
    written_at: z.iso.datetime({ offset: true }),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type FrontmatterAuthorship = z.infer<typeof FrontmatterAuthorshipSchema>;

/**
 * Inner `collab:` block per §3.1. The arrays default to empty so freshly
 * minted frontmatter (created by the first `collab_write` after a
 * `frontmatter_reset`) does not require the caller to supply empty
 * collections.
 */
export const CollabBlockSchema = z
  .object({
    version: z.literal(COLLAB_FRONTMATTER_VERSION),
    doc_id: z.string().min(1),
    created_at: z.iso.datetime({ offset: true }),
    sections: z.array(FrontmatterSectionSchema).default([]),
    proposals: z.array(FrontmatterProposalSchema).default([]),
    authorship: z.array(FrontmatterAuthorshipSchema).default([]),
  })
  .strict();
export type CollabBlock = z.infer<typeof CollabBlockSchema>;

/**
 * Top-level `---` block. The schema rejects any sibling key alongside
 * `collab:` — frontmatter for the authoritative file is collab's
 * coordination state, not a free-form metadata bag.
 */
export const CollabFrontmatterSchema = z
  .object({
    collab: CollabBlockSchema,
  })
  .strict();
export type CollabFrontmatter = z.infer<typeof CollabFrontmatterSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised for any decoding or validation failure inside the codec. */
export class FrontmatterParseError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(`Frontmatter parse failed: ${message}`);
    this.name = "FrontmatterParseError";
  }
}

/**
 * Raised when the deterministic-emitter contract
 * (`serialize(parse(serialize(input))) === serialize(input)`) is
 * violated at runtime. This should be impossible if the codec is
 * functioning correctly; it exists so the call site (`collab_write`)
 * can refuse to PUT a body it cannot reproduce. Round-trip is also
 * asserted in the test suite so the gate fires there first.
 */
export class FrontmatterRoundtripError extends Error {
  constructor(message: string) {
    super(`Frontmatter round-trip failed: ${message}`);
    this.name = "FrontmatterRoundtripError";
  }
}

// ---------------------------------------------------------------------------
// Pure codec
// ---------------------------------------------------------------------------

/**
 * Parse the inner YAML body of a `---`-delimited frontmatter block.
 * The input is the YAML *without* the surrounding delimiter lines —
 * use {@link splitFrontmatter} to peel the envelope first.
 */
export function parseFrontmatter(yamlBody: string): CollabFrontmatter {
  if (yamlBody.length > FRONTMATTER_MAX_BYTES) {
    throw new FrontmatterParseError(
      `body length ${String(yamlBody.length)} exceeds ${String(FRONTMATTER_MAX_BYTES)} bytes`,
    );
  }
  // Explicitly reject multi-document YAML before invoking the parser.
  // Multi-doc input is a parser-confusion vector (per §6 hardening) and
  // there is no legitimate reason for an inner frontmatter body to
  // contain a `---` or `...` document separator.
  if (/(^|\n)(---|\.\.\.)\s*(\n|$)/.test(yamlBody)) {
    throw new FrontmatterParseError("body contains a YAML document separator");
  }
  let raw: unknown;
  try {
    const doc = yamlParseDocument(yamlBody, {
      // Hardened parse options per §6.
      prettyErrors: true,
      strict: true,
      // Reject `!!js/function` / `!!python/object` style custom tags. The
      // empty-array form disables the YAML 1.2 schema-extension surface
      // that historically produced `js-yaml` RCEs.
      customTags: [],
      // Keep timestamps as plain strings (the schema validates them as
      // RFC 3339 datetimes via Zod). The default already does this for
      // `yaml@2.x` but pinning it here documents intent.
      schema: "core",
      // Silence yaml's own logger; we surface both `errors` and `warnings`
      // explicitly below so test output is not polluted by `console.warn`.
      logLevel: "silent",
    });
    // Treat warnings (e.g. unresolved custom tags) as hard failures so
    // hardening item §6 ("Forbid custom tags") actually rejects them
    // instead of silently parsing them as plain mappings.
    if (doc.errors.length > 0) {
      const first = doc.errors[0];
      throw first ?? new Error("yaml parse failed");
    }
    if (doc.warnings.length > 0) {
      const first = doc.warnings[0];
      throw first ?? new Error("yaml parse warning");
    }
    raw = doc.toJS();
  } catch (err) {
    throw new FrontmatterParseError(err instanceof Error ? err.message : "yaml parse failed", err);
  }
  if (raw === undefined || raw === null) {
    throw new FrontmatterParseError("body is empty");
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new FrontmatterParseError("body root is not a YAML mapping");
  }
  // Refuse anything that is not a vanilla `Object.create({})` — defends
  // against alias / tag tricks that surface as class instances.
  if (Object.getPrototypeOf(raw) !== Object.prototype) {
    throw new FrontmatterParseError("body root is not a plain object");
  }
  const result = CollabFrontmatterSchema.safeParse(raw);
  if (!result.success) {
    throw new FrontmatterParseError(result.error.message, result.error);
  }
  return result.data;
}

/**
 * Build a canonically-ordered shallow copy of the input. Stringifying
 * this result yields stable byte output regardless of how the caller
 * happened to construct their object literal. Pure helper, no I/O.
 */
function canonicalise(input: CollabFrontmatter): CollabFrontmatter {
  // Validate and apply schema defaults first so the order of `default([])`
  // arrays is consistent across hand-built and parsed inputs.
  const parsed = CollabFrontmatterSchema.parse(input);
  return {
    collab: {
      version: parsed.collab.version,
      doc_id: parsed.collab.doc_id,
      created_at: parsed.collab.created_at,
      sections: parsed.collab.sections.map((s) => ({
        id: s.id,
        title: s.title,
      })),
      proposals: parsed.collab.proposals.map((p) => ({
        id: p.id,
        target_section_slug: p.target_section_slug,
        target_section_content_hash_at_create: p.target_section_content_hash_at_create,
        author_agent_id: p.author_agent_id,
        author_display_name: p.author_display_name,
        created_at: p.created_at,
        status: p.status,
        body_path: p.body_path,
        rationale: p.rationale,
        source: p.source,
      })),
      authorship: parsed.collab.authorship.map((a) => ({
        target_section_slug: a.target_section_slug,
        section_content_hash: a.section_content_hash,
        author_kind: a.author_kind,
        author_agent_id: a.author_agent_id,
        author_display_name: a.author_display_name,
        written_at: a.written_at,
        revision: a.revision,
      })),
    },
  };
}

/**
 * Serialise a {@link CollabFrontmatter} to canonical YAML. The output
 * does **not** include the surrounding `---` delimiter lines — use
 * {@link joinFrontmatter} when wrapping a Markdown body.
 *
 * Determinism contract (§3.1):
 * - stable key order (declared in schema; rebuilt by `canonicalise`),
 * - two-space indent,
 * - always-quoted strings (`QUOTE_DOUBLE`),
 * - LF only (no CRLF), no trailing spaces,
 * - no `---` directives header.
 *
 * The function asserts `parse(out) === input` semantically and throws
 * {@link FrontmatterRoundtripError} otherwise — defence-in-depth for
 * the codec invariant. The matching test suite catches violations
 * before this branch ever fires in production.
 */
export function serializeFrontmatter(input: CollabFrontmatter): string {
  const canonical = canonicalise(input);
  const yaml = yamlStringify(canonical, {
    indent: 2,
    lineWidth: 0,
    minContentWidth: 0,
    defaultStringType: "QUOTE_DOUBLE",
    defaultKeyType: "PLAIN",
    directives: false,
    // Emit timestamps and dates as their string form; we never put a
    // `Date` instance into the input graph but pin the behaviour.
    schema: "core",
  });
  // Belt and braces: round-trip through the parser. A future yaml minor
  // bump that produces non-canonical output trips this gate before we
  // PUT anything to OneDrive.
  let reparsed: CollabFrontmatter;
  try {
    reparsed = parseFrontmatter(yaml);
  } catch (err) {
    throw new FrontmatterRoundtripError(
      err instanceof Error ? err.message : "round-trip parse failed",
    );
  }
  const reEmitted = yamlStringify(canonicalise(reparsed), {
    indent: 2,
    lineWidth: 0,
    minContentWidth: 0,
    defaultStringType: "QUOTE_DOUBLE",
    defaultKeyType: "PLAIN",
    directives: false,
    schema: "core",
  });
  if (reEmitted !== yaml) {
    throw new FrontmatterRoundtripError("re-emitted YAML differs from initial emit");
  }
  return yaml;
}

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

/** Result of {@link splitFrontmatter}. */
export interface SplitFrontmatterResult {
  /** Raw YAML between the opening and closing `---` lines, without the delimiters. */
  yaml: string;
  /** Markdown body following the closing `---` line (may be empty). */
  body: string;
}

/**
 * Peel the leading `---\n…\n---\n` envelope off a Markdown file, returning
 * the inner YAML and the trailing body separately. Returns `null` if the
 * file has no frontmatter envelope.
 *
 * Recognises both LF and CRLF line endings on the input but the returned
 * `yaml` and `body` are LF-normalised. Per §3.1, the first line of the
 * file must be exactly `---` (no BOM, no leading whitespace).
 */
export function splitFrontmatter(content: string): SplitFrontmatterResult | null {
  // Normalise CRLF → LF early so the regex below stays simple. The codec
  // re-emits LF only, matching the determinism contract.
  const normalised = content.replace(/\r\n/g, "\n");
  if (!normalised.startsWith(`${FRONTMATTER_DELIMITER}\n`)) {
    return null;
  }
  // Find the next `---` line after the opening one.
  const startIdx = FRONTMATTER_DELIMITER.length + 1; // skip "---\n"
  const closingPattern = new RegExp(`^${FRONTMATTER_DELIMITER}\\s*$`, "m");
  const rest = normalised.slice(startIdx);
  const match = closingPattern.exec(rest);
  if (!match) {
    return null;
  }
  const yaml = rest.slice(0, match.index);
  const afterDelimiter = rest.slice(match.index + match[0].length);
  // Strip a single leading newline after the closing `---` so callers do
  // not see a phantom blank line at the top of every body.
  const body = afterDelimiter.startsWith("\n") ? afterDelimiter.slice(1) : afterDelimiter;
  return { yaml, body };
}

/**
 * Wrap a serialised YAML body and a Markdown body in the canonical
 * `---\n…\n---\n` envelope. The `yaml` argument must already end with a
 * newline (as `serializeFrontmatter` produces). The body is appended
 * verbatim — callers that want a blank line between the closing
 * delimiter and the first heading should include it in `body`.
 */
export function joinFrontmatter(yaml: string, body: string): string {
  if (!yaml.endsWith("\n")) {
    throw new FrontmatterRoundtripError("yaml argument must end with a newline");
  }
  return `${FRONTMATTER_DELIMITER}\n${yaml}${FRONTMATTER_DELIMITER}\n${body}`;
}

// ---------------------------------------------------------------------------
// Read-with-recovery
//
// W2 Day 2 — `doc_id` recovery + `frontmatter_reset` audit
// (`docs/plans/collab-v1.md` §3.1, §9 "Week 2").
//
// The read path for the authoritative `.md` file must tolerate two
// distinct failure modes that show up when a human (or another tool)
// edits the file outside of `collab_write`:
//
// 1. **Missing envelope** — the OneDrive web UI "remove all formatting"
//    affordance, or a hand-edit that deleted the leading `---\n…\n---\n`
//    block entirely. There is no YAML to parse; the body is whatever
//    the human typed.
// 2. **Malformed envelope** — the delimiters are present but the inner
//    YAML fails the hardened parser (custom tag, multi-doc, sibling
//    keys at root, schema mismatch, etc.). The body sits after the
//    closing `---` and is still readable.
//
// Both cases are recoverable. The read path returns defaults to the
// caller and emits a `frontmatter_reset` audit entry (the writer lands
// in W3 Day 3; this file produces the typed envelope it consumes). The
// next `collab_write` re-injects a freshly serialised block carrying
// the prior `doc_id` recovered from local project metadata
// (`<configDir>/projects/<projectId>.json`). When that local cache is
// also absent — fresh machine + wiped frontmatter — the writer refuses
// with `DocIdRecoveryRequiredError` and points the agent at
// `session_recover_doc_id` (W5 Day 1).
//
// These helpers are pure (no Graph, no fs, no audit I/O) so the
// downstream `collab_read` and `collab_write` tools can orchestrate
// the actual side effects (Graph fetch, audit append, local-cache
// update) at their own composition layer.
// ---------------------------------------------------------------------------

/**
 * Why the read path produced default frontmatter instead of a parsed
 * block. Mirrors the `frontmatter_reset.reason` enum in `§3.6`
 * (audit-log table); kept in sync with the typed audit envelope below.
 */
export type FrontmatterResetReason = "missing" | "malformed";

/**
 * Outcome of {@link readMarkdownFrontmatter}.
 *
 * - `parsed` — leading envelope present and the inner YAML satisfied
 *   the strict schema. The caller uses `frontmatter` directly; no
 *   audit entry is required.
 * - `reset` — envelope was missing or malformed. The caller treats
 *   `frontmatter` as defaults (no `collab` state — schema does not
 *   permit a `null` `doc_id`, so we expose `null` for the doc_id
 *   field instead of synthesising one), records a `frontmatter_reset`
 *   audit entry, and falls back to local metadata for `doc_id` on the
 *   next write via {@link resolveDocId}.
 *
 * In both cases `body` is the markdown body following the (possibly
 * absent) closing delimiter, normalised to LF line endings.
 */
export type ReadFrontmatterResult =
  | {
      kind: "parsed";
      frontmatter: CollabFrontmatter;
      body: string;
    }
  | {
      kind: "reset";
      reason: FrontmatterResetReason;
      body: string;
      /**
       * Underlying parser failure when {@link FrontmatterResetReason}
       * is `"malformed"`. Surfaced for diagnostic logging only — the
       * audit envelope intentionally records `reason` and not the raw
       * parse message (which can leak parts of a cooperator-edited
       * file body). `undefined` when `reason === "missing"`.
       */
      parseError?: FrontmatterParseError;
    };

/**
 * Read the authoritative-file content into either a parsed
 * frontmatter block or a structured "reset" outcome with the body
 * preserved. Pure — no I/O. Performs no `doc_id` recovery itself; pair
 * with {@link resolveDocId} once the caller has loaded the local
 * project metadata.
 */
export function readMarkdownFrontmatter(content: string): ReadFrontmatterResult {
  const split = splitFrontmatter(content);
  if (split === null) {
    // Either no leading `---\n…\n---\n` envelope at all, or the
    // opening `---` had no closing partner. Both are "missing" from
    // the read-path's perspective: there is no parseable frontmatter.
    // Preserve the body so `collab_read` can still echo the file
    // content and so the next `collab_write` does not stomp on what
    // the human typed.
    return {
      kind: "reset",
      reason: "missing",
      body: content.replace(/\r\n/g, "\n"),
    };
  }
  try {
    const frontmatter = parseFrontmatter(split.yaml);
    return { kind: "parsed", frontmatter, body: split.body };
  } catch (err) {
    // The hardened parser surfaces every failure as
    // `FrontmatterParseError` (yaml errors, schema mismatch,
    // prototype-pollution attempts, oversize bodies, multi-doc
    // separators). All of these are "malformed" from the read-path's
    // perspective; the writer-side codepath is identical regardless
    // of which sub-reason fired.
    if (err instanceof FrontmatterParseError) {
      return {
        kind: "reset",
        reason: "malformed",
        body: split.body,
        parseError: err,
      };
    }
    // Any other throw is a programmer error inside the codec — let it
    // propagate so it is caught by the call site rather than silently
    // demoted to "malformed" (which would mask a regression).
    throw err;
  }
}

/**
 * Resolved `doc_id` outcome from {@link resolveDocId}.
 *
 * `source` records which input wins so the caller can emit the right
 * audit entry: a `parsed` read with `source: "frontmatter"` is the
 * happy path (no extra audit), while a `reset` read with
 * `source: "local-cache"` is the recovery path that pairs with a
 * `frontmatter_reset` audit entry carrying `recoveredDocId: true`.
 */
export interface DocIdResolution {
  docId: string;
  source: "frontmatter" | "local-cache";
}

/**
 * Resolve the `doc_id` for the authoritative file given the read
 * outcome and the local project metadata's cached `docId`.
 *
 * - Read returned `parsed` ⇒ frontmatter wins. The cached value (if
 *   any) is ignored; §3.1 says the embedded value is authoritative
 *   when present and parseable.
 * - Read returned `reset` and `cachedDocId` is non-null ⇒ recovery
 *   from local cache. The next write re-injects this `doc_id`.
 * - Read returned `reset` and `cachedDocId` is null ⇒ throw
 *   {@link DocIdRecoveryRequiredError} so the writer refuses and
 *   directs the agent at `session_recover_doc_id`.
 *
 * `projectId` is used only to compose a helpful error message —
 * pass the locally-known id, not the (possibly missing) frontmatter
 * one.
 */
export function resolveDocId(
  read: ReadFrontmatterResult,
  cachedDocId: string | null,
  projectId: string,
): DocIdResolution {
  if (read.kind === "parsed") {
    return { docId: read.frontmatter.collab.doc_id, source: "frontmatter" };
  }
  if (cachedDocId !== null) {
    return { docId: cachedDocId, source: "local-cache" };
  }
  throw new DocIdRecoveryRequiredError(projectId);
}

/**
 * Typed envelope for the `frontmatter_reset` audit entry (§3.6).
 *
 * The W3 Day 3 audit writer composes this from the read outcome plus
 * the file's pre-read revision and whether {@link resolveDocId}
 * succeeded. Defined here next to the helpers that produce its
 * inputs so a future schema bump touches one file, not two.
 *
 * Field meanings (per §3.6):
 *
 * - `reason` — which read-path branch fired.
 * - `previousRevision` — the file's `cTag` immediately before the
 *   read that triggered this reset, or `null` when the file had no
 *   revision history (created in the same operation). Carried
 *   verbatim from the Graph response; the audit writer is
 *   responsible for redacting any sensitive substrings (§3.6).
 * - `recoveredDocId` — `true` if `doc_id` was recoverable from local
 *   cache, `false` if `DocIdRecoveryRequiredError` was raised. The
 *   writer logs the reset entry **before** the recovery throw
 *   propagates so the unrecoverable case is auditable too.
 */
export interface FrontmatterResetAudit {
  reason: FrontmatterResetReason;
  previousRevision: string | null;
  recoveredDocId: boolean;
}
