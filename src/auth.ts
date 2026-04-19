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
import { type GraphScope, toGraphScopes, defaultScopes } from "./scopes.js";

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
  login(signal: AbortSignal): Promise<LoginResult>;

  /** Acquire a cached access token, refreshing silently if needed. */
  token(signal: AbortSignal): Promise<string>;

  /** Clear cached tokens and account data. */
  logout(signal: AbortSignal): Promise<void>;

  /** Check whether a valid cached token exists (without prompting). */
  isAuthenticated(signal: AbortSignal): Promise<boolean>;

  /** Get info about the currently logged-in account, if any. */
  accountInfo(signal: AbortSignal): Promise<AccountInfo | null>;

  /** Get the scopes granted in the current auth session. Empty if not authenticated. */
  grantedScopes(signal: AbortSignal): Promise<GraphScope[]>;
}

export interface LoginResult {
  /** Human-readable message about the login attempt. */
  message: string;
  /** Scopes granted by the auth server. */
  grantedScopes: GraphScope[];
}

/** Basic info about the logged-in account. */
export interface AccountInfo {
  username: string;
  /**
   * Entra object identifier of the signed-in user (`idTokenClaims.oid`).
   *
   * Per ADR-0006, this is the canonical user identifier surfaced to collab
   * consumers (audit log, agentId derivation, scope-key, etc.). MSAL's
   * `localAccountId` is intentionally NOT used because it can diverge from
   * `oid` in multi-tenant and B2B-guest setups, and we do not want that
   * ambiguity baked into audit trails.
   */
  userOid: string;
}

// ---------------------------------------------------------------------------
// idTokenClaims helpers
// ---------------------------------------------------------------------------

/** Minimal shape of the parts of `idTokenClaims` we read from MSAL. */
interface IdTokenClaimsWithOid {
  oid?: unknown;
}

/**
 * Extract the `oid` claim from an MSAL `idTokenClaims`-shaped value.
 * Returns `undefined` if missing or not a string.
 */
function readOidFromClaims(claims: unknown): string | undefined {
  if (claims === null || typeof claims !== "object") return undefined;
  const oid = (claims as IdTokenClaimsWithOid).oid;
  return typeof oid === "string" && oid.length > 0 ? oid : undefined;
}

/**
 * Extract `idTokenClaims.oid` from a fresh MSAL `AuthenticationResult`.
 *
 * MSAL exposes the parsed id-token claims either on `result.idTokenClaims`
 * directly or, for cached accounts, on `result.account.idTokenClaims`. We
 * check both — in that order — so login flows and silent refreshes both work.
 */
