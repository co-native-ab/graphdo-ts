// Integration test #03: cTag-mismatch → proposal fallback
// (`docs/plans/collab-v1.md` §10 row 03 + W4 Day 2 DoD).
//
// Single MCP client, single project. Agent "A" writes the authoritative
// file successfully (which bumps the cTag). Agent "B" — modelled here
// as the same client re-issuing a write but with the *original* (now
// stale) cTag and `conflictMode: "proposal"` — must NOT overwrite the
// authoritative body. Instead the tool should:
//
//   1. Write the agent's content to `/proposals/<ulid>.md`.
//   2. Append a `proposals[]` entry to the authoritative frontmatter
//      (using the live cTag from the 412), leaving the body untouched.
//   3. Return success with `kind: diverted` and the new proposalId.
//
// W4 Day 4 (`session_open_project`) has not landed yet, so two
// independent MCP sessions sharing one project is not testable. The
// stale-cTag shortcut here exercises the same code path the diversion
// will take when two real agents collide.

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

let env: IntegrationEnv;

function pickerSpy(
  folderId: string,
  folderLabel: string,
  fileId: string,
  fileLabel: string,
): { spy: (url: string) => Promise<void>; captured: { url: string } } {
  const captured = { url: "" };
  let call = 0;
  const spy = (url: string): Promise<void> => {
    captured.url = url;
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
        }
      })();
    }, 150);
    return Promise.resolve();
  };
  return { spy, captured };
}

function seedProject(env: IntegrationEnv): void {
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
  env.graphState.driveFolderChildren.set("folder-proj", [
    {
      id: "file-spec",
      name: "spec.md",
      size: 32,
      lastModifiedDateTime: "2026-04-19T05:00:00Z",
      file: { mimeType: "text/markdown" },
      content: "# Introduction\n\nIntro body.\n",
    },
  ]);
}

