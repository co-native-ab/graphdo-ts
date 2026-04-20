// Integration test #07: destructive apply proposal
// (`docs/plans/collab-v1.md` §10 row 07 + W4 Day 3 DoD).
//
// Three variants:
//
//   A. Same slug + hash mismatch — the section's content has been
//      rewritten since the proposal was created, but the slug still
//      matches. Authorship trail attributes the section to a human, so
//      the destructive re-prompt must fire. On approve, the apply
//      succeeds, write counter increments, destructive counter
//      increments.
//
//   B. Slug renamed in body, `target_section_content_hash_at_create`
//      still matches an existing section — the slug-drift fallback
//      resolves the target via content hash. `slug_drift_resolved`
//      audit fires; apply proceeds (not destructive in this variant
//      because authorship[] does not attribute the section to anyone
//      else yet).
//
//   C. Neither slug nor hash matches — `SectionAnchorLostError` is
//      raised carrying the old slug + the current heading slugs.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  setupIntegrationEnv,
  teardownIntegrationEnv,
  createTestClient,
  firstText,
  fetchCsrfToken,
  type IntegrationEnv,
  type ToolResult,
} from "./helpers.js";
import { MockAuthenticator } from "../mock-auth.js";
import { resetFormFactoryForTest } from "../../src/tools/collab-forms.js";
import { joinFrontmatter, serializeFrontmatter } from "../../src/collab/frontmatter.js";
import { computeSectionContentHash } from "../../src/collab/authorship.js";

let env: IntegrationEnv;

/**
 * Picker spy that handles the two `session_init_project` selections
 * (folder, then authoritative file) and any number of trailing
 * approve-form clicks. Each subsequent call after the init pair POSTs
 * `id: "approve"` to the picker — matching the destructive /
 * external-source re-prompt forms.
 */
function pickerSpy(
  folderId: string,
  folderLabel: string,
  fileId: string,
  fileLabel: string,
): { spy: (url: string) => Promise<void>; approveCount: { value: number } } {
  let call = 0;
  const approveCount = { value: 0 };
  const spy = (url: string): Promise<void> => {
    const which = call++;
    setTimeout(() => {
      void (async () => {
        const csrfToken = await fetchCsrfToken(url);
        if (which === 0) {
          await fetch(`${url}/select`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: folderId, label: folderLabel, csrfToken }),
          });
          return;
        }
        if (which === 1) {
          await fetch(`${url}/select`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: fileId, label: fileLabel, csrfToken }),
          });
          return;
        }
        approveCount.value += 1;
        await fetch(`${url}/select`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: "approve",
            label: "Approve",
            csrfToken,
          }),
        });
      })();
    }, 150);
    return Promise.resolve();
  };
  return { spy, approveCount };
}

/**
 * Seed the project with `spec.md` carrying a fully-formed `collab:`
 * frontmatter envelope. The `authorship[]` entry attributes the
 * `introduction` section to a human so that {@link classifyAuthorshipMatch}
 * fires the destructive flag in variant A.
 *
 * `bodyOverride` lets variant B replace the body so the live heading
 * differs from the one named on the proposal.
 */
function seedProject(env: IntegrationEnv, bodyOverride?: string): string {
  env.graphState.drive = {
    id: "mock-drive-1",
    driveType: "business",
    webUrl: "https://contoso-my.sharepoint.com/personal/user_contoso_com/Documents",
  };
  env.graphState.driveRootChildren = [
    {
      id: "folder-proj",
      name: "Project Foo",
      folder: {},
      lastModifiedDateTime: "2026-04-19T05:00:00Z",
    },
  ];

  const body = bodyOverride ?? "# Introduction\n\nIntro body.\n";
  // For variant A: hash the *seed* introduction body so the authorship
  // entry's `section_content_hash` matches the live section. The
  // proposal-time hash will differ from the *current* hash by the time
  // the apply runs (variant A specifically tests slug-match + hash-
  // mismatch destructive).
  const introBody = "\nIntro body.\n";
  const introHash = computeSectionContentHash(introBody);
  const fm = serializeFrontmatter({
    collab: {
      version: 1,
      doc_id: "01HXXXXXXXXXXXXXXXXXXXXXXX",
      created_at: "2026-04-19T05:00:00Z",
      sections: [],
      proposals: [],
      authorship: [
        {
          target_section_slug: "introduction",
          section_content_hash: introHash,
          author_kind: "human",
          author_agent_id: "human:alice@example.com",
          author_display_name: "alice@example.com",
          written_at: "2026-04-19T05:00:00Z",
          revision: 1,
        },
      ],
    },
  });
  const content = joinFrontmatter(fm, body);
  env.graphState.driveFolderChildren.set("folder-proj", [
    {
      id: "file-spec",
      name: "spec.md",
      size: content.length,
      lastModifiedDateTime: "2026-04-19T05:00:00Z",
      file: { mimeType: "text/markdown" },
      content,
    },
  ]);
  return content;
}

