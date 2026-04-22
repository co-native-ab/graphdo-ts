// Tests for the login flow descriptor and createMsalLoopback adapter.
//
// Login-specific assertions: landing page renders auth URL, redirect captures
// auth code, success page, error page, /cancel rejects with UserCancelledError.

import { describe, it, expect, afterEach } from "vitest";

import { createMsalLoopback } from "../../../src/browser/flows/login.js";
import { loginFlow } from "../../../src/browser/flows/login.js";
import { runBrowserFlow } from "../../../src/browser/server.js";
import type { FlowHandle } from "../../../src/browser/server.js";
import type { AuthorizeResponse } from "@azure/msal-node";
import { fetchCsrfToken, testSignal } from "../../helpers.js";

// Helper: start a login flow directly and wait for it.
async function startLoginFlow(authUrl?: string): Promise<{
  handle: FlowHandle<AuthorizeResponse>;
  uri: string;
}> {
  const currentAuthUrl = authUrl;
  const handle = await runBrowserFlow(
    loginFlow(() => currentAuthUrl, testSignal()),
    testSignal(),
  );
  return { handle, uri: handle.url };
}

// Helper: make an HTTP request.
async function request(
  url: string,
  opts?: { method?: string; redirect?: "manual" | "follow" },
): Promise<Response> {
  return fetch(url, {
    method: opts?.method ?? "GET",
    redirect: opts?.redirect ?? "manual",
  });
}

/** POST /cancel with a properly-formed CSRF body. */
async function postCancel(uri: string, csrfToken: string): Promise<Response> {
  return fetch(`${uri}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csrfToken }),
  });
}

describe("loginFlow descriptor", () => {
  let handle: FlowHandle<AuthorizeResponse> | undefined;

  afterEach(() => {
    handle?.close();
  });

  it("serves landing page at / with auth URL", async () => {
    const result = await startLoginFlow("https://login.microsoftonline.com/test");
    handle = result.handle;

    const res = await request(result.uri);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("graphdo");
    expect(html).toContain("Sign in");
    expect(html).toContain("Sign in with Microsoft");
  });

  it("shows error page when auth URL is not set", async () => {
    const result = await startLoginFlow(undefined);
    handle = result.handle;

    const res = await request(result.uri);
    const html = await res.text();
    expect(html).toContain("Authentication failed");
    expect(html).toContain("Authentication URL is not available");
  });

  it("embeds auth URL directly in sign-in button when set", async () => {
    const result = await startLoginFlow(
      "https://login.microsoftonline.com/test?client_id=abc&scope=openid",
    );
    handle = result.handle;

    const res = await request(result.uri);
    const html = await res.text();
    expect(html).toContain('class="sign-in-btn"');
    expect(html).toContain("cursor: pointer");
    expect(html).toContain("https://login.microsoftonline.com/test?client_id=abc&amp;scope=openid");
    expect(html).not.toContain('href="/redirect"');
  });

  it("captures auth code and redirects to /done", async () => {
    const result = await startLoginFlow("https://login.microsoftonline.com/test");
    handle = result.handle;

    const res = await request(`${result.uri}/?code=AUTH_CODE_123&state=STATE_456`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/done");

    const authResult = await handle.result;
    expect(authResult.code).toBe("AUTH_CODE_123");
    expect(authResult.state).toBe("STATE_456");
  });

  it("serves success page at /done", async () => {
    const result = await startLoginFlow("https://login.microsoftonline.com/test");
    handle = result.handle;

    // First trigger auth to put server in completed state
    await request(`${result.uri}/?code=test&state=test`, { redirect: "manual" });
    await handle.result;

    const res = await request(`${result.uri}/done`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Authentication successful");
    expect(html).toContain("close this window");
    expect(html).toContain("countdown");
  });

  it("handles error redirect from Microsoft", async () => {
    const result = await startLoginFlow("https://login.microsoftonline.com/test");
    handle = result.handle;

    const res = await request(
      `${result.uri}/?error=access_denied&error_description=User+cancelled+the+sign-in`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Authentication failed");
    expect(html).toContain("User cancelled the sign-in");

    const authResult = await handle.result;
    expect(authResult.error).toBe("access_denied");
    expect(authResult.error_description).toBe("User cancelled the sign-in");
  });

  it("escapes HTML in error messages", async () => {
    const result = await startLoginFlow("https://login.microsoftonline.com/test");
    handle = result.handle;

    const res = await request(
      `${result.uri}/?error=xss&error_description=${encodeURIComponent("<img src=x onerror=alert(1)>")}`,
    );
    const html = await res.text();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
    await handle.result;
  });

  it("returns 404 for unknown paths", async () => {
    const result = await startLoginFlow("https://login.microsoftonline.com/test");
    handle = result.handle;

    const res = await request(`${result.uri}/unknown`);
    expect(res.status).toBe(404);
  });

  it("preserves all auth response parameters", async () => {
    const result = await startLoginFlow("https://login.microsoftonline.com/test");
    handle = result.handle;

    await request(
      `${result.uri}/?code=CODE&state=STATE&client_info=INFO&cloud_instance_host_name=graph.microsoft.com`,
      { redirect: "manual" },
    );

    const authResult = await handle.result;
    expect(authResult.code).toBe("CODE");
    expect(authResult.state).toBe("STATE");
    expect(authResult.client_info).toBe("INFO");
    expect(authResult.cloud_instance_host_name).toBe("graph.microsoft.com");
  });

  it("rejects with UserCancelledError when /cancel is posted", async () => {
    const result = await startLoginFlow("https://login.microsoftonline.com/test");
    handle = result.handle;

    const csrfToken = await fetchCsrfToken(result.uri);
    const [res] = await Promise.all([
      postCancel(result.uri, csrfToken),
      expect(handle.result).rejects.toThrow("Login cancelled by user"),
    ]);
    expect(res.status).toBe(200);
  });

  it("landing page includes a Cancel button", async () => {
    const result = await startLoginFlow("https://login.microsoftonline.com/test");
    handle = result.handle;

    const res = await request(result.uri);
    const html = await res.text();
    expect(html).toContain('id="cancel-btn"');
    expect(html).toContain("Cancel");
  });

  it("does not require CSRF on the OAuth callback (cross-site GET from Microsoft)", async () => {
    const result = await startLoginFlow("https://login.microsoftonline.com/test");
    handle = result.handle;

    const res = await request(`${result.uri}/?code=AUTH_CODE&state=STATE`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/done");

    const authResult = await handle.result;
    expect(authResult.code).toBe("AUTH_CODE");
  });

  it("full login flow simulation", async () => {
    const state = { authUrl: undefined as string | undefined };
    const h = await runBrowserFlow(
      loginFlow(() => state.authUrl, testSignal()),
      testSignal(),
    );
    handle = h;
    const redirectUri = handle.url;

    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // Set auth URL
    const microsoftAuthUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=test&redirect_uri=${encodeURIComponent(redirectUri)}&scope=Mail.Send`;
    state.authUrl = microsoftAuthUrl;

    // User sees landing page with auth URL embedded directly
    const landingRes = await request(redirectUri);
    expect(landingRes.status).toBe(200);
    const landingHtml = await landingRes.text();
    expect(landingHtml).toContain("Sign in with Microsoft");
    expect(landingHtml).toContain("login.microsoftonline.com");
    expect(landingHtml).not.toContain('href="/redirect"');

    // Microsoft redirects back with auth code
    const callbackRes = await request(`${redirectUri}/?code=REAL_CODE&state=REAL_STATE`, {
      redirect: "manual",
    });
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get("location")).toBe("/done");

    // Browser follows redirect to /done
    const doneRes = await request(`${redirectUri}/done`);
    expect(doneRes.status).toBe(200);
    const doneHtml = await doneRes.text();
    expect(doneHtml).toContain("Authentication successful");

    // listenForAuthCode resolves
    const authResult = await handle.result;
    expect(authResult.code).toBe("REAL_CODE");
    expect(authResult.state).toBe("REAL_STATE");
  });
});

