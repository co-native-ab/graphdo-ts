// Shared HTML shell for all browser-facing pages.
// Provides doctype, head (meta, viewport, favicon, fonts, stylesheet) and body wrapper.

import { googleFontsUrl } from "./tokens.js";
import { symbolDataUri } from "./icons.js";
import { BASE_STYLE } from "./styles.js";

export interface LayoutParams {
  title: string;
  /** Additional CSS appended after BASE_STYLE. */
  extraStyles?: string;
  /** Body inner HTML. */
  body: string;
  /** Optional inline script placed before </body>. */
  script?: string;
  /**
   * Optional CSP nonce. When provided, both the inline `<style>` and the
   * inline `<script>` are emitted with `nonce="..."` so they remain
   * allowed under the strict nonce-based CSP used by hardened loopback
   * servers (see `src/loopback-security.ts#buildLoopbackCsp`). When
   * omitted, the legacy `<style>` / `<script>` form is used (still valid
   * under the legacy `'unsafe-inline'` CSP). Optional head HTML (e.g. a
   * CSRF meta tag) appended inside `<head>`.
   */
  nonce?: string;
  /** Extra HTML appended inside `<head>` (after the stylesheet link). */
  extraHead?: string;
}

export function layoutHtml(params: LayoutParams): string {
  const nonceAttr = params.nonce ? ` nonce="${params.nonce}"` : "";
  const scriptBlock = params.script
    ? `\n  <script${nonceAttr}>\n${params.script}\n  </script>`
    : "";
  const extraHead = params.extraHead ? `\n  ${params.extraHead}` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${params.title}</title>
  <link rel="icon" type="image/svg+xml" href="${symbolDataUri}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="${googleFontsUrl}" rel="stylesheet">
  <style${nonceAttr}>
    ${BASE_STYLE}${params.extraStyles ?? ""}
  </style>${extraHead}
</head>
<body>
  ${params.body}${scriptBlock}
</body>
</html>`;
}