describe("03-cTag-mismatch-proposal-fallback (W4 Day 2)", () => {
  beforeEach(async () => {
    resetFormFactoryForTest();
    env = await setupIntegrationEnv();
    seedProject(env);
  });

  afterEach(async () => {
    resetFormFactoryForTest();
    await teardownIntegrationEnv(env);
  });

  it("diverts agent B's stale-cTag write to /proposals/ and leaves the body unchanged", async () => {
    const { spy } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
    const auth = new MockAuthenticator({ token: "tok", username: "alice@example.com" });
    const client = await createTestClient(env, auth, { openBrowser: spy });

    const init = (await client.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    expect(init.isError).toBeFalsy();

    // Capture the original cTag (the one Agent B will use, stale).
    const read = (await client.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const originalCTag = /cTag: (\S+)/.exec(firstText(read))?.[1];
    expect(originalCTag).toBeDefined();

    // Agent A writes successfully — this bumps the cTag.
    const writeA = (await client.callTool({
      name: "collab_write",
      arguments: {
        path: "spec.md",
        content: "# Introduction\n\nAgent A's update.\n",
        cTag: originalCTag,
        source: "chat",
      },
    })) as ToolResult;
    expect(writeA.isError).toBeFalsy();
    expect(firstText(writeA)).toContain("kind: replaced");

    // Confirm the body was written.
    const specAfterA = env.graphState.driveFolderChildren
      .get("folder-proj")
      ?.find((f) => f.id === "file-spec");
    expect(specAfterA?.content).toContain("Agent A's update.");
    const cTagAfterA = specAfterA?.cTag;
    expect(cTagAfterA).not.toBe(originalCTag);

    // Agent B writes with the STALE cTag and conflictMode: "proposal".
    // The diversion path must:
    //   - NOT overwrite the body,
    //   - create a /proposals/<ulid>.md file,
    //   - append a proposals[] entry to the frontmatter,
    //   - return success with kind: diverted + a proposalId.
    const writeB = (await client.callTool({
      name: "collab_write",
      arguments: {
        path: "spec.md",
        content: "# Introduction\n\nAgent B's competing edit.\n",
        cTag: originalCTag,
        source: "chat",
        conflictMode: "proposal",
        intent: "Agent B disagrees and proposes an alternative",
      },
    })) as ToolResult;
    expect(writeB.isError).toBeFalsy();
    const writeBText = firstText(writeB);
    expect(writeBText).toContain("kind: diverted");
    expect(writeBText).toMatch(/proposalId: [0-9A-HJKMNP-TV-Z]{26}/);
    expect(writeBText).toContain("diverted: spec.md → proposals/");
    const proposalIdMatch = /proposalId: (\S+)/.exec(writeBText);
    const proposalId = proposalIdMatch?.[1];
    expect(proposalId).toBeDefined();

    // Body must be UNCHANGED from after Agent A — no overwrite.
    const specAfterB = env.graphState.driveFolderChildren
      .get("folder-proj")
      ?.find((f) => f.id === "file-spec");
    expect(specAfterB?.content).toContain("Agent A's update.");
    expect(specAfterB?.content).not.toContain("Agent B's competing edit.");
    // …but the frontmatter has been refreshed (proposals[] appended), so
    // the cTag has bumped from cTagAfterA.
    expect(specAfterB?.cTag).not.toBe(cTagAfterA);

    // Proposal file exists under /proposals/ with the agent's content.
    const proposalsFolder = env.graphState.driveFolderChildren
      .get("folder-proj")
      ?.find((f) => f.name === "proposals");
    expect(proposalsFolder).toBeDefined();
    const proposalFile = env.graphState.driveFolderChildren
      .get(proposalsFolder?.id ?? "")
      ?.find((f) => f.name === `${proposalId ?? ""}.md`);
    expect(proposalFile).toBeDefined();
    expect(proposalFile?.content).toBe("# Introduction\n\nAgent B's competing edit.\n");

    // Authoritative frontmatter must now carry a proposals[] entry
    // referencing the new proposal.
    expect(specAfterB?.content).toMatch(/proposals:/);
    expect(specAfterB?.content).toContain(proposalId ?? "");
    expect(specAfterB?.content).toContain('status: "open"');
    expect(specAfterB?.content).toContain('source: "chat"');
    expect(specAfterB?.content).toContain('target_section_slug: "__preamble__"');
  });

  it("collab_create_proposal happy path — targets a real heading and updates frontmatter", async () => {
    const { spy } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
    const auth = new MockAuthenticator({ token: "tok", username: "alice@example.com" });
    const client = await createTestClient(env, auth, { openBrowser: spy });

    await client.callTool({ name: "session_init_project", arguments: {} });

    // First write to inject a fresh doc_id into the live frontmatter so
    // the proposal helper has a `doc_id` to anchor against (the seed
    // file is plain markdown with no envelope).
    const initialRead = (await client.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const initialCTag = /cTag: (\S+)/.exec(firstText(initialRead))?.[1];
    const seedWrite = (await client.callTool({
      name: "collab_write",
      arguments: {
        path: "spec.md",
        content: "# Introduction\n\nIntro body.\n",
        cTag: initialCTag,
        source: "chat",
      },
    })) as ToolResult;
    expect(seedWrite.isError).toBeFalsy();

    const read = (await client.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const cTag = /cTag: (\S+)/.exec(firstText(read))?.[1];
    expect(cTag).toBeDefined();

    const propose = (await client.callTool({
      name: "collab_create_proposal",
      arguments: {
        targetSectionId: "Introduction",
        body: "Tightened intro paragraph.\n",
        rationale: "Less verbose",
        source: "chat",
        authoritativeCTag: cTag,
      },
    })) as ToolResult;
    expect(propose.isError).toBeFalsy();
    const proposeText = firstText(propose);
    expect(proposeText).toMatch(/proposalId: [0-9A-HJKMNP-TV-Z]{26}/);
    expect(proposeText).toContain("targetSectionSlug: introduction");
    expect(proposeText).toMatch(/targetSectionContentHashAtCreate: sha256:[a-f0-9]{64}/);
    expect(proposeText).toContain("source: chat");

    const proposalId = /proposalId: (\S+)/.exec(proposeText)?.[1];
    const proposalsFolder = env.graphState.driveFolderChildren
      .get("folder-proj")
      ?.find((f) => f.name === "proposals");
    const proposalFile = env.graphState.driveFolderChildren
      .get(proposalsFolder?.id ?? "")
      ?.find((f) => f.name === `${proposalId ?? ""}.md`);
    expect(proposalFile?.content).toBe("Tightened intro paragraph.\n");

    // Authoritative body is unchanged; frontmatter now has the entry.
    const spec = env.graphState.driveFolderChildren
      .get("folder-proj")
      ?.find((f) => f.id === "file-spec");
    expect(spec?.content).toContain("Intro body.");
    expect(spec?.content).toContain('target_section_slug: "introduction"');
    expect(spec?.content).toContain('rationale: "Less verbose"');
  });

  it("collab_create_proposal returns SectionAnchorLostError when the target slug does not exist", async () => {
    const { spy } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
    const auth = new MockAuthenticator({ token: "tok" });
    const client = await createTestClient(env, auth, { openBrowser: spy });

    await client.callTool({ name: "session_init_project", arguments: {} });

    const read = (await client.callTool({
      name: "collab_read",
      arguments: { path: "spec.md" },
    })) as ToolResult;
    const cTag = /cTag: (\S+)/.exec(firstText(read))?.[1] ?? "";

    const propose = (await client.callTool({
      name: "collab_create_proposal",
      arguments: {
        targetSectionId: "Nonexistent Section",
        body: "Body for section that does not exist.\n",
        source: "chat",
        authoritativeCTag: cTag,
      },
    })) as ToolResult;
    expect(propose.isError).toBe(true);
    expect(firstText(propose)).toContain("Cannot apply proposal");

    // No proposals/ folder created when the anchor check refuses early.
    const proposalsFolder = env.graphState.driveFolderChildren
      .get("folder-proj")
      ?.find((f) => f.name === "proposals");
    expect(proposalsFolder).toBeUndefined();
  });
});
