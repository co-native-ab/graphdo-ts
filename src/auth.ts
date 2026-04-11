// Authentication module - MSAL-based token acquisition for Microsoft Graph.
//
// Uses interactive browser login exclusively. If the browser cannot be opened,
// the login URL is returned for manual navigation.

import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

import * as msal from "@azure/msal-node";
import { z } from "zod";

import { AuthenticationRequiredError, isNodeError, UserCancelledError } from "./errors.js";
import { logger } from "./logger.js";
import { LoginLoopbackClient } from "./loopback.js";
import { logoutPageHtml } from "./templates/logout.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTHORITY_BASE = "https://login.microsoftonline.com";

/** Default tenant: "common" allows any Microsoft account (personal + work/school). */
export const DEFAULT_TENANT_ID = "common";

const CACHE_FILE_NAME = "msal_cache.json";
const ACCOUNT_FILE_NAME = "account.json";

/** Timeout for the browser login flow (user must complete OAuth within this). */
const LOGIN_TIMEOUT_MS = 120_000; // 2 minutes

/** Timeout for the logout confirmation page. */
const LOGOUT_TIMEOUT_MS = 120_000; // 2 minutes

// ---------------------------------------------------------------------------
// Authenticator interface
// ---------------------------------------------------------------------------

/** Abstraction for login + token acquisition. */
export interface Authenticator {
  /** Perform an interactive browser login. */
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
        if (isNodeError(err) && err.code === "ENOENT") {
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

async function saveAccount(account: msal.AccountInfo, configDir: string): Promise<void> {
  const accountPath = path.join(configDir, ACCOUNT_FILE_NAME);
  await fs.mkdir(path.dirname(accountPath), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(accountPath, JSON.stringify(account, undefined, 2) + "\n", { mode: 0o600 });
  logger.debug("saved account", { path: accountPath });
}

const AccountInfoSchema = z
  .object({
    username: z.string(),
    // msal.AccountInfo has more fields, but we only care about username for now.
  })
  .loose();

async function loadAccount(configDir: string): Promise<msal.AccountInfo | undefined> {
  const accountPath = path.join(configDir, ACCOUNT_FILE_NAME);
  try {
    const data = await fs.readFile(accountPath, "utf-8");
    let account: unknown;
    try {
      account = JSON.parse(data);
    } catch {
      logger.error("Failed to parse account.json as JSON", { path: accountPath });
      return undefined;
    }
    // Validate minimal shape
    const parsed = AccountInfoSchema.safeParse(account);
    if (!parsed.success) {
      logger.error("Account file failed validation", {
        path: accountPath,
        error: parsed.error.message,
      });
      return undefined;
    }
    logger.debug("loaded account", {
      path: accountPath,
      username: parsed.data.username,
    });
    return parsed.data as msal.AccountInfo;
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
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
 * MSAL-based authenticator using interactive browser login exclusively.
 */
export class MsalAuthenticator implements Authenticator {
  private readonly clientId: string;
  private readonly tenantId: string;
  private readonly configDir: string;
  private readonly scopes: string[];
  private readonly openBrowser: (url: string) => Promise<void>;

  constructor(
    clientId: string,
    tenantId: string,
    configDir: string,
    scopes: string[],
    openBrowser: (url: string) => Promise<void>,
  ) {
    this.clientId = clientId;
    this.tenantId = tenantId;
    this.configDir = configDir;
    this.scopes = scopes;
    this.openBrowser = openBrowser;
  }

  private createClient(): msal.PublicClientApplication {
    return new msal.PublicClientApplication({
      auth: {
        clientId: this.clientId,
        authority: `${AUTHORITY_BASE}/${this.tenantId}`,
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

  async login(): Promise<LoginResult> {
    logger.info("starting browser login");
    const client = this.createClient();
    const loopback = new LoginLoopbackClient();

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const result = await Promise.race([
        client.acquireTokenInteractive({
          scopes: this.scopes,
          prompt: "select_account",
          loopbackClient: loopback,
          openBrowser: async (authUrl: string) => {
            loopback.setAuthUrl(authUrl);
            await this.openBrowser(loopback.getRedirectUri());
          },
        }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(
              new Error(
                "Browser login timed out — sign-in was not completed within the time limit.",
              ),
            );
          }, LOGIN_TIMEOUT_MS);
        }),
      ]);

      if (!result.account) {
        throw new Error("Browser authentication returned no account");
      }

      await saveAccount(result.account, this.configDir);
      logger.info("browser login successful", {
        username: result.account.username,
      });

      return {
        message: `Logged in as ${result.account.username}`,
      };
    } finally {
      clearTimeout(timeoutId);
      loopback.closeServer();
    }
  }

  async token(): Promise<string> {
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
    try {
      await showLogoutPage(this.openBrowser, () => this.clearCacheFiles());
    } catch (err: unknown) {
      if (err instanceof UserCancelledError) throw err;
      // Browser unavailable or timed out — clear tokens silently
      logger.warn("could not show logout confirmation page, clearing tokens silently", {
        error: err instanceof Error ? err.message : String(err),
      });
      await this.clearCacheFiles();
    }
  }

  private async clearCacheFiles(): Promise<void> {
    const files = [
      path.join(this.configDir, CACHE_FILE_NAME),
      path.join(this.configDir, ACCOUNT_FILE_NAME),
    ];

    for (const f of files) {
      try {
        await fs.unlink(f);
        logger.debug("removed cache file", { path: f });
      } catch (err: unknown) {
        if (isNodeError(err) && err.code === "ENOENT") {
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
// Logout confirmation page
// ---------------------------------------------------------------------------

/**
 * Show an interactive logout confirmation page in the browser.
 * The page has "Sign Out" and "Cancel" buttons. Token clearing only happens
 * when the user confirms. Resolves on confirm, rejects with UserCancelledError
 * on cancel, rejects with Error if browser cannot be opened.
 */
async function showLogoutPage(
  openBrowser: (url: string) => Promise<void>,
  onConfirm: () => Promise<void>,
): Promise<void> {
  const html = logoutPageHtml();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const server = createServer((req, res) => {
      const url = req.url ?? "/";

      if (req.method === "GET" && url === "/") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(html);
        return;
      }

      if (req.method === "POST" && url === "/confirm") {
        onConfirm()
          .then(() => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            setTimeout(() => server.close(), 100);
            settle(() => resolve());
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            logger.error("logout confirm failed", { error: message });
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Failed to sign out. Please try again.");
            server.close();
            settle(() => reject(err instanceof Error ? err : new Error(message)));
          });
        return;
      }

      if (req.method === "POST" && url === "/cancel") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        setTimeout(() => server.close(), 100);
        settle(() => reject(new UserCancelledError("Logout cancelled by user")));
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });

    const timer = setTimeout(() => {
      logger.warn("logout confirmation page timed out");
      server.close();
      settle(() => reject(new Error("Logout confirmation timed out")));
    }, LOGOUT_TIMEOUT_MS);

    server.on("close", () => {
      clearTimeout(timer);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        settle(() =>
          reject(new Error("Server bound to unexpected address type (expected port number)")),
        );
        return;
      }
      const url = `http://127.0.0.1:${String(addr.port)}`;
      logger.debug("logout page server started", { url });

      openBrowser(url).catch((err: unknown) => {
        server.close();
        settle(() => reject(err instanceof Error ? err : new Error(String(err))));
      });
    });

    server.on("error", (err) => {
      settle(() => reject(err));
    });
  });
}

// ---------------------------------------------------------------------------
// StaticAuthenticator (for testing / GRAPHDO_ACCESS_TOKEN)
// ---------------------------------------------------------------------------

export class StaticAuthenticator implements Authenticator {
  constructor(private readonly accessToken: string) {}

  login(): Promise<LoginResult> {
    return Promise.resolve({
      message: "Already authenticated with static token.",
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
