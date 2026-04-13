// Tests for the custom MSAL loopback client (login landing page).

import { describe, it, expect, afterEach } from "vitest";

import { LoginLoopbackClient } from "../src/loopback.js";

// Helper: start the loopback client and wait for it to be ready.
async function startClient(): Promise<{
  client: LoginLoopbackClient;
  uri: string;
  authPromise: Promise<import("@azure/msal-node").AuthorizeResponse>;
}> {
  const client = new LoginLoopbackClient();
  const authPromise = client.listenForAuthCode();
  await client.waitForReady();
  const uri = client.getRedirectUri();
  return { client, uri, authPromise };
}

// Helper: make an HTTP request to the loopback server.
async function request(
  url: string,
  opts?: { method?: string; redirect?: "manual" | "follow" },
): Promise<Response> {
  return fetch(url, {
    method: opts?.method ?? "GET",
    redirect: opts?.redirect ?? "manual",
  });
}

describe("LoginLoopbackClient", () => {
  let client: LoginLoopbackClient | undefined;

  afterEach(() => {
    client?.closeServer();
  });

  it("starts server and returns redirect URI", async () => {
    const { client: c, uri, authPromise } = await startClient();
    client = c;

    expect(uri).toMatch(/^http:\/\/localhost:\d+$/);

    // Simulate an auth code to resolve the promise
    await fetch(`${uri}/?code=test&state=test`, { redirect: "manual" });
    const result = await authPromise;
    expect(result.code).toBe("test");
    expect(result.state).toBe("test");
  });

  it("serves landing page at /", async () => {
    const { client: c, uri } = await startClient();
    client = c;

    c.setAuthUrl("https://login.microsoftonline.com/test");

    const res = await request(uri);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("graphdo");
    expect(html).toContain("Sign in");
    expect(html).toContain("Sign in with Microsoft");
  });

  it("shows error page when auth URL is not set", async () => {
    const { client: c, uri } = await startClient();
    client = c;

    const res = await request(uri);
    const html = await res.text();

    expect(html).toContain("Authentication failed");
    expect(html).toContain("Authentication URL is not available");
  });

  it("embeds auth URL directly in sign-in button when set", async () => {
    const { client: c, uri } = await startClient();
    client = c;

    c.setAuthUrl("https://login.microsoftonline.com/test?client_id=abc&scope=openid");

    const res = await request(uri);
    const html = await res.text();

    expect(html).toContain('class="sign-in-btn"');
    expect(html).toContain("cursor: pointer");
    // Auth URL is embedded directly in the href (& escaped as &amp;)
    expect(html).toContain("https://login.microsoftonline.com/test?client_id=abc&amp;scope=openid");
    // Should NOT link to /redirect
    expect(html).not.toContain('href="/redirect"');
  });

  it("captures auth code and redirects to /done", async () => {
    const { client: c, uri, authPromise } = await startClient();
    client = c;

    const res = await request(`${uri}/?code=AUTH_CODE_123&state=STATE_456`, {
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/done");

    const result = await authPromise;
    expect(result.code).toBe("AUTH_CODE_123");
    expect(result.state).toBe("STATE_456");
  });

  it("serves success page at /done", async () => {
    const { client: c, uri, authPromise } = await startClient();
    client = c;

    // First trigger auth to put server in completed state
    await request(`${uri}/?code=test&state=test`, { redirect: "manual" });
    await authPromise;

    const res = await request(`${uri}/done`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("Authentication successful");
    expect(html).toContain("close this window");
    expect(html).toContain("countdown");
  });

  it("handles error redirect from Microsoft", async () => {
    const { client: c, uri, authPromise } = await startClient();
    client = c;

    const res = await request(
      `${uri}/?error=access_denied&error_description=User+cancelled+the+sign-in`,
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Authentication failed");
    expect(html).toContain("User cancelled the sign-in");

    const result = await authPromise;
    expect(result.error).toBe("access_denied");
    expect(result.error_description).toBe("User cancelled the sign-in");
  });

  it("escapes HTML in error messages", async () => {
    const { client: c, uri, authPromise } = await startClient();
    client = c;

    const res = await request(
      `${uri}/?error=xss&error_description=${encodeURIComponent("<img src=x onerror=alert(1)>")}`,
    );
    const html = await res.text();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");

    await authPromise;
  });

  it("returns 404 for unknown paths", async () => {
    const { client: c, uri } = await startClient();
    client = c;

    const res = await request(`${uri}/unknown`);

    expect(res.status).toBe(404);
  });

  it("throws when server already exists", async () => {
    const { client: c } = await startClient();
    client = c;

    await expect(c.listenForAuthCode()).rejects.toThrow("Loopback server already exists");
  });

  it("throws when getting redirect URI before server starts", () => {
    const c = new LoginLoopbackClient();
    client = c;

    expect(() => c.getRedirectUri()).toThrow("No loopback server exists");
  });

  it("closeServer is idempotent", () => {
    const c = new LoginLoopbackClient();
    client = c;
    // Should not throw even when no server exists
    c.closeServer();
    c.closeServer();
  });

  it("preserves all auth response parameters", async () => {
    const { client: c, uri, authPromise } = await startClient();
    client = c;

    await request(
      `${uri}/?code=CODE&state=STATE&client_info=INFO&cloud_instance_host_name=graph.microsoft.com`,
      { redirect: "manual" },
    );

    const result = await authPromise;
    expect(result.code).toBe("CODE");
    expect(result.state).toBe("STATE");
    expect(result.client_info).toBe("INFO");
    expect(result.cloud_instance_host_name).toBe("graph.microsoft.com");
  });

  it("full login flow simulation", async () => {
    // Simulates the complete MSAL flow
    const { client: c, uri: redirectUri, authPromise } = await startClient();
    client = c;

    expect(redirectUri).toMatch(/^http:\/\/localhost:\d+$/);

    // Step 3: MSAL calls openBrowser(authUrl) - we intercept and set auth URL
    const microsoftAuthUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=test&redirect_uri=${encodeURIComponent(redirectUri)}&scope=Mail.Send`;
    c.setAuthUrl(microsoftAuthUrl);

    // Step 4: User sees landing page with auth URL embedded directly
    const landingRes = await request(redirectUri);
    expect(landingRes.status).toBe(200);
    const landingHtml = await landingRes.text();
    expect(landingHtml).toContain("Sign in with Microsoft");
    // Auth URL should be embedded directly in the href (not via /redirect)
    expect(landingHtml).toContain("login.microsoftonline.com");
    expect(landingHtml).not.toContain('href="/redirect"');

    // Step 5: User clicks "Sign in with Microsoft" → navigates directly to Microsoft
    // (In a real browser, clicking the link opens the auth URL directly.
    //  Here we simulate Microsoft redirecting back with the auth code.)

    // Step 6: Microsoft redirects back with auth code
    const callbackRes = await request(`${redirectUri}/?code=REAL_CODE&state=REAL_STATE`, {
      redirect: "manual",
    });
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get("location")).toBe("/done");

    // Step 7: Browser follows redirect to /done
    const doneRes = await request(`${redirectUri}/done`);
    expect(doneRes.status).toBe(200);
    const doneHtml = await doneRes.text();
    expect(doneHtml).toContain("Authentication successful");

    // Step 8: listenForAuthCode resolves
    const result = await authPromise;
    expect(result.code).toBe("REAL_CODE");
    expect(result.state).toBe("REAL_STATE");
  });

  it("rejects with UserCancelledError when /cancel is posted", async () => {
    const { client: c, uri, authPromise } = await startClient();
    client = c;

    const [res] = await Promise.all([
      fetch(`${uri}/cancel`, { method: "POST" }),
      expect(authPromise).rejects.toThrow("Login cancelled by user"),
    ]);
    expect(res.status).toBe(200);
  });

  it("landing page includes a Cancel button", async () => {
    const { client: c, uri } = await startClient();
    client = c;

    c.setAuthUrl("https://login.microsoftonline.com/test");

    const res = await request(uri);
    const html = await res.text();

    expect(html).toContain('id="cancel-btn"');
    expect(html).toContain("Cancel");
  });
});
