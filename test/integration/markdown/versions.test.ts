// Integration tests: version history & diff

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

import {
  setupIntegrationEnv,
  teardownIntegrationEnv,
  firstText,
  MockAuthenticator,
  createMcpServer,
  InMemoryTransport,
  Client,
  testSignal,
  saveConfig,
  type IntegrationEnv,
  type ToolResult,
} from "../helpers.js";
import { seedDrive } from "./_helpers.js";

let env: IntegrationEnv;

describe("integration: markdown — version history & diff", () => {
  beforeAll(async () => {
    env = await setupIntegrationEnv();
  });

  afterAll(async () => {
    await teardownIntegrationEnv(env);
  });

  beforeEach(() => {
    seedDrive(env);
  });

  describe("with configured root folder", () => {
    let configDir: string;
    let c: Client;

    beforeEach(async () => {
      configDir = await mkdtemp(path.join(tmpdir(), "graphdo-md-"));
      await saveConfig(
        {
          workspace: {
            driveId: "me",
            itemId: "folder-1",
            driveName: "OneDrive",
            itemName: "Notes",
            itemPath: "/Notes",
          },
        },
        configDir,
        testSignal(),
      );

      const auth = new MockAuthenticator({ token: "md-ops-token" });
      const server = await createMcpServer(
        {
          authenticator: auth,
          graphBaseUrl: env.graphUrl,
          configDir,
          openBrowser: () => Promise.reject(new Error("no browser in tests")),
        },
        testSignal(),
      );
      const [ct, st] = InMemoryTransport.createLinkedPair();
      c = new Client({ name: "test", version: "1.0" });
      await server.connect(st);
      await c.connect(ct);
    });

    afterEach(async () => {
      await rm(configDir, { recursive: true, force: true });
    });

    describe("version history", () => {
      it("markdown_list_file_versions shows the current version for an untouched file", async () => {
        // Real OneDrive includes the current version as the first entry even
        // when the file has never been overwritten.
        const r = (await c.callTool({
          name: "markdown_list_file_versions",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        expect(r.isError).toBeFalsy();
        const text = firstText(r);
        expect(text).toContain("hello.md");
        expect(text).toMatch(/Total: 1 version\(s\)/);
      });

      it("markdown_list_file_versions lists current and historical snapshots after overwriting updates", async () => {
        // Two updates create two historical snapshots plus the current version.
        const get1 = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const cTag1 = /cTag: (".+?")/.exec(firstText(get1))![1]!;
        const upd1 = (await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "hello.md", cTag: cTag1, content: "v2" },
        })) as ToolResult;
        const cTag2 = /cTag: (".+?")/.exec(firstText(upd1))![1]!;
        await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "hello.md", cTag: cTag2, content: "v3" },
        });

        const r = (await c.callTool({
          name: "markdown_list_file_versions",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        expect(r.isError).toBeFalsy();
        const text = firstText(r);
        expect(text).toContain("hello.md");
        // Current version (v3) + two historical snapshots (v2 + original).
        expect(text).toMatch(/Total: 3 version\(s\)/);
        expect(text).toContain("markdown_get_file_version");
      });

      it("markdown_get_file_version returns the historical content", async () => {
        const get = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const cTag = /cTag: (".+?")/.exec(firstText(get))![1]!;
        await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "hello.md", cTag, content: "updated" },
        });

        const list = (await c.callTool({
          name: "markdown_list_file_versions",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const listText = firstText(list);
        // After one overwrite: line 1 = current version, line 2 = prior snapshot.
        // Extract the second "2. <versionId> — ..." entry for the historical version.
        const match = /^2\. (\S+) —/m.exec(listText);
        expect(match).not.toBeNull();
        const versionId = match?.[1];
        if (!versionId) throw new Error("expected to parse a versionId from list output");

        const r = (await c.callTool({
          name: "markdown_get_file_version",
          arguments: { fileName: "hello.md", versionId },
        })) as ToolResult;
        expect(r.isError).toBeFalsy();
        const body = firstText(r);
        expect(body).toContain(`Version: ${versionId}`);
        // The original seeded content before the overwrite was "hello".
        expect(body).toContain("hello");
        expect(body).not.toContain("updated");
      });

      it("markdown_get_file_version errors with an unknown versionId", async () => {
        const r = (await c.callTool({
          name: "markdown_get_file_version",
          arguments: { fileName: "hello.md", versionId: "does-not-exist" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
      });

      it("markdown_get_file_version works when the current version id (from list) is supplied", async () => {
        // An agent may pick up the current version ID from markdown_list_file_versions
        // and then pass it to markdown_get_file_version. This should succeed by
        // falling back to the /content endpoint (OneDrive rejects /versions/{id}/content
        // for the current version).
        const list = (await c.callTool({
          name: "markdown_list_file_versions",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        // Line 1 is the current version (newest first).
        const match = /^1\. (\S+) —/m.exec(firstText(list));
        const currentVersionId = match?.[1];
        if (!currentVersionId) throw new Error("expected to parse a versionId from list output");

        const r = (await c.callTool({
          name: "markdown_get_file_version",
          arguments: { fileName: "hello.md", versionId: currentVersionId },
        })) as ToolResult;
        expect(r.isError).toBeFalsy();
        const body = firstText(r);
        expect(body).toContain(`Version: ${currentVersionId}`);
        expect(body).toContain("(current version content)");
        expect(body).not.toContain("historical content");
        expect(body).toContain("hello"); // seeded content
      });

      it("markdown_list_file_versions requires itemId or fileName", async () => {
        const r = (await c.callTool({
          name: "markdown_list_file_versions",
          arguments: {},
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r)).toContain("Either itemId or fileName");
      });

      it("markdown_list_file_versions rejects a subdirectory", async () => {
        env.graphState.driveFolderChildren.set("folder-1", [
          { id: "sub", name: "archive", folder: {} },
        ]);
        const r = (await c.callTool({
          name: "markdown_list_file_versions",
          arguments: { itemId: "sub" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r).toLowerCase()).toContain("subdirectory");
      });
    });

    describe("current revision + diff", () => {
      function extract(label: string, text: string): string {
        // Lines look like `Revision: abc` / `Current Revision: abc` / `Current Revision:    abc`.
        const re = new RegExp(`${label}:\\s*(\\S+)`);
        const m = re.exec(text);
        if (!m?.[1]) throw new Error(`expected to find '${label}' in:\n${text}`);
        return m[1];
      }

      it("markdown_get_file surfaces a non-empty Revision", async () => {
        const r = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        expect(r.isError).toBeFalsy();
        const rev = extract("Revision", firstText(r));
        expect(rev).not.toBe("(none)");
      });

      it("markdown_create_file surfaces a non-empty Revision", async () => {
        const r = (await c.callTool({
          name: "markdown_create_file",
          arguments: { fileName: "brand-new.md", content: "hello" },
        })) as ToolResult;
        expect(r.isError).toBeFalsy();
        extract("Revision", firstText(r));
      });

      it("markdown_update_file bumps the Revision", async () => {
        const get1 = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const get1Text = firstText(get1);
        const origRev = extract("Revision", get1Text);
        const cTag = extract("cTag", get1Text);

        const upd = (await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "hello.md", cTag, content: "body-v2" },
        })) as ToolResult;
        expect(upd.isError).toBeFalsy();
        const newRev = extract("Revision", firstText(upd));
        expect(newRev).not.toBe(origRev);
      });

      it("cTag-mismatch error surfaces the Current Revision and points at the diff tool", async () => {
        const get1 = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const t1 = firstText(get1);
        const staleCTag = extract("cTag", t1);

        // Make a successful update to bump the revision.
        await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "hello.md", cTag: staleCTag, content: "someone-elses-write" },
        });

        // Retry with the OLD cTag → 412 surfaced as agent-facing reconcile guidance.
        const stale = (await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "hello.md", cTag: staleCTag, content: "my-intended-write" },
        })) as ToolResult;
        expect(stale.isError).toBe(true);
        const body = firstText(stale);
        expect(body).toContain("Current Revision:");
        expect(body).toContain("markdown_diff_file_versions");
        expect(body).toContain("fromVersionId");
        expect(body).toContain("toVersionId");
      });

      it("markdown_diff_file_versions produces a unified patch between historical and current", async () => {
        // Read the seeded file to learn its original revision.
        const get1 = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const t1 = firstText(get1);
        const origRev = extract("Revision", t1);
        const cTag = extract("cTag", t1);

        // Overwrite it.
        const upd = (await c.callTool({
          name: "markdown_update_file",
          arguments: {
            fileName: "hello.md",
            cTag,
            content: "hello world, with additions!",
          },
        })) as ToolResult;
        const newRev = extract("Revision", firstText(upd));

        // Diff the two revisions.
        const diff = (await c.callTool({
          name: "markdown_diff_file_versions",
          arguments: {
            fileName: "hello.md",
            fromVersionId: origRev,
            toVersionId: newRev,
          },
        })) as ToolResult;
        expect(diff.isError).toBeFalsy();
        const body = firstText(diff);
        expect(body).toContain(`hello.md@${origRev}`);
        expect(body).toContain(`hello.md@${newRev}`);
        // Unified-diff header lines.
        expect(body).toMatch(/^---/m);
        expect(body).toMatch(/^\+\+\+/m);
        // The old body and the new body both appear with +/- markers.
        expect(body).toContain("-hello");
        expect(body).toContain("+hello world, with additions!");
      });

      it("markdown_diff_file_versions reports 'no content differences' when two revisions hold identical content", async () => {
        // Two updates with the same body produce two distinct revisions whose
        // content is identical.
        const get1 = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const cTag1 = extract("cTag", firstText(get1));

        const upd1 = (await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "hello.md", cTag: cTag1, content: "identical" },
        })) as ToolResult;
        const rev1 = extract("Revision", firstText(upd1));
        const cTag2 = extract("cTag", firstText(upd1));

        const upd2 = (await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "hello.md", cTag: cTag2, content: "identical" },
        })) as ToolResult;
        const rev2 = extract("Revision", firstText(upd2));

        const diff = (await c.callTool({
          name: "markdown_diff_file_versions",
          arguments: { fileName: "hello.md", fromVersionId: rev1, toVersionId: rev2 },
        })) as ToolResult;
        expect(diff.isError).toBeFalsy();
        expect(firstText(diff)).toContain("no content differences");
      });

      it("markdown_diff_file_versions short-circuits when from and to are the same id", async () => {
        const get1 = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const rev = extract("Revision", firstText(get1));

        const diff = (await c.callTool({
          name: "markdown_diff_file_versions",
          arguments: { fileName: "hello.md", fromVersionId: rev, toVersionId: rev },
        })) as ToolResult;
        expect(diff.isError).toBeFalsy();
        expect(firstText(diff)).toContain("same");
      });

      it("markdown_diff_file_versions returns a clear error for an unknown revision id", async () => {
        const get1 = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const rev = extract("Revision", firstText(get1));

        const diff = (await c.callTool({
          name: "markdown_diff_file_versions",
          arguments: { fileName: "hello.md", fromVersionId: "nope", toVersionId: rev },
        })) as ToolResult;
        expect(diff.isError).toBe(true);
        const body = firstText(diff);
        expect(body).toContain("Version nope not found");
        expect(body).toContain("markdown_list_file_versions");
        expect(body).toContain("markdown_get_file");
      });

      it("markdown_diff_file_versions requires itemId or fileName", async () => {
        const r = (await c.callTool({
          name: "markdown_diff_file_versions",
          arguments: { fromVersionId: "a", toVersionId: "b" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r)).toContain("Either itemId or fileName");
      });

      it("markdown_diff_file_versions rejects unsafe names at the schema layer", async () => {
        const r = (await c.callTool({
          name: "markdown_diff_file_versions",
          arguments: { fileName: "../escape.md", fromVersionId: "a", toVersionId: "b" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r).toLowerCase()).toContain("path separator");
      });

      it("markdown_diff_file_versions rejects a subdirectory", async () => {
        env.graphState.driveFolderChildren.set("folder-1", [
          { id: "sub", name: "archive", folder: {} },
        ]);
        const r = (await c.callTool({
          name: "markdown_diff_file_versions",
          arguments: { itemId: "sub", fromVersionId: "a", toVersionId: "b" },
        })) as ToolResult;
        expect(r.isError).toBe(true);
        expect(firstText(r).toLowerCase()).toContain("subdirectory");
      });

      // ---------------------------------------------------------------------
      // Regression: production-typical "drive item omits version" path.
      //
      // Real OneDrive does not include `version` on `GET /me/drive/items/{id}`
      // (or on the response from a content upload), even though `/versions`
      // returns proper IDs. The mock mirrors this behaviour. Without the
      // /versions-fallback in `resolveCurrentRevision`, the agent-facing
      // Revision would read `(none)` / `(unknown)` and the cTag-mismatch
      // diff workflow would be unreachable. These tests lock in the
      // contract end-to-end so any future regression (re-introducing
      // `version` on the mock, or removing the fallback) fails loudly.
      // ---------------------------------------------------------------------

      it("regression: tool output does not leak the bare '(none)' / '(unknown)' placeholder when the drive item omits version", async () => {
        const get = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const getText = firstText(get);
        const cTag = extract("cTag", getText);

        const create = (await c.callTool({
          name: "markdown_create_file",
          arguments: { fileName: "regression-new.md", content: "fresh" },
        })) as ToolResult;

        const upd = (await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "hello.md", cTag, content: "updated" },
        })) as ToolResult;

        for (const r of [get, create, upd]) {
          expect(r.isError).toBeFalsy();
          const text = firstText(r);
          // Old broken state: `Revision: (none)` (drive item didn't surface
          // version, no fallback) → unusable revision string.
          expect(text).not.toMatch(/Revision:\s*\(none\)/);
          // New unresolvable state would hint at list_file_versions; assert
          // the fallback succeeded so we get a real revision instead.
          expect(text).not.toMatch(/Revision:\s*\(unknown/);
        }
      });

      it("regression: Revision reported by markdown_get_file matches the current /versions entry returned by markdown_list_file_versions", async () => {
        const get = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const reportedRev = extract("Revision", firstText(get));

        const versions = (await c.callTool({
          name: "markdown_list_file_versions",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        // The list output renders revisions one per line; the current
        // version is the first (newest) entry. Ensure the bare ID appears
        // somewhere in the listing — and crucially is the same value that
        // markdown_get_file surfaced.
        expect(versions.isError).toBeFalsy();
        const versionsBody = firstText(versions);
        expect(versionsBody).toContain(reportedRev);
      });

      it("regression: Revision reported by markdown_create_file / markdown_update_file is usable as fromVersionId in markdown_diff_file_versions", async () => {
        // Create → revision A; update → revision B; diff(A, B) must work
        // end-to-end even though the underlying drive item omits `version`
        // on every Graph response.
        const create = (await c.callTool({
          name: "markdown_create_file",
          arguments: { fileName: "regression-roundtrip.md", content: "v1\n" },
        })) as ToolResult;
        expect(create.isError).toBeFalsy();
        const revA = extract("Revision", firstText(create));
        const cTag = extract("cTag", firstText(create));

        const upd = (await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "regression-roundtrip.md", cTag, content: "v2\n" },
        })) as ToolResult;
        expect(upd.isError).toBeFalsy();
        const revB = extract("Revision", firstText(upd));
        expect(revB).not.toBe(revA);

        const diff = (await c.callTool({
          name: "markdown_diff_file_versions",
          arguments: {
            fileName: "regression-roundtrip.md",
            fromVersionId: revA,
            toVersionId: revB,
          },
        })) as ToolResult;
        expect(diff.isError).toBeFalsy();
        const diffBody = firstText(diff);
        expect(diffBody).toContain("-v1");
        expect(diffBody).toContain("+v2");
      });

      it("regression: cTag-mismatch error surfaces a real Current Revision (not '(unknown)') even though Graph omits item.version", async () => {
        const get1 = (await c.callTool({
          name: "markdown_get_file",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        const staleCTag = extract("cTag", firstText(get1));

        await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "hello.md", cTag: staleCTag, content: "concurrent-write" },
        });

        const stale = (await c.callTool({
          name: "markdown_update_file",
          arguments: { fileName: "hello.md", cTag: staleCTag, content: "stale-write" },
        })) as ToolResult;
        expect(stale.isError).toBe(true);
        const body = firstText(stale);
        // The Current Revision line must carry an actual revision ID, not
        // a placeholder. Without the /versions fallback this would read
        // `Current Revision: (unknown)`.
        expect(body).toMatch(/Current Revision:\s+(?!\(unknown)\S/);
        const errRev = extract("Current Revision", body);
        // And it must be the same ID surfaced by /versions.
        const versions = (await c.callTool({
          name: "markdown_list_file_versions",
          arguments: { fileName: "hello.md" },
        })) as ToolResult;
        expect(firstText(versions)).toContain(errRev);
      });
    });
  });
});
