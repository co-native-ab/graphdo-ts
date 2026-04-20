import type { EncodedShareId } from "./collab/share-url.js";

export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

export class AuthenticationRequiredError extends Error {
  constructor() {
    super("Not logged in - use the login tool to authenticate with Microsoft");
    this.name = "AuthenticationRequiredError";
  }
}

export class UserCancelledError extends Error {
  constructor(message = "Cancelled by user") {
    super(message);
    this.name = "UserCancelledError";
  }
}

/**
 * Raised when a tool requests a browser-based approval form while another
 * form is already open. The form-factory enforces a single in-flight form
 * across login, picker, and (forthcoming) collab approval flows so the
 * human is never asked to reason about two pages at once.
 *
 * `url` is the URL of the in-flight form when known (empty string while
 * the form server is still starting). `kind` is a short identifier of
 * the active form for diagnostic context (e.g. "login", "todo_select_list").
 */
/**
 * Raised when a project's live sentinel (`.collab/project.json`) diverges
 * from the locally pinned `authoritativeFileId` recorded on the first
 * successful `session_open_project`.
 *
 * Per `docs/plans/collab-v1.md` §3.2 the sentinel is **untrusted on second
 * and subsequent reads**; the rename-tolerant pin defends collaborators
 * from a malicious cooperator silently re-pointing the project at a
 * different file. Renames of the authoritative file (same `id`, different
 * `name`) are explicitly allowed and never raise this error — see
 * `verifySentinelAgainstPin` in `src/collab/sentinel.ts`.
 *
 * The error carries the pinned vs. live ids so callers (and the future
 * `sentinel_changed` audit entry — §3.6) can record both sides.
 */
export class SentinelTamperedError extends Error {
  constructor(
    public readonly pinnedAuthoritativeFileId: string,
    public readonly currentAuthoritativeFileId: string,
    public readonly pinnedSentinelFirstSeenAt: string,
  ) {
    super(
      `Sentinel tampered: pinned authoritativeFileId ${pinnedAuthoritativeFileId} ` +
        `does not match current sentinel value ${currentAuthoritativeFileId} ` +
        `(pinned at ${pinnedSentinelFirstSeenAt}). ` +
        "Forget the project from recents and re-open it to re-pin.",
    );
    this.name = "SentinelTamperedError";
  }
}

export class FormBusyError extends Error {
  constructor(
    public readonly url: string,
    public readonly kind: string,
  ) {
    const where = url.length > 0 ? `at ${url}` : "(still starting)";
    super(
      `Another approval form is already open ${where} (${kind}). ` +
        "Please complete or cancel that form before requesting a new one.",
    );
    this.name = "FormBusyError";
  }
}

/**
 * Raised by `session_init_project` when the human picks a folder that
 * contains zero `.md` files at its root. The tool surfaces the folder
 * name in the message so the human knows which folder to fix.
 */
export class NoMarkdownFileError extends Error {
  constructor(
    public readonly folderName: string,
    public readonly folderId: string,
  ) {
    super(
      `Folder "${folderName}" contains no markdown (.md) files at its root. ` +
        "Create one (e.g. spec.md) in OneDrive web, then run session_init_project again.",
    );
    this.name = "NoMarkdownFileError";
  }
}

/**
 * Raised by `session_init_project` when the chosen folder already
 * contains a `.collab/` subfolder. The tool surfaces this as a
 * dedicated error so the agent can re-route to `session_open_project`
 * (which lands in W4 Day 4) without overwriting an existing project's
 * sentinel.
 */
export class ProjectAlreadyInitialisedError extends Error {
  constructor(public readonly folderId: string) {
    super(
      `Folder ${folderId} already contains a .collab/ subfolder, so a project ` +
        "is already initialised here. Use session_open_project to join it.",
    );
    this.name = "ProjectAlreadyInitialisedError";
  }
}