describe("07-destructive-apply-proposal (W4 Day 3)", () => {
  beforeEach(async () => {
    resetFormFactoryForTest();
    env = await setupIntegrationEnv();
  });

  afterEach(async () => {
    resetFormFactoryForTest();
    await teardownIntegrationEnv(env);
  });

  // -------------------------------------------------------------------------
  // Variant A — same slug, hash mismatch → destructive re-prompt fires
  // -------------------------------------------------------------------------
  it("Variant A: same-slug + human authorship triggers destructive re-prompt; approve applies", async () => {
    seedProject(env);
    const { spy, approveCount } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
    const auth = new MockAuthenticator({ token: "tok", username: "alice@example.com" });
    const client = await createTestClient(env, auth, { openBrowser: spy });

    const init = (await client.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    expect(init.isError).toBeFalsy();

    // Read to capture the cTag for the create-proposal call.
    const read1 = (await client.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const cTag1 = /cTag: (\S+)/.exec(firstText(read1))?.[1];

    const propose = (await client.callTool({
      name: "collab_create_proposal",
      arguments: {
        targetSectionId: "Introduction",
        body: "Tightened intro paragraph.\n",
        rationale: "Less verbose",
        source: "chat",
        authoritativeCTag: cTag1,
      },
    })) as ToolResult;
    expect(propose.isError).toBeFalsy();
    const proposalId = /proposalId: (\S+)/.exec(firstText(propose))?.[1];
    expect(proposalId).toBeDefined();

    // Re-read to get the cTag bumped by create-proposal.
    const read2 = (await client.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const cTag2 = /cTag: (\S+)/.exec(firstText(read2))?.[1];
    expect(cTag2).not.toBe(cTag1);

    const approveBefore = approveCount.value;
    const apply = (await client.callTool({
      name: "collab_apply_proposal",
      arguments: {
        proposalId,
        authoritativeCTag: cTag2,
        intent: "Apply the tightened intro",
      },
    })) as ToolResult;
    expect(apply.isError).toBeFalsy();
    const applyText = firstText(apply);
    expect(applyText).toContain(`applied: proposal ${proposalId ?? ""}`);
    expect(applyText).toContain("targetSectionSlug: introduction");
    expect(applyText).toContain("destructive: true");
    expect(applyText).toContain("slugDriftResolved: false");
    // Destructive re-prompt must have fired exactly once.
    expect(approveCount.value).toBe(approveBefore + 1);

    // Body now contains the proposal's text.
    const spec = env.graphState.driveFolderChildren
      .get("folder-proj")
      ?.find((f) => f.id === "file-spec");
    expect(spec?.content).toContain("Tightened intro paragraph.");
    expect(spec?.content).not.toContain("Intro body.");
    // Frontmatter records the proposal as applied.
    expect(spec?.content).toContain('status: "applied"');

    // Status surfaces incremented destructive counter.
    const status = (await client.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    const statusText = firstText(status);
    expect(statusText).toMatch(/destructive approvals:\s*1\s*\/\s*10/);
  });

  // -------------------------------------------------------------------------
  // Variant B — slug renamed, hash matches → slug_drift_resolved
  // -------------------------------------------------------------------------
  it("Variant B: heading rename between create & apply is recovered via content hash", async () => {
    seedProject(env);
    const { spy } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
    const auth = new MockAuthenticator({ token: "tok", username: "alice@example.com" });
    const client = await createTestClient(env, auth, { openBrowser: spy });

    const init = (await client.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    expect(init.isError).toBeFalsy();

    const read1 = (await client.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const cTag1 = /cTag: (\S+)/.exec(firstText(read1))?.[1];

    // Create the proposal targeting `Introduction` while the heading
    // still slugifies to `introduction`.
    const propose = (await client.callTool({
      name: "collab_create_proposal",
      arguments: {
        targetSectionId: "Introduction",
        body: "Replacement intro.\n",
        rationale: "Rewrite",
        source: "chat",
        authoritativeCTag: cTag1,
      },
    })) as ToolResult;
    expect(propose.isError).toBeFalsy();
    const proposalId = /proposalId: (\S+)/.exec(firstText(propose))?.[1];

    // Out-of-band: rename the heading on the live file from
    // `Introduction` to `Overview`. The body bytes (after the heading
    // line) are unchanged so the recorded
    // `target_section_content_hash_at_create` still matches the renamed
    // section's content.
    const live = env.graphState.driveFolderChildren
      .get("folder-proj")
      ?.find((f) => f.id === "file-spec");
    expect(live).toBeDefined();
    if (live === undefined) throw new Error("seed missing");
    live.content = (live.content ?? "").replace("# Introduction", "# Overview");
    // Bump cTag manually so a subsequent collab_read reflects the
    // rename. The mock server's PUT path bumps cTag automatically; for
    // this synthetic edit we update it ourselves.
    const oldCTag = live.cTag ?? '"{0,1}"';
    const m = /,(\d+)"$/.exec(oldCTag);
    const next = m?.[1] !== undefined ? parseInt(m[1], 10) + 1 : 99;
    live.cTag = `"{rename,${String(next)}}"`;

    const read2 = (await client.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const cTag2 = /cTag: (\S+)/.exec(firstText(read2))?.[1];

    const apply = (await client.callTool({
      name: "collab_apply_proposal",
      arguments: {
        proposalId,
        authoritativeCTag: cTag2,
      },
    })) as ToolResult;
    expect(apply.isError).toBeFalsy();
    const applyText = firstText(apply);
    expect(applyText).toContain("slugDriftResolved: true");
    expect(applyText).toContain("oldSlug: introduction");
    expect(applyText).toContain("newSlug: overview");
    // Body now carries the proposal's content under the renamed heading.
    expect(live.content).toContain("Replacement intro.");
    expect(live.content).not.toContain("Intro body.");
  });

  // -------------------------------------------------------------------------
  // Variant C — neither slug nor hash matches → SectionAnchorLostError
  // -------------------------------------------------------------------------
  it("Variant C: anchor totally lost between create & apply raises SectionAnchorLostError", async () => {
    seedProject(env);
    const { spy } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
    const auth = new MockAuthenticator({ token: "tok", username: "alice@example.com" });
    const client = await createTestClient(env, auth, { openBrowser: spy });

    await client.callTool({ name: "session_init_project", arguments: {} });

    const read1 = (await client.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const cTag1 = /cTag: (\S+)/.exec(firstText(read1))?.[1];

    const propose = (await client.callTool({
      name: "collab_create_proposal",
      arguments: {
        targetSectionId: "Introduction",
        body: "Replacement intro.\n",
        source: "chat",
        authoritativeCTag: cTag1,
      },
    })) as ToolResult;
    expect(propose.isError).toBeFalsy();
    const proposalId = /proposalId: (\S+)/.exec(firstText(propose))?.[1];

    // Rewrite the body to replace both the heading and the body — both
    // anchors (slug + hash) are gone.
    const live = env.graphState.driveFolderChildren
      .get("folder-proj")
      ?.find((f) => f.id === "file-spec");
    if (live === undefined) throw new Error("seed missing");
    const split = (live.content ?? "").split("---\n");
    // Keep the frontmatter envelope (first two `---` segments), replace
    // the body completely.
    const newContent = `${split[0] ?? ""}---\n${split[1] ?? ""}---\n# Goals\n\nNew prose.\n`;
    live.content = newContent;
    const m = /,(\d+)"$/.exec(live.cTag ?? '"{0,1}"');
    const next = m?.[1] !== undefined ? parseInt(m[1], 10) + 1 : 99;
    live.cTag = `"{rewrite,${String(next)}}"`;

    const read2 = (await client.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const cTag2 = /cTag: (\S+)/.exec(firstText(read2))?.[1];

    const apply = (await client.callTool({
      name: "collab_apply_proposal",
      arguments: {
        proposalId,
        authoritativeCTag: cTag2,
      },
    })) as ToolResult;
    expect(apply.isError).toBe(true);
    const text = firstText(apply);
    expect(text).toContain("Cannot apply proposal");
    expect(text).toContain("introduction");
    // Body remains unchanged from the rewrite — no apply happened.
    expect(live.content).toContain("New prose.");
    expect(live.content).not.toContain("Replacement intro.");
  });
});
