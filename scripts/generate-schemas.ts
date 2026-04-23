// Generates `schemas/config-v{N}.json` for every on-disk config version
// from the Zod schemas declared in `src/config.ts`. Single source of truth:
// the Zod definitions are the contract; the JSON Schema files are
// derivable artefacts.
//
// Usage:
//   npm run schemas:generate         # write all schemas/config-vN.json files
//   npm run schemas:check            # verify every file is up-to-date (exit 1 if drift)
//
// Wired into `npm run check` (CI gate) and `npm run build` so a forgotten
// `npm run schemas:generate` is caught long before a release.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { SCHEMAS } from "../src/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const schemasDir = resolve(root, "schemas");

const checkMode = process.argv.includes("--check");

interface Plan {
  version: number;
  filePath: string;
  expected: string;
}

function buildPlan(): Plan[] {
  const plans: Plan[] = [];
  for (const versionStr of Object.keys(SCHEMAS).sort((a, b) => Number(a) - Number(b))) {
    const version = Number(versionStr);
    const schema = SCHEMAS[version];
    if (schema === undefined) continue;
    // Trailing newline matches Prettier's defaults so a `prettier --write`
    // on the file is a no-op after generation.
    const expected = `${JSON.stringify(z.toJSONSchema(schema, { target: "draft-2020-12" }), null, 2)}\n`;
    plans.push({
      version,
      filePath: resolve(schemasDir, `config-v${String(version)}.json`),
      expected,
    });
  }
  return plans;
}

function runCheck(plans: Plan[]): number {
  let drift = false;
  for (const { version, filePath, expected } of plans) {
    let current: string;
    try {
      current = readFileSync(filePath, "utf-8");
    } catch {
      console.error(
        `schemas/config-v${String(version)}.json is missing. Run: npm run schemas:generate`,
      );
      drift = true;
      continue;
    }
    if (current !== expected) {
      console.error(
        `schemas/config-v${String(version)}.json is out of date with src/config.ts. Run: npm run schemas:generate`,
      );
      drift = true;
    }
  }
  if (drift) return 1;
  console.log(`schemas/ up to date (${String(plans.length)} versions checked).`);
  return 0;
}

function runWrite(plans: Plan[]): void {
  mkdirSync(schemasDir, { recursive: true });
  for (const { filePath, expected } of plans) {
    writeFileSync(filePath, expected, "utf-8");
    console.log(`Generated ${filePath}`);
  }
}

const plans = buildPlan();
if (plans.length === 0) {
  console.error("no schemas to generate (SCHEMAS is empty)");
  process.exit(1);
}

if (checkMode) {
  process.exit(runCheck(plans));
} else {
  runWrite(plans);
}