/**
 * Raised by `collab_write` (W3 Day 2) against the authoritative file
 * when both the live frontmatter `doc_id` and the local cache
 * (`<configDir>/projects/<projectId>.json` `docId`) are gone — a fresh
 * machine where a cooperator also wiped the YAML block in OneDrive web.
 *
 * Per `docs/plans/collab-v1.md` §3.1 this is _recoverable_: the agent
 * must call `session_recover_doc_id` (W5 Day 1), which walks the file's
 * `/versions` history for parseable frontmatter and writes the
 * recovered `doc_id` back to local metadata without touching the file.
 * Only when that walk also turns up nothing
 * (`DocIdUnrecoverableError`) is the project effectively dead.
 *
 * The error name and `nextStep` field appear verbatim in §2.6
 * (typed-error table) so callers can pattern-match without importing
 * the class.
 */
export class DocIdRecoveryRequiredError extends Error {
  /** Stable identifier the agent should pass to the recovery tool — never localised. */
  public readonly nextStep = "session_recover_doc_id" as const;

  constructor(public readonly projectId: string) {
    super(
      `Authoritative file frontmatter has no doc_id and the local project ` +
        `metadata for ${projectId} also has no cached docId. ` +
        "Call session_recover_doc_id to walk the file's version history " +
        "for a recoverable doc_id before retrying the write.",
    );
    this.name = "DocIdRecoveryRequiredError";
  }
}

/**
 * Informational result raised by `session_recover_doc_id` (W5 Day 1)
 * when there is nothing to recover — the live frontmatter is parseable
 * **and** the local cache already holds a `docId`. Per §2.2 this is
 * **not** an `isError: true` outcome; the tool surfaces the existing
 * `docId` so the caller knows the recovery was a no-op. Defined here so
 * the W5 implementation does not have to back-fill it.
 */
export class DocIdAlreadyKnownError extends Error {
  constructor(public readonly docId: string) {
    super(
      `doc_id ${docId} is already present in both the live frontmatter and ` +
        "the local project metadata. Nothing to recover.",
    );
    this.name = "DocIdAlreadyKnownError";
  }
}

/**
 * Raised by `session_recover_doc_id` (W5 Day 1) when the version walk
 * cap is exhausted without finding a single historical version whose
 * frontmatter parses cleanly and carries a `doc_id`.
 *
 * Per `docs/plans/collab-v1.md` §2.2 the project is then "effectively
 * dead" — no automated recovery is possible. The human's only option
 * is to start fresh with `session_init_project` against a copy of the
 * folder under a new name; the new project gets a new id and the old
 * audit log is archived rather than continued.
 *
 * The error name and `nextStep` field appear verbatim in §2.6
 * (typed-error table) so callers can pattern-match without importing
 * the class.
 */
export class DocIdUnrecoverableError extends Error {
  /** Stable identifier the human should follow — never localised. */
  public readonly nextStep = "init_fresh_project" as const;

  constructor(
    public readonly projectId: string,
    public readonly versionsInspected: number,
  ) {
    super(
      `No historical version of the authoritative file for project ${projectId} ` +
        `had parseable collab frontmatter (inspected ${String(versionsInspected)} ` +
        "versions). The project's doc_id cannot be recovered automatically. " +
        "Start a fresh project with session_init_project against a copy of the " +
        "folder under a new name; the old audit log is archived rather than continued.",
    );
    this.name = "DocIdUnrecoverableError";
  }
}

/**
 * Refusal reasons emitted by the §4.6 scope resolution algorithm. Each
 * value is a stable identifier so downstream callers (the `scope_denied`
 * audit entry — §3.6, the agent-facing message, and post-hoc analysis)
 * can pattern-match without parsing free-text. The strings appear
 * verbatim in `docs/plans/collab-v1.md` §4.6 and §8.2 row 08.
 */
