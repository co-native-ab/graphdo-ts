// Custom MSAL loopback client - serves a branded login landing page.
//
// Replaces MSAL's default loopback server with our own that shows a nice
// landing page with a "Sign in with Microsoft" button, handles the OAuth
// redirect, and displays a success/error page with auto-close.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";

import type { AuthorizeResponse } from "@azure/msal-node";
import type { ILoopbackClient } from "@azure/msal-node";

import { logger } from "./logger.js";
import { UserCancelledError } from "./errors.js";
import { landingPageHtml, successPageHtml, errorPageHtml } from "./templates/login.js";

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

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");

  // Auth code redirect from Microsoft: /?code=...&state=...
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
    );
    resolve(authResponse);
    return;
  }

  // Landing page
  if (pathname === "/" && req.method === "GET") {
    serveLandingPage(res, client);
    return;
  }

  // Success page (shown after redirect from auth code capture)
  if (pathname === "/done" && req.method === "GET") {
    serveSuccessPage(res);
    return;
  }

  // Cancel login
  if (pathname === "/cancel" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    client.closeServer();
    reject(new UserCancelledError("Login cancelled by user"));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
}

function parseAuthResponse(params: URLSearchParams): AuthorizeResponse {
  const response: AuthorizeResponse = {};
  for (const [key, value] of params.entries()) {
    (response as Record<string, string>)[key] = value;
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

function serveLandingPage(res: ServerResponse, client: LoginLoopbackClient): void {
  const authUrl = client.getAuthUrl();
  if (!authUrl) {
    serveErrorPage(
      res,
      "Authentication URL is not available. Please close this window and try again.",
    );
    return;
  }

  serveHtml(res, landingPageHtml(authUrl));
}

function serveSuccessPage(res: ServerResponse): void {
  serveHtml(res, successPageHtml());
}

function serveErrorPage(res: ServerResponse, errorMessage: string): void {
  serveHtml(res, errorPageHtml(errorMessage));
}
