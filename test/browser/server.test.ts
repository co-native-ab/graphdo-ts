// Tests for the runBrowserFlow primitive.
//
// Exercises the primitive directly using a trivial in-test descriptor,
// covering server lifecycle, headers, CSRF, abort, timeout, and helpers.

import { describe, it, expect } from "vitest";
import { request as httpRequest } from "node:http";

import { z } from "zod";

import {
  runBrowserFlow,
  serveHtml,
  readJsonWithCsrf,
  respondAndClose,
} from "../../src/browser/server.js";
import type { BrowserFlow } from "../../src/browser/server.js";
import { fetchCsrfToken, testSignal } from "../helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** POST a JSON body to a URL. */
async function postJson(url: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Issue a raw HTTP POST via `node:http` so the test can set the `Host`
 * header (forbidden via the fetch API).
 */
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

/** A trivial flow descriptor for testing. */
function testFlow(overrides: Partial<BrowserFlow<string>> = {}): BrowserFlow<string> {
  return {
    name: "test",
    routes: (ctx) => ({
      "GET /": (_req, res, nonce) => {
        serveHtml(
          res,
          `<html><head><meta name="csrf-token" content="${ctx.csrfToken}"></head><body nonce="${nonce}">OK</body></html>`,
        );
      },
      "POST /complete": (req, res) => {
        const schema = z.object({ value: z.string(), csrfToken: z.string() });
        readJsonWithCsrf(req, res, ctx, schema, (data) => {
          respondAndClose(res, ctx.server, { ok: true });
          ctx.resolve(data.value);
        });
      },
      "POST /fail": (req, res) => {
        const schema = z.object({ csrfToken: z.string() });
        readJsonWithCsrf(req, res, ctx, schema, () => {
          ctx.reject(new Error("flow failed"));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          ctx.server.close();
        });
      },
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

describe("runBrowserFlow", () => {
  it("starts on 127.0.0.1 with random port; handle.url is http://127.0.0.1:<port>", async () => {
    const handle = await runBrowserFlow(testFlow(), testSignal());
    try {
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const port = new URL(handle.url).port;
      expect(Number(port)).toBeGreaterThan(0);
    } finally {
      handle.close();
    }
  });

  it("returns 404 for unknown routes", async () => {
    const handle = await runBrowserFlow(testFlow(), testSignal());
    try {
      const res = await fetch(`${handle.url}/unknown`);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("Not Found");
    } finally {
      handle.close();
    }
  });

  it("sets CSP/Cache-Control/Pragma headers on every response with fresh nonce per request", async () => {
    const handle = await runBrowserFlow(testFlow(), testSignal());
    try {
      const res1 = await fetch(handle.url);
      const csp1 = res1.headers.get("content-security-policy") ?? "";
      expect(res1.headers.get("cache-control")).toBe("no-store, no-cache, must-revalidate");
      expect(res1.headers.get("pragma")).toBe("no-cache");
      expect(csp1).toContain("frame-ancestors 'none'");
      expect(csp1).toContain("base-uri 'none'");
      expect(csp1).toContain("form-action 'self'");
      expect(csp1).not.toContain("'unsafe-inline'");
      expect(csp1).toMatch(/script-src 'nonce-[0-9a-f]{64}'/);
      expect(csp1).toMatch(/style-src 'nonce-[0-9a-f]{64}'/);

      // A second request must mint a fresh nonce.
      const res2 = await fetch(handle.url);
      const csp2 = res2.headers.get("content-security-policy") ?? "";
      const nonce1 = /'nonce-([0-9a-f]{64})'/.exec(csp1)?.[1];
      const nonce2 = /'nonce-([0-9a-f]{64})'/.exec(csp2)?.[1];
      expect(nonce1).toBeDefined();
      expect(nonce2).toBeDefined();
      expect(nonce1).not.toBe(nonce2);
    } finally {
      handle.close();
    }
  });

  it("abort signal closes server and rejects result", async () => {
    const controller = new AbortController();
    const handle = await runBrowserFlow(testFlow(), controller.signal);

    controller.abort(new Error("test abort"));

    await expect(handle.result).rejects.toThrow("test abort");
  });

  it("timeout closes server and rejects with timeout message", async () => {
    const handle = await runBrowserFlow(testFlow({ timeoutMs: 50, name: "picker" }), testSignal());

    await expect(handle.result).rejects.toThrow("timed out");
  });

  it("handle.close() is idempotent", async () => {
    const handle = await runBrowserFlow(testFlow(), testSignal());
    handle.close();
    handle.close(); // should not throw
  });

  it("rejects immediately if signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already aborted"));

    await expect(runBrowserFlow(testFlow(), controller.signal)).rejects.toThrow("already aborted");
  });
});

// ---------------------------------------------------------------------------
// readJsonWithCsrf
// ---------------------------------------------------------------------------

describe("readJsonWithCsrf", () => {
  it("rejects with 415 for wrong content-type", async () => {
    const handle = await runBrowserFlow(testFlow(), testSignal());
    try {
      const csrfToken = await fetchCsrfToken(handle.url);
      const res = await fetch(`${handle.url}/complete`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ value: "hello", csrfToken }),
      });
      expect(res.status).toBe(415);
    } finally {
      handle.close();
    }
  });

  it("rejects with 413 for body >1 MB", async () => {
    const handle = await runBrowserFlow(testFlow(), testSignal());
    try {
      const oversized = "x".repeat(1_048_577);
      const res = await fetch(`${handle.url}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: oversized,
      });
      expect(res.status).toBe(413);
      expect(await res.text()).toMatch(/Payload Too Large/);
    } finally {
      handle.close();
    }
  });

  it("rejects with 400 for malformed JSON", async () => {
    const handle = await runBrowserFlow(testFlow(), testSignal());
    try {
      const res = await fetch(`${handle.url}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toMatch(/Invalid request body/);
    } finally {
      handle.close();
    }
  });

  it("rejects with 400 for schema mismatch (missing required fields)", async () => {
    const handle = await runBrowserFlow(testFlow(), testSignal());
    try {
      // Schema expects { value: string, csrfToken: string }
      // Send only csrfToken — value is missing → schema fails → 400
      const csrfToken = await fetchCsrfToken(handle.url);
      const res = await postJson(`${handle.url}/complete`, { csrfToken });
      expect(res.status).toBe(400);
    } finally {
      handle.close();
    }
  });

  it("rejects with 400 for missing csrfToken (schema validation)", async () => {
    const handle = await runBrowserFlow(testFlow(), testSignal());
    try {
      // Schema requires csrfToken, but we don't send it
      const res = await postJson(`${handle.url}/complete`, { value: "hello" });
      expect(res.status).toBe(400);
    } finally {
      handle.close();
    }
  });

  it("rejects with 403 for bad CSRF token", async () => {
    const handle = await runBrowserFlow(testFlow(), testSignal());
    try {
      const res = await postJson(`${handle.url}/complete`, {
        value: "hello",
        csrfToken: "0".repeat(64),
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toMatch(/CSRF/);
    } finally {
      handle.close();
    }
  });

  it("rejects with 403 for wrong-length CSRF token", async () => {
    const handle = await runBrowserFlow(testFlow(), testSignal());
    try {
      const res = await postJson(`${handle.url}/complete`, {
        value: "hello",
        csrfToken: "short",
      });
      expect(res.status).toBe(403);
    } finally {
      handle.close();
    }
  });

  it("invokes onValid on success", async () => {
    const handle = await runBrowserFlow(testFlow(), testSignal());
    const csrfToken = await fetchCsrfToken(handle.url);
    const res = await postJson(`${handle.url}/complete`, {
      value: "hello",
      csrfToken,
    });
    expect(res.status).toBe(200);
    const result = await handle.result;
    expect(result).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// respondAndClose
// ---------------------------------------------------------------------------

describe("respondAndClose", () => {
  it("flushes then closes after delay", async () => {
    const handle = await runBrowserFlow(testFlow(), testSignal());
    const csrfToken = await fetchCsrfToken(handle.url);
    const res = await postJson(`${handle.url}/complete`, {
      value: "done",
      csrfToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // result should resolve
    const result = await handle.result;
    expect(result).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Hardening (Host pin, Origin pin, Sec-Fetch-Site pin, Content-Type pin)
// These were previously tested in both loopback.test.ts and picker.test.ts.
// Now tested once here against the primitive.
// ---------------------------------------------------------------------------

describe("runBrowserFlow: §5.4 hardening", () => {
  it("rejects POST when Host header is not the loopback literal", async () => {
    const handle = await runBrowserFlow(testFlow(), testSignal());
    try {
      const csrfToken = await fetchCsrfToken(handle.url);
      const res = await rawHttpPost(`${handle.url}/complete`, {
        hostHeader: "evil.example:80",
        body: JSON.stringify({ value: "hello", csrfToken }),
      });
      expect(res.status).toBe(403);
      expect(res.body).toMatch(/Host/);
    } finally {
      handle.close();
    }
  });

  it("accepts POST when Host is 127.0.0.1:<port>", async () => {
    const handle = await runBrowserFlow(testFlow(), testSignal());
    const port = new URL(handle.url).port;
    const csrfToken = await fetchCsrfToken(handle.url);
    const res = await rawHttpPost(`${handle.url}/complete`, {
      hostHeader: `127.0.0.1:${port}`,
      body: JSON.stringify({ value: "hello", csrfToken }),
    });
    expect(res.status).toBe(200);
    await handle.result;
  });

  it("accepts POST when Host is localhost:<port>", async () => {
    const handle = await runBrowserFlow(testFlow(), testSignal());
    const port = new URL(handle.url).port;
    const csrfToken = await fetchCsrfToken(handle.url);
    const res = await rawHttpPost(`${handle.url}/complete`, {
      hostHeader: `localhost:${port}`,
      body: JSON.stringify({ value: "hello", csrfToken }),
    });
    expect(res.status).toBe(200);
    await handle.result;
  });

  it("rejects POST when Origin is present and not loopback literal", async () => {
    const handle = await runBrowserFlow(testFlow(), testSignal());
    try {
      const csrfToken = await fetchCsrfToken(handle.url);
      const res = await fetch(`${handle.url}/complete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({ value: "hello", csrfToken }),
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toMatch(/Origin/);
    } finally {
      handle.close();
    }
  });

  it("accepts POST when Origin matches the loopback literal", async () => {
    const handle = await runBrowserFlow(testFlow(), testSignal());
    const host = new URL(handle.url).host;
    const csrfToken = await fetchCsrfToken(handle.url);
    const res = await fetch(`${handle.url}/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: `http://${host}`,
      },
      body: JSON.stringify({ value: "hello", csrfToken }),
    });
    expect(res.status).toBe(200);
    await handle.result;
  });

  it("rejects POST when Sec-Fetch-Site is present and not 'same-origin'", async () => {
    const handle = await runBrowserFlow(testFlow(), testSignal());
    try {
      const csrfToken = await fetchCsrfToken(handle.url);
      const res = await fetch(`${handle.url}/complete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "cross-site",
        },
        body: JSON.stringify({ value: "hello", csrfToken }),
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toMatch(/Sec-Fetch-Site/);
    } finally {
      handle.close();
    }
  });

  it("rejects POST when Content-Type is not application/json", async () => {
    const handle = await runBrowserFlow(testFlow(), testSignal());
    try {
      const csrfToken = await fetchCsrfToken(handle.url);
      const res = await fetch(`${handle.url}/complete`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ value: "hello", csrfToken }),
      });
      expect(res.status).toBe(415);
    } finally {
      handle.close();
    }
  });

  it("CSP header embeds CSRF meta and nonce on inline elements", async () => {
    const handle = await runBrowserFlow(testFlow(), testSignal());
    try {
      const html = await (await fetch(handle.url)).text();
      expect(html).toMatch(/<meta name="csrf-token" content="[0-9a-f]{64}">/);
    } finally {
      handle.close();
    }
  });

  it("rejects POST with payload larger than 1 MiB cap (413)", async () => {
    const handle = await runBrowserFlow(testFlow(), testSignal());
    try {
      const oversized = JSON.stringify({ filler: "x".repeat(1_048_577) });
      const res = await fetch(`${handle.url}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: oversized,
      });
      expect(res.status).toBe(413);
      expect(await res.text()).toMatch(/Payload Too Large/);
    } finally {
      handle.close();
    }
  });
});