export type OutOfScopeReason =
  // Pre-resolution refusals (§4.6 step 1)
  | "empty_path"
  | "path_too_long"
  | "control_character"
  | "backslash"
  | "percent_in_raw_path"
  | "absolute_path"
  | "drive_letter"
  // URL-decode (§4.6 step 2)
  | "double_encoded"
  // NFC/NFKC normalisation (§4.6 step 3)
  | "homoglyph_or_compatibility_form"
  // Segment validation (§4.6 step 4)
  | "empty_segment"
  | "dot_segment"
  | "dotdot_segment"
  | "dot_prefixed_segment"
  // Layout enforcement (§4.6 step 5)
  | "path_layout_violation"
  | "subfolder_in_flat_group"
  | "wrong_extension"
  // Post-resolution defence-in-depth (§4.6 step 7)
  | "shortcut_redirect"
  | "cross_drive"
  | "ancestry_escape"
  | "case_aliasing";

/**
 * Raised by the §4.6 scope resolver when a scope-relative `path`
 * argument from the agent does not name an in-scope item under the
 * active project folder.
 *
 * Carries the `attemptedPath` (verbatim, as supplied by the caller) and
 * a stable `reason` enum value so the `scope_denied` audit entry can
 * record both. `resolvedItemId` is populated only when the refusal
 * happens after a successful Graph resolution (the post-resolution
 * defence-in-depth checks in step 7).
 */
export class OutOfScopeError extends Error {
  constructor(
    public readonly attemptedPath: string,
    public readonly reason: OutOfScopeReason,
    public readonly resolvedItemId?: string,
  ) {
    super(`Path "${attemptedPath}" is out of scope: ${reason}`);
    this.name = "OutOfScopeError";
  }
}

/**
 * Raised by collab write helpers ({@link writeAuthoritative},
 * {@link writeProjectFile} replace target) and by the lease writers
 * (W3 Day 4) when a `PUT /content` returns HTTP 412 — the supplied
 * `If-Match` cTag does not match the file's current cTag, so another
 * agent's CAS write landed first.
 *
 * Per `docs/plans/collab-v1.md` §2.6 the error carries the file's
 * **current** state so the agent can re-read, reconcile, and retry:
 *
 * - `currentCTag` — the file's live cTag, ready for the next attempt.
 * - `currentRevision` — OneDrive's `version` id (string) of the
 *   authoritative state on the server, surfaced as `revision:` in
 *   agent-facing output (§3 audit envelope, §10 read view).
 *   `undefined` when Graph did not return one (e.g. brand-new files
 *   or backends that omit the field).
 * - `currentItem` — the full {@link DriveItem} as last seen by Graph,
 *   so the §3.6 audit envelope can record `cTagAfter` /
 *   `revisionAfter` without re-fetching.
 *
 * Diversion to `/proposals/<ulid>.md` (the `conflictMode === "proposal"`
 * branch of `collab_write`, §2.3) is the responsibility of the tool
 * layer (W3 Day 2) — the helper always surfaces this error and lets
 * the caller decide whether to fall back.
 */
export class CollabCTagMismatchError extends Error {
  constructor(
    public readonly itemId: string,
    public readonly suppliedCTag: string,
    public readonly currentCTag: string | undefined,
    public readonly currentRevision: string | undefined,
    public readonly currentItem: import("./graph/types.js").DriveItem,
  ) {
    super(
      `cTag mismatch for item ${itemId}: supplied ${suppliedCTag}, ` +
        `current ${currentCTag ?? "(unknown)"}` +
        (currentRevision !== undefined ? ` (revision ${currentRevision})` : ""),
    );
    this.name = "CollabCTagMismatchError";
  }
}

/**
 * Raised by `collab_write` (W3 Day 2) when the active session has
 * exhausted its write budget (`writesUsed >= writeBudgetTotal`).
 *
 * Per `docs/plans/collab-v1.md` §5.2 the write budget is enforced by the
 * tool layer — the underlying Graph helper does not know about budgets.
 * The error carries the current state so the agent can surface the
 * numbers verbatim and direct the human at `session_renew` (which
 * resets the clock but **not** the counters per §2.2) or at starting a
 * new session.
 */
