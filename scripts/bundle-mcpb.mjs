#!/usr/bin/env node

// Builds and packs an MCPB bundle from a minimal staging directory.
// Only the files required by the manifest are included — no source, tests, or tooling.
//
// Usage: node scripts/bundle-mcpb.mjs [--no-build] [output]
//   --no-build  Skip the build step (assumes dist/ is already up to date)
//   output      Path for the .mcpb file (default: graphdo.mcpb)

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const stageDir = join(root, ".mcpb-stage");

const args = process.argv.slice(2);
const noBuild = args.includes("--no-build");
const output = args.find((a) => a !== "--no-build") ?? "graphdo.mcpb";

// Files to include in the bundle (paths relative to repo root)
const include = ["manifest.json", "dist/index.js", "assets/symbol.png", "README.md", "LICENSE"];

// ---------------------------------------------------------------------------
// 1. Build
// ---------------------------------------------------------------------------

if (!noBuild) {
  console.log("Building…");
  execSync("npm run build", { cwd: root, stdio: "inherit" });
}

// ---------------------------------------------------------------------------
// 2. Stage
// ---------------------------------------------------------------------------

rmSync(stageDir, { recursive: true, force: true });

for (const file of include) {
  const src = join(root, file);
  const dest = join(stageDir, file);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}

console.log(`Staged ${include.length} files in .mcpb-stage/`);

// ---------------------------------------------------------------------------
// 3. Pack
// ---------------------------------------------------------------------------

try {
  execSync(`node_modules/.bin/mcpb pack "${stageDir}" "${join(root, output)}"`, {
    cwd: root,
    stdio: "inherit",
  });
  console.log(`\nBundle written to ${output}`);
} finally {
  rmSync(stageDir, { recursive: true, force: true });
}
