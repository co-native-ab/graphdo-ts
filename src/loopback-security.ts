// Shared hardening helpers for loopback HTTP servers (login, picker, logout).
//
// The hardening defends against two browser-based attack patterns that
// can target loopback servers from any malicious page the user happens
// to have open: brute-force port discovery via `no-cors` `fetch` POSTs,
// and DNS rebinding (a hostname that resolves first to the attacker's
// IP, then to `127.0.0.1`). All POST handlers used by the loopback
// servers MUST run `validateLoopbackPostHeaders` and check the CSRF
// token before performing any state-changing action.

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

// ---------------------------------------------------------------------------
// Token generation + comparison
// ---------------------------------------------------------------------------

/** Generate a 32-byte cryptographically random token, hex-encoded (64 chars). */
export function generateRandomToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Constant-time comparison of a CSRF token against the expected value.
 * `timingSafeEqual` requires equal-length buffers, so a length mismatch
 * is treated as a non-match without leaking timing information.
 */
export function verifyCsrfToken(expected: string, received: unknown): boolean {
  if (typeof received !== "string") return false;
  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(received, "utf8");
  if (expectedBuf.length !== receivedBuf.length) return false;
  return timingSafeEqual(expectedBuf, receivedBuf);
}

// ---------------------------------------------------------------------------
// CSP header
// ---------------------------------------------------------------------------

/**
 * Build the hardened CSP header for loopback pages. `nonce` must be a
 * fresh per-request value (generated via `generateRandomToken()`). The
 * policy:
 * - locks down to nonce-based inline scripts and styles (no `'unsafe-inline'`)
 * - retains the Google Fonts allowance used by the shared layout
 * - allows data-URI images (used for the embedded logo)
 * - forbids framing (`frame-ancestors 'none'`) so a rebinding attacker
 *   cannot iframe the page and click-jack the form
 * - locks `<base>` and `<form action>` to the same origin
 */
export function buildLoopbackCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}' https://fonts.googleapis.com`,
    "font-src https://fonts.gstatic.com",
    "img-src data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// ---------------------------------------------------------------------------
// POST header validator
// ---------------------------------------------------------------------------

export type HeaderValidationResult = { ok: true } | { ok: false; status: number; message: string };

export interface ValidateOptions {
  /** Hostnames (host[:port]) that the loopback server will accept on POST. */
  allowedHosts: string[];
  /** Allowed `Origin` values. Defaults to `http://${allowedHosts[i]}` for each host. */
  allowedOrigins?: string[];
}

/**
 * Apply the §5.4 header pins to a POST request. Returns `{ ok: true }` if
 * the request is allowed, otherwise the HTTP status + plaintext message
 * the caller should respond with.
 *
 * - **Host pin** — defeats DNS rebinding. The rebound hostname will be
 *   sent in `Host`, not the loopback literal.
 * - **Origin pin** (when present) — most browsers send `Origin` on `POST`.
 *   Missing `Origin` is allowed to keep server-to-server style and
 *   same-origin top-level navigations working in older user agents.
 * - **Sec-Fetch-Site pin** (when present) — best-effort defense in depth.
 * - **Content-Type pin** — must be `application/json` (allowing optional
 *   `; charset=...` parameter). Rejects `text/plain` and HTML form posts
 *   that are normally exempt from CORS preflight.
 */
export function validateLoopbackPostHeaders(
  req: IncomingMessage,
  opts: ValidateOptions,
): HeaderValidationResult {
  const allowedHosts = new Set(opts.allowedHosts);
  const allowedOrigins = new Set(
    opts.allowedOrigins ?? opts.allowedHosts.map((h) => `http://${h}`),
  );

  const host = req.headers.host;
  if (typeof host !== "string" || !allowedHosts.has(host)) {
    return { ok: false, status: 403, message: "Forbidden: invalid Host header" };
  }

  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0 && !allowedOrigins.has(origin)) {
    return { ok: false, status: 403, message: "Forbidden: invalid Origin header" };
  }

  const fetchSite = req.headers["sec-fetch-site"];
  if (typeof fetchSite === "string" && fetchSite.length > 0 && fetchSite !== "same-origin") {
    return { ok: false, status: 403, message: "Forbidden: invalid Sec-Fetch-Site header" };
  }

  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !isJsonContentType(contentType)) {
    return { ok: false, status: 415, message: "Unsupported Media Type: expected application/json" };
  }

  return { ok: true };
}

function isJsonContentType(value: string): boolean {
  // Accept "application/json" with optional parameters like "; charset=utf-8".
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json";
}
