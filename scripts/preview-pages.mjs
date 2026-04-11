#!/usr/bin/env node

// Generates static HTML previews of all browser-facing pages into html-preview/.
// Useful for visually reviewing page consistency without running the MCP server.
//
// Usage: node scripts/preview-pages.mjs

import { mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const outDir = join(root, "html-preview");

// ---------------------------------------------------------------------------
// 1. Bundle template functions via esbuild (reuses existing devDep)
// ---------------------------------------------------------------------------

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const entryPath = join(outDir, "_entry.ts");
const bundlePath = join(outDir, "_bundle.mjs");

writeFileSync(
  entryPath,
  [
    'export { landingPageHtml, successPageHtml, errorPageHtml } from "../src/templates/login.js";',
    'export { logoutPageHtml } from "../src/templates/logout.js";',
    'export { pickerPageHtml } from "../src/templates/picker.js";',
  ].join("\n"),
);

buildSync({
  entryPoints: [entryPath],
  bundle: true,
  outfile: bundlePath,
  format: "esm",
  platform: "node",
  logLevel: "warning",
});

const T = await import(pathToFileURL(bundlePath).href);

unlinkSync(entryPath);
unlinkSync(bundlePath);

// ---------------------------------------------------------------------------
// 2. Generate preview pages
// ---------------------------------------------------------------------------

const pages = [];

// Login
pages.push({
  file: "login.html",
  html: T.landingPageHtml("login-success.html"),
});
pages.push({
  file: "login-success.html",
  html: T.successPageHtml(),
});
pages.push({
  file: "login-error.html",
  html: T.errorPageHtml(
    "AADSTS50059: No tenant-identifying information found in the request. Please try again.",
  ),
});

// Logout
pages.push({
  file: "logout.html",
  html: T.logoutPageHtml(),
});
pages.push({
  file: "logout-success.html",
  html: T.logoutPageHtml()
    .replace('id="confirm-view">', 'id="confirm-view" style="display:none">')
    .replace('id="done-view" style="display:none"', 'id="done-view"'),
});

// Picker
const pickerConfig = {
  title: "Select a List",
  subtitle: "Choose which Microsoft To Do list to use:",
  options: [
    { id: "list-1", label: "Work Tasks" },
    { id: "list-2", label: "Personal" },
    { id: "list-3", label: "Shopping" },
  ],
};

pages.push({
  file: "picker.html",
  html: T.pickerPageHtml(pickerConfig),
});
pages.push({
  file: "picker-done.html",
  html: T.pickerPageHtml(pickerConfig)
    .replace('id="picker">', 'id="picker" style="display:none">')
    .replace('id="done" style="display:none"', 'id="done"')
    .replace('id="selected-label"></strong>', 'id="selected-label">Work Tasks</strong>'),
});

// ---------------------------------------------------------------------------
// 3. Index page with links to all previews
// ---------------------------------------------------------------------------

pages.push({
  file: "index.html",
  html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>graphdo - Page Previews</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Lexend:wght@300;400;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Lexend', Arial, sans-serif;
      background: linear-gradient(160deg, #eae8f3 0%, #efeff0 100%);
      color: #636466;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 40px 20px;
      min-height: 100vh;
    }
    .container { max-width: 440px; width: 100%; text-align: center; }
    .card {
      background: #fff;
      border-radius: 16px;
      padding: 48px 40px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
    }
    h1 { font-size: 1.4rem; font-weight: 700; color: #120457; margin-bottom: 8px; }
    .subtitle { color: #636466; font-size: 0.95rem; margin-bottom: 24px; }
    .section { text-align: left; margin-top: 20px; }
    .section-title {
      font-size: 0.75rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: #8a8c8e; margin-bottom: 8px;
    }
    a.link {
      display: block; padding: 14px 18px; margin-bottom: 8px;
      background: #fff; border: 1.5px solid #efeff0; border-radius: 12px;
      text-decoration: none; color: #636466; font-size: 0.95rem;
      transition: all 0.2s ease;
    }
    a.link:hover {
      border-color: #6659a7; background: #eae8f3;
      transform: translateY(-1px);
      box-shadow: 0 2px 8px rgba(102, 89, 167, 0.15);
    }
    a.link span { float: right; color: #8a8c8e; font-size: 0.8rem; }
    @media (prefers-color-scheme: dark) {
      body {
        background: linear-gradient(160deg, #0d0c14 0%, #141320 100%);
        color: #c2c1cf;
      }
      .card {
        background: #1c1b29;
        box-shadow: 0 4px 24px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2);
      }
      h1 { color: #e0dded; }
      .subtitle { color: #c2c1cf; }
      .section-title { color: #7d7c8f; }
      a.link {
        background: #1c1b29; border-color: #2c2b3d; color: #c2c1cf;
      }
      a.link:hover {
        border-color: #6659a7; background: #24233a;
      }
      a.link span { color: #7d7c8f; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>Page Previews</h1>
      <p class="subtitle">Visual review of all browser-facing pages</p>
      <div class="section">
        <p class="section-title">Login</p>
        <a class="link" href="login.html">Landing <span>sign-in prompt</span></a>
        <a class="link" href="login-success.html">Success <span>authenticated</span></a>
        <a class="link" href="login-error.html">Error <span>auth failed</span></a>
      </div>
      <div class="section">
        <p class="section-title">Logout</p>
        <a class="link" href="logout.html">Confirmation <span>sign-out prompt</span></a>
        <a class="link" href="logout-success.html">Success <span>signed out</span></a>
      </div>
      <div class="section">
        <p class="section-title">Picker</p>
        <a class="link" href="picker.html">Selection <span>choose a list</span></a>
        <a class="link" href="picker-done.html">Done <span>list selected</span></a>
      </div>
    </div>
  </div>
</body>
</html>`,
});

// ---------------------------------------------------------------------------
// 4. Write files
// ---------------------------------------------------------------------------

for (const { file, html } of pages) {
  writeFileSync(join(outDir, file), html);
}

console.log(`Generated ${pages.length} pages in html-preview/`);
console.log("Open html-preview/index.html to browse all previews.");
