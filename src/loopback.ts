// Custom MSAL loopback client - serves a branded login landing page.
//
// Replaces MSAL's default loopback server with our own that shows a nice
// landing page with a "Sign in with Microsoft" button, handles the OAuth
// redirect, and displays a success/error page with auto-close.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";

import type { AuthorizeResponse } from "@azure/msal-node";
import type { ILoopbackClient } from "@azure/msal-node";

import { z } from "zod";
import { logger } from "./logger.js";
import { UserCancelledError } from "./errors.js";
import { landingPageHtml, successPageHtml, errorPageHtml } from "./templates/login.js";
import {
  buildLoopbackCsp,
  generateRandomToken,
  validateLoopbackPostHeaders,
  verifyCsrfToken,
} from "./loopback-security.js";

/** Maximum POST body size (1 MB). */
const MAX_BODY_SIZE = 1_048_576;

const CancelSchema = z.object({ csrfToken: z.string() });

// ---------------------------------------------------------------------------
// LoginLoopbackClient
// ---------------------------------------------------------------------------

/**
 * Custom MSAL loopback client that serves a branded login experience.
 *
 * Flow:
 * 1. MSAL calls `listenForAuthCode()` → HTTP server starts
 * 2. MSAL calls `getRedirectUri()` → returns server URL
 * 3. MSAL calls `openBrowser(authUrl)` → caller stores the auth URL via `setAuthUrl()`
 *    and opens our landing page instead
 * 4. User clicks "Sign in with Microsoft" → `/redirect` → 302 to Microsoft auth URL
 * 5. Microsoft redirects back with `?code=...` → captured → redirects to `/done`
 * 6. `/done` shows success page with auto-close countdown
 * 7. Promise resolves with `AuthorizeResponse`
 */
export class LoginLoopbackClient implements ILoopbackClient {
  private server: Server | undefined;
  private authUrl: string | undefined;
  private serverReady: Promise<void> | undefined;
  /** Per-server CSRF token; required on every state-changing POST. */
  private readonly csrfToken: string = generateRandomToken();

  /** Set the Microsoft auth URL (called from the openBrowser wrapper). */
  setAuthUrl(url: string): void {
    this.authUrl = url;
  }

  async listenForAuthCode(): Promise<AuthorizeResponse> {
    if (this.server) {
      throw new Error("Loopback server already exists");
    }

    return new Promise<AuthorizeResponse>((resolve, reject) => {
      const server = createServer((req, res) => {
        handleRequest(req, res, this, resolve, reject);
      });
      this.server = server;

      this.serverReady = new Promise<void>((readyResolve) => {
        server.listen(0, "127.0.0.1", () => {
          readyResolve();
        });
      });

      server.on("error", (err) => {
        logger.error("login loopback server error", { error: err.message });
        reject(err);
      });
    });
  }

  /** Wait for the server to start listening. */
  async waitForReady(): Promise<void> {
    await this.serverReady;
  }

  getRedirectUri(): string {
    if (!this.server?.listening) {
      throw new Error("No loopback server exists");
    }

    const address = this.server.address();
    if (!address || typeof address === "string" || !address.port) {
      this.closeServer();
      throw new Error("Invalid loopback server address");
    }

    return `http://localhost:${String(address.port)}`;
  }

  closeServer(): void {
    if (this.server) {
      this.server.close();
      if (typeof this.server.closeAllConnections === "function") {
        this.server.closeAllConnections();
      }
      this.server.unref();
      this.server = undefined;
    }
  }

  /** Expose auth URL for request handler. */
  getAuthUrl(): string | undefined {
    return this.authUrl;
  }

  /** Expose CSRF token for request handler / templates. */
  getCsrfToken(): string {
    return this.csrfToken;
  }

