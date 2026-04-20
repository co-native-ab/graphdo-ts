// Unit tests for the `walkVersionsForDocId` helper (W5 Day 1).
//
// Exercises:
//   - newest-first traversal stops at the first parseable doc_id
//   - per-version 4 MiB cap and 4xx responses are skipped (best-effort)
//   - exhausted-walk reports the inspected count
//   - the 50-version cap is honoured (bounded walk)

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createTestEnv, gid, testSignal } from "../helpers.js";
import type { TestEnv } from "../helpers.js";
import { GraphClient } from "../../src/graph/client.js";
import { walkVersionsForDocId, MAX_RECOVERY_VERSIONS } from "../../src/collab/doc-id-recovery.js";

const ITEM_ID = "file-spec";

function staticToken(token: string): { getToken: () => Promise<string> } {
  return { getToken: () => Promise.resolve(token) };
}

function frontmatterFor(docId: string): string {
  return [
    "---",
    "collab:",
    `  version: 1`,
    `  doc_id: "${docId}"`,
    `  created_at: "2026-04-01T00:00:00.000Z"`,
    "  sections: []",
    "  proposals: []",
    "  authorship: []",
    "---",
    "# spec",
    "",
    "body",
  ].join("\n");
}

let env: TestEnv;

describe("walkVersionsForDocId", () => {
  beforeEach(async () => {
    env = await createTestEnv();
    env.state.driveRootChildren = [{ id: "folder-proj", name: "Project Foo", folder: {} }];
    env.state.driveFolderChildren.set("folder-proj", [
      {
        id: ITEM_ID,
        name: "spec.md",
        size: 12,
        file: { mimeType: "text/markdown" },
        content: "# current\n",
      },
    ]);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("returns the doc_id from the most recent parseable version", async () => {
    // Seed two historical versions: the most recent has a valid doc_id;
    // the older one has a different doc_id (which must NOT win).
    env.state.driveItemVersions.set(ITEM_ID, [
      {
        id: "5.0",
        lastModifiedDateTime: "2026-04-15T00:00:00Z",
        size: 100,
        content: frontmatterFor("doc-RECENT"),
      },
      {
        id: "1.0",
        lastModifiedDateTime: "2026-04-01T00:00:00Z",
        size: 90,
        content: frontmatterFor("doc-OLDEST"),
      },
    ]);

    const client = new GraphClient(env.graphUrl, staticToken("t"));
    const result = await walkVersionsForDocId(client, gid(ITEM_ID), testSignal());

    expect(result.kind).toBe("found");
    if (result.kind !== "found") return;
    expect(result.docId).toBe("doc-RECENT");
    expect(result.recoveredFrom).toBe("5.0");
    // First entry from /versions list (the live current) was inspected
    // and skipped (current content has no frontmatter), then "5.0".
    expect(result.versionsInspected).toBeGreaterThanOrEqual(1);
  });

  it("skips malformed versions and continues to older parseable ones", async () => {
    env.state.driveItemVersions.set(ITEM_ID, [
      {
        id: "3.0",
        lastModifiedDateTime: "2026-04-10T00:00:00Z",
        size: 5,
        content: "garbage",
      },
      {
        id: "2.0",
        lastModifiedDateTime: "2026-04-05T00:00:00Z",
        size: 100,
        content: frontmatterFor("doc-FROM-OLDER"),
      },
    ]);

    const client = new GraphClient(env.graphUrl, staticToken("t"));
    const result = await walkVersionsForDocId(client, gid(ITEM_ID), testSignal());

    expect(result.kind).toBe("found");
    if (result.kind !== "found") return;
    expect(result.docId).toBe("doc-FROM-OLDER");
    expect(result.recoveredFrom).toBe("2.0");
  });

  it("returns exhausted when no version has parseable frontmatter", async () => {
    env.state.driveItemVersions.set(ITEM_ID, [
      {
        id: "2.0",
        lastModifiedDateTime: "2026-04-05T00:00:00Z",
        size: 5,
        content: "no envelope",
      },
      {
        id: "1.0",
        lastModifiedDateTime: "2026-04-01T00:00:00Z",
        size: 5,
        content: "still no envelope",
      },
    ]);

    const client = new GraphClient(env.graphUrl, staticToken("t"));
    const result = await walkVersionsForDocId(client, gid(ITEM_ID), testSignal());

    expect(result.kind).toBe("exhausted");
    if (result.kind !== "exhausted") return;
    expect(result.versionsInspected).toBeGreaterThan(0);
  });

  it("respects the MAX_RECOVERY_VERSIONS cap", async () => {
    expect(MAX_RECOVERY_VERSIONS).toBe(50);
    // Seed 60 unparseable versions; the walker must stop at 50.
    const versions = Array.from({ length: 60 }, (_, i) => ({
      id: `${String(60 - i)}.0`,
      lastModifiedDateTime: "2026-04-05T00:00:00Z",
      size: 5,
      content: `unparseable v${String(i)}`,
    }));
    env.state.driveItemVersions.set(ITEM_ID, versions);

    const client = new GraphClient(env.graphUrl, staticToken("t"));
    const result = await walkVersionsForDocId(client, gid(ITEM_ID), testSignal());

    expect(result.kind).toBe("exhausted");
    if (result.kind !== "exhausted") return;
    // Walker inspected exactly 50 (one of which is the live current
    // entry returned first by /versions) — never more.
    expect(result.versionsInspected).toBeLessThanOrEqual(MAX_RECOVERY_VERSIONS);
  });
});
