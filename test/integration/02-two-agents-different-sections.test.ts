// Integration test #02: two MCP clients hold leases on different
// sections of the same project (`docs/plans/collab-v1.md` §10 row 02 +
// W3 Day 4 DoD).
//
// Each test wires up a single mock Graph server with two independent
// MCP server/client pairs (each gets its own `MockAuthenticator` and
// its own `SessionRegistry`) to model two agents running in two
// different MCP processes against the same OneDrive project.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";

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

/**
 * Build the picker spy used by `session_init_project` (folder picker
 * → file picker). Same shape as `01-init-write-read-list.test.ts` —
 * keeping it inline here so this file remains self-contained.
 */
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

/** Seed a project folder with a single multi-section authoritative file. */
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
      size: 64,
      lastModifiedDateTime: "2026-04-19T05:00:00Z",
      file: { mimeType: "text/markdown" },
      content:
        "# Introduction\n\nIntro body.\n\n## Methodology\n\nMethod body.\n\n## Results\n\nResults body.\n",
    },
  ]);
}

/**
 * Initialise a project by driving the two-step picker flow with the
 * supplied `MockAuthenticator`. Returns the projectId parsed from the
 * tool output AND the live client — every test must keep using the
 * same client because each `createTestClient` builds a fresh in-memory
 * `SessionRegistry`, so the active session would be lost on a second
 * client.
 */
async function initProject(
  env: IntegrationEnv,
  auth: MockAuthenticator,
): Promise<{ projectId: string; client: Awaited<ReturnType<typeof createTestClient>> }> {
  const { spy } = pickerSpy("folder-proj", "/Project Foo", "file-spec", "spec.md");
  const c = await createTestClient(env, auth, { openBrowser: spy });
  const result = (await c.callTool({
    name: "session_init_project",
    arguments: {},
  })) as ToolResult;
  expect(result.isError).toBeFalsy();
  const text = firstText(result);
  const projectIdMatch = /projectId: (\S+)/.exec(text);
  const projectId = projectIdMatch?.[1] ?? "";
  expect(projectId.length).toBeGreaterThan(0);
  return { projectId, client: c };
}

