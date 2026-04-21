// Pure parser, deterministic emitter, and `---` envelope helpers for the
// `collab:` frontmatter (collab v1 §3.1). Split out from `frontmatter.ts`;
// re-exported through the barrel.

import { stringify as yamlStringify, parseDocument as yamlParseDocument } from "yaml";

import { CollabFrontmatterSchema, type CollabFrontmatter } from "./frontmatter-schema.js";

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