export class BudgetExhaustedError extends Error {
  constructor(
    public readonly writesUsed: number,
    public readonly writeBudgetTotal: number,
  ) {
    super(
      `Write budget exhausted: ${writesUsed} / ${writeBudgetTotal} writes used in this session. ` +
        "Stop the MCP server (or wait for TTL expiry) and start a new session to continue.",
    );
    this.name = "BudgetExhaustedError";
  }
}

/**
 * Raised by `collab_write` and `collab_create_proposal` (W4 Day 2) when
 * a `source: "external"` re-approval form is dismissed by the human
 * (cancel button, browser close, timeout). Per `docs/plans/collab-v1.md`
 * §5.2.4 the write is **not** issued in this case — no Graph round-trip,
 * no counter increments.
 */
export class ExternalSourceDeclinedError extends Error {
  constructor(public readonly path: string) {
    super(
      `External-source write to "${path}" was declined at the browser approval form. ` +
        "Re-issue collab_write only if you genuinely want to proceed.",
    );
    this.name = "ExternalSourceDeclinedError";
  }
}

/**
 * Raised by `collab_acquire_section` and `collab_release_section`
 * (W3 Day 4) when the supplied `sectionId` does not slugify to any
 * heading currently present in the authoritative file's body.
 *
 * Per `docs/plans/collab-v1.md` §2.3 the error carries the list of
 * current heading slugs as a hint so the agent can re-issue the call
 * with the right id (e.g. after a heading rename). Lease tools use the
 * strict slug-equality contract — there is no slug-drift / content-hash
 * fallback (that lands with `collab_apply_proposal` in W4 Day 3).
 */
export class SectionNotFoundError extends Error {
  constructor(
    public readonly sectionId: string,
    public readonly normalisedSlug: string,
    public readonly currentSlugs: readonly string[],
  ) {
    const sample = currentSlugs.slice(0, 10).join(", ");
    super(
      `Section "${sectionId}" (slug "${normalisedSlug}") not found in the authoritative file. ` +
        `Current heading slugs: ${currentSlugs.length === 0 ? "(no headings)" : sample}` +
        (currentSlugs.length > 10 ? ", … (truncated)" : "") +
        ". Re-read the authoritative file with collab_read and re-issue with the new slug.",
    );
    this.name = "SectionNotFoundError";
  }
}

/**
 * Raised by `collab_acquire_section` (W3 Day 4) when the requested
 * section already has an active (non-expired) lease held by a
 * **different** agent. Carries the holder's `agentId` and lease
 * `expiresAt` so the agent can decide to wait or report up.
 *
 * Per §2.5 the error is in the typed-error table — agents need the
 * structured `holderAgentId`/`expiresAt` to coordinate.
 */
export class SectionAlreadyLeasedError extends Error {
  constructor(
    public readonly sectionSlug: string,
    public readonly holderAgentId: string,
    public readonly holderAgentDisplayName: string,
    public readonly expiresAt: string,
  ) {
    super(
      `Section "${sectionSlug}" is already leased by ${holderAgentDisplayName} ` +
        `(agentId ${holderAgentId}); lease expires at ${expiresAt}.`,
    );
    this.name = "SectionAlreadyLeasedError";
  }
}

/**
 * Raised by `collab_release_section` (W3 Day 4) when the agent tries to
 * release a lease that is currently held by a **different** agent.
 * Releasing a lease the caller never acquired is a programming error,
 * not a coordination error — surface it as a hard refusal so the agent
 * notices the bug. No-op when the lease is already absent (per §2.3).
 */
export class LeaseNotHeldError extends Error {
  constructor(
    public readonly sectionSlug: string,
    public readonly callerAgentId: string,
    public readonly holderAgentId: string,
  ) {
    super(
      `Refusing to release lease on section "${sectionSlug}": held by ${holderAgentId}, ` +
        `not by this agent (${callerAgentId}). Releasing a stale lease is rejected.`,
    );
    this.name = "LeaseNotHeldError";
  }
}

