// Shared HTML shell for all browser-facing pages.
// Provides doctype, head (meta, viewport, favicon, fonts, stylesheet) and body wrapper.

import { googleFontsUrl } from "./tokens.js";
import { iconDataUri } from "./icons.js";
import { BASE_STYLE } from "./styles.js";

export interface LayoutParams {
  title: string;
  /** Additional CSS appended after BASE_STYLE. */
  extraStyles?: string;
  /** Body inner HTML. */
  body: string;
  /** Optional inline script placed before </body>. */
  script?: string;
}

export function layoutHtml(params: LayoutParams): string {
  const scriptBlock = params.script ? `\n  <script>\n${params.script}\n  </script>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${params.title}</title>
  <link rel="icon" type="image/png" href="${iconDataUri}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="${googleFontsUrl}" rel="stylesheet">
  <style>
    ${BASE_STYLE}${params.extraStyles ?? ""}
  </style>
</head>
<body>
  ${params.body}${scriptBlock}
</body>
</html>`;
}
