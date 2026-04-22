// Login flow descriptor + MSAL ILoopbackClient adapter.
//
// Replaces the bespoke `LoginLoopbackClient` class with a thin flow
// descriptor on top of `runBrowserFlow` and an adapter that satisfies
// MSAL's `ILoopbackClient` interface.

import type { AuthorizeResponse, ILoopbackClient } from "@azure/msal-node";

import { z } from "zod";

import { UserCancelledError } from "../../errors.js";
import { landingPageHtml, successPageHtml, errorPageHtml } from "../../templates/login.js";
import type { BrowserFlow, FlowContext, RouteTable } from "../server.js";
import { readJsonWithCsrf, runBrowserFlow, serveHtml } from "../server.js";

// ---------------------------------------------------------------------------
// Auth-response whitelist
// ---------------------------------------------------------------------------

/**
 * Documented MSAL OAuth 2.0 authorization-response fields. We only
 * forward these to MSAL so an attacker who controls the redirect URL
 * cannot smuggle additional keys into the AuthorizeResponse the way
 * an unconditional `for (const [k,v] of params)` would have allowed.
 * Kept aligned with `@azure/msal-common`'s `ServerAuthorizationCodeResponse`.
 */
const ALLOWED_AUTH_RESPONSE_FIELDS = new Set<string>([
  "code",
  "state",
  "session_state",
  "client_info",
  "cloud_instance_name",
  "cloud_instance_host_name",
  "cloud_graph_host_name",
  "msgraph_host",
  "error",
  "error_description",
  "error_uri",
  "suberror",
  "timestamp",
  "trace_id",
  "correlation_id",
]);

function parseAuthResponse(params: URLSearchParams): AuthorizeResponse {
  const response: AuthorizeResponse = {};
  for (const [key, value] of params.entries()) {
    if (ALLOWED_AUTH_RESPONSE_FIELDS.has(key)) {
      (response as Record<string, string>)[key] = value;
    }
  }
  return response;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CancelSchema = z.object({ csrfToken: z.string() });

// ---------------------------------------------------------------------------
// loginFlow descriptor
// ---------------------------------------------------------------------------

export function loginFlow(
  getAuthUrl: () => string | undefined,
  _signal: AbortSignal,
): BrowserFlow<AuthorizeResponse> {
  return {
    name: "login",
    routes: (ctx: FlowContext<AuthorizeResponse>): RouteTable => {
      // The route handler for "/" needs to check query params BEFORE matching
      // the standard "GET /" route. Auth code redirects from Microsoft arrive
      // as GET /?code=... or GET /?error=... and must be handled specially.
      // We handle this by making "GET /" check the query string internally.
      return {
        "GET /": (req, res, nonce) => {
          const rawUrl = req.url ?? "/";
          const parsedUrl = new URL(rawUrl, "http://127.0.0.1");

          // Auth code redirect from Microsoft: /?code=...&state=...
          // This is a top-level cross-site GET originating from login.microsoftonline.com,
          // so Sec-Fetch-Site / Origin / CSRF checks are intentionally skipped. The
          // path is read-only with respect to the loopback server's own state — it
          // only resolves the in-flight Promise with the auth code that MSAL will
          // exchange server-side for tokens.
          if (parsedUrl.searchParams.has("code")) {
            const authResponse = parseAuthResponse(parsedUrl.searchParams);
            // Redirect to /done to strip the code from browser history
            res.writeHead(302, { Location: "/done" });
            res.end();
            ctx.resolve(authResponse);
            return;
          }

          // Error redirect from Microsoft: /?error=...
          if (parsedUrl.searchParams.has("error")) {
            const authResponse = parseAuthResponse(parsedUrl.searchParams);
            serveHtml(
              res,
              errorPageHtml(
                parsedUrl.searchParams.get("error_description") ??
                  parsedUrl.searchParams.get("error") ??
                  "Unknown error",
                nonce,
              ),
            );
            ctx.resolve(authResponse);
            return;
          }

          // Landing page
          const authUrl = getAuthUrl();
          if (!authUrl) {
            serveHtml(
              res,
              errorPageHtml(
                "Authentication URL is not available. Please close this window and try again.",
                nonce,
              ),
            );
            return;
          }
          serveHtml(res, landingPageHtml(authUrl, { csrfToken: ctx.csrfToken, nonce }));
        },

        "GET /done": (_req, res, nonce) => {
          serveHtml(res, successPageHtml(nonce));
        },

        "POST /cancel": (req, res) => {
          readJsonWithCsrf(req, res, ctx, CancelSchema, () => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            ctx.server.close();
            ctx.reject(new UserCancelledError("Login cancelled by user"));
          });
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// MSAL ILoopbackClient adapter
// ---------------------------------------------------------------------------

/**
 * Creates an MSAL `ILoopbackClient` adapter backed by `runBrowserFlow`.
 *
 * MSAL lifecycle:
 * 1. `listenForAuthCode()` → starts the flow server, returns the auth result promise
 * 2. `getRedirectUri()` → returns the server URL (MSAL uses this for auth URL)
 * 3. MSAL calls `openBrowser(authUrl)` → our wrapper calls `setAuthUrl()` then
 *    opens the landing page
 * 4. Auth completes → `listenForAuthCode` promise resolves
 * 5. `closeServer()` → cleanup
 *
 * Note: MSAL does NOT await `listenForAuthCode()` before calling `getRedirectUri()`.
 * It calls `listenForAuthCode()` (gets back a Promise), then immediately calls
 * `getRedirectUri()`. So we must start the server and capture the URL before
 * the first `await` in `listenForAuthCode()`.
 */
export function createMsalLoopback(
  _openBrowser: (url: string) => Promise<void>,
  signal: AbortSignal,
): ILoopbackClient & { setAuthUrl(url: string): void } {
  let authUrl: string | undefined;
  let handleClose: (() => void) | undefined;
  let handleUrl: string | undefined;
  let handleReady: Promise<void> | undefined;
  let readyResolve: (() => void) | undefined;

  return {
    setAuthUrl(url: string): void {
      authUrl = url;
    },

    listenForAuthCode(): Promise<AuthorizeResponse> {
      // Create a "ready" promise that resolves once the server URL is known.
      handleReady = new Promise<void>((resolve) => {
        readyResolve = resolve;
      });

      // Start the flow asynchronously. Once the handle is ready, capture
      // the URL so `getRedirectUri()` can return it synchronously.
      const flowPromise = runBrowserFlow(
        loginFlow(() => authUrl, signal),
        signal,
      ).then((handle) => {
        handleUrl = handle.url;
        handleClose = handle.close;
        readyResolve?.();
        return handle.result;
      });

      return flowPromise;
    },

    getRedirectUri(): string {
      if (!handleUrl) {
        throw new Error("No loopback server exists");
      }
      // MSAL expects localhost in the redirect URI
      const parsed = new URL(handleUrl);
      return `http://localhost:${parsed.port}`;
    },

    closeServer(): void {
      handleClose?.();
      handleClose = undefined;
      handleUrl = undefined;
    },

    // For test compatibility — wait until the server is ready
    async waitForReady(): Promise<void> {
      await handleReady;
    },
  } as ILoopbackClient & { setAuthUrl(url: string): void };
}