/**
 * Raised by `collab_apply_proposal` (W4 Day 3) when neither the
 * proposal's recorded `target_section_slug` nor its
 * `target_section_content_hash_at_create` matches any section in the
 * current authoritative body.
 *
 * Per `docs/plans/collab-v1.md` §2.3 step 2e this is **distinct** from
 * {@link SectionNotFoundError}: the proposal recorded *both* anchors
 * at create time and *both* are now gone, so the human has either
 * deleted or fundamentally rewritten the section between proposal
 * creation and apply. Surface the old slug, the current heading slugs
 * (so the agent can suggest a re-target), and the proposal id so the
 * caller can decide between creating a fresh proposal and asking the
 * human.
 *
 * Slug-drift fallback decisions are computed by
 * {@link import("./collab/authorship.js").findSectionByAnchor} —
 * `SectionAnchorLostError` is the terminal "neither anchor matched"
 * outcome of that helper, raised by the tool layer when it lands.
 */
export class SectionAnchorLostError extends Error {
  constructor(
    public readonly proposalId: string,
    public readonly oldSlug: string,
    public readonly contentHashAtCreate: string,
    public readonly currentSlugs: readonly string[],
  ) {
    const sample = currentSlugs.slice(0, 10).join(", ");
    super(
      `Cannot apply proposal ${proposalId}: neither the original section slug ` +
        `"${oldSlug}" nor the section content hash recorded at create time matches ` +
        `any current heading or section body. Current heading slugs: ` +
        (currentSlugs.length === 0 ? "(no headings)" : sample) +
        (currentSlugs.length > 10 ? ", … (truncated)" : "") +
        ". Re-read the authoritative file with collab_read and consider creating a fresh proposal.",
    );
    this.name = "SectionAnchorLostError";
  }
}

/**
 * Raised by `collab_apply_proposal` (W4 Day 3) when the supplied
 * `proposalId` is not present in the authoritative file's
 * `frontmatter.collab.proposals[]`. Carries the id so the agent can
 * surface it back to the human; either the proposal was never created
 * or a cooperator already removed it.
 */
export class ProposalNotFoundError extends Error {
  constructor(public readonly proposalId: string) {
    super(
      `Proposal ${proposalId} is not present in the authoritative file's ` +
        "frontmatter proposals[]. Re-read the file with collab_read and " +
        "verify the proposalId.",
    );
    this.name = "ProposalNotFoundError";
  }
}

/**
 * Raised by `collab_apply_proposal` (W4 Day 3) when the proposal's
 * `status` is not `open` — i.e. it was already applied, superseded, or
 * withdrawn. Per `docs/plans/collab-v1.md` §3.1 only `open` proposals
 * are considered for application; re-applying a terminal proposal is a
 * programming error rather than a coordination error.
 */
export class ProposalAlreadyAppliedError extends Error {
  constructor(
    public readonly proposalId: string,
    public readonly status: string,
  ) {
    super(
      `Proposal ${proposalId} cannot be applied: status is "${status}", ` +
        'not "open". Only open proposals can be applied; create a fresh ' +
        "proposal if you want to retry.",
    );
    this.name = "ProposalAlreadyAppliedError";
  }
}

/**
 * Raised by `collab_apply_proposal` (W4 Day 3) — and forthcoming
 * destructive tools (`collab_restore_version`, `collab_delete_file`) —
 * when the active session has exhausted its destructive-approval
 * budget (`destructiveUsed >= destructiveBudgetTotal`).
 *
 * Per `docs/plans/collab-v1.md` §5.2 the destructive budget is enforced
 * by the tool layer and is independent of the write budget. The error
 * carries the current state so the agent can surface the numbers
 * verbatim and direct the human at starting a new session
 * (`session_renew` resets the TTL but **not** the counters per §2.2).
 */