  /** Allowed Host header values for POST requests. MSAL's redirect URI uses
   *  `localhost`, but some browsers normalise to `127.0.0.1`; accept both. */
  getAllowedHosts(): string[] {
    if (!this.server?.listening) return [];
    const address = this.server.address();
    if (!address || typeof address === "string") return [];
    const port = String(address.port);
    return [`localhost:${port}`, `127.0.0.1:${port}`];
  }
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  client: LoginLoopbackClient,
  resolve: (response: AuthorizeResponse) => void,
  reject: (err: Error) => void,
): void {
  const rawUrl = req.url ?? "/";
  const redirectUri = client.getRedirectUri();
  const parsedUrl = new URL(rawUrl, redirectUri);
  const pathname = parsedUrl.pathname;

  // Per-request CSP nonce. Hardened CSP forbids unsafe-inline.
  const nonce = generateRandomToken();

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Content-Security-Policy", buildLoopbackCsp(nonce));

  // Auth code redirect from Microsoft: /?code=...&state=...
  // This is a top-level cross-site GET originating from login.microsoftonline.com,
  // so Sec-Fetch-Site / Origin / CSRF checks are intentionally skipped. The
  // path is read-only with respect to the loopback server's own state — it
  // only resolves the in-flight Promise with the auth code that MSAL will
  // exchange server-side for tokens.
  if (pathname === "/" && parsedUrl.searchParams.has("code")) {
    const authResponse = parseAuthResponse(parsedUrl.searchParams);
    // Redirect to /done to strip the code from browser history
    res.writeHead(302, { Location: "/done" });
    res.end();
    resolve(authResponse);
    return;
  }

  // Error redirect from Microsoft: /?error=...
  if (pathname === "/" && parsedUrl.searchParams.has("error")) {
    const authResponse = parseAuthResponse(parsedUrl.searchParams);
    serveErrorPage(
      res,
      parsedUrl.searchParams.get("error_description") ??
        parsedUrl.searchParams.get("error") ??
        "Unknown error",
      nonce,
    );
    resolve(authResponse);
    return;
  }

  // Landing page
  if (pathname === "/" && req.method === "GET") {
    serveLandingPage(res, client, nonce);
    return;
  }

  // Success page (shown after redirect from auth code capture)
  if (pathname === "/done" && req.method === "GET") {
    serveSuccessPage(res, nonce);
    return;
  }

  // Cancel login — state-changing POST, must pass full hardening.
  if (pathname === "/cancel" && req.method === "POST") {
    handleCancel(req, res, client, reject);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
}

function handleCancel(
  req: IncomingMessage,
  res: ServerResponse,
  client: LoginLoopbackClient,
  reject: (err: Error) => void,
): void {
  const headerCheck = validateLoopbackPostHeaders(req, {
    allowedHosts: client.getAllowedHosts(),
  });
  if (!headerCheck.ok) {
    res.writeHead(headerCheck.status, { "Content-Type": "text/plain" });
    res.end(headerCheck.message);
    return;
  }

  let body = "";
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) {
      res.writeHead(413, { "Content-Type": "text/plain" });
      res.end("Payload Too Large");
      req.destroy();
      return;
    }
    body += chunk.toString();
  });
  req.on("end", () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid request body");
      return;
    }
    const parseResult = CancelSchema.safeParse(parsed);
    if (
      !parseResult.success ||
      !verifyCsrfToken(client.getCsrfToken(), parseResult.data.csrfToken)
    ) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: invalid CSRF token");
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    client.closeServer();
    reject(new UserCancelledError("Login cancelled by user"));
  });
}

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
// HTML response helpers
// ---------------------------------------------------------------------------

function serveHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
  });
  res.end(html);
}

function serveLandingPage(res: ServerResponse, client: LoginLoopbackClient, nonce: string): void {
  const authUrl = client.getAuthUrl();
  if (!authUrl) {
    serveErrorPage(
      res,
      "Authentication URL is not available. Please close this window and try again.",
      nonce,
    );
    return;
  }

  serveHtml(res, landingPageHtml(authUrl, { csrfToken: client.getCsrfToken(), nonce }));
}

function serveSuccessPage(res: ServerResponse, nonce: string): void {
  serveHtml(res, successPageHtml(nonce));
}

function serveErrorPage(res: ServerResponse, errorMessage: string, nonce: string): void {
  serveHtml(res, errorPageHtml(errorMessage, nonce));
}
