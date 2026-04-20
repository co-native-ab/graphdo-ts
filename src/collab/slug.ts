// Heading slug helper for collab v1 (`docs/plans/collab-v1.md` §3.1).
//
// **W3 Day 4** shipped the steps that `collab_acquire_section` /
// `collab_release_section` need:
//
//   1. Lowercase the heading text after stripping leading `#`s and
//      trimming whitespace.
//   2. NFKD-normalise + strip non `[a-z0-9-_ ]` characters.
//   3. Replace whitespace runs with a single `-`.
//   4. Empty result → synthetic slug `__heading__`.
//   5. Walk the document in source order; on collision append `-1`,
//      `-2`, … until unique (matches GitHub's anchor generator).
//
// **W4 Day 1** extends this module with the `__preamble__` synthetic
// (prose before the first heading) and a body-walking helper that
// returns each section's slug, heading level, and byte range so the
// authorship module (`src/collab/authorship.ts`) can compute stable
// SHA-256 anchors over section bodies. The slug-drift fallback used by
// `collab_apply_proposal` (slug → content-hash) is implemented in
// `src/collab/authorship.ts` on top of {@link walkSections}; the lease
// tools continue to use the strict slug-equality contract above
// (§2.3 `collab_acquire_section`).

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Synthetic slug used when a heading slugifies to the empty string (§3.1 step 4). */
export const EMPTY_HEADING_SYNTHETIC_SLUG = "__heading__";

/**
 * Synthetic slug used for prose that precedes the first ATX heading
 * (§3.1 step 6). Tools that operate on the preamble must opt in via
 * `allowSyntheticSlugs: true`; the default `target_section_slug`
 * validation rejects the double-underscore prefix.
 */
export const PREAMBLE_SYNTHETIC_SLUG = "__preamble__";

/** Match an ATX heading (`#` … `######`) at the start of a line. */
const ATX_HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Slugify a single heading text per §3.1 steps 1–4. Does **not** handle
 * collisions — see {@link slugifyHeadings} for the source-order walk
 * that adds the `-N` suffix on duplicates.
 *
 * The leading `#`s and trailing closing `#`s are tolerated when the
 * caller passes a raw heading line (e.g. `"## Introduction"`).
 */
