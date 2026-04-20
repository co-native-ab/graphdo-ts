// Heading slug helper for collab v1 (`docs/plans/collab-v1.md` §3.1).
//
// **W3 Day 4 ships only the steps that `collab_acquire_section` /
// `collab_release_section` need:**
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
// (prose before the first heading) and the slug-drift fallback used by
// `collab_apply_proposal` (slug → content-hash). For the lease tools
// the strict slug-equality contract above is sufficient: a lease is
// short-lived and a heading rename mid-lease is a hard refusal
// (§2.3 `collab_acquire_section`).

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Synthetic slug used when a heading slugifies to the empty string (§3.1 step 4). */
export const EMPTY_HEADING_SYNTHETIC_SLUG = "__heading__";

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
