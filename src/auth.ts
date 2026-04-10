// Authentication module - MSAL-based token acquisition for Microsoft Graph.
//
// Supports two login methods:
// 1. Interactive browser login (preferred) - opens system browser, handles redirect
// 2. Device code flow (fallback) - for headless/remote environments

import { promises as fs } from "node:fs";
import path from "node:path";

import * as msal from "@azure/msal-node";

import { logger } from "./logger.js";
import { LoginLoopbackClient } from "./loopback.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTHORITY_URL = "https://login.microsoftonline.com/common";

const CACHE_FILE_NAME = "msal_cache.json";
const ACCOUNT_FILE_NAME = "account.json";

// ---------------------------------------------------------------------------
// Authenticator interface
// ---------------------------------------------------------------------------

/** Abstraction for login + token acquisition (mirrors Go's auth.Authenticator). */
export interface Authenticator {
  /**
   * Perform an interactive login flow.
   * Returns a result indicating whether login completed immediately (browser)
   * or requires user action (device code with a pending background flow).
   */
  login(): Promise<LoginResult>;

  /** Acquire a cached access token, refreshing silently if needed. */
  token(): Promise<string>;

  /** Clear cached tokens and account data. */
  logout(): Promise<void>;

  /** Check whether a valid cached token exists (without prompting). */
  isAuthenticated(): Promise<boolean>;

  /** Get info about the currently logged-in account, if any. */
  accountInfo(): Promise<AccountInfo | null>;
}

export interface LoginResult {
  /** Human-readable message about the login attempt. */
  message: string;
  /** Whether login has fully completed (browser flow completes immediately). */
  completed: boolean;
}

/** Basic info about the logged-in account. */
export interface AccountInfo {
  username: string;
}

// ---------------------------------------------------------------------------
// File-based MSAL cache (mirrors Go's tokencache.go)
// ---------------------------------------------------------------------------

