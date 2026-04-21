// Tests for the generic browser picker.
//
// Verifies the full flow: start picker → fetch HTML → POST selection → callback fired.
// Also exercises the §5.4 loopback hardening (CSRF token, Host pin, Origin
// pin, Sec-Fetch-Site pin, Content-Type pin, hardened CSP header).

import { describe, it, expect, vi } from "vitest";
import { request as httpRequest } from "node:http";

import { startBrowserPicker } from "../src/picker.js";
import type { PickerOption } from "../src/picker.js";
import { fetchCsrfToken, testSignal } from "./helpers.js";

const sampleOptions: PickerOption[] = [
  { id: "opt-1", label: "Option A" },
  { id: "opt-2", label: "Option B" },
];

interface PostJsonInit {
  csrfToken: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  hostUrl?: string;
}

/** POST a JSON body with a CSRF token included. */
async function postJson(url: string, init: PostJsonInit): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    body: JSON.stringify({ ...init.body, csrfToken: init.csrfToken }),
  });
}

/**
 * Issue a raw HTTP POST via `node:http` so the test can set the `Host`
 * header (forbidden via the fetch API). Used by the Host-pin tests.
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

describe("browser picker", () => {
  it("serves HTML page with options", async () => {
    const onSelect = vi
      .fn<(opt: PickerOption, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const handle = await startBrowserPicker(
      {
        title: "Pick Something",
        subtitle: "Choose wisely:",
        options: sampleOptions,
        onSelect,
        timeoutMs: 5000,
      },
      testSignal(),
    );

    try {
      const response = await fetch(handle.url);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");

      const html = await response.text();
      expect(html).toContain("Pick Something");
      expect(html).toContain("Choose wisely:");
      expect(html).toContain("Option A");
      expect(html).toContain("Option B");
      expect(html).toContain("opt-1");
      expect(html).toContain("opt-2");
    } finally {
      const csrfToken = await fetchCsrfToken(handle.url);
      await postJson(`${handle.url}/select`, {
        csrfToken,
        body: { id: "opt-1", label: "Option A" },
      });
      await handle.waitForSelection;
    }
  });

  it("calls onSelect and resolves with the selected option", async () => {
    const onSelect = vi
      .fn<(opt: PickerOption, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const handle = await startBrowserPicker(
      {
        title: "Test",
        subtitle: "Test",
        options: sampleOptions,
        onSelect,
        timeoutMs: 5000,
      },
      testSignal(),
    );

    const csrfToken = await fetchCsrfToken(handle.url);
    const response = await postJson(`${handle.url}/select`, {
      csrfToken,
      body: { id: "opt-2", label: "Option B" },
    });
    expect(response.status).toBe(200);

    const result = await handle.waitForSelection;
    expect(result.selected).toEqual({ id: "opt-2", label: "Option B" });
    expect(onSelect).toHaveBeenCalledWith(
      { id: "opt-2", label: "Option B" },
      expect.any(AbortSignal),
    );
  });

  it("rejects invalid selection", async () => {
    const onSelect = vi
      .fn<(opt: PickerOption, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const handle = await startBrowserPicker(
      {
        title: "Test",
        subtitle: "Test",
        options: sampleOptions,
        onSelect,
        timeoutMs: 5000,
      },
      testSignal(),
    );

    const csrfToken = await fetchCsrfToken(handle.url);
    const response = await postJson(`${handle.url}/select`, {
      csrfToken,
      body: { id: "nonexistent", label: "Fake" },
    });
    expect(response.status).toBe(400);
    expect(onSelect).not.toHaveBeenCalled();

    // Clean up - post a valid selection
    await postJson(`${handle.url}/select`, {
      csrfToken,
      body: { id: "opt-1", label: "Option A" },
    });
    await handle.waitForSelection;
  });

  it("returns 404 for unknown paths", async () => {
    const onSelect = vi
      .fn<(opt: PickerOption, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const handle = await startBrowserPicker(
      {
        title: "Test",
        subtitle: "Test",
        options: sampleOptions,
        onSelect,
        timeoutMs: 5000,
      },
      testSignal(),
    );

    const response = await fetch(`${handle.url}/unknown`);
    expect(response.status).toBe(404);

    // Clean up
    const csrfToken = await fetchCsrfToken(handle.url);
    await postJson(`${handle.url}/select`, {
      csrfToken,
      body: { id: "opt-1", label: "Option A" },
    });
    await handle.waitForSelection;
  });

  it("times out when no selection is made", async () => {
    const onSelect = vi
      .fn<(opt: PickerOption, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const handle = await startBrowserPicker(
      {
        title: "Test",
        subtitle: "Test",
        options: sampleOptions,
        onSelect,
        timeoutMs: 100,
      },
      testSignal(),
    );

    await expect(handle.waitForSelection).rejects.toThrow("timed out");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("escapes HTML in option labels", async () => {
    const xssOptions: PickerOption[] = [{ id: "xss", label: '<script>alert("xss")</script>' }];
    const onSelect = vi
      .fn<(opt: PickerOption, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const handle = await startBrowserPicker(
      {
        title: "Test",
        subtitle: "Test",
        options: xssOptions,
        onSelect,
        timeoutMs: 5000,
      },
      testSignal(),
    );

    const response = await fetch(handle.url);
    const html = await response.text();
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");

    // Clean up
    const csrfToken = await fetchCsrfToken(handle.url);
    await postJson(`${handle.url}/select`, {
      csrfToken,
      body: { id: "xss", label: '<script>alert("xss")</script>' },
    });
    await handle.waitForSelection;
  });

  it("returns 413 when POST body exceeds size limit", async () => {
    const onSelect = vi
      .fn<(opt: PickerOption, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const handle = await startBrowserPicker(
      {
        title: "Test",
        subtitle: "Test",
        options: sampleOptions,
        onSelect,
        timeoutMs: 5000,
      },
      testSignal(),
    );

    // Send a body larger than MAX_BODY_SIZE (1 MB). The hardening header
    // checks pass first (Content-Type is application/json), then the body
    // limit is enforced.
    const oversizedBody = "x".repeat(1_048_577);
    const response = await fetch(`${handle.url}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversizedBody,
    });
    expect(response.status).toBe(413);
    expect(onSelect).not.toHaveBeenCalled();

    // Clean up - post a valid selection
    const csrfToken = await fetchCsrfToken(handle.url);
    await postJson(`${handle.url}/select`, {
      csrfToken,
      body: { id: "opt-1", label: "Option A" },
    });
    await handle.waitForSelection;
  });

  it("returns 500 when onSelect throws", async () => {
    const onSelect = vi
      .fn<(opt: PickerOption, signal: AbortSignal) => Promise<void>>()
      .mockRejectedValue(new Error("save failed"));

    const handle = await startBrowserPicker(
      {
        title: "Test",
        subtitle: "Test",
        options: sampleOptions,
        onSelect,
        timeoutMs: 5000,
      },
      testSignal(),
    );

    const csrfToken = await fetchCsrfToken(handle.url);
    const response = await postJson(`${handle.url}/select`, {
      csrfToken,
      body: { id: "opt-1", label: "Option A" },
    });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("save failed");

    // Server should still be running - post again with working callback
    onSelect.mockResolvedValue(undefined);
    await postJson(`${handle.url}/select`, {
      csrfToken,
      body: { id: "opt-1", label: "Option A" },
    });
    await handle.waitForSelection;
  });

  it("rejects waitForSelection with UserCancelledError when /cancel is posted", async () => {
    const onSelect = vi
      .fn<(opt: PickerOption, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const handle = await startBrowserPicker(
      {
        title: "Test",
        subtitle: "Test",
        options: sampleOptions,
        onSelect,
        timeoutMs: 5000,
      },
      testSignal(),
    );

    const csrfToken = await fetchCsrfToken(handle.url);
    const [response] = await Promise.all([
      postJson(`${handle.url}/cancel`, { csrfToken, body: {} }),
      expect(handle.waitForSelection).rejects.toThrow("Selection cancelled by user"),
    ]);
    expect(response.status).toBe(200);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("picker page includes a Cancel button", async () => {
    const onSelect = vi
      .fn<(opt: PickerOption, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const handle = await startBrowserPicker(
      {
        title: "Choose a list",
        subtitle: "Select one:",
        options: sampleOptions,
        onSelect,
        timeoutMs: 5000,
      },
      testSignal(),
    );

    // Attach cleanup handler before any requests to avoid unhandled rejection
    const cleanup = handle.waitForSelection.catch(() => {
      /* expected rejection */
    });
    try {
      const response = await fetch(handle.url);
      const html = await response.text();
      expect(html).toContain('id="cancel-btn"');
      expect(html).toContain("Cancel");
    } finally {
      const csrfToken = await fetchCsrfToken(handle.url);
      await postJson(`${handle.url}/cancel`, { csrfToken, body: {} }).catch(() => {
        /* ignore */
      });
      await cleanup;
    }
  });
});