function readUserOidFromResult(result: msal.AuthenticationResult): string | undefined {
  return (
    readOidFromClaims(result.idTokenClaims) ??
    readOidFromClaims((result.account as { idTokenClaims?: unknown } | null)?.idTokenClaims)
  );
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Races a promise against an AbortSignal so long-running MSAL operations
 * (e.g. silent token refresh) are cancelled when the caller aborts.
 */
function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void =>
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

// ---------------------------------------------------------------------------
// File-based MSAL cache (mirrors Go's tokencache.go)
// ---------------------------------------------------------------------------

/**
 * MSAL cache plugin that persists token data to a JSON file.
 *
 * Note: the `ICachePlugin` interface (`beforeCacheAccess` / `afterCacheAccess`)
 * is defined by the MSAL library and does not include an AbortSignal parameter.
 * Signal-forwarding is intentionally omitted here — it is not possible without
 * changing the MSAL interface.
 */
function createFileCachePlugin(configDir: string): msal.ICachePlugin {
  const cachePath = path.join(configDir, CACHE_FILE_NAME);

  return {
    async beforeCacheAccess(context: msal.TokenCacheContext): Promise<void> {
      try {
        const data = await fs.readFile(cachePath, {
          encoding: "utf-8",
          signal: AbortSignal.timeout(5_000),
        });
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
          signal: AbortSignal.timeout(5_000),
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
  userOid: string,
  configDir: string,
  signal: AbortSignal,
): Promise<void> {
  const accountPath = path.join(configDir, ACCOUNT_FILE_NAME);
  await fs.mkdir(path.dirname(accountPath), {
    recursive: true,
    mode: 0o700,
  });
  // Persist the MSAL account verbatim plus the resolved `userOid` under a
  // dedicated top-level key so we never have to re-derive it on read. The
  // separate field makes the schema explicit and avoids depending on MSAL
  // happening to round-trip `idTokenClaims` through its own cache.
  const payload = { ...account, userOid };
  await fs.writeFile(accountPath, JSON.stringify(payload, undefined, 2) + "\n", {
    mode: 0o600,
    signal,
  });
  logger.debug("saved account", { path: accountPath });
}

const AccountInfoSchema = z
  .object({
    username: z.string(),
    /**
     * `userOid` is the persisted form of `idTokenClaims.oid` resolved at
     * login time. It is required — without it we cannot satisfy the
     * `AccountInfo` contract surfaced to collab consumers.
     */
    userOid: z.string().min(1),
    // msal.AccountInfo has more fields, but we only care about username +
    // userOid for now.
  })
  .loose();

interface PersistedAccount extends msal.AccountInfo {
  userOid: string;
}

async function loadAccount(
  configDir: string,
  signal: AbortSignal,
): Promise<PersistedAccount | undefined> {
  const accountPath = path.join(configDir, ACCOUNT_FILE_NAME);
  try {
    const data = await fs.readFile(accountPath, { encoding: "utf-8", signal });
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
    return parsed.data as unknown as PersistedAccount;
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
  private readonly openBrowser: (url: string) => Promise<void>;
  private cachedScopes: GraphScope[] = [];

  constructor(
    clientId: string,
    tenantId: string,
    configDir: string,
    openBrowser: (url: string) => Promise<void>,
  ) {
    this.clientId = clientId;
    this.tenantId = tenantId;
    this.configDir = configDir;
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

  async login(signal: AbortSignal): Promise<LoginResult> {
    if (signal.aborted) throw signal.reason;
    logger.info("starting browser login");

    const client = this.createClient();
    const loopback = new LoginLoopbackClient();

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const racePromises: Promise<msal.AuthenticationResult>[] = [
        withSignal(
          client.acquireTokenInteractive({
            // Requesting only User.Read is intentional: Azure AD's admin consent
            // grants all required scopes (Tasks.ReadWrite, Mail.Send, offline_access)
            // regardless of which scopes are included in the interactive request.
            // The granted scopes are read from the token response and stored in
            // cachedScopes to drive dynamic tool visibility.
            scopes: ["User.Read"],
            prompt: "select_account",
            loopbackClient: loopback,
            openBrowser: async (authUrl: string) => {
              loopback.setAuthUrl(authUrl);
              await this.openBrowser(loopback.getRedirectUri());
            },
          }),
          signal,
        ),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(
              new Error(
                "Browser login timed out — sign-in was not completed within the time limit.",
              ),
            );
          }, LOGIN_TIMEOUT_MS);
        }),
      ];

      const result = await Promise.race(racePromises);

      if (!result.account) {
        throw new Error("Browser authentication returned no account");
      }

      const userOid = readUserOidFromResult(result);
      if (!userOid) {
        // ADR-0006: `userOid = idTokenClaims.oid` is required. If the id
        // token did not include an `oid` claim, refuse to persist a
        // partial account rather than silently producing audit entries
        // with a missing or made-up identifier.
        throw new Error(
          "Browser authentication did not return an Entra `oid` claim — cannot establish user identity.",
        );
      }

      await saveAccount(result.account, userOid, this.configDir, signal);
      this.cachedScopes = toGraphScopes(result.scopes);
      logger.info("browser login successful", {
        username: result.account.username,
        scopes: this.cachedScopes.join(", "),
      });

      return {
        message: `Logged in as ${result.account.username}`,
        grantedScopes: this.cachedScopes,
      };
    } finally {
      clearTimeout(timeoutId);
      loopback.closeServer();
    }
  }

  async token(signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw signal.reason;
    const client = this.createClient();
    const account = await loadAccount(this.configDir, signal);

    if (!account) {
      throw new AuthenticationRequiredError();
    }

    logger.debug("acquiring token silently", {
      username: account.username,
    });

    try {
      const result = await withSignal(
        client.acquireTokenSilent({
          account,
          // Same reasoning as acquireTokenInteractive: request only User.Read —
          // all app scopes are already pre-consented via admin grant. MSAL returns
          // the full set of granted scopes in the token response.
          scopes: ["User.Read"],
        }),
        signal,
      );

      this.cachedScopes = toGraphScopes(result.scopes);
      logger.debug("token acquired");
      return result.accessToken;
    } catch (err: unknown) {
      if (err instanceof msal.InteractionRequiredAuthError) {
        throw new AuthenticationRequiredError();
      }
      throw err;
    }
  }

  async logout(signal: AbortSignal): Promise<void> {
    try {
      await showLogoutPage(this.openBrowser, (s) => this.clearCacheFiles(s), signal);
    } catch (err: unknown) {
      if (err instanceof UserCancelledError) throw err;
      // Browser unavailable or timed out — clear tokens silently
      logger.warn("could not show logout confirmation page, clearing tokens silently", {
        error: err instanceof Error ? err.message : String(err),
      });
      await this.clearCacheFiles(signal);
    }
    this.cachedScopes = [];
  }

  private async clearCacheFiles(signal: AbortSignal): Promise<void> {
    const files = [
      path.join(this.configDir, CACHE_FILE_NAME),
      path.join(this.configDir, ACCOUNT_FILE_NAME),
    ];

    for (const f of files) {
      if (signal.aborted) throw signal.reason;
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

  async isAuthenticated(signal: AbortSignal): Promise<boolean> {
    try {
      await this.token(signal);
      return true;
    } catch {
      return false;
    }
  }

  async accountInfo(signal: AbortSignal): Promise<AccountInfo | null> {
    const account = await loadAccount(this.configDir, signal);
    if (!account) return null;
    return { username: account.username, userOid: account.userOid };
  }

  async grantedScopes(signal: AbortSignal): Promise<GraphScope[]> {
    if (this.cachedScopes.length > 0) {
      return this.cachedScopes;
    }
    // Try a silent token acquisition to discover scopes
    try {
      await this.token(signal);
      return this.cachedScopes;
    } catch {
      return [];
    }
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
  onConfirm: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason;
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

      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; connect-src 'self'",
      );

      if (req.method === "GET" && url === "/") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
        });
        res.end(html);
        return;
      }

      if (req.method === "POST" && url === "/confirm") {
        onConfirm(signal)
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
      signal.removeEventListener("abort", onAbort);
    });

    // Abort signal handling — shut down server on cancellation
    const onAbort = (): void => {
      server.close();
      settle(() =>
        reject(signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled")),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });

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

  login(_signal: AbortSignal): Promise<LoginResult> {
    return Promise.resolve({
      message: "Already authenticated with static token.",
      grantedScopes: defaultScopes(),
    });
  }

  token(_signal: AbortSignal): Promise<string> {
    return Promise.resolve(this.accessToken);
  }

  async logout(_signal: AbortSignal): Promise<void> {
    // No-op for static authenticator
  }

  isAuthenticated(_signal: AbortSignal): Promise<boolean> {
    return Promise.resolve(true);
  }

  accountInfo(_signal: AbortSignal): Promise<AccountInfo | null> {
    // The all-zero UUID is a deterministic, obviously-synthetic placeholder
    // for environments using a static bearer token (CI, local dev). It is
    // never a real Entra `oid` and is safe to surface in audit trails as a
    // marker that no MSAL identity was established.
    return Promise.resolve({
      username: "static-token",
      userOid: "00000000-0000-0000-0000-000000000000",
    });
  }

  grantedScopes(_signal: AbortSignal): Promise<GraphScope[]> {
    return Promise.resolve(defaultScopes());
  }
}