/** MSAL cache plugin that persists token data to a JSON file. */
function createFileCachePlugin(configDir: string): msal.ICachePlugin {
  const cachePath = path.join(configDir, CACHE_FILE_NAME);

  return {
    async beforeCacheAccess(context: msal.TokenCacheContext): Promise<void> {
      try {
        const data = await fs.readFile(cachePath, "utf-8");
        context.tokenCache.deserialize(data);
        logger.debug("loaded token cache", { path: cachePath });
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          logger.debug("token cache file not found, starting fresh", {
            path: cachePath,
          });
          return;
        }
        throw err;
      }
    },

    async afterCacheAccess(context: msal.TokenCacheContext): Promise<void> {
      if (context.cacheHasChanged) {
        await fs.mkdir(path.dirname(cachePath), {
          recursive: true,
          mode: 0o700,
        });
        await fs.writeFile(cachePath, context.tokenCache.serialize(), {
          mode: 0o600,
        });
        logger.debug("exported token cache", { path: cachePath });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Account persistence (mirrors Go's saveAccount/loadAccount)
// ---------------------------------------------------------------------------

async function saveAccount(
  account: msal.AccountInfo,
  configDir: string,
): Promise<void> {
  const accountPath = path.join(configDir, ACCOUNT_FILE_NAME);
  await fs.mkdir(path.dirname(accountPath), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(
    accountPath,
    JSON.stringify(account, undefined, 2) + "\n",
    { mode: 0o600 },
  );
  logger.debug("saved account", { path: accountPath });
}

async function loadAccount(
  configDir: string,
): Promise<msal.AccountInfo | undefined> {
  const accountPath = path.join(configDir, ACCOUNT_FILE_NAME);
  try {
    const data = await fs.readFile(accountPath, "utf-8");
    const account = JSON.parse(data) as msal.AccountInfo;
    logger.debug("loaded account", {
      path: accountPath,
      username: account.username,
    });
    return account;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      logger.debug("account file not found", { path: accountPath });
      return undefined;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// MsalAuthenticator
// ---------------------------------------------------------------------------

/**
 * MSAL-based authenticator supporting both interactive browser login
 * and device code flow as a fallback.
 */
export class MsalAuthenticator implements Authenticator {
  private readonly clientId: string;
  private readonly configDir: string;
  private readonly scopes: string[];
  private readonly openBrowser: (url: string) => Promise<void>;
  private pendingLogin: Promise<void> | null = null;

  constructor(
    clientId: string,
    configDir: string,
    scopes: string[],
    openBrowser: (url: string) => Promise<void>,
  ) {
    this.clientId = clientId;
    this.configDir = configDir;
    this.scopes = scopes;
    this.openBrowser = openBrowser;
  }

  private createClient(): msal.PublicClientApplication {
    return new msal.PublicClientApplication({
      auth: {
        clientId: this.clientId,
        authority: AUTHORITY_URL,
      },
      cache: {
        cachePlugin: createFileCachePlugin(this.configDir),
      },
      system: {
        loggerOptions: {
          logLevel: msal.LogLevel.Warning,
          piiLoggingEnabled: false,
        },
      },
    });
  }

  /**
   * Try interactive browser login first, fall back to device code.
   */
  async login(): Promise<LoginResult> {
    // Try browser login first
    try {
      return await this.loginWithBrowser();
    } catch (err: unknown) {
      logger.info("browser login failed, falling back to device code", {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.loginWithDeviceCode();
    }
  }

  /** Interactive browser login - shows landing page, handles redirect via custom loopback. */
  private async loginWithBrowser(): Promise<LoginResult> {
    logger.info("starting browser login");
    const client = this.createClient();
    const loopback = new LoginLoopbackClient();

    const result = await client.acquireTokenInteractive({
      scopes: this.scopes,
      loopbackClient: loopback,
      openBrowser: async (authUrl: string) => {
        loopback.setAuthUrl(authUrl);
        await this.openBrowser(loopback.getRedirectUri());
      },
    });

    if (!result.account) {
      throw new Error("Browser authentication returned no account");
    }

    await saveAccount(result.account, this.configDir);
    logger.info("browser login successful", {
      username: result.account.username,
    });

    return {
      message: `Logged in as ${result.account.username}`,
      completed: true,
    };
  }

  /** Device code flow - fires in the background, returns message immediately. */
  private async loginWithDeviceCode(): Promise<LoginResult> {
    logger.info("starting device code login");
    const client = this.createClient();

    let resolveMessage: (msg: string) => void;
    const messagePromise = new Promise<string>((resolve) => {
      resolveMessage = resolve;
    });

    // Start device code flow - runs in the background, caches tokens on completion
    this.pendingLogin = client
      .acquireTokenByDeviceCode({
        scopes: this.scopes,
        deviceCodeCallback: (response) => {
          resolveMessage(response.message);
        },
      })
      .then(async (result) => {
        if (!result?.account) {
          throw new Error("Device code authentication returned no result");
        }

        await saveAccount(result.account, this.configDir);
        logger.info("device code login successful", {
          username: result.account.username,
        });
      })
      .catch((err: unknown) => {
        logger.error("device code login failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      })
      .finally(() => {
        this.pendingLogin = null;
      });

    // Wait for the device code callback to fire (immediate - just the code URL)
    const message = await messagePromise;
    return { message, completed: false };
  }

  async token(): Promise<string> {
    // If a login is in progress, wait for it to complete first
    if (this.pendingLogin) {
      await this.pendingLogin;
    }

    const client = this.createClient();
    const account = await loadAccount(this.configDir);

    if (!account) {
      throw new AuthenticationRequiredError();
    }

    logger.debug("acquiring token silently", {
      username: account.username,
    });

    try {
      const result = await client.acquireTokenSilent({
        account,
        scopes: this.scopes,
      });

      logger.debug("token acquired");
      return result.accessToken;
    } catch (err: unknown) {
      if (err instanceof msal.InteractionRequiredAuthError) {
        throw new AuthenticationRequiredError();
      }
      throw err;
    }
  }

  async logout(): Promise<void> {
    const files = [
      path.join(this.configDir, CACHE_FILE_NAME),
      path.join(this.configDir, ACCOUNT_FILE_NAME),
    ];

    for (const f of files) {
      try {
        await fs.unlink(f);
        logger.debug("removed cache file", { path: f });
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          continue;
        }
        throw err;
      }
    }

    logger.info("logged out, token cache cleared");
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      await this.token();
      return true;
    } catch {
      return false;
    }
  }

  async accountInfo(): Promise<AccountInfo | null> {
    const account = await loadAccount(this.configDir);
    if (!account) return null;
    return { username: account.username };
  }
}

// ---------------------------------------------------------------------------
// StaticAuthenticator (for testing / GRAPHDO_ACCESS_TOKEN)
// ---------------------------------------------------------------------------

export class StaticAuthenticator implements Authenticator {
  constructor(private readonly accessToken: string) {}

  login(): Promise<LoginResult> {
    return Promise.resolve({
      message: "Already authenticated with static token.",
      completed: true,
    });
  }

  token(): Promise<string> {
    return Promise.resolve(this.accessToken);
  }

  async logout(): Promise<void> {
    // No-op for static authenticator
  }

  isAuthenticated(): Promise<boolean> {
    return Promise.resolve(true);
  }

  accountInfo(): Promise<AccountInfo | null> {
    return Promise.resolve({ username: "static-token" });
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AuthenticationRequiredError extends Error {
  constructor() {
    super("Not logged in - use the login tool to authenticate with Microsoft");
    this.name = "AuthenticationRequiredError";
  }
}
