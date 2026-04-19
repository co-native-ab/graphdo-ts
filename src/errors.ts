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
