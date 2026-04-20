// Integration test #22 — two MCP server processes on the same Microsoft
// account, distinguished only by the `GRAPHDO_AGENT_PERSONA` override
// (`docs/plans/two-instance-e2e.md`, ADR-0009).
//
// This test models the exact production topology the playbook
// targets: two Copilot CLI MCP server entries (`graphdo-alice` and
// `graphdo-bob`), each pointed at its own `<configDir>` and its own
// persona id, both authenticated as the same OneDrive user, both
// operating against the same shared project folder. The persona id
// must replace the session-derived `<oidPrefix>-<clientSlug>-<sessionPrefix>`
// agentId so the lease sidecar, the destructive classifier, and the
// audit log all see the two instances as distinct collaborators.
//
// Coverage:
//   - Alice (originator) initialises the project. Audit `session_start`
//     carries `mode: "test-persona"` + `agentPersona.id = "persona:alice"`
//     and `agentId = "persona:alice"`.
//   - Bob (collaborator) opens the same project via `session_open_project`.
//     Audit `session_start` carries `agentId = "persona:bob"`.
//   - Both lease different sections; the leases sidecar contains two
//     entries with distinct `agentId` values.
//   - `session_status` on each instance prints the WARN-persona line.
//   - `auth_status` on each instance prints the WARN-persona line.
//   - Both instances share one `userOid` in their audit lines (real
//     user identity preserved).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

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
import type { AgentPersona } from "../../src/persona.js";
import { upsertRecent } from "../../src/collab/projects.js";
import { testSignal } from "../helpers.js";

let env: IntegrationEnv;
let bobConfigDir: string;

const ALICE_PERSONA: AgentPersona = {
  id: "persona:alice",
  rawEnvValue: "persona:alice",
  source: "env",
};
const BOB_PERSONA: AgentPersona = {
  id: "persona:bob",
  rawEnvValue: "persona:bob",
  source: "env",
};

function pickerSpyTwoStep(
  folderId: string,
  folderLabel: string,
  fileId: string,
  fileLabel: string,
): (url: string) => Promise<void> {
  let call = 0;
  return (url: string): Promise<void> => {
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
}

function pickerSpyOpenProject(
  recentOptionId: string,
  label: string,
): (url: string) => Promise<void> {
  return (url: string): Promise<void> => {
    setTimeout(() => {
      void (async () => {
        const csrfToken = await fetchCsrfToken(url);
        await fetch(`${url}/select`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: recentOptionId, label, csrfToken }),
        });
      })();
    }, 150);
    return Promise.resolve();
  };
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
      size: 64,
      lastModifiedDateTime: "2026-04-19T05:00:00Z",
      file: { mimeType: "text/markdown" },
      content:
        "# Introduction\n\nIntro body.\n\n## Methodology\n\nMethod body.\n\n## Results\n\nResults body.\n",
    },
  ]);
  // W4 Day 4 — `session_open_project` pre-flight checks write access.
  // Grant the shared user "write" on the project folder so Bob's open
  // succeeds (in production both Alice + Bob authenticate as the same
  // OneDrive user, so they have the same permissions on the shared
  // folder).
  env.graphState.permissions?.set("folder-proj", [{ id: "perm-1", roles: ["write"] }]);
}

function extractLeasesCTag(statusText: string): string {
  const match = /leasesCTag: (.+)$/m.exec(statusText);
  return match?.[1] ?? "";
}