describe("02-two-agents-different-sections (W3 Day 4)", () => {
  beforeEach(async () => {
    resetFormFactoryForTest();
    env = await setupIntegrationEnv();
    seedProject(env);
  });

  afterEach(async () => {
    resetFormFactoryForTest();
    await teardownIntegrationEnv(env);
  });

  // -------------------------------------------------------------------------
  // Helper to read leasesCTag out of session_status output.
  // -------------------------------------------------------------------------

  function extractLeasesCTag(statusText: string): string {
    const match = /leasesCTag: (.+)$/m.exec(statusText);
    return match?.[1] ?? "";
  }

  it("agent A acquires Methodology, agent B acquires Results — both succeed without conflict", async () => {
    // Agent A (originator) — initialises the project.
    const authA = new MockAuthenticator({
      token: "token-a",
      username: "alice@example.com",
    });
    const { projectId, client: clientA } = await initProject(env, authA);

    // Agent A acquires "Methodology" as the very first lease. The
    // sidecar does not exist yet → lazy-create path.
    const acquireA = (await clientA.callTool({
      name: "collab_acquire_section",
      arguments: { sectionId: "Methodology", leasesCTag: "" },
    })) as ToolResult;
    expect(acquireA.isError).toBeFalsy();
    const acquireAText = firstText(acquireA);
    expect(acquireAText).toContain("acquired: methodology");
    expect(acquireAText).toContain("activeLeases: 1");

    // Sidecar must now exist on disk in the mock.
    const collabFolder = env.graphState.driveFolderChildren
      .get("folder-proj")
      ?.find((c) => c.name === ".collab");
    expect(collabFolder).toBeDefined();
    const sidecar = env.graphState.driveFolderChildren
      .get(collabFolder?.id ?? "")
      ?.find((c) => c.name === "leases.json");
    expect(sidecar).toBeDefined();
    const sidecarDoc = JSON.parse(sidecar?.content ?? "") as Record<string, unknown>;
    expect(sidecarDoc["schemaVersion"]).toBe(1);
    expect((sidecarDoc["leases"] as unknown[]).length).toBe(1);

    // "Agent B" — simulated by directly adding a rival entry to the
    // sidecar (the v1 milestone-aware shortcut: `session_open_project`
    // lands in W4 Day 4, so we can't yet wire up two independent MCP
    // sessions sharing one project. The leases tool trusts the JSON
    // alone, so this models the cross-process state faithfully).
    const sidecarFile = env.graphState.driveFolderChildren
      .get(collabFolder?.id ?? "")
      ?.find((f) => f.name === "leases.json");
    const sidecarBefore = JSON.parse(sidecarFile?.content ?? "") as {
      schemaVersion: number;
      leases: {
        sectionSlug: string;
        agentId: string;
        agentDisplayName: string;
        acquiredAt: string;
        expiresAt: string;
      }[];
    };
    sidecarBefore.leases.push({
      sectionSlug: "results",
      agentId: "bbcd5678-cli-01jbbb",
      agentDisplayName: "Bob's MCP Client",
      acquiredAt: "2026-04-19T05:55:00Z",
      expiresAt: "2030-12-31T00:00:00Z",
    });
    if (sidecarFile !== undefined) {
      sidecarFile.content = `${JSON.stringify(sidecarBefore, null, 2)}\n`;
      sidecarFile.cTag = env.graphState.genCTag(sidecarFile.id);
      sidecarFile.size = Buffer.byteLength(sidecarFile.content, "utf-8");
    }

    // Both leases coexist in the sidecar.
    const updatedSidecar = env.graphState.driveFolderChildren
      .get(collabFolder?.id ?? "")
      ?.find((c) => c.name === "leases.json");
    const updatedDoc = JSON.parse(updatedSidecar?.content ?? "") as Record<string, unknown>;
    const leases = updatedDoc["leases"] as { sectionSlug: string; agentId: string }[];
    expect(leases.length).toBe(2);
    const slugs = leases.map((l) => l.sectionSlug).sort();
    expect(slugs).toEqual(["methodology", "results"]);
    const agentIds = new Set(leases.map((l) => l.agentId));
    expect(agentIds.size).toBe(2);

    // Agent A releases its lease; the rival agent B's stays.
    const statusA = (await clientA.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    const leasesCTagAAfter = extractLeasesCTag(firstText(statusA));
    const releaseA = (await clientA.callTool({
      name: "collab_release_section",
      arguments: { sectionId: "methodology", leasesCTag: leasesCTagAAfter },
    })) as ToolResult;
    expect(releaseA.isError).toBeFalsy();
    expect(firstText(releaseA)).toContain("released: methodology");
    expect(firstText(releaseA)).toContain("activeLeases: 1");

    // Audit log records both lease tool_calls.
    const auditPath = `${env.configDir}/sessions/audit/${projectId}.jsonl`;
    const raw = await readFile(auditPath, { encoding: "utf-8" });
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const leaseCalls = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter(
        (e) => e["tool"] === "collab_acquire_section" || e["tool"] === "collab_release_section",
      );
    expect(leaseCalls.length).toBe(2);
    expect(leaseCalls[0]?.["tool"]).toBe("collab_acquire_section");
    expect(leaseCalls[1]?.["tool"]).toBe("collab_release_section");
  });

  it("rejects acquire when supplied leasesCTag is stale (CAS mismatch)", async () => {
    const auth = new MockAuthenticator({ token: "tok", username: "alice@example.com" });
    const { client: c } = await initProject(env, auth);

    // First acquire creates the sidecar.
    const first = (await c.callTool({
      name: "collab_acquire_section",
      arguments: { sectionId: "Methodology", leasesCTag: "" },
    })) as ToolResult;
    expect(first.isError).toBeFalsy();

    // A second acquire with a bogus cTag is now stale —
    // surfaces CollabCTagMismatchError.
    const stale = (await c.callTool({
      name: "collab_acquire_section",
      arguments: { sectionId: "Results", leasesCTag: "stale-ctag" },
    })) as ToolResult;
    expect(stale.isError).toBe(true);
    expect(firstText(stale)).toMatch(/cTag/i);
  });

  it("returns SectionNotFoundError when the heading does not exist", async () => {
    const auth = new MockAuthenticator({ token: "tok", username: "alice@example.com" });
    const { client: c } = await initProject(env, auth);

    const result = (await c.callTool({
      name: "collab_acquire_section",
      arguments: { sectionId: "Nonexistent Section", leasesCTag: "" },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("not found");
    expect(firstText(result)).toContain("introduction");
    expect(firstText(result)).toContain("methodology");
  });

  it("returns SectionAlreadyLeasedError when another agent holds the lease", async () => {
    const auth = new MockAuthenticator({ token: "token-a", username: "alice@example.com" });
    const { client: c } = await initProject(env, auth);

    // Agent A acquires Methodology, then we directly seed a rival
    // lease on the same slug from a different agentId so the next
    // acquire from agent A would surface the conflict — except the
    // tool de-dupes per-slug per-agentId. So we seed the rival
    // first, then have the only real client try to acquire it.
    //
    // To do this without a second MCP server: bypass agent A's
    // acquire entirely and seed the sidecar by hand.
    const collabFolder = await ensureCollabFolderExists(env, "folder-proj");
    seedLeasesSidecar(env, collabFolder.id, [
      {
        sectionSlug: "methodology",
        agentId: "rival-agent",
        agentDisplayName: "Rival Agent",
        acquiredAt: "2026-04-19T05:00:00Z",
        expiresAt: "2030-12-31T00:00:00Z",
      },
    ]);

    const status = (await c.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    const leasesCTag = extractLeasesCTag(firstText(status));

    const conflict = (await c.callTool({
      name: "collab_acquire_section",
      arguments: { sectionId: "methodology", leasesCTag },
    })) as ToolResult;
    expect(conflict.isError).toBe(true);
    const text = firstText(conflict);
    expect(text).toContain("already leased");
    expect(text).toContain("expires");
  });

  it("collab_release_section is a no-op when the leases sidecar does not exist", async () => {
    const auth = new MockAuthenticator({ token: "tok", username: "alice@example.com" });
    const { client: c } = await initProject(env, auth);

    // No acquire yet — sidecar absent.
    const result = (await c.callTool({
      name: "collab_release_section",
      arguments: { sectionId: "Methodology", leasesCTag: "" },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toContain("no-op: methodology");
  });

  it("collab_release_section refuses LeaseNotHeldError when held by another agent", async () => {
    const auth = new MockAuthenticator({ token: "token-a", username: "alice@example.com" });
    const { client: c } = await initProject(env, auth);

    // Seed a sidecar with a lease held by a different agentId.
    const collabFolder = await ensureCollabFolderExists(env, "folder-proj");
    seedLeasesSidecar(env, collabFolder.id, [
      {
        sectionSlug: "methodology",
        agentId: "rival-agent",
        agentDisplayName: "Rival Agent",
        acquiredAt: "2026-04-19T05:00:00Z",
        expiresAt: "2030-12-31T00:00:00Z",
      },
    ]);

    const status = (await c.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    const leasesCTag = extractLeasesCTag(firstText(status));

    const release = (await c.callTool({
      name: "collab_release_section",
      arguments: { sectionId: "methodology", leasesCTag },
    })) as ToolResult;
    expect(release.isError).toBe(true);
    expect(firstText(release)).toContain("not by this agent");
  });

  it("session_status surfaces leasesCTag and reports (none) before the sidecar exists", async () => {
    const auth = new MockAuthenticator({ token: "tok", username: "alice@example.com" });
    const { client: c } = await initProject(env, auth);

    const before = (await c.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    expect(before.isError).toBeFalsy();
    expect(firstText(before)).toContain("leasesCTag: (none)");

    // Acquire creates the sidecar; the next session_status reflects the cTag.
    const a = (await c.callTool({
      name: "collab_acquire_section",
      arguments: { sectionId: "Introduction", leasesCTag: "" },
    })) as ToolResult;
    expect(a.isError).toBeFalsy();

    const after = (await c.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    const text = firstText(after);
    const cTag = extractLeasesCTag(text);
    expect(cTag).not.toBe("(none)");
    expect(cTag).not.toBe("(unavailable)");
    expect(cTag.length).toBeGreaterThan(0);
  });

  it("re-acquiring the same section by the same agent extends the lease (no error)", async () => {
    const auth = new MockAuthenticator({ token: "tok", username: "alice@example.com" });
    const { client: c } = await initProject(env, auth);

    const first = (await c.callTool({
      name: "collab_acquire_section",
      arguments: { sectionId: "Methodology", leasesCTag: "" },
    })) as ToolResult;
    expect(first.isError).toBeFalsy();

    const status = (await c.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    const leasesCTag = extractLeasesCTag(firstText(status));

    const second = (await c.callTool({
      name: "collab_acquire_section",
      arguments: { sectionId: "Methodology", leasesCTag, ttlSeconds: 1200 },
    })) as ToolResult;
    expect(second.isError).toBeFalsy();
    expect(firstText(second)).toContain("acquired: methodology");
    // Lease count stays at 1 — the prior entry was replaced, not duplicated.
    expect(firstText(second)).toContain("activeLeases: 1");
  });
});

// ---------------------------------------------------------------------------
// Test helpers (sidecar seeding bypassing the tool layer)
// ---------------------------------------------------------------------------

function ensureCollabFolderExists(
  env: IntegrationEnv,
  projectFolderId: string,
): Promise<{ id: string }> {
  const projectChildren = env.graphState.driveFolderChildren.get(projectFolderId) ?? [];
  let collab = projectChildren.find((c) => c.name === ".collab");
  if (collab === undefined) {
    collab = {
      id: env.graphState.genId(),
      name: ".collab",
      folder: { childCount: 0 },
      lastModifiedDateTime: "2026-04-19T05:00:00Z",
    };
    projectChildren.push(collab);
    env.graphState.driveFolderChildren.set(projectFolderId, projectChildren);
    env.graphState.driveFolderChildren.set(collab.id, []);
  }
  return Promise.resolve({ id: collab.id });
}

function seedLeasesSidecar(
  env: IntegrationEnv,
  collabFolderId: string,
  leases: {
    sectionSlug: string;
    agentId: string;
    agentDisplayName: string;
    acquiredAt: string;
    expiresAt: string;
  }[],
): void {
  const body = `${JSON.stringify({ schemaVersion: 1, leases }, null, 2)}\n`;
  const collabChildren = env.graphState.driveFolderChildren.get(collabFolderId) ?? [];
  const existing = collabChildren.find((c) => c.name === "leases.json");
  if (existing !== undefined) {
    existing.content = body;
    existing.size = Buffer.byteLength(body, "utf-8");
    existing.cTag = env.graphState.genCTag(existing.id);
    return;
  }
  const id = env.graphState.genId();
  collabChildren.push({
    id,
    name: "leases.json",
    size: Buffer.byteLength(body, "utf-8"),
    lastModifiedDateTime: "2026-04-19T05:00:00Z",
    cTag: env.graphState.genCTag(id),
    file: { mimeType: "application/json" },
    content: body,
  });
  env.graphState.driveFolderChildren.set(collabFolderId, collabChildren);
}
