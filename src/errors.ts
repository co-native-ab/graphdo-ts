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

// Note: `NoActiveSessionError` and `SessionAlreadyActiveError` live in
// `src/collab/session.ts` next to the registry that throws them. They are
// re-exported here for the rare consumer that wants a single import — but
// the canonical location is the session module so the error and the
// thrower travel together (mirrors the `ProjectMetadataParseError` /
// `loadProjectMetadata` pairing in `src/collab/projects.ts`).
export { NoActiveSessionError, SessionAlreadyActiveError } from "./collab/session.js";
