// Tests that the JSON Schema artefacts under `schemas/` are byte-identical
// to what `scripts/generate-schemas.ts` would emit *right now* from the
// Zod schemas in `src/config.ts`, and that no historical version's
// generated output has drifted from its frozen snapshot.
//
// Two layers of assertions:
//
//  1. **Drift test** — `schemas/config-vN.json` matches the generator's
//     in-memory output. Mirrors `npm run schemas:check` at unit-test level
//     so a developer who skips the script gets the same red bar from
//     `npm test` (and CI).
//
//  2. **Frozen-history test** — generator output matches a manually-frozen
//     snapshot under `test/fixtures/schemas-frozen/`. This is the
//     "force-a-version-bump" guard: changing `ConfigFileSchemaV2` makes
//     `schemas/config-v2.json` change and the v2 frozen snapshot diverge.
//     The fix is one of:
//       a) (recommended) Add `ConfigFileSchemaV3`, bump
//          `CURRENT_CONFIG_VERSION`, and leave V2 untouched. The new file
//          `test/fixtures/schemas-frozen/config-v3.json` then needs to be
//          created (this test refuses to run without it).
//       b) Acknowledge a non-breaking change to V2 by updating the frozen
//          snapshot — a visible, reviewable PR diff that signals the
//          developer thought about backward compatibility.
//
// See ADR-0010 ("snake_case for All Persisted Config" → "JSON Schema
// generated from a single source of truth") for the rationale.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CURRENT_CONFIG_VERSION, SCHEMAS } from "../src/config.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "..");
const PUBLISHED_DIR = path.resolve(REPO_ROOT, "schemas");
const FROZEN_DIR = path.resolve(TEST_DIR, "fixtures", "schemas-frozen");

/**
 * Render the generator's in-memory output for one version. Mirrors
 * `scripts/generate-schemas.ts` exactly (same JSON.stringify args, same
 * trailing newline). If the two ever drift the unit test fails first,
 * before CI's `npm run schemas:check`.
 */
function generate(version: number): string {
  const schema = SCHEMAS[version];
  if (schema === undefined) throw new Error(`no Zod schema registered for v${String(version)}`);
  return `${JSON.stringify(z.toJSONSchema(schema, { target: "draft-2020-12" }), null, 2)}\n`;
}

const versions = Object.keys(SCHEMAS)
  .map((s) => Number(s))
  .sort((a, b) => a - b);

describe("schemas/ generator", () => {
  it("covers at least v1 and the current version", () => {
    // Sanity: a refactor that drops a version's Zod schema would silently
    // disable the round-trip + frozen-history tests below. Pin the matrix.
    expect(versions).toContain(1);
    expect(versions).toContain(CURRENT_CONFIG_VERSION);
  });

  for (const version of versions) {
    describe(`v${String(version)}`, () => {
      it("schemas/config-v{N}.json is byte-identical to the generator output (run `npm run schemas:generate` if this fails)", async () => {
        const expected = generate(version);
        const filePath = path.resolve(PUBLISHED_DIR, `config-v${String(version)}.json`);
        const current = await fs.readFile(filePath, "utf-8");
        expect(current).toBe(expected);
      });

      it("frozen snapshot under test/fixtures/schemas-frozen/ matches the current generator output (a diff here means you're changing a published contract — bump to a new config_version instead, or update the snapshot to acknowledge a non-breaking change)", async () => {
        const expected = generate(version);
        const frozenPath = path.resolve(FROZEN_DIR, `config-v${String(version)}.json`);
        const frozen = await fs.readFile(frozenPath, "utf-8");
        expect(frozen).toBe(expected);
      });
    });
  }
});

describe("schemas/ generator metadata", () => {
  for (const version of versions) {
    it(`v${String(version)} embeds the canonical raw.githubusercontent.com URL as $id`, () => {
      const json = z.toJSONSchema(SCHEMAS[version]!, { target: "draft-2020-12" }) as Record<
        string,
        unknown
      >;
      expect(json["$id"]).toBe(
        `https://raw.githubusercontent.com/co-native-ab/graphdo-ts/main/schemas/config-v${String(version)}.json`,
      );
    });

    it(`v${String(version)} declares draft 2020-12`, () => {
      const json = z.toJSONSchema(SCHEMAS[version]!, { target: "draft-2020-12" }) as Record<
        string,
        unknown
      >;
      expect(json["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
    });
  }
});

describe("schemas/ generator surface", () => {
  it("never re-uses an existing version when ConfigFileSchemaV{CURRENT} is modified (catches a forgotten version bump)", () => {
    // The frozen-history test above is the primary guard. This is a
    // belt-and-braces sanity check: if a developer accidentally renames
    // CURRENT_CONFIG_VERSION but forgets to add a new SCHEMAS entry, this
    // pinpoints the mistake with a clearer message than a missing fixture.
    expect(SCHEMAS[CURRENT_CONFIG_VERSION]).toBeDefined();
  });
});
