// Mock authenticator for testing - controllable authentication state.

import type { Authenticator, LoginResult, AccountInfo } from "../src/auth.js";
import { AuthenticationRequiredError } from "../src/errors.js";
import { type GraphScope, GraphScope as GS } from "../src/scopes.js";

/**
 * A mock authenticator that can be controlled from tests.
 *
 * Starts unauthenticated (unless configured otherwise). When `browserLogin`
 * is true, login completes immediately. Otherwise it always completes
 * immediately as browser-only.
 */
export class MockAuthenticator implements Authenticator {
  private _token: string | null;
  private _username: string;
  private _browserLogin: boolean;
  private _logoutCalled = false;
  private _grantedScopes: GraphScope[];

  constructor(opts?: {
    token?: string;
    username?: string;
    browserLogin?: boolean;
    grantedScopes?: GraphScope[];
  }) {
    this._token = opts?.token ?? null;
    this._username = opts?.username ?? "test@example.com";
    this._browserLogin = opts?.browserLogin ?? true;
    this._grantedScopes = opts?.grantedScopes ?? [
      GS.MailSend,
      GS.TasksReadWrite,
      GS.UserRead,
      GS.OfflineAccess,
    ];
  }

  login(): Promise<LoginResult> {
    if (this._token) {
      return Promise.resolve({
        message: "Already authenticated.",
        grantedScopes: this._grantedScopes,
      });
    }

    if (this._browserLogin) {
      this._token = "browser-token";
      return Promise.resolve({
        message: `Logged in as ${this._username}`,
        grantedScopes: this._grantedScopes,
      });
    }

    // Simulate browser failure - throw error
    return Promise.reject(new Error("Could not open browser"));
  }

  token(): Promise<string> {
    if (!this._token) {
      return Promise.reject(new AuthenticationRequiredError());
    }
    return Promise.resolve(this._token);
  }

  logout(): Promise<void> {
    this._token = null;
    this._logoutCalled = true;
    return Promise.resolve();
  }

  isAuthenticated(): Promise<boolean> {
    return Promise.resolve(this._token !== null);
  }

  accountInfo(): Promise<AccountInfo | null> {
    if (!this._token) return Promise.resolve(null);
    return Promise.resolve({ username: this._username });
  }

  grantedScopes(): Promise<GraphScope[]> {
    if (!this._token) return Promise.resolve([]);
    return Promise.resolve(this._grantedScopes);
  }

  // ---- Test helpers ----

  /** Whether logout was called. */
  get wasLoggedOut(): boolean {
    return this._logoutCalled;
  }
}
