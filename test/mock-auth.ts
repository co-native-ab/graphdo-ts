// Mock authenticator for testing — controllable authentication state.

import type { Authenticator, LoginResult } from "../src/auth.js";
import { AuthenticationRequiredError } from "../src/auth.js";

/**
 * A mock authenticator that can be controlled from tests.
 *
 * Starts unauthenticated (unless configured otherwise). Login starts a
 * simulated device code flow — the caller can resolve/reject the pending
 * login from outside to simulate user completion.
 */
export class MockAuthenticator implements Authenticator {
  private _token: string | null;
  private _deviceCodeMessage: string;
  private pendingLogin: {
    resolve: (token: string) => void;
    reject: (err: Error) => void;
    promise: Promise<void>;
  } | null = null;

  constructor(opts?: { token?: string; deviceCodeMessage?: string }) {
    this._token = opts?.token ?? null;
    this._deviceCodeMessage =
      opts?.deviceCodeMessage ??
      "To sign in, visit https://microsoft.com/devicelogin and enter code MOCK1234";
  }

  login(): Promise<LoginResult> {
    if (this._token) {
      return Promise.resolve({ message: "Already authenticated." });
    }

    // Create a deferred promise that the test can resolve externally
    let resolve!: (token: string) => void;
    let reject!: (err: Error) => void;

    const tokenPromise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const loginPromise = tokenPromise.then((token) => {
      this._token = token;
    });

    this.pendingLogin = { resolve, reject, promise: loginPromise };

    // Don't catch — let the test observe failures naturally
    loginPromise.catch(() => {
      this.pendingLogin = null;
    });

    return Promise.resolve({ message: this._deviceCodeMessage });
  }

  async token(): Promise<string> {
    // If a login is in progress, wait for it
    if (this.pendingLogin) {
      await this.pendingLogin.promise;
    }

    if (!this._token) {
      throw new AuthenticationRequiredError();
    }
    return this._token;
  }

  logout(): Promise<void> {
    this._token = null;
    this.pendingLogin = null;
    return Promise.resolve();
  }

  isAuthenticated(): Promise<boolean> {
    return Promise.resolve(this._token !== null);
  }

  // ---- Test helpers ----

  /** Simulate the user completing device code authentication. */
  completeLogin(token = "mock-access-token"): void {
    if (!this.pendingLogin) {
      throw new Error("No pending login to complete");
    }
    this.pendingLogin.resolve(token);
    this.pendingLogin = null;
  }

  /** Simulate the device code flow failing. */
  failLogin(message = "Authentication timed out"): void {
    if (!this.pendingLogin) {
      throw new Error("No pending login to fail");
    }
    this.pendingLogin.reject(new Error(message));
    this.pendingLogin = null;
  }

  /** Whether a login flow is currently pending. */
  get loginPending(): boolean {
    return this.pendingLogin !== null;
  }
}