export class DestructiveBudgetExhaustedError extends Error {
  constructor(
    public readonly destructiveUsed: number,
    public readonly destructiveBudgetTotal: number,
  ) {
    super(
      `Destructive-approval budget exhausted: ${destructiveUsed} / ` +
        `${destructiveBudgetTotal} destructive operations used in this session. ` +
        "Stop the MCP server (or wait for TTL expiry) and start a new session " +
        "to continue.",
    );
    this.name = "DestructiveBudgetExhaustedError";
  }
}

/**
 * Raised by `collab_apply_proposal` (W4 Day 3) — and forthcoming
 * destructive tools — when a destructive re-approval form is dismissed
 * by the human (cancel button, browser close, timeout). Per
 * `docs/plans/collab-v1.md` §5.2.3 the write is **not** issued in this
 * case — no Graph round-trip, no counter increments.
 */
export class DestructiveApprovalDeclinedError extends Error {
  constructor(
    public readonly tool: string,
    public readonly subject: string,
  ) {
    super(
      `Destructive ${tool} on "${subject}" was declined at the browser ` +
        "approval form. Re-issue the tool only if you genuinely want to proceed.",
    );
    this.name = "DestructiveApprovalDeclinedError";
  }
}

/**
 * Raised by `collab_create_proposal` (W4 Day 2) when the helper cannot
 * find an unused proposal id (`/proposals/<ulid>.md`) inside its retry
 * budget. ULIDs are randomised in the rightmost 80 bits, so a true
 * collision is astronomically unlikely; in practice this surfaces as a
 * persistent 409 from `conflictBehavior=fail` against the byPath PUT,
 * almost certainly a bug or a misbehaving cooperator.
 *
 * Per `docs/plans/collab-v1.md` §2.3 the error is informational — the
 * caller can simply retry the tool. Carries the project folder id and
 * the most recent attempted proposal id so post-hoc analysis can locate
 * the file (if any sneaked through outside the helper) and the number of
 * attempts for telemetry.
 */
export class ProposalIdCollisionError extends Error {
  constructor(
    public readonly projectFolderId: string,
    public readonly lastAttemptedProposalId: string,
    public readonly attempts: number,
  ) {
    super(
      `Could not create a proposal file under folder ${projectFolderId} ` +
        `after ${String(attempts)} attempts (last id: ${lastAttemptedProposalId}). ` +
        "Retry collab_create_proposal — the next ULID will almost certainly land.",
    );
    this.name = "ProposalIdCollisionError";
  }
}

// Note: `NoActiveSessionError` and `SessionAlreadyActiveError` live in
// `src/collab/session.ts` next to the registry that throws them. They are
// re-exported here for the rare consumer that wants a single import — but
// the canonical location is the session module so the error and the
// thrower travel together (mirrors the `ProjectMetadataParseError` /
// `loadProjectMetadata` pairing in `src/collab/projects.ts`).
export { NoActiveSessionError, SessionAlreadyActiveError } from "./collab/session.js";

// ---------------------------------------------------------------------------
// W4 Day 4 — session_open_project
// ---------------------------------------------------------------------------

export class SchemaVersionUnsupportedError extends Error {
  constructor(public readonly schemaVersion: number) {
    super(
      `The sentinel at this project uses schemaVersion ${String(schemaVersion)}, ` +
        "which is not supported by this MCP server version. " +
        "Please upgrade the MCP server.",
    );
    this.name = "SchemaVersionUnsupportedError";
  }
}

export class BlockedScopeError extends Error {
  constructor(public readonly reason: string) {
    super(`Cannot open project: ${reason}`);
    this.name = "BlockedScopeError";
  }
}

export class NoWriteAccessError extends Error {
  constructor(public readonly folderId: string) {
    super(
      `You do not have write permission on the project folder ${folderId}. ` +
        "Ask the owner to grant you write access.",
    );
    this.name = "NoWriteAccessError";
  }
}

export class NotAFolderError extends Error {
  constructor(public readonly itemId: string) {
    super(`Drive item ${itemId} is not a folder — only folders can be project scopes.`);
    this.name = "NotAFolderError";
  }
}

