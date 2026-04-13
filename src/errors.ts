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

/** Thrown by the loopback client when the user changes scopes mid-login flow. */
export class ScopeChangeError extends Error {
  constructor(message = "Scopes changed during login — restarting") {
    super(message);
    this.name = "ScopeChangeError";
  }
}