export function slugifyHeading(rawHeading: string): string {
  // 1. Strip leading `#`s + surrounding whitespace.
  const withoutHashes = rawHeading
    .replace(/^[ \t]*#{1,6}[ \t]+/u, "")
    .replace(/[ \t]+#*[ \t]*$/u, "");
  const trimmed = withoutHashes.trim();
  // Empty / hash-only line → synthetic slug.
  if (trimmed.length === 0) return EMPTY_HEADING_SYNTHETIC_SLUG;

  // 2. Lowercase, NFKD normalise, strip everything outside `[a-z0-9-_ ]`.
  // NFKD splits accented chars into base+combining marks; the strip
  // step then drops the marks, giving an ASCII fold ("Café" → "cafe").
  const folded = trimmed.toLowerCase().normalize("NFKD");
  const stripped = folded.replace(/[^a-z0-9\-_ ]+/gu, "");
  // 3. Whitespace runs → single `-`.
  const dashed = stripped
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (dashed.length === 0) return EMPTY_HEADING_SYNTHETIC_SLUG;
  return dashed;
}

/**
 * Slugify every ATX heading in `body` in source order, applying the §3.1
 * step-5 collision walk (`-1`, `-2`, …). Returns the slugs in the same
 * order as the headings they came from.
 *
 * Setext headings (`Heading\n=====`), HTML headings, and indented code
 * blocks are intentionally **not** parsed — the agent-facing surface in
 * v1 only commits to ATX. The plan calls this out as a v1 trade-off.
 */
export function slugifyHeadings(body: string): string[] {
  const out: string[] = [];
  const seen = new Map<string, number>();
  for (const line of body.split("\n")) {
    const match = ATX_HEADING_RE.exec(line);
    if (match === null) continue;
    const text = match[2] ?? "";
    const base = slugifyHeading(text);
    const collisions = seen.get(base) ?? 0;
    const finalSlug = collisions === 0 ? base : `${base}-${String(collisions)}`;
    seen.set(base, collisions + 1);
    out.push(finalSlug);
  }
  return out;
}

/**
 * Convenience: return the set of heading slugs for `body` (de-duplicated
 * after the collision walk; identity is by `Set` membership). Used by
 * `collab_acquire_section` to test for slug existence in a single pass.
 */
export function headingSlugSet(body: string): Set<string> {
  return new Set(slugifyHeadings(body));
}

/**
 * Normalise an agent-supplied `sectionId` argument to a heading slug.
 *
 * The plan permits the caller to pass either a raw heading text
 * (`"## Introduction"` / `"Introduction"`) or a pre-computed slug
 * (`"introduction"`). Both shapes flow through {@link slugifyHeading}
 * so the matching step downstream sees a single canonical form.
 */
export function normaliseSectionId(sectionId: string): string {
  return slugifyHeading(sectionId);
}

// ---------------------------------------------------------------------------
// Section walking — used by the authorship codec (§3.1 §2.3 step 3)
// ---------------------------------------------------------------------------

/**
 * One section in a markdown body, as walked by {@link walkSections}.
 *
 * - The preamble (prose before the first ATX heading) carries
 *   `slug = PREAMBLE_SYNTHETIC_SLUG`, `level = 0`, `headingText = null`,
 *   and `headingLine = null`. It is **always** emitted, even when the
 *   body starts with a heading — in that case it covers the empty range
 *   `[0, 0)`. Callers that ignore empty preambles can filter on
 *   `bodyEnd > bodyStart`.
 * - Each ATX heading produces one entry. `bodyStart` points at the
 *   first byte **after** the heading line's trailing `\n` (or end of
 *   string if the heading is the final line); `bodyEnd` points at the
 *   start of the next equal-or-higher-level heading line, or at
 *   `body.length` if no such heading exists.
 *
 * Offsets are JS string indices (UTF-16 code units), not byte offsets;
 * downstream hashing uses `Buffer.from(body.slice(start, end), "utf8")`
 * to convert before hashing.
 */
export interface SectionRange {
  /** Slug after the §3.1 step-5 collision walk; `__preamble__` for the prose preamble. */
  slug: string;
  /** Heading depth (1–6 for ATX); 0 for the synthetic preamble. */
  level: number;
  /** Heading text (after the leading `#`s and before the optional closing `#`s); `null` for the preamble. */
  headingText: string | null;
  /** Index of the heading line's first character; `null` for the preamble. */
  headingLine: number | null;
  /** First index of the section body (after the heading line, or 0 for the preamble). */
  bodyStart: number;
  /** First index past the section body (start of the next equal-or-higher heading line, or `body.length`). */
  bodyEnd: number;
}

const ATX_HEADING_LINE_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u;

interface RawHeadingHit {
  level: number;
  text: string;
  /** Start offset of the heading line (inclusive). */
  lineStart: number;
  /** Start offset of the line that follows the heading (i.e. body start). */
  bodyStart: number;
}

function findAtxHeadingLines(body: string): RawHeadingHit[] {
  const hits: RawHeadingHit[] = [];
  let lineStart = 0;
  while (lineStart <= body.length) {
    const newline = body.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? body.length : newline;
    const line = body.slice(lineStart, lineEnd);
    const match = ATX_HEADING_LINE_RE.exec(line);
    if (match !== null) {
      const hashes = match[1] ?? "";
      const text = match[2] ?? "";
      hits.push({
        level: hashes.length,
        text,
        lineStart,
        bodyStart: newline === -1 ? body.length : newline + 1,
      });
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return hits;
}

/**
 * Walk `body` once and return one {@link SectionRange} per section, in
 * source order, starting with the synthetic preamble entry.
 *
 * The slug for each heading is built with the §3.1 step-5 collision
 * walk (so duplicate `## Introduction` headings produce `introduction`,
 * `introduction-1`, …); the preamble entry always uses
 * {@link PREAMBLE_SYNTHETIC_SLUG} regardless of body content.
 *
 * Section bounds match §2.3 step 3: a section runs from the byte after
 * its heading line to the byte before the next heading at the same or
 * shallower depth. A deeper sub-heading does **not** terminate the
 * section — its bytes belong to the parent. The preamble runs from
 * byte 0 through the byte before the first heading (or `body.length`
 * when the file has no headings at all).
 */
export function walkSections(body: string): SectionRange[] {
  const headings = findAtxHeadingLines(body);

  const slugCollisions = new Map<string, number>();
  const slugs: string[] = [];
  for (const heading of headings) {
    const base = slugifyHeading(heading.text);
    const prior = slugCollisions.get(base) ?? 0;
    slugs.push(prior === 0 ? base : `${base}-${String(prior)}`);
    slugCollisions.set(base, prior + 1);
  }

  const out: SectionRange[] = [];
  // Preamble — always emitted; ranges [0, firstHeadingLineStart).
  const preambleEnd = headings.length === 0 ? body.length : (headings[0]?.lineStart ?? body.length);
  out.push({
    slug: PREAMBLE_SYNTHETIC_SLUG,
    level: 0,
    headingText: null,
    headingLine: null,
    bodyStart: 0,
    bodyEnd: preambleEnd,
  });

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    if (heading === undefined) continue;
    // Find the next heading at <= this level; that's where this section ends.
    let bodyEnd = body.length;
    for (let j = i + 1; j < headings.length; j++) {
      const candidate = headings[j];
      if (candidate !== undefined && candidate.level <= heading.level) {
        bodyEnd = candidate.lineStart;
        break;
      }
    }
    out.push({
      slug: slugs[i] ?? EMPTY_HEADING_SYNTHETIC_SLUG,
      level: heading.level,
      headingText: heading.text,
      headingLine: heading.lineStart,
      bodyStart: heading.bodyStart,
      bodyEnd,
    });
  }

  return out;
}