export class AuthoritativeFileMissingError extends Error {
  constructor(public readonly authoritativeFileId: string) {
    super(
      `The authoritative file ${authoritativeFileId} referenced by the sentinel ` +
        "no longer exists — the file may have been deleted.",
    );
    this.name = "AuthoritativeFileMissingError";
  }
}

export class StaleRecentError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly folderId: string,
  ) {
    super(
      `The recent entry for project ${projectId} (folder ${folderId}) is stale — ` +
        "the folder no longer exists or you lost access. It has been marked unavailable.",
    );
    this.name = "StaleRecentError";
  }
}

/**
 * Raised by `session_renew` (W4 Day 5) when the active session has
 * already used its per-session renewal cap (3 — `MAX_RENEWALS_PER_SESSION`
 * in `src/collab/session.ts`). Per `docs/plans/collab-v1.md` §2.2 the
 * session must be ended (process exit / TTL expiry) and a new one
 * started before further renewals are possible.
 */
export class RenewalCapPerSessionError extends Error {
  constructor(
    public readonly renewalsUsed: number,
    public readonly cap: number,
  ) {
    super(
      `Per-session renewal cap reached: ${renewalsUsed} / ${cap} renewals used. ` +
        "Stop the MCP server (or wait for TTL expiry) and start a new session " +
        "with session_init_project / session_open_project to renew further.",
    );
    this.name = "RenewalCapPerSessionError";
  }
}

/**
 * Raised by `session_renew` (W4 Day 5) when the user has already used
 * the maximum number of renewals (6 — `MAX_RENEWALS_PER_WINDOW`) for
 * this `(userOid, projectId)` key inside the rolling 24-hour window.
 * Per `docs/plans/collab-v1.md` §3.5 the window slides on read (entries
 * older than 24h are pruned), so the cap reopens automatically once the
 * oldest renewal ages out.
 */
export class RenewalCapPerWindowError extends Error {
  constructor(
    public readonly windowCount: number,
    public readonly cap: number,
    public readonly windowHours: number,
  ) {
    super(
      `Per-${String(windowHours)}h-window renewal cap reached: ${windowCount} / ${cap} ` +
        "renewals used in the rolling window. Wait until the oldest renewal " +
        "ages out, or stop using session_renew until the window reopens.",
    );
    this.name = "RenewalCapPerWindowError";
  }
}

export class BrowserFormCancelledError extends Error {
  constructor(public readonly formType: string) {
    super(`Browser form (${formType}) was cancelled by the user.`);
    this.name = "BrowserFormCancelledError";
  }
}

export class BrowserFormTimeoutError extends Error {
  constructor(public readonly formType: string) {
    super(`Browser form (${formType}) timed out waiting for user input.`);
    this.name = "BrowserFormTimeoutError";
  }
}

export type InvalidShareUrlReason =
  | "unsupported_scheme"
  | "unsupported_host"
  | "ip_literal"
  | "loopback"
  | "malformed";

export class InvalidShareUrlError extends Error {
  constructor(
    public readonly url: string,
    public readonly reason: InvalidShareUrlReason,
  ) {
    super(`Invalid share URL "${url}": ${reason}`);
    this.name = "InvalidShareUrlError";
  }
}

export class ShareNotFoundError extends Error {
  constructor(public readonly encodedShareId: EncodedShareId) {
    super(
      `The share link could not be found (${encodedShareId}) — ` +
        "the link may be revoked, or you may not have access.",
    );
    this.name = "ShareNotFoundError";
  }
}

export class ShareAccessDeniedError extends Error {
  constructor(public readonly encodedShareId: EncodedShareId) {
    super(
      `Access denied to share ${encodedShareId} — ` +
        "the link is valid but you do not have access. " +
        "Ask the owner to share with your account.",
    );
    this.name = "ShareAccessDeniedError";
  }
}
