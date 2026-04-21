// Static {@link ToolDef} entries for the collab MCP tool family.
// Split out from `./shared.ts`; re-exported through the barrel.

import type { ToolDef } from "../../tool-registry.js";
import { GraphScope } from "../../scopes.js";

/** Maximum total entries returned by `collab_list_files` (§2.3). */
export const LIST_FILES_BREADTH_CAP = 500;

/** Sentinel folder name, excluded from ROOT listing. */
export const SENTINEL_FOLDER_NAME = ".collab";

/** Folder name used by the proposal-write helpers (matches §4.6 layout). */
export const PROPOSALS_FOLDER_NAME = "proposals";

/**
 * Maximum attempts to mint a non-colliding proposal id before raising
 * `ProposalIdCollisionError`. ULIDs are 80 bits of randomness, so one
 * attempt is overwhelmingly enough; the retry budget exists for
 * defence in depth (e.g. a misbehaving cooperator pre-creating files
 * matching newly-minted ids) and for telemetry.
 */
export const PROPOSAL_ID_RETRY_LIMIT = 3;

export const COLLAB_READ_DEF: ToolDef = {
  name: "collab_read",
  title: "Read Collab File",
  description:
    "Read any file inside the active project's scope. Provide either `path` " +
    "(scope-relative, e.g. 'spec.md', 'proposals/foo.md', 'attachments/img.png') " +
    "or `itemId` (from a previous collab_list_files). Exactly one is required. " +
    "For the authoritative markdown file, the response includes parsed frontmatter " +
    "and body separately. For other files, returns raw content with cTag/size/modified. " +
    "Files larger than 4 MiB return an error (graphdo-ts tool-side limit).",
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const COLLAB_LIST_FILES_DEF: ToolDef = {
  name: "collab_list_files",
  title: "List Collab Project Files",
  description:
    "List files in the active project folder, grouped into ROOT, PROPOSALS, " +
    "DRAFTS, and ATTACHMENTS. The authoritative markdown file is marked with " +
    "[authoritative]. The .collab/ sentinel folder is excluded. Accepts an " +
    "optional prefix filter: '/' (all), '/proposals', '/drafts', '/attachments'. " +
    "Total entries are capped at 500; on overflow the response shows which " +
    "groups were truncated.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const COLLAB_WRITE_DEF: ToolDef = {
  name: "collab_write",
  title: "Write Collab File",
  description:
    "Create or update a file inside the active project's scope. Provide " +
    "`path` (scope-relative — `<authoritativeFile>.md` for the authoritative " +
    "file, `proposals/foo.md`, `drafts/scratch.md`, `attachments/img.png`), " +
    "`content` (UTF-8 text, ≤ 4 MiB), and `source` (where the content came " +
    "from: 'chat' = the human typed it this turn; 'project' = read via " +
    "collab_read in this session; 'external' = anything else, which triggers " +
    "a browser re-approval before the write is issued). For existing files " +
    "supply the `cTag` returned by collab_read for optimistic concurrency. " +
    "On the authoritative file the canonical YAML `collab:` frontmatter " +
    "block is re-injected (recovering `doc_id` from local cache when the " +
    "human stripped it); the body is taken from the supplied content (with " +
    "the agent-supplied frontmatter winning when present and parseable).",
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const COLLAB_CREATE_PROPOSAL_DEF: ToolDef = {
  name: "collab_create_proposal",
  title: "Create Section Proposal",
  description:
    "Propose a replacement body for one section of the authoritative file " +
    "without overwriting it. Writes the proposed body to " +
    "`/proposals/<ulid>.md` and records a `proposals[]` entry in the " +
    "authoritative frontmatter (target_section_slug + " +
    "target_section_content_hash_at_create — the latter survives heading " +
    "renames between create and apply). Counts as 1 write toward the " +
    "session budget. Provide `targetSectionId` (raw heading text or " +
    "pre-computed slug), `body` (proposed section markdown), `source` " +
    "(same enum as collab_write — 'external' triggers a browser " +
    "re-approval), and `authoritativeCTag` (from collab_read). Errors: " +
    "SectionAnchorLostError (target slug does not match any current " +
    "heading), CollabCTagMismatchError, BudgetExhaustedError, " +
    "ExternalSourceDeclinedError, ProposalIdCollisionError.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const COLLAB_APPLY_PROPOSAL_DEF: ToolDef = {
  name: "collab_apply_proposal",
  title: "Apply Section Proposal",
  description:
    "Merge a previously-created proposal into the authoritative file. " +
    "Locates the target section by slug first, falling back to the " +
    "content hash recorded at create time (so a rename between create " +
    "and apply is recovered automatically and audited as " +
    "slug_drift_resolved). The §3.1 authorship trail is consulted to " +
    "decide whether the apply is destructive — if any prior author of " +
    "the target section is a human or a different agent, a browser " +
    "re-approval form is opened showing a unified diff of the change. " +
    "On approve, the section body is replaced, an `authorship[]` entry " +
    "is appended, and the matching `proposals[]` entry is marked " +
    "`applied`; the file is CAS-written with the supplied " +
    "`authoritativeCTag`. Counts toward the write budget always and " +
    "toward the destructive-approval budget when the apply was " +
    "destructive. Errors: ProposalNotFoundError, " +
    "ProposalAlreadyAppliedError, SectionAnchorLostError, " +
    "CollabCTagMismatchError, BudgetExhaustedError, " +
    "DestructiveBudgetExhaustedError, DestructiveApprovalDeclinedError.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const COLLAB_ACQUIRE_SECTION_DEF: ToolDef = {
  name: "collab_acquire_section",
  title: "Acquire Section Lease",
  description:
    "Lease a section of the authoritative file so cooperating agents avoid " +
    "concurrent writes to the same heading. Free — does not count toward the " +
    "session write budget. Section identity is the GitHub-flavored heading " +
    "slug; pass either the raw heading text ('## Introduction') or a " +
    "pre-computed slug ('introduction'). The leases sidecar lives at " +
    "`.collab/leases.json` and is created lazily on first acquire. Supply " +
    "`leasesCTag` (from session_status). Returns the slug, lease expiry, " +
    "and the new leases-file cTag for the next acquire/release. Errors: " +
    "SectionNotFoundError, SectionAlreadyLeasedError (carries holder + " +
    "expiresAt), CollabCTagMismatchError (re-read leasesCTag and retry).",
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const COLLAB_RELEASE_SECTION_DEF: ToolDef = {
  name: "collab_release_section",
  title: "Release Section Lease",
  description:
    "Release a previously-acquired section lease. Free. No-op when the lease " +
    "is already absent (gracefully degraded — the leases sidecar may have " +
    "been deleted or expired). Refuses with LeaseNotHeldError when the lease " +
    "exists but is held by a different agent — releasing somebody else's " +
    "lease is rejected. Supply `leasesCTag` (from session_status) for the " +
    "byId CAS replace.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const COLLAB_LIST_VERSIONS_DEF: ToolDef = {
  name: "collab_list_versions",
  title: "List Collab File Versions",
  description:
    "List historical versions of a file in the active project's scope, " +
    "newest first. Provide either `path` (scope-relative) or `itemId` " +
    "(from collab_list_files); when both are omitted the authoritative " +
    "file is used. Read-only — does not count toward the write or " +
    "destructive-approval budget. Each entry reports the opaque versionId, " +
    "size, and last-modified timestamp; pass the versionId to " +
    "collab_restore_version to roll the file back to that revision.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const COLLAB_RESTORE_VERSION_DEF: ToolDef = {
  name: "collab_restore_version",
  title: "Restore Collab File Version",
  description:
    "Roll a file in the active project back to a previous revision via " +
    "OneDrive's restoreVersion API. Provide `versionId` (from " +
    "collab_list_versions) plus either `path` (scope-relative) or " +
    "`itemId`; defaults to the authoritative file when both are omitted. " +
    "When the target is the authoritative file the restore is destructive: " +
    "a browser re-approval form is opened showing a unified diff between " +
    "the current and the target revision; on approve the destructive " +
    "budget is decremented. Counts as 1 write toward the session budget " +
    "always. The authoritative file also requires `authoritativeCTag` " +
    "(from collab_read) for optimistic-concurrency safety: a stale cTag " +
    "raises CollabCTagMismatchError before the restore is issued.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

export const COLLAB_DELETE_FILE_DEF: ToolDef = {
  name: "collab_delete_file",
  title: "Delete Collab File",
  description:
    "Permanently delete a non-authoritative file inside the active " +
    "project's scope. Always destructive: a browser re-approval form is " +
    "opened for every call and the destructive-approval budget is " +
    "decremented on approve. Counts as 1 write toward the session " +
    "budget. Accepts `path` (scope-relative — `proposals/<...>.md`, " +
    "`drafts/<...>.md`, `attachments/<...>`); the authoritative `.md` " +
    "file and the `.collab/` sentinel folder are always refused. " +
    "Errors: RefuseDeleteAuthoritativeError, RefuseDeleteSentinelError, " +
    "OutOfScopeError, FileNotFoundError, BudgetExhaustedError, " +
    "DestructiveBudgetExhaustedError, DestructiveApprovalDeclinedError.",
  requiredScopes: [GraphScope.FilesReadWrite],
};

/** Static tool metadata for collab tools. */
export const COLLAB_TOOL_DEFS: readonly ToolDef[] = [
  COLLAB_READ_DEF,
  COLLAB_LIST_FILES_DEF,
  COLLAB_WRITE_DEF,
  COLLAB_CREATE_PROPOSAL_DEF,
  COLLAB_APPLY_PROPOSAL_DEF,
  COLLAB_ACQUIRE_SECTION_DEF,
  COLLAB_RELEASE_SECTION_DEF,
  COLLAB_LIST_VERSIONS_DEF,
  COLLAB_RESTORE_VERSION_DEF,
  COLLAB_DELETE_FILE_DEF,
];
