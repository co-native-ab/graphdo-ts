// Custom MSAL loopback client — serves a branded login landing page.
//
// Replaces MSAL's default loopback server with our own that shows a nice
// landing page with a "Sign in with Microsoft" button, handles the OAuth
// redirect, and displays a success/error page with auto-close.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";

import type { AuthorizeResponse } from "@azure/msal-node";
import type { ILoopbackClient } from "@azure/msal-node";

import { logger } from "./logger.js";

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
      this.server = createServer((req, res) => {
        handleRequest(req, res, this, resolve);
      });

      this.serverReady = new Promise<void>((readyResolve) => {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- server is set above
        this.server!.listen(0, "127.0.0.1", () => {
          readyResolve();
        });
      });

      this.server.on("error", (err) => {
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
): void {
  const rawUrl = req.url ?? "/";
  const redirectUri = client.getRedirectUri();
  const parsedUrl = new URL(rawUrl, redirectUri);
  const pathname = parsedUrl.pathname;

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
    serveErrorPage(res, parsedUrl.searchParams.get("error_description") ?? parsedUrl.searchParams.get("error") ?? "Unknown error");
    resolve(authResponse);
    return;
  }

  // Landing page
  if (pathname === "/" && req.method === "GET") {
    serveLandingPage(res, client.getAuthUrl());
    return;
  }

  // Redirect to Microsoft auth
  if (pathname === "/redirect" && req.method === "GET") {
    const authUrl = client.getAuthUrl();
    if (!authUrl) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Authentication URL not yet available. Please wait a moment and refresh.");
      return;
    }
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // Success page (shown after redirect from auth code capture)
  if (pathname === "/done" && req.method === "GET") {
    serveSuccessPage(res);
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
// HTML pages
// ---------------------------------------------------------------------------

const BASE_STYLE = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      color: #333;
      display: flex;
      justify-content: center;
      padding: 60px 20px;
      min-height: 100vh;
    }
    .container {
      max-width: 420px;
      width: 100%;
      text-align: center;
    }
    .card {
      background: white;
      border-radius: 12px;
      padding: 40px 32px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08);
    }`;

function serveLandingPage(res: ServerResponse, authUrl: string | undefined): void {
  const buttonDisabled = authUrl ? "" : "disabled";
  const buttonStyle = authUrl
    ? "background: #0078d4; cursor: pointer;"
    : "background: #ccc; cursor: not-allowed;";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>graphdo — Sign In</title>
  <style>
    ${BASE_STYLE}
    .logo { font-size: 1.8rem; font-weight: 700; color: #0078d4; margin-bottom: 8px; }
    h1 { font-size: 1.3rem; font-weight: 600; margin-bottom: 12px; }
    .subtitle { color: #666; font-size: 0.95rem; line-height: 1.5; margin-bottom: 32px; }
    .sign-in-btn {
      display: inline-block;
      padding: 14px 32px;
      ${buttonStyle}
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 500;
      text-decoration: none;
      transition: background 0.15s, box-shadow 0.15s;
    }
    .sign-in-btn:not([disabled]):hover { background: #106ebe; box-shadow: 0 2px 8px rgba(0,120,212,0.25); }
    .sign-in-btn:not([disabled]):active { background: #005a9e; }
    .footer { margin-top: 24px; font-size: 0.8rem; color: #999; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">graphdo</div>
      <h1>Sign in to continue</h1>
      <p class="subtitle">Connect your Microsoft account to enable email and task management through your AI assistant.</p>
      <a href="/redirect" class="sign-in-btn" ${buttonDisabled}>Sign in with Microsoft</a>
    </div>
    <p class="footer">Your credentials are handled directly by Microsoft. graphdo never sees your password.</p>
  </div>
</body>
</html>`;

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function serveSuccessPage(res: ServerResponse): void {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>graphdo — Signed In</title>
  <style>
    ${BASE_STYLE}
    .checkmark { font-size: 3rem; color: #107c10; margin-bottom: 16px; }
    h1 { font-size: 1.3rem; font-weight: 600; color: #107c10; margin-bottom: 12px; }
    .message { color: #666; font-size: 0.95rem; line-height: 1.5; }
    .countdown { color: #999; margin-top: 16px; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="checkmark">&#10003;</div>
      <h1>Authentication successful</h1>
      <p class="message">You can close this window and return to your AI assistant.</p>
      <p class="countdown">Closing in <span id="countdown">5</span>s&hellip;</p>
    </div>
  </div>
  <script>
    let remaining = 5;
    const el = document.getElementById('countdown');
    const tick = setInterval(() => {
      remaining--;
      el.textContent = String(remaining);
      if (remaining <= 0) { clearInterval(tick); window.close(); }
    }, 1000);
  </script>
</body>
</html>`;

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function serveErrorPage(res: ServerResponse, errorMessage: string): void {
  const safeMessage = errorMessage
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>graphdo — Sign In Failed</title>
  <style>
    ${BASE_STYLE}
    .icon { font-size: 3rem; color: #d13438; margin-bottom: 16px; }
    h1 { font-size: 1.3rem; font-weight: 600; color: #d13438; margin-bottom: 12px; }
    .message { color: #666; font-size: 0.95rem; line-height: 1.5; }
    .error-detail { margin-top: 16px; padding: 12px; background: #fef0f0; border-radius: 6px; font-size: 0.85rem; color: #a4262c; word-break: break-word; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="icon">&#10007;</div>
      <h1>Authentication failed</h1>
      <p class="message">Please close this window and try again.</p>
      <div class="error-detail">${safeMessage}</div>
    </div>
  </div>
</body>
</html>`;

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}
