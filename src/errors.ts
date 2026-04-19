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
