// Tests for the loopback-security helper module (CSRF + header pins +
// CSP builder).

import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "node:http";

import {
  buildLoopbackCsp,
  generateRandomToken,
  validateLoopbackPostHeaders,
  verifyCsrfToken,
} from "../src/loopback-security.js";

function fakeReq(headers: Record<string, string>): IncomingMessage {
  // Cast the minimum-viable shape — we only ever read `headers`.
  return { headers } as unknown as IncomingMessage;
}

describe("loopback-security: generateRandomToken", () => {
  it("returns a 64-char hex string (32 bytes)", () => {
    const tok = generateRandomToken();
    expect(tok).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns different tokens on each call", () => {
    const a = generateRandomToken();
    const b = generateRandomToken();
    expect(a).not.toBe(b);
  });
});

describe("loopback-security: verifyCsrfToken", () => {
  it("accepts a matching token", () => {
    const tok = generateRandomToken();
    expect(verifyCsrfToken(tok, tok)).toBe(true);
  });

  it("rejects a different same-length token", () => {
    expect(verifyCsrfToken("a".repeat(64), "b".repeat(64))).toBe(false);
  });

  it("rejects a wrong-length token (timing-safe)", () => {
    // timingSafeEqual would throw on length mismatch — we must short-circuit.
    expect(verifyCsrfToken("a".repeat(64), "short")).toBe(false);
  });

  it("rejects a non-string received token", () => {
    expect(verifyCsrfToken("a".repeat(64), undefined)).toBe(false);
    expect(verifyCsrfToken("a".repeat(64), 123)).toBe(false);
    expect(verifyCsrfToken("a".repeat(64), null)).toBe(false);
  });
});

describe("loopback-security: buildLoopbackCsp", () => {
  const csp = buildLoopbackCsp("nonce-value");

  it("forbids unsafe-inline", () => {
    expect(csp).not.toContain("'unsafe-inline'");
  });

  it("includes per-request nonce on script-src and style-src", () => {
    expect(csp).toContain("script-src 'nonce-nonce-value'");
    expect(csp).toContain("style-src 'nonce-nonce-value' https://fonts.googleapis.com");
  });

  it("forbids framing", () => {
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("locks <base> and <form action>", () => {
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
  });

  it("retains the legacy allowances (data: img, fonts, connect-src self)", () => {
    expect(csp).toContain("font-src https://fonts.gstatic.com");
    expect(csp).toContain("img-src data:");
    expect(csp).toContain("connect-src 'self'");
  });
});

describe("loopback-security: validateLoopbackPostHeaders", () => {
  const allowedHosts = ["127.0.0.1:1234"];

  it("accepts a same-origin POST with json content type", () => {
    const result = validateLoopbackPostHeaders(
      fakeReq({
        host: "127.0.0.1:1234",
        origin: "http://127.0.0.1:1234",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      }),
      { allowedHosts },
    );
    expect(result).toEqual({ ok: true });
  });

  it("accepts when Origin and Sec-Fetch-Site are omitted", () => {
    const result = validateLoopbackPostHeaders(
      fakeReq({ host: "127.0.0.1:1234", "content-type": "application/json" }),
      { allowedHosts },
    );
    expect(result).toEqual({ ok: true });
  });

  it("accepts json content type with a charset parameter", () => {
    const result = validateLoopbackPostHeaders(
      fakeReq({ host: "127.0.0.1:1234", "content-type": "application/json; charset=utf-8" }),
      { allowedHosts },
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects a missing Host header", () => {
    const result = validateLoopbackPostHeaders(fakeReq({ "content-type": "application/json" }), {
      allowedHosts,
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects a Host header that is not in the allow-list (DNS rebinding)", () => {
    const result = validateLoopbackPostHeaders(
      fakeReq({ host: "evil.example:80", "content-type": "application/json" }),
      { allowedHosts },
    );
    expect(result).toMatchObject({ ok: false, status: 403 });
    if (!result.ok) expect(result.message).toMatch(/Host/);
  });

  it("rejects a non-loopback Origin", () => {
    const result = validateLoopbackPostHeaders(
      fakeReq({
        host: "127.0.0.1:1234",
        origin: "https://evil.example",
        "content-type": "application/json",
      }),
      { allowedHosts },
    );
    expect(result).toMatchObject({ ok: false, status: 403 });
    if (!result.ok) expect(result.message).toMatch(/Origin/);
  });

  it("rejects a Sec-Fetch-Site that is not 'same-origin'", () => {
    const result = validateLoopbackPostHeaders(
      fakeReq({
        host: "127.0.0.1:1234",
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
      }),
      { allowedHosts },
    );
    expect(result).toMatchObject({ ok: false, status: 403 });
    if (!result.ok) expect(result.message).toMatch(/Sec-Fetch-Site/);
  });

  it("rejects a non-json Content-Type with 415", () => {
    const result = validateLoopbackPostHeaders(
      fakeReq({ host: "127.0.0.1:1234", "content-type": "text/plain" }),
      { allowedHosts },
    );
    expect(result).toMatchObject({ ok: false, status: 415 });
  });

  it("rejects a missing Content-Type", () => {
    const result = validateLoopbackPostHeaders(fakeReq({ host: "127.0.0.1:1234" }), {
      allowedHosts,
    });
    expect(result).toMatchObject({ ok: false, status: 415 });
  });

  it("accepts both `localhost:<port>` and `127.0.0.1:<port>` when both are allowed", () => {
    const opts = { allowedHosts: ["localhost:5555", "127.0.0.1:5555"] };
    expect(
      validateLoopbackPostHeaders(
        fakeReq({ host: "localhost:5555", "content-type": "application/json" }),
        opts,
      ),
    ).toEqual({ ok: true });
    expect(
      validateLoopbackPostHeaders(
        fakeReq({ host: "127.0.0.1:5555", "content-type": "application/json" }),
        opts,
      ),
    ).toEqual({ ok: true });
  });
});
