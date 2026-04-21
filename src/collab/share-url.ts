// URL-paste resolution for `session_open_project` (collab v1 §4.4).
//
// Validates and encodes OneDrive sharing URLs per the RFC 4648 §5
// base64url scheme (`u!<base64url(utf8(url))>`). Enforces a strict host
// allow-list to refuse attacker-controlled URLs before they reach Graph.
//
// **Host allow-list** (§4.4 lines 1799–1807):
//
//   - `*.sharepoint.com`
//   - `*-my.sharepoint.com`
//   - `1drv.ms`
//   - `onedrive.live.com`
//
// Anything else (`http://`, `file:///`, IP literals, `localhost`, arbitrary
// hostnames) is refused with {@link InvalidShareUrlError} carrying a
// precise reason. This is a local client-side check — no Graph call is
// issued for rejected URLs.

import { InvalidShareUrlError } from "../errors.js";

// ---------------------------------------------------------------------------
// EncodedShareId — branded `string` newtype
// ---------------------------------------------------------------------------

/**
 * A `u!<base64url>` Microsoft Graph share token, produced exclusively by
 * {@link encodeShareUrl} after the URL has cleared {@link validateShareUrl}'s
 * host allow-list. The brand makes "this string is safe to splice into
 * `/shares/{id}`" a compile-time guarantee instead of a comment.
 *
 * Mirrors `ValidatedGraphId` from `src/graph/ids.ts`. We keep a separate
 * brand because the value sets do not overlap: a `ValidatedGraphId` is an
 * opaque ASCII identifier (no `!`, no base64url chars), whereas an
 * `EncodedShareId` always starts with `u!` and may contain `-` / `_`.
 * Per ADR-0007 "Out of scope", share tokens deliberately live outside the
 * `ValidatedGraphId` domain.
 *
 * The brand symbol is module-private; the only ways to obtain a value are
 * {@link encodeShareUrl} (the normal path) or
 * {@link unsafeAssumeEncodedShareId} (loud-named escape hatch for tests
 * and decoded-from-trusted-storage cases — every use site MUST carry a
 * one-line rationale comment, mirroring `unsafeAssumeValidatedGraphId`).
 */
declare const encodedShareIdBrand: unique symbol;
export type EncodedShareId = string & { readonly [encodedShareIdBrand]: true };

/**
 * Escape hatch for the rare case where an `EncodedShareId`-shaped value
 * arrives as a plain `string` (e.g. a test fixture, a value re-read from
 * trusted local storage). Prefer {@link encodeShareUrl}. Grep for this
 * function name to audit every bypass site.
 */
export function unsafeAssumeEncodedShareId(value: string): EncodedShareId {
  return value as EncodedShareId;
}

// ---------------------------------------------------------------------------
// Host allow-list
// ---------------------------------------------------------------------------

/**
 * OneDrive sharing URL hosts that `session_open_project` will accept
 * before sending to Graph. Matching is case-insensitive so
 * `Contoso.SharePoint.com` passes.
 *
 * - `ALLOWED_EXACT_HOSTS` — the hostname must equal the entry verbatim.
 *   Used for hosts on a public TLD that an attacker could register a
 *   look-alike of (e.g. `evil1drv.ms`); textual `endsWith` would have
 *   accepted those.
 * - `ALLOWED_HOST_SUFFIXES` — the hostname must be the suffix itself or
 *   end with a `.`-bound prefix of it (`contoso.sharepoint.com`,
 *   `contoso-my.sharepoint.com`). This rejects substring spoofing such
 *   as `evilsharepoint.com` and `evil-sharepoint.com.attacker.example`
 *   while keeping legitimate Microsoft tenants.
 */
const ALLOWED_EXACT_HOSTS = ["1drv.ms", "onedrive.live.com"];
const ALLOWED_HOST_SUFFIXES = [".sharepoint.com"];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a pasted URL is an allowed OneDrive sharing URL. Returns
 * the validated URL on success; throws {@link InvalidShareUrlError} with
 * a precise `reason` when the URL is rejected.
 *
 * Performs the following checks (§4.4):
 *
 * 1. Refuse any scheme other than `https:`.
 * 2. Refuse IP literals (IPv4 and IPv6).
 * 3. Refuse `localhost` and `127.0.0.1`-like addresses.
 * 4. Refuse any hostname not matching the allow-list.
 *
 * Does **not** issue any Graph call — this is a pure client-side guard
 * that happens before {@link encodeShareUrl}.
 */
export function validateShareUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidShareUrlError(url, "malformed");
  }

  // 1. Refuse non-https schemes
  if (parsed.protocol !== "https:") {
    throw new InvalidShareUrlError(url, "unsupported_scheme");
  }

  const hostname = parsed.hostname.toLowerCase();

  // 2. Refuse IP literals (IPv4 and IPv6)
  //    IPv4: 4 dot-separated decimal octets
  //    IPv6: square-bracketed in hostname (parsed.hostname strips brackets)
  // 3. Refuse localhost
  if (hostname === "localhost" || hostname.startsWith("127.")) {
    throw new InvalidShareUrlError(url, "loopback");
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) {
    throw new InvalidShareUrlError(url, "ip_literal");
  }

  // 4. Host allow-list
  //    Exact hosts catch entries on public TLDs (`1drv.ms`, the `.ms`
  //    TLD is registrable; suffix-only matching would let
  //    `evil1drv.ms` slip through).
  //    Suffix hosts must be the suffix itself, or end with `.<suffix>`
  //    so `contoso.sharepoint.com` passes but `evilsharepoint.com`
  //    and `evil-sharepoint.com.attacker.example` are rejected.
  const matchesAllowList =
    ALLOWED_EXACT_HOSTS.includes(hostname) ||
    ALLOWED_HOST_SUFFIXES.some((suffix) => {
      const lower = suffix.toLowerCase();
      if (hostname === lower) return true;
      // Strip leading dot, then require an exact `.<suffix>` boundary
      const bare = lower.startsWith(".") ? lower.slice(1) : lower;
      const needle = `.${bare}`;
      return hostname.endsWith(needle) && hostname.length > needle.length;
    });

  if (!matchesAllowList) {
    throw new InvalidShareUrlError(url, "unsupported_host");
  }

  return url;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * Encode a validated OneDrive sharing URL into the Graph `u!<base64url>`
 * format per RFC 4648 §5: replace `+` with `-`, `/` with `_`, strip
 * trailing `=` padding.
 *
 * The caller must validate the URL via {@link validateShareUrl} first.
 * This helper does **not** re-validate — it assumes the input is a
 * well-formed `https://` URL.
 */
export function encodeShareUrl(url: string): EncodedShareId {
  const utf8 = Buffer.from(url, "utf-8");
  const base64 = utf8.toString("base64");
  const base64url = base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `u!${base64url}` as EncodedShareId;
}