// ---------------------------------------------------------------------------
// createMsalLoopback adapter
// ---------------------------------------------------------------------------

describe("createMsalLoopback", () => {
  it("throws when getting redirect URI before server starts", () => {
    const loopback = createMsalLoopback(() => Promise.resolve(), testSignal());
    expect(() => loopback.getRedirectUri()).toThrow("No loopback server exists");
  });

  it("closeServer is idempotent", () => {
    const loopback = createMsalLoopback(() => Promise.resolve(), testSignal());
    // Should not throw even when no server exists
    loopback.closeServer();
    loopback.closeServer();
  });

  it("starts server and returns redirect URI with localhost", async () => {
    const loopback = createMsalLoopback(() => Promise.resolve(), testSignal()) as ReturnType<
      typeof createMsalLoopback
    > & { waitForReady(): Promise<void> };

    const authPromise = loopback.listenForAuthCode();
    // Wait for server to start (MSAL does this internally via its flow)
    await loopback.waitForReady();
    const uri = loopback.getRedirectUri();
    expect(uri).toMatch(/^http:\/\/localhost:\d+$/);

    // Simulate auth code - use the actual server URL (127.0.0.1) not the redirect URI (localhost)
    const port = new URL(uri).port;
    await fetch(`http://127.0.0.1:${port}/?code=test&state=test`, { redirect: "manual" });
    const result = await authPromise;
    expect(result.code).toBe("test");

    loopback.closeServer();
  });
});
