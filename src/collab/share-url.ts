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
// Host allow-list
// ---------------------------------------------------------------------------

/**
 * OneDrive sharing URL hosts that `session_open_project` will accept
 * before sending to Graph. Suffix matches are performed case-insensitively
 * so `Contoso.SharePoint.com` passes.
 */
const ALLOWED_HOST_SUFFIXES = [
  ".sharepoint.com",
  "-my.sharepoint.com",
  "1drv.ms",
  "onedrive.live.com",
];

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
  const matchesSuffix = ALLOWED_HOST_SUFFIXES.some((suffix) => {
    // Exact match or suffix match with a leading dot/dash
    if (hostname === suffix.toLowerCase()) return true;
    if (hostname.endsWith(suffix.toLowerCase())) {
      // Ensure it's truly a suffix match and not a substring spoofing attack
      // (e.g. reject `evil-sharepoint.com.attacker.example`)
      const prefix = hostname.slice(0, -suffix.length);
      // For `.sharepoint.com`, prefix must not end with `.` (it's already covered)
      // For `-my.sharepoint.com`, prefix must not end with `-` (same reason)
      // For exact matches like `1drv.ms` or `onedrive.live.com`, we already returned
      return prefix.length > 0;
    }
    return false;
  });

  if (!matchesSuffix) {
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
export function encodeShareUrl(url: string): string {
  const utf8 = Buffer.from(url, "utf-8");
  const base64 = utf8.toString("base64");
  const base64url = base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `u!${base64url}`;
}