// ---------------------------------------------------------------------------
// Filter / Refresh / Create-link enhancements
// ---------------------------------------------------------------------------

describe("browser picker: enhanced features", () => {
  it("renders a filter input and create-link when configured", async () => {
    const handle = await startBrowserPicker(
      {
        title: "Pick",
        subtitle: "Choose:",
        options: sampleOptions,
        filterPlaceholder: "Type to filter...",
        createLink: {
          url: "https://example.com/new",
          label: "Create a new thing",
          description: "Opens the service in a new tab.",
        },
        onSelect: vi.fn().mockResolvedValue(undefined),
        timeoutMs: 5000,
      },
      testSignal(),
    );
    const cleanup = handle.waitForSelection.catch(() => undefined);
    try {
      const res = await fetch(handle.url);
      const html = await res.text();
      expect(html).toContain('id="filter-input"');
      expect(html).toContain("Type to filter...");
      expect(html).toContain("https://example.com/new");
      expect(html).toContain("Create a new thing");
      expect(html).toContain("Opens the service in a new tab.");
      // Refresh button is hidden unless refreshOptions is provided
      expect(html).not.toContain('id="refresh-btn"');
    } finally {
      const csrfToken = await fetchCsrfToken(handle.url);
      await postJson(`${handle.url}/cancel`, { csrfToken, body: {} }).catch(() => undefined);
      await cleanup;
    }
  });

  it("escapes HTML special characters in filter placeholder, create link, and options", async () => {
    const handle = await startBrowserPicker(
      {
        title: "Pick",
        subtitle: "Choose:",
        options: [{ id: "x<y>", label: "<script>alert(1)</script>" }],
        filterPlaceholder: 'evil" placeholder',
        createLink: {
          url: "https://example.com/?a=1&b=2",
          label: "<b>bold</b>",
          description: "desc <with> chars",
        },
        onSelect: vi.fn().mockResolvedValue(undefined),
        timeoutMs: 5000,
      },
      testSignal(),
    );
    const cleanup = handle.waitForSelection.catch(() => undefined);
    try {
      const html = await (await fetch(handle.url)).text();
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;");
      expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
      expect(html).toContain("https://example.com/?a=1&amp;b=2");
      expect(html).toContain('placeholder="evil&quot; placeholder"');
    } finally {
      const csrfToken = await fetchCsrfToken(handle.url);
      await postJson(`${handle.url}/cancel`, { csrfToken, body: {} }).catch(() => undefined);
      await cleanup;
    }
  });

  it("renders a refresh button only when refreshOptions is provided", async () => {
    const handle = await startBrowserPicker(
      {
        title: "Pick",
        subtitle: "Choose:",
        options: sampleOptions,
        refreshOptions: () => Promise.resolve(sampleOptions),
        onSelect: vi.fn().mockResolvedValue(undefined),
        timeoutMs: 5000,
      },
      testSignal(),
    );
    const cleanup = handle.waitForSelection.catch(() => undefined);
    try {
      const html = await (await fetch(handle.url)).text();
      expect(html).toContain('id="refresh-btn"');
    } finally {
      const csrfToken = await fetchCsrfToken(handle.url);
      await postJson(`${handle.url}/cancel`, { csrfToken, body: {} }).catch(() => undefined);
      await cleanup;
    }
  });

  it("GET /options calls the refresh provider and returns fresh options", async () => {
    const provider = vi
      .fn<(signal: AbortSignal) => Promise<PickerOption[]>>()
      .mockResolvedValueOnce([{ id: "refreshed-1", label: "Refreshed A" }]);

    const handle = await startBrowserPicker(
      {
        title: "Pick",
        subtitle: "Choose:",
        options: sampleOptions,
        refreshOptions: provider,
        onSelect: vi.fn().mockResolvedValue(undefined),
        timeoutMs: 5000,
      },
      testSignal(),
    );
    const cleanup = handle.waitForSelection.catch(() => undefined);
    try {
      const res = await fetch(`${handle.url}/options`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { options: PickerOption[] };
      expect(body.options).toEqual([{ id: "refreshed-1", label: "Refreshed A" }]);
      expect(provider).toHaveBeenCalledTimes(1);
    } finally {
      const csrfToken = await fetchCsrfToken(handle.url);
      await postJson(`${handle.url}/cancel`, { csrfToken, body: {} }).catch(() => undefined);
      await cleanup;
    }
  });

  it("after a refresh, only options from the refreshed set are selectable", async () => {
    // Initial set offers opt-1 and opt-2. Refresh replaces them.
    const onSelect = vi
      .fn<(opt: PickerOption, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);
    const handle = await startBrowserPicker(
      {
        title: "Pick",
        subtitle: "Choose:",
        options: sampleOptions,
        refreshOptions: () => Promise.resolve([{ id: "new-1", label: "New A" }]),
        onSelect,
        timeoutMs: 5000,
      },
      testSignal(),
    );

    // Refresh first
    await fetch(`${handle.url}/options`);

    const csrfToken = await fetchCsrfToken(handle.url);
    // Now try selecting the old ID — must be rejected
    const stale = await postJson(`${handle.url}/select`, {
      csrfToken,
      body: { id: "opt-1", label: "Option A" },
    });
    expect(stale.status).toBe(400);
    expect(onSelect).not.toHaveBeenCalled();

    // The new ID works
    const ok = await postJson(`${handle.url}/select`, {
      csrfToken,
      body: { id: "new-1", label: "New A" },
    });
    expect(ok.status).toBe(200);
    await handle.waitForSelection;
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("GET /options returns 405 when no refresh provider is configured", async () => {
    const handle = await startBrowserPicker(
      {
        title: "Pick",
        subtitle: "Choose:",
        options: sampleOptions,
        onSelect: vi.fn().mockResolvedValue(undefined),
        timeoutMs: 5000,
      },
      testSignal(),
    );
    const cleanup = handle.waitForSelection.catch(() => undefined);
    try {
      const res = await fetch(`${handle.url}/options`);
      expect(res.status).toBe(405);
    } finally {
      const csrfToken = await fetchCsrfToken(handle.url);
      await postJson(`${handle.url}/cancel`, { csrfToken, body: {} }).catch(() => undefined);
      await cleanup;
    }
  });

  it("GET /options returns 500 with JSON error when the provider throws", async () => {
    const handle = await startBrowserPicker(
      {
        title: "Pick",
        subtitle: "Choose:",
        options: sampleOptions,
        refreshOptions: () => Promise.reject(new Error("graph exploded")),
        onSelect: vi.fn().mockResolvedValue(undefined),
        timeoutMs: 5000,
      },
      testSignal(),
    );
    const cleanup = handle.waitForSelection.catch(() => undefined);
    try {
      const res = await fetch(`${handle.url}/options`);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      // Generic message — internal error details must not leak to the browser.
      expect(body.error).toBe("refresh failed");
      expect(body.error).not.toContain("graph exploded");
    } finally {
      const csrfToken = await fetchCsrfToken(handle.url);
      await postJson(`${handle.url}/cancel`, { csrfToken, body: {} }).catch(() => undefined);
      await cleanup;
    }
  });
});

// ---------------------------------------------------------------------------
// §5.4 Loopback hardening (CSRF, Host pin, Origin pin, Sec-Fetch-Site,
// Content-Type pin, hardened CSP)
// ---------------------------------------------------------------------------

describe("browser picker: §5.4 loopback hardening", () => {
  /**
   * Boilerplate-free helper: starts a picker, runs the body with a handle
   * + scraped CSRF token + the loopback host literal, then cancels cleanly.
   */
  async function withPicker(
    body: (ctx: { handle: { url: string }; csrfToken: string; host: string }) => Promise<void>,
  ): Promise<void> {
    const handle = await startBrowserPicker(
      {
        title: "Test",
        subtitle: "Test",
        options: sampleOptions,
        onSelect: vi.fn().mockResolvedValue(undefined),
        timeoutMs: 5000,
      },
      testSignal(),
    );
    const cleanup = handle.waitForSelection.catch(() => undefined);
    const host = new URL(handle.url).host;
    try {
      const csrfToken = await fetchCsrfToken(handle.url);
      await body({ handle, csrfToken, host });
    } finally {
      const csrfToken = await fetchCsrfToken(handle.url);
      await postJson(`${handle.url}/cancel`, { csrfToken, body: {} }).catch(() => undefined);
      await cleanup;
    }
  }

  it("rejects POST /select when Host header is not the loopback literal", async () => {
    await withPicker(async ({ handle, csrfToken }) => {
      const res = await rawHttpPost(`${handle.url}/select`, {
        hostHeader: "evil.example:80",
        body: JSON.stringify({ id: "opt-1", label: "Option A", csrfToken }),
      });
      expect(res.status).toBe(403);
      expect(res.body).toMatch(/Host/);
    });
  });

  it("accepts POST /select when Host header is the loopback literal (sanity)", async () => {
    await withPicker(async ({ handle, csrfToken, host }) => {
      const res = await rawHttpPost(`${handle.url}/select`, {
        hostHeader: host,
        body: JSON.stringify({ id: "opt-1", label: "Option A", csrfToken }),
      });
      expect(res.status).toBe(200);
    });
  });

  it("rejects POST /select when Origin is present and not loopback literal", async () => {
    await withPicker(async ({ handle, csrfToken }) => {
      const res = await postJson(`${handle.url}/select`, {
        csrfToken,
        body: { id: "opt-1", label: "Option A" },
        headers: { Origin: "https://evil.example" },
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toMatch(/Origin/);
    });
  });

  it("accepts POST /select when Origin matches the loopback literal", async () => {
    await withPicker(async ({ handle, csrfToken, host }) => {
      const res = await postJson(`${handle.url}/select`, {
        csrfToken,
        body: { id: "opt-1", label: "Option A" },
        headers: { Origin: `http://${host}` },
      });
      expect(res.status).toBe(200);
    });
  });

  it("rejects POST /select when Sec-Fetch-Site is present and not 'same-origin'", async () => {
    await withPicker(async ({ handle, csrfToken }) => {
      const res = await postJson(`${handle.url}/select`, {
        csrfToken,
        body: { id: "opt-1", label: "Option A" },
        headers: { "Sec-Fetch-Site": "cross-site" },
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toMatch(/Sec-Fetch-Site/);
    });
  });

  it("rejects POST /select when Content-Type is not application/json", async () => {
    await withPicker(async ({ handle, csrfToken }) => {
      const res = await fetch(`${handle.url}/select`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ id: "opt-1", label: "Option A", csrfToken }),
      });
      expect(res.status).toBe(415);
    });
  });

  it("rejects POST /select when CSRF token is missing", async () => {
    await withPicker(async ({ handle }) => {
      const res = await fetch(`${handle.url}/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "opt-1", label: "Option A" }),
      });
      expect(res.status).toBe(400);
    });
  });

  it("rejects POST /select when CSRF token is wrong (timing-safe)", async () => {
    await withPicker(async ({ handle }) => {
      const res = await postJson(`${handle.url}/select`, {
        csrfToken: "0".repeat(64),
        body: { id: "opt-1", label: "Option A" },
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toMatch(/CSRF/);
    });
  });

  it("rejects POST /select when CSRF token is the wrong length (timing-safe)", async () => {
    await withPicker(async ({ handle }) => {
      const res = await postJson(`${handle.url}/select`, {
        csrfToken: "short",
        body: { id: "opt-1", label: "Option A" },
      });
      expect(res.status).toBe(403);
    });
  });

  it("rejects POST /cancel when CSRF token is missing", async () => {
    await withPicker(async ({ handle }) => {
      const res = await fetch(`${handle.url}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(403);
    });
  });

  it("rejects POST /cancel when Content-Type is not application/json", async () => {
    await withPicker(async ({ handle, csrfToken }) => {
      const res = await fetch(`${handle.url}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ csrfToken }),
      });
      expect(res.status).toBe(415);
    });
  });

  it("CSP header forbids framing and uses a per-request nonce", async () => {
    await withPicker(async ({ handle }) => {
      const res = await fetch(handle.url);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).not.toContain("'unsafe-inline'");
      expect(csp).toMatch(/script-src 'nonce-[0-9a-f]{64}'/);
      expect(csp).toMatch(/style-src 'nonce-[0-9a-f]{64}'/);

      // A second request must mint a fresh nonce.
      const csp2 = (await fetch(handle.url)).headers.get("content-security-policy") ?? "";
      const nonce1 = /'nonce-([0-9a-f]{64})'/.exec(csp)?.[1];
      const nonce2 = /'nonce-([0-9a-f]{64})'/.exec(csp2)?.[1];
      expect(nonce1).toBeDefined();
      expect(nonce2).toBeDefined();
      expect(nonce1).not.toBe(nonce2);
    });
  });

  it("HTML embeds the CSRF token in a <meta> tag and a per-request nonce on inline <script> and <style>", async () => {
    await withPicker(async ({ handle, csrfToken }) => {
      const html = await (await fetch(handle.url)).text();
      expect(html).toContain(`<meta name="csrf-token" content="${csrfToken}">`);
      expect(html).toMatch(/<script nonce="[0-9a-f]{64}">/);
      expect(html).toMatch(/<style nonce="[0-9a-f]{64}">/);
    });
  });
});

// ---------------------------------------------------------------------------
// Navigation mode tests
// ---------------------------------------------------------------------------

describe("browser picker — navigation mode", () => {
  const rootOptions: PickerOption[] = [
    { id: "folder-1", label: "Projects" },
    { id: "folder-2", label: "Archive" },
  ];
  const subOptions: PickerOption[] = [
    { id: "sub-1", label: "MyProject" },
    { id: "sub-2", label: "OtherProject" },
  ];

  function buildNavPicker(opts?: {
    onNavigateResult?: { options: PickerOption[]; breadcrumb: string[] };
    onSelectCurrentResult?: { id: string; label: string };
    onShareUrlResult?:
      | { kind: "jump"; options: PickerOption[]; breadcrumb: string[] }
      | { kind: "select"; selected: { id: string; label: string } };
    onShareUrlEnabled?: boolean;
    onShareUrlError?: Error;
  }) {
    const onNavigate = vi
      .fn<
        (
          opt: PickerOption,
          sig: AbortSignal,
        ) => Promise<{ options: PickerOption[]; breadcrumb: string[] }>
      >()
      .mockResolvedValue(
        opts?.onNavigateResult ?? { options: subOptions, breadcrumb: ["My OneDrive", "Projects"] },
      );
    const onSelectCurrent = vi
      .fn<(sig: AbortSignal) => Promise<{ id: string; label: string }>>()
      .mockResolvedValue(
        opts?.onSelectCurrentResult ?? { id: "folder-1", label: "My OneDrive / Projects" },
      );
    const onShareUrl =
      opts?.onShareUrlEnabled !== false
        ? vi
            .fn<
              (
                url: string,
                sig: AbortSignal,
              ) => Promise<
                | { kind: "jump"; options: PickerOption[]; breadcrumb: string[] }
                | { kind: "select"; selected: { id: string; label: string } }
              >
            >()
            .mockImplementation((_, __) => {
              if (opts?.onShareUrlError) return Promise.reject(opts.onShareUrlError);
              return Promise.resolve(
                opts?.onShareUrlResult ?? {
                  kind: "jump" as const,
                  options: subOptions,
                  breadcrumb: ["My OneDrive", "Shared"],
                },
              );
            })
        : undefined;

    const config = {
      title: "Pick Folder",
      subtitle: "Navigate to pick a folder",
      options: rootOptions,
      onSelect: vi
        .fn<(opt: PickerOption, sig: AbortSignal) => Promise<void>>()
        .mockResolvedValue(undefined),
      timeoutMs: 5000,
      navigation: {
        initialBreadcrumb: ["My OneDrive"],
        onNavigate,
        onSelectCurrent,
        ...(onShareUrl !== undefined ? { onShareUrl } : {}),
      },
    };
    return { config, onNavigate, onSelectCurrent, onShareUrl };
  }

  it("renders breadcrumb when navigation is configured", async () => {
    const { config } = buildNavPicker();
    const handle = await startBrowserPicker(config, testSignal());
    try {
      const html = await (await fetch(handle.url)).text();
      expect(html).toContain('id="breadcrumb"');
      expect(html).toContain("My OneDrive");
    } finally {
      const ac = new AbortController();
      ac.abort();
    }
    // cleanup: just let handle dangle (timeout is 5 s)
  });

  it("renders Select this folder button when navigation is configured", async () => {
    const { config } = buildNavPicker();
    const handle = await startBrowserPicker(config, testSignal());
    const html = await (await fetch(handle.url)).text();
    expect(html).toContain("select-current-btn");
    expect(html).toContain("disabled");
  });

  it("POST /navigate with valid id calls onNavigate and returns new options/breadcrumb", async () => {
    const { config, onNavigate } = buildNavPicker();
    const handle = await startBrowserPicker(config, testSignal());
    const csrfToken = await fetchCsrfToken(handle.url);
    const res = await postJson(`${handle.url}/navigate`, {
      csrfToken,
      body: { id: "folder-1" },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      ok: boolean;
      options: PickerOption[];
      breadcrumb: string[];
    };
    expect(data.ok).toBe(true);
    expect(data.options).toEqual(subOptions);
    expect(data.breadcrumb).toEqual(["My OneDrive", "Projects"]);
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onNavigate.mock.calls[0]?.[0]).toMatchObject({ id: "folder-1" });
  });

  it("POST /navigate with invalid id returns 400 without calling onNavigate", async () => {
    const { config, onNavigate } = buildNavPicker();
    const handle = await startBrowserPicker(config, testSignal());
    const csrfToken = await fetchCsrfToken(handle.url);
    const res = await postJson(`${handle.url}/navigate`, {
      csrfToken,
      body: { id: "nonexistent-folder" },
    });
    expect(res.status).toBe(400);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("POST /navigate validates against updated option set after prior navigate", async () => {
    const { config } = buildNavPicker();
    const handle = await startBrowserPicker(config, testSignal());
    const csrfToken = await fetchCsrfToken(handle.url);
    // First navigate: replaces options with subOptions
    await postJson(`${handle.url}/navigate`, { csrfToken, body: { id: "folder-1" } });
    // Old root option is now invalid
    const res = await postJson(`${handle.url}/navigate`, { csrfToken, body: { id: "folder-2" } });
    expect(res.status).toBe(400);
    // Sub-option is valid
    const res2 = await postJson(`${handle.url}/navigate`, { csrfToken, body: { id: "sub-1" } });
    expect(res2.status).toBe(200);
  });

  it("POST /select-current calls onSelectCurrent and resolves waitForSelection", async () => {
    const { config, onSelectCurrent } = buildNavPicker({
      onSelectCurrentResult: { id: "folder-1", label: "My OneDrive / Projects" },
    });
    const handle = await startBrowserPicker(config, testSignal());
    const csrfToken = await fetchCsrfToken(handle.url);
    const [res, selectionResult] = await Promise.all([
      postJson(`${handle.url}/select-current`, { csrfToken, body: {} }),
      handle.waitForSelection,
    ]);
    expect(res.status).toBe(200);
    expect(onSelectCurrent).toHaveBeenCalledOnce();
    expect(selectionResult.selected.id).toBe("folder-1");
    expect(selectionResult.selected.label).toBe("My OneDrive / Projects");
  });

  it("POST /share-url with kind=jump replaces options and breadcrumb without resolving", async () => {
    const { config, onShareUrl } = buildNavPicker({
      onShareUrlResult: {
        kind: "jump",
        options: subOptions,
        breadcrumb: ["My OneDrive", "Shared"],
      },
    });
    const handle = await startBrowserPicker(config, testSignal());
    const csrfToken = await fetchCsrfToken(handle.url);
    const res = await postJson(`${handle.url}/share-url`, {
      csrfToken,
      body: { url: "https://contoso.sharepoint.com/sites/foo" },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      ok: boolean;
      kind: string;
      options: PickerOption[];
      breadcrumb: string[];
    };
    expect(data.ok).toBe(true);
    expect(data.kind).toBe("jump");
    expect(data.options).toEqual(subOptions);
    expect(data.breadcrumb).toEqual(["My OneDrive", "Shared"]);
    expect(onShareUrl).toHaveBeenCalledOnce();
    // Server should still be open — post another navigate with new options
    const res2 = await postJson(`${handle.url}/navigate`, { csrfToken, body: { id: "sub-1" } });
    expect(res2.status).toBe(200);
  });

  it("POST /share-url with kind=select resolves waitForSelection", async () => {
    const { config } = buildNavPicker({
      onShareUrlResult: {
        kind: "select",
        selected: { id: "shared-folder", label: "Shared Folder" },
      },
    });
    const handle = await startBrowserPicker(config, testSignal());
    const csrfToken = await fetchCsrfToken(handle.url);
    const [, selectionResult] = await Promise.all([
      postJson(`${handle.url}/share-url`, {
        csrfToken,
        body: { url: "https://contoso.sharepoint.com/sites/foo" },
      }),
      handle.waitForSelection,
    ]);
    expect(selectionResult.selected.id).toBe("shared-folder");
    expect(selectionResult.selected.label).toBe("Shared Folder");
  });

  it("POST /share-url returns 405 when onShareUrl is undefined", async () => {
    const { config } = buildNavPicker({ onShareUrlEnabled: false });
    const handle = await startBrowserPicker(config, testSignal());
    const csrfToken = await fetchCsrfToken(handle.url);
    const res = await postJson(`${handle.url}/share-url`, {
      csrfToken,
      body: { url: "https://contoso.sharepoint.com/sites/foo" },
    });
    expect(res.status).toBe(405);
  });

  it("POST /share-url returns 400 with user-facing error message on InvalidShareUrlError", async () => {
    const { InvalidShareUrlError } = await import("../src/errors.js");
    const { config } = buildNavPicker({
      onShareUrlError: new InvalidShareUrlError("http://evil.com/x", "unsupported_host"),
    });
    const handle = await startBrowserPicker(config, testSignal());
    const csrfToken = await fetchCsrfToken(handle.url);
    const res = await postJson(`${handle.url}/share-url`, {
      csrfToken,
      body: { url: "http://evil.com/x" },
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Invalid share URL");
  });

  it("POST /navigate rejects without valid CSRF token (403)", async () => {
    const { config } = buildNavPicker();
    const handle = await startBrowserPicker(config, testSignal());
    const res = await postJson(`${handle.url}/navigate`, {
      csrfToken: "wrong-token",
      body: { id: "folder-1" },
    });
    expect(res.status).toBe(403);
  });

  it("POST /navigate rejects with wrong Host header (403)", async () => {
    const { config } = buildNavPicker();
    const handle = await startBrowserPicker(config, testSignal());
    const csrfToken = await fetchCsrfToken(handle.url);
    const body = JSON.stringify({ id: "folder-1", csrfToken });
    const result = await rawHttpPost(`${handle.url}/navigate`, {
      hostHeader: "evil.example.com",
      body,
    });
    expect(result.status).toBe(403);
  });

  it("POST /select-current rejects without valid CSRF token (403)", async () => {
    const { config } = buildNavPicker();
    const handle = await startBrowserPicker(config, testSignal());
    const res = await postJson(`${handle.url}/select-current`, {
      csrfToken: "bad-token",
      body: {},
    });
    expect(res.status).toBe(403);
  });
});
