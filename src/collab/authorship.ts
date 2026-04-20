// Authorship-on-section codec for collab v1 (`docs/plans/collab-v1.md`
// §3.1, §2.3 `collab_apply_proposal`).
//
// **W4 Day 1** ships:
//
//   - `SECTION_HASH_PREFIX` + {@link computeSectionContentHash} — the
//     stable `"sha256:<hex>"` digest of a section body, computed over
//     the UTF-8 bytes between a heading and the next equal-or-higher
//     heading (or, for the synthetic preamble, between byte 0 and the
//     first heading line).
//   - {@link walkSectionsWithHashes} — pairs each {@link SectionRange}
//     with its content hash in a single body pass, used by
//     `collab_apply_proposal` (W4 Day 3) and `collab_create_proposal`
//     (W4 Day 2) when they need to record `section_content_hash` /
//     `target_section_content_hash_at_create`.
//   - {@link findSectionByAnchor} — slug-first / content-hash-fallback
//     section lookup matching §2.3 step 2 of `collab_apply_proposal`:
//     the slug wins when exactly one heading matches; otherwise the
//     stored hash anchors the section even after the human renamed
//     `## Introduction` to `## Overview`. The result is a discriminated
//     union so the caller can audit `slug_drift_resolved` (§3.6) on the
//     drift branch and raise {@link SectionAnchorLostError} on the
//     unmatched branch.
//   - {@link classifyAuthorshipMatch} — destructive-detection over the
//     `frontmatter.authorship[]` trail per §2.3 step 4. Returns the
//     matching entries plus a `destructive` flag the tool layer uses to
//     decide whether to open the destructive re-prompt form.
//
// Tool wiring (`collab_apply_proposal`) lands in W4 Day 3; this module
// is intentionally tool-agnostic so the lookup + destructive matrix can
// be unit-tested in isolation.

import { createHash } from "node:crypto";

import type { FrontmatterAuthorship } from "./frontmatter.js";
import { PREAMBLE_SYNTHETIC_SLUG, type SectionRange, walkSections } from "./slug.js";

// ---------------------------------------------------------------------------
// Section content hash (§3.1)
// ---------------------------------------------------------------------------

/** Prefix stamped on every section content hash so audit logs and frontmatter values are self-describing. */
export const SECTION_HASH_PREFIX = "sha256:";

/**
 * Compute the canonical content hash for a section body.
 *
 * The hash is `"sha256:" + lower-hex(SHA-256(utf8 bytes))`. The
 * caller supplies the **body text** of the section — typically
 * `body.slice(range.bodyStart, range.bodyEnd)` from a
 * {@link SectionRange} — and gets back a value byte-comparable with the
 * `section_content_hash` field of `frontmatter.authorship[]`.
 *
 * Trailing newlines are part of the hash by design: §3.1 anchors on
 * the literal bytes between a heading and the next equal-or-higher
 * heading, and a paragraph that ends in `\n` is genuinely different
 * from one that does not.
 */
export function computeSectionContentHash(sectionBody: string): string {
  const digest = createHash("sha256").update(sectionBody, "utf8").digest("hex");
  return `${SECTION_HASH_PREFIX}${digest}`;
}

/**
 * One section in a markdown body, paired with its content hash.
 * Returned in source order by {@link walkSectionsWithHashes}; the first
 * entry is always the synthetic preamble (§3.1 step 6).
 */
export interface SectionWithHash extends SectionRange {
  /** SHA-256 of the section body bytes; `"sha256:<hex>"`. */
  contentHash: string;
}

/**
 * Walk `body` once, returning every {@link SectionRange} paired with
 * its {@link SECTION_HASH_PREFIX}-prefixed content hash. The preamble
 * entry is always present and uses {@link PREAMBLE_SYNTHETIC_SLUG}.
 */
export function walkSectionsWithHashes(body: string): SectionWithHash[] {
  return walkSections(body).map((section) => ({
    ...section,
    contentHash: computeSectionContentHash(body.slice(section.bodyStart, section.bodyEnd)),
  }));
}

// ---------------------------------------------------------------------------
// Slug-first / content-hash fallback section lookup (§2.3 step 2)
// ---------------------------------------------------------------------------

/**
 * Outcome of {@link findSectionByAnchor}. The discriminated union maps
 * directly onto the §2.3 step-2 branches of `collab_apply_proposal`:
 *
 * - `slug_match` — the proposal's slug uniquely identifies a section
 *   in the current body; no audit needed.
 * - `slug_drift_resolved` — the proposal's slug no longer matches any
 *   heading **or** matches more than one heading; the recorded
 *   content hash uniquely identifies the renamed section. The caller
 *   should emit a `slug_drift_resolved` audit envelope (§3.6) carrying
 *   `oldSlug` + `newSlug`.
 * - `anchor_lost` — neither anchor matches. The caller should raise
 *   {@link import("../errors.js").SectionAnchorLostError} carrying
 *   `currentSlugs` so the agent can reorient.
 */
export type AnchorMatch =
  | { kind: "slug_match"; section: SectionWithHash }
  | { kind: "slug_drift_resolved"; section: SectionWithHash; oldSlug: string; newSlug: string }
  | { kind: "anchor_lost"; oldSlug: string; contentHashAtCreate: string; currentSlugs: string[] };

