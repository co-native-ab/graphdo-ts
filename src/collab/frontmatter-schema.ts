// Zod schemas + types for the `collab:` YAML frontmatter (collab v1 §3.1).
// Split out from `frontmatter.ts`; re-exported through the barrel.

import { z } from "zod";

/** Schema version this codec emits and accepts on the `collab.version` field. */
export const COLLAB_FRONTMATTER_VERSION = 1;

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
 * `source` parameter (W4 Day 2) and the `collab_write.source` enum
 * (`docs/plans/collab-v1.md` §2.3 / §5.2.4): `chat` = the human typed
 * it this turn; `project` = read via `collab_read` in this session;
 * `external` = anything else (web fetch, prior session, generated).
 */
export const FrontmatterProposalSourceSchema = z.enum(["chat", "project", "external"]);

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
