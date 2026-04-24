// System browser opener — cross-platform utility.
//
// We do our own URL validation (allowlist of protocols, no plain http to
// non-localhost hosts) as a security gatekeeper, then hand the URL off to
// the `open` package, which handles the platform/quoting/spawn details
// (PowerShell `Start-Process` on Windows so the URL is passed verbatim,
// `open` on macOS, an upstream `xdg-open` on Linux, plus WSL handling).
//
// See ADR-0011 for the rationale behind delegating to `open`.

import openExternal from "open";

/** Open a URL in the system browser. Throws on failure. */
export async function openBrowser(url: string): Promise<void> {
  // Security: validate URL to prevent handing arbitrary strings to a
  // platform launcher. `open` makes no security guarantees of its own
  // (per its README), so this gatekeeper is the only thing standing
  // between a caller-supplied URL and the OS.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  // Two callers open URLs through this helper:
  //   1. The loopback / picker / logout pages on a local 127.0.0.1 server
  //      (always plain http://localhost or http://127.0.0.1 with a random port).
  //   2. Tools that deep-link the user into an external site (e.g. the
  //      markdown preview tool opening a SharePoint URL). These are always
  //      https.
  //
  // Plain http to a non-local host is never something this app emits — and
  // letting it through would risk silently opening a cleartext page to an
  // attacker-controlled URL — so we reject that combination.
  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol === "http:" && !isLocal) {
    throw new Error(`Plain http:// URLs must be a localhost address, got: ${parsed.hostname}`);
  }

  try {
    await openExternal(url);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to open browser: ${message}`);
  }
}