/**
 * Locate a section in the current authoritative body using the
 * §2.3 step-2 algorithm:
 *
 *   1. Compute slugs + content hashes for every section in the body.
 *   2. If exactly one section has the supplied slug, that's the
 *      target ({@link AnchorMatch} `slug_match`).
 *   3. Otherwise (zero matches **or** more than one match), look for a
 *      section whose content hash equals
 *      `contentHashAtCreate`. A unique hash match wins
 *      ({@link AnchorMatch} `slug_drift_resolved`).
 *   4. If neither anchor uniquely identifies a section, return
 *      `anchor_lost` so the caller can surface
 *      `SectionAnchorLostError`.
 *
 * `contentHashAtCreate` may be omitted when no proposal-time hash was
 * recorded — in that case the function reduces to "exactly one slug
 * match wins, otherwise `anchor_lost`".
 *
 * Multiple slug matches that don't disambiguate via hash also return
 * `anchor_lost`: the slug is no longer a unique identifier, so the
 * conservative read is "the human inserted a duplicate; refuse rather
 * than guess".
 */
export function findSectionByAnchor(
  body: string,
  slug: string,
  contentHashAtCreate?: string,
): AnchorMatch {
  const sections = walkSectionsWithHashes(body);
  const slugMatches = sections.filter((s) => s.slug === slug);

  if (slugMatches.length === 1) {
    const [section] = slugMatches;
    if (section !== undefined) {
      return { kind: "slug_match", section };
    }
  }

  if (contentHashAtCreate !== undefined && contentHashAtCreate.length > 0) {
    const hashMatches = sections.filter((s) => s.contentHash === contentHashAtCreate);
    if (hashMatches.length === 1) {
      const [matched] = hashMatches;
      if (matched !== undefined) {
        return {
          kind: "slug_drift_resolved",
          section: matched,
          oldSlug: slug,
          newSlug: matched.slug,
        };
      }
    }
  }

  return {
    kind: "anchor_lost",
    oldSlug: slug,
    contentHashAtCreate: contentHashAtCreate ?? "",
    currentSlugs: sections
      .filter((s) => s.slug !== PREAMBLE_SYNTHETIC_SLUG || s.bodyEnd > s.bodyStart)
      .map((s) => s.slug),
  };
}

// ---------------------------------------------------------------------------
// Destructive-detection over the authorship trail (§2.3 step 4)
// ---------------------------------------------------------------------------

/**
 * Why an authorship entry was selected as a match for the current
 * section, mirroring §2.3 step 4 cases (a)/(b)/(c).
 */
export enum AuthorshipMatchReason {
  /** Same slug **and** the same `section_content_hash` as the current section. */
  SlugAndHash = "slug_and_hash",
  /** Same slug, different hash — used only when no exact-hash match exists. */
  SlugOnly = "slug_only",
  /** Same hash, different slug — catches a rename + authorship pair. */
  HashOnly = "hash_only",
}

/**
 * One authorship-trail entry that matched the current section, paired
 * with the {@link AuthorshipMatchReason} that selected it.
 */
export interface AuthorshipMatch {
  entry: FrontmatterAuthorship;
  reason: AuthorshipMatchReason;
}

/**
 * Result of {@link classifyAuthorshipMatch}.
 *
 * - `destructive` is `true` when **any** matching entry attributes the
 *   section to a human (`author_kind: "human"`) **or** to a different
 *   agent (`author_agent_id !== currentAgentId`). The tool layer uses
 *   this to decide whether to open the destructive re-prompt form.
 * - `matches` is the full list of matching entries in trail order so
 *   the caller can surface them in the form / audit log.
 */
export interface AuthorshipClassification {
  destructive: boolean;
  matches: AuthorshipMatch[];
}

/**
 * Walk `authorship` and decide whether overwriting the section
 * identified by `currentSlug` + `currentHash` would clobber another
 * author's work, per §2.3 step 4.
 *
 * Selection algorithm (case order matches the plan):
 *   (a) Entries with the **same slug and same hash** as the current
 *       section. Strongest signal — the human/agent the trail
 *       attributes the section to is still its author.
 *   (b) Entries with the **same slug, any hash** — used only when (a)
 *       found nothing, so the section has been re-hashed since the
 *       trail was last appended.
 *   (c) Entries with **any slug, the same hash** — catches a renamed
 *       section whose body still matches a prior write.
 *
 * The destructive flag fires if any matching entry has
 * `author_kind === "human"` or an `author_agent_id` other than the
 * caller's. An empty `authorship[]` (or no matches in any case)
 * yields `destructive: false`, matches: []` — the section has no
 * recorded prior author, so writing is safe.
 */
export function classifyAuthorshipMatch(
  authorship: readonly FrontmatterAuthorship[],
  currentSlug: string,
  currentHash: string,
  currentAgentId: string,
): AuthorshipClassification {
  // (a) slug + hash
  let matches: AuthorshipMatch[] = authorship
    .filter((e) => e.target_section_slug === currentSlug && e.section_content_hash === currentHash)
    .map((entry) => ({ entry, reason: AuthorshipMatchReason.SlugAndHash }));

  // (b) slug-only (only when no exact-hash match exists)
  if (matches.length === 0) {
    matches = authorship
      .filter((e) => e.target_section_slug === currentSlug)
      .map((entry) => ({ entry, reason: AuthorshipMatchReason.SlugOnly }));
  }

  // (c) hash-only — orthogonal: catches a renamed-and-touched section
  // even when (a)/(b) already filled `matches`. Plan §2.3 step 4 OR's
  // the three cases together; we keep them deduplicated by entry
  // identity.
  const seen = new Set(matches.map((m) => m.entry));
  for (const entry of authorship) {
    if (
      entry.section_content_hash === currentHash &&
      entry.target_section_slug !== currentSlug &&
      !seen.has(entry)
    ) {
      matches.push({ entry, reason: AuthorshipMatchReason.HashOnly });
      seen.add(entry);
    }
  }

  const destructive = matches.some(
    ({ entry }) => entry.author_kind === "human" || entry.author_agent_id !== currentAgentId,
  );

  return { destructive, matches };
}
