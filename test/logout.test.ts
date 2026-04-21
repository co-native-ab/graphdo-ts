// Tests for the logout loopback server hardening (CSRF/CSP parity with the
// login loopback). Mirrors the §5.4 hardening tests in `test/loopback.test.ts`.
//
// Drives the in-process logout flow via `MsalAuthenticator.logout()` (which
// is the only public entry point to `showLogoutPage`). The `openBrowser` mock
// gives the test a handle on the loopback URL so it can probe the server
// directly before completing the flow.

import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { request as httpRequest } from "node:http";

import { MsalAuthenticator } from "../src/auth.js";
import { UserCancelledError } from "../src/errors.js";
import { fetchCsrfToken, testSignal } from "./helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `graphdo-logout-test-${crypto.randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "msal_cache.json"), "{}");
  await fs.writeFile(path.join(dir, "account.json"), "{}");
  return dir;
}

/**
 * Waits until `openBrowser` has been called and returns the loopback URL it
 * was invoked with. Polls because the listener resolves asynchronously.
 */
async function waitForLoopbackUrl(
  spy: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>,
  timeoutMs = 2000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const call = spy.mock.calls[0];
    if (call && typeof call[0] === "string") return call[0];
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("openBrowser was never called");
}

/**
 * Start an in-process logout flow and return the loopback URL plus a
 * pre-armed `logoutPromise`. A no-op `.catch(() => undefined)` is attached
 * eagerly so a late-attached cleanup `.catch()` never trips Node's
 * unhandled-rejection detector.
 */
async function startLogout(dir: string): Promise<{ uri: string; logoutPromise: Promise<void> }> {
  const openBrowser = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
  const auth = new MsalAuthenticator("client-id", "common", dir, openBrowser);
  const logoutPromise = auth.logout(testSignal());
  // Pre-arm: a separate handler ensures the rejection is always "handled"
  // even if the test's own .catch() arrives a microtask later.
  void logoutPromise.catch(() => undefined);
  const uri = await waitForLoopbackUrl(openBrowser);
  return { uri, logoutPromise };
}

