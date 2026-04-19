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

// Note: `NoActiveSessionError` and `SessionAlreadyActiveError` live in
// `src/collab/session.ts` next to the registry that throws them. They are
// re-exported here for the rare consumer that wants a single import — but
// the canonical location is the session module so the error and the
// thrower travel together (mirrors the `ProjectMetadataParseError` /
// `loadProjectMetadata` pairing in `src/collab/projects.ts`).
export { NoActiveSessionError, SessionAlreadyActiveError } from "./collab/session.js";