function readJsonLines(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("22-two-personas-same-config (W6 — two-instance collab E2E)", () => {
  beforeEach(async () => {
    resetFormFactoryForTest();
    env = await setupIntegrationEnv();
    seedProject(env);
    bobConfigDir = await mkdtemp(path.join(tmpdir(), "graphdo-bob-test-"));
  });

  afterEach(async () => {
    resetFormFactoryForTest();
    await teardownIntegrationEnv(env);
    await rm(bobConfigDir, { recursive: true, force: true });
  });

  it("Alice and Bob share one user, different personas, hold distinct leases on different sections", async () => {
    // Alice + Bob share the same Microsoft account → same userOid in
    // every audit envelope. The persona override is what distinguishes
    // them.
    const sharedAuth = new MockAuthenticator({
      token: "shared-token",
      username: "shared@example.com",
    });

    // ---- Alice (originator, persona:alice, configDir A = env.configDir) ----
    const aliceClient = await createTestClient(env, sharedAuth, {
      openBrowser: pickerSpyTwoStep("folder-proj", "/Project Foo", "file-spec", "spec.md"),
      agentPersona: ALICE_PERSONA,
    });

    const aliceInit = (await aliceClient.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    expect(aliceInit.isError).toBeFalsy();
    const aliceInitText = firstText(aliceInit);
    expect(aliceInitText).toContain("agentId: persona:alice");
    const projectIdMatch = /projectId: (\S+)/.exec(aliceInitText);
    const projectId = projectIdMatch?.[1] ?? "";
    expect(projectId.length).toBeGreaterThan(0);

    // session_status on Alice's side surfaces the persona warning.
    const aliceStatus = (await aliceClient.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    expect(aliceStatus.isError).toBeFalsy();
    const aliceStatusText = firstText(aliceStatus);
    expect(aliceStatusText).toContain("WARN: Test persona active: persona:alice");
    expect(aliceStatusText).toContain("agentId: persona:alice");

    // auth_status surfaces the persona warning too.
    const aliceAuthStatus = (await aliceClient.callTool({
      name: "auth_status",
      arguments: {},
    })) as ToolResult;
    expect(aliceAuthStatus.isError).toBeFalsy();
    expect(firstText(aliceAuthStatus)).toContain("WARN: Test persona active: persona:alice");

    // Alice acquires "Methodology". This lazy-creates the leases sidecar.
    const aliceAcquire = (await aliceClient.callTool({
      name: "collab_acquire_section",
      arguments: { sectionId: "Methodology", leasesCTag: "" },
    })) as ToolResult;
    expect(aliceAcquire.isError).toBeFalsy();
    expect(firstText(aliceAcquire)).toContain("acquired: methodology");

    // ---- Bob (collaborator, persona:bob, configDir B = bobConfigDir) ----
    // Critical: Bob shares the SAME mock Graph state (i.e. the same
    // OneDrive) as Alice — that is how `.collab/leases.json` provides
    // cross-instance coordination — but his own configDir, his own
    // SessionRegistry, and his own persona id.
    //
    // Pre-seed Bob's recents with the project so `session_open_project`'s
    // picker has an option to select. In the playbook this corresponds
    // to the "second time Bob opens the project" or to the share-URL
    // flow that lands the recent on first open; here we collapse those
    // into a fixture write so the test focuses on the persona behaviour.
    await upsertRecent(
      bobConfigDir,
      {
        projectId,
        folderId: "folder-proj",
        folderPath: "/Project Foo",
        authoritativeFile: "spec.md",
        lastOpened: "2026-04-19T05:50:00Z",
        role: "collaborator",
        available: true,
        unavailableReason: null,
      },
      testSignal(),
    );
    const bobRecentOptionId = `recent:${projectId}:folder-proj`;

    const bobClient = await createTestClient(env, sharedAuth, {
      openBrowser: pickerSpyOpenProject(bobRecentOptionId, "/Project Foo — spec.md"),
      agentPersona: BOB_PERSONA,
      configDir: bobConfigDir,
    });

    const bobOpen = (await bobClient.callTool({
      name: "session_open_project",
      arguments: {},
    })) as ToolResult;
    expect(bobOpen.isError).toBeFalsy();
    const bobOpenText = firstText(bobOpen);
    expect(bobOpenText).toContain("Agent ID: persona:bob");

    // session_status on Bob's side: warning line, his agentId, but the
    // userOid suffix matches Alice's (same Microsoft account).
    const bobStatus = (await bobClient.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    expect(bobStatus.isError).toBeFalsy();
    const bobStatusText = firstText(bobStatus);
    expect(bobStatusText).toContain("WARN: Test persona active: persona:bob");
    expect(bobStatusText).toContain("agentId: persona:bob");
    // Same trailing 8 chars of userOid → same Microsoft account.
    const aliceOidSuffix = /userOid: \.\.\.([a-f0-9]+)/.exec(aliceStatusText)?.[1];
    const bobOidSuffix = /userOid: \.\.\.([a-f0-9]+)/.exec(bobStatusText)?.[1];
    expect(aliceOidSuffix).toBeDefined();
    expect(bobOidSuffix).toBe(aliceOidSuffix);

    // Bob reads the live leases cTag (from his session_status) so his
    // CAS acquire of "Results" picks up Alice's freshly-written sidecar.
    const bobLeasesCTag = extractLeasesCTag(bobStatusText);
    expect(bobLeasesCTag.length).toBeGreaterThan(0);

    const bobAcquire = (await bobClient.callTool({
      name: "collab_acquire_section",
      arguments: { sectionId: "Results", leasesCTag: bobLeasesCTag },
    })) as ToolResult;
    expect(bobAcquire.isError).toBeFalsy();
    expect(firstText(bobAcquire)).toContain("acquired: results");
    expect(firstText(bobAcquire)).toContain("activeLeases: 2");

    // ---- Cross-instance verification: leases sidecar holds two
    //      distinct holders with distinct persona ids ----
    const collabFolder = env.graphState.driveFolderChildren
      .get("folder-proj")
      ?.find((c) => c.name === ".collab");
    expect(collabFolder).toBeDefined();
    const sidecar = env.graphState.driveFolderChildren
      .get(collabFolder?.id ?? "")
      ?.find((c) => c.name === "leases.json");
    expect(sidecar).toBeDefined();
    const sidecarDoc = JSON.parse(sidecar?.content ?? "") as {
      schemaVersion: number;
      leases: { sectionSlug: string; agentId: string; agentDisplayName: string }[];
    };
    expect(sidecarDoc.leases.length).toBe(2);
    const slugs = sidecarDoc.leases.map((l) => l.sectionSlug).sort();
    expect(slugs).toEqual(["methodology", "results"]);
    const agentIds = sidecarDoc.leases.map((l) => l.agentId).sort();
    expect(agentIds).toEqual(["persona:alice", "persona:bob"]);

    // ---- Audit-log verification on each side ----
    // Alice audit lives in env.configDir, Bob's lives in bobConfigDir.
    const aliceAuditPath = path.join(env.configDir, "sessions", "audit", `${projectId}.jsonl`);
    const bobAuditPath = path.join(bobConfigDir, "sessions", "audit", `${projectId}.jsonl`);
    const aliceAudit = readJsonLines(await readFile(aliceAuditPath, "utf-8"));
    const bobAudit = readJsonLines(await readFile(bobAuditPath, "utf-8"));

    // Alice's session_start must record the persona override.
    const aliceStart = aliceAudit.find((e) => e["type"] === "session_start");
    expect(aliceStart).toBeDefined();
    expect(aliceStart?.["agentId"]).toBe("persona:alice");
    expect((aliceStart?.["details"] as Record<string, unknown>)["mode"]).toBe("test-persona");
    expect((aliceStart?.["details"] as Record<string, unknown>)["agentPersona"]).toEqual({
      id: "persona:alice",
      source: "env",
    });

    // Bob's session_start must record his own persona, same userOid.
    const bobStart = bobAudit.find((e) => e["type"] === "session_start");
    expect(bobStart).toBeDefined();
    expect(bobStart?.["agentId"]).toBe("persona:bob");
    expect(bobStart?.["userOid"]).toBe(aliceStart?.["userOid"]);
    expect((bobStart?.["details"] as Record<string, unknown>)["mode"]).toBe("test-persona");

    // Lease tool_call envelopes on each side carry the right persona.
    const aliceLeaseCall = aliceAudit.find((e) => e["tool"] === "collab_acquire_section");
    expect(aliceLeaseCall?.["agentId"]).toBe("persona:alice");
    const bobLeaseCall = bobAudit.find((e) => e["tool"] === "collab_acquire_section");
    expect(bobLeaseCall?.["agentId"]).toBe("persona:bob");

    await aliceClient.close();
    await bobClient.close();
  });

  it("back-compat: when neither persona is set, session_start audit omits mode + agentPersona (byte-identical to today)", async () => {
    const auth = new MockAuthenticator({
      token: "shared-token",
      username: "shared@example.com",
    });
    const client = await createTestClient(env, auth, {
      openBrowser: pickerSpyTwoStep("folder-proj", "/Project Foo", "file-spec", "spec.md"),
      // NB: no agentPersona override.
    });
    const init = (await client.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    expect(init.isError).toBeFalsy();
    const projectIdMatch = /projectId: (\S+)/.exec(firstText(init));
    const projectId = projectIdMatch?.[1] ?? "";
    expect(projectId.length).toBeGreaterThan(0);

    // session_status must NOT print the WARN line.
    const status = (await client.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    expect(firstText(status)).not.toContain("WARN: Test persona active");

    // Audit envelope must NOT have mode / agentPersona.
    const auditPath = path.join(env.configDir, "sessions", "audit", `${projectId}.jsonl`);
    const audit = readJsonLines(await readFile(auditPath, "utf-8"));
    const start = audit.find((e) => e["type"] === "session_start");
    expect(start).toBeDefined();
    const details = start?.["details"] as Record<string, unknown>;
    expect(details).not.toHaveProperty("mode");
    expect(details).not.toHaveProperty("agentPersona");

    await client.close();
  });
});