/** POST /confirm with a properly-formed CSRF body. */
async function postConfirm(uri: string, csrfToken: string): Promise<Response> {
  return fetch(`${uri}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csrfToken }),
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

/** Raw POST with a controllable Host header (used by the DNS-rebinding tests). */
function rawHttpPost(
  url: string,
  opts: { hostHeader: string; body: string; contentType?: string },
): Promise<{ status: number; body: string }> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          Host: opts.hostHeader,
          "Content-Type": opts.contentType ?? "application/json",
          "Content-Length": Buffer.byteLength(opts.body).toString(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    req.write(opts.body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("logout loopback server (§5.4 hardening parity)", () => {
  it("CSP header forbids unsafe-inline and uses a per-request nonce", async () => {
    const dir = await makeTempDir();
    const { uri, logoutPromise } = await startLogout(dir);

    try {
      const res = await fetch(uri);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).not.toContain("'unsafe-inline'");
      expect(csp).toMatch(/script-src 'nonce-[0-9a-f]{64}'/);
      expect(csp).toMatch(/style-src 'nonce-[0-9a-f]{64}'/);
    } finally {
      const csrfToken = await fetchCsrfToken(uri);
      await postCancel(uri, csrfToken).catch(() => undefined);
      await logoutPromise.catch(() => undefined);
    }
  });

  it("page embeds a CSRF meta tag and applies the nonce to inline <script>/<style>", async () => {
    const dir = await makeTempDir();
    const { uri, logoutPromise } = await startLogout(dir);

    try {
      const html = await (await fetch(uri)).text();
      expect(html).toMatch(/<meta name="csrf-token" content="[0-9a-f]{64}">/);
      expect(html).toMatch(/<script nonce="[0-9a-f]{64}">/);
      expect(html).toMatch(/<style nonce="[0-9a-f]{64}">/);
    } finally {
      const csrfToken = await fetchCsrfToken(uri);
      await postCancel(uri, csrfToken).catch(() => undefined);
      await logoutPromise.catch(() => undefined);
    }
  });

  it("rejects POST /confirm without a CSRF token (403)", async () => {
    const dir = await makeTempDir();
    const { uri, logoutPromise } = await startLogout(dir);

    try {
      const res = await fetch(`${uri}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(403);
    } finally {
      const csrfToken = await fetchCsrfToken(uri);
      await postCancel(uri, csrfToken).catch(() => undefined);
      await logoutPromise.catch(() => undefined);
    }
  });

  it("rejects POST /cancel without a CSRF token (403)", async () => {
    const dir = await makeTempDir();
    const { uri, logoutPromise } = await startLogout(dir);

    try {
      const res = await fetch(`${uri}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(403);
    } finally {
      const csrfToken = await fetchCsrfToken(uri);
      await postCancel(uri, csrfToken).catch(() => undefined);
      await logoutPromise.catch(() => undefined);
    }
  });

  it("rejects POST /confirm with the wrong Content-Type (415)", async () => {
    const dir = await makeTempDir();
    const { uri, logoutPromise } = await startLogout(dir);

    try {
      const csrfToken = await fetchCsrfToken(uri);
      const res = await fetch(`${uri}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ csrfToken }),
      });
      expect(res.status).toBe(415);
    } finally {
      const csrfToken = await fetchCsrfToken(uri);
      await postCancel(uri, csrfToken).catch(() => undefined);
      await logoutPromise.catch(() => undefined);
    }
  });

  it("rejects POST /confirm when Host is not loopback (defends DNS rebinding)", async () => {
    const dir = await makeTempDir();
    const { uri, logoutPromise } = await startLogout(dir);

    try {
      const csrfToken = await fetchCsrfToken(uri);
      const res = await rawHttpPost(`${uri}/confirm`, {
        hostHeader: "evil.example:80",
        body: JSON.stringify({ csrfToken }),
      });
      expect(res.status).toBe(403);
      expect(res.body).toMatch(/Host/);
    } finally {
      const csrfToken = await fetchCsrfToken(uri);
      await postCancel(uri, csrfToken).catch(() => undefined);
      await logoutPromise.catch(() => undefined);
    }
  });

  it("accepts POST /confirm when Host is `localhost:<port>`", async () => {
    const dir = await makeTempDir();
    const { uri, logoutPromise } = await startLogout(dir);

    const port = new URL(uri).port;
    const csrfToken = await fetchCsrfToken(uri);

    const res = await rawHttpPost(`${uri}/confirm`, {
      hostHeader: `localhost:${port}`,
      body: JSON.stringify({ csrfToken }),
    });
    expect(res.status).toBe(200);

    // The successful confirm should have resolved the logout flow and
    // cleared the cache files.
    await expect(logoutPromise).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, "msal_cache.json"))).rejects.toThrow();
  });

  it("accepts POST /confirm when Host is `127.0.0.1:<port>`", async () => {
    const dir = await makeTempDir();
    const { uri, logoutPromise } = await startLogout(dir);

    const port = new URL(uri).port;
    const csrfToken = await fetchCsrfToken(uri);

    const res = await rawHttpPost(`${uri}/confirm`, {
      hostHeader: `127.0.0.1:${port}`,
      body: JSON.stringify({ csrfToken }),
    });
    expect(res.status).toBe(200);

    await expect(logoutPromise).resolves.toBeUndefined();
  });

  it("happy-path: valid CSRF + JSON to /confirm clears the cache files", async () => {
    const dir = await makeTempDir();
    const { uri, logoutPromise } = await startLogout(dir);
    const csrfToken = await fetchCsrfToken(uri);

    const res = await postConfirm(uri, csrfToken);
    expect(res.status).toBe(200);
    await expect(logoutPromise).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, "msal_cache.json"))).rejects.toThrow();
    await expect(fs.access(path.join(dir, "account.json"))).rejects.toThrow();
  });

  it("happy-path: valid CSRF + JSON to /cancel rejects with UserCancelledError and preserves cache", async () => {
    const dir = await makeTempDir();
    const { uri, logoutPromise } = await startLogout(dir);
    const csrfToken = await fetchCsrfToken(uri);

    const [res] = await Promise.all([
      postCancel(uri, csrfToken),
      expect(logoutPromise).rejects.toThrow(UserCancelledError),
    ]);
    expect(res.status).toBe(200);
    await expect(fs.access(path.join(dir, "msal_cache.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, "account.json"))).resolves.toBeUndefined();
  });

  it("returns 404 for unknown paths", async () => {
    const dir = await makeTempDir();
    const { uri, logoutPromise } = await startLogout(dir);

    try {
      const res = await fetch(`${uri}/unknown`);
      expect(res.status).toBe(404);
    } finally {
      const csrfToken = await fetchCsrfToken(uri);
      await postCancel(uri, csrfToken).catch(() => undefined);
      await logoutPromise.catch(() => undefined);
    }
  });

  // ---------------------------------------------------------------------------
  // Error path coverage
  // ---------------------------------------------------------------------------

  it("logout clears tokens silently when openBrowser fails", async () => {
    const dir = await makeTempDir();
    const openBrowserError = new Error("xdg-open failed");
    const openBrowser = vi
      .fn<(url: string) => Promise<void>>()
      .mockRejectedValueOnce(openBrowserError);
    const auth = new MsalAuthenticator("client-id", "common", dir, openBrowser);
    const logoutPromise = auth.logout(testSignal());

    // logout() catches openBrowser errors and clears tokens silently
    // so it should resolve (not reject)
    await expect(logoutPromise).resolves.toBeUndefined();

    // Verify tokens were cleared
    await expect(fs.access(path.join(dir, "msal_cache.json"))).rejects.toThrow();
  });

  it("logout clears tokens silently when server binding fails", async () => {
    const dir = await makeTempDir();
    const openBrowser = vi
      .fn<(url: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Server binding error"));
    const auth = new MsalAuthenticator("client-id", "common", dir, openBrowser);

    // This tests the path where the server cannot bind to a port
    // The showLogoutPage rejects, and MsalAuthenticator.logout catches it
    const logoutPromise = auth.logout(testSignal());
    await expect(logoutPromise).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, "msal_cache.json"))).rejects.toThrow();
  });

  it("logout clears tokens when caller aborts the signal", async () => {
    const dir = await makeTempDir();
    const controller = new AbortController();
    const openBrowser = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
    const auth = new MsalAuthenticator("client-id", "common", dir, openBrowser);

    const logoutPromise = auth.logout(controller.signal);
    void logoutPromise.catch(() => undefined);

    // Wait for openBrowser to be called
    await waitForLoopbackUrl(openBrowser, 2000);

    // Abort the signal
    controller.abort(new Error("Test abort"));

    // logout's clearCacheFiles checks signal.aborted and throws signal.reason
    await expect(logoutPromise).rejects.toThrow("Test abort");
  });
});
