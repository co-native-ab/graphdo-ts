// Integration test #11: session_renew + renewal caps (W4 Day 5).
//
// DoD per `docs/plans/collab-v1.md` §9 / §3.5 / §2.2:
//
//   - Cap-3-per-session: the fourth `session_renew` on the same session
//     returns RenewalCapPerSessionError.
//   - Cap-6-per-window: with 6 renewals across the rolling 24h window
//     for `(userOid, projectId)`, the 7th returns
//     RenewalCapPerWindowError. Advance the clock past 24h and the
//     window reopens (the next renewal succeeds).
//
// Both scenarios use the injected `now` factory so TTL math + the
// renewal-counts sliding-window prune are deterministic. The cap-6
// scenario seeds the renewal-counts sidecar with 6 entries (rather
// than running 6 successful renewals through two MCP processes), so
// the fast cap test stays under one second.

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
import { resetFormFactoryForTest, getActiveFormSlotForTest } from "../../src/tools/collab-forms.js";
import { recordRenewal, renewalKey, windowCount } from "../../src/collab/renewal-counts.js";
import { testSignal } from "../helpers.js";

let env: IntegrationEnv;

const USER_OID = "00000000-0000-0000-0000-0000a3f2c891";

// ---------------------------------------------------------------------------
// Fake clock — shared across the test client and the test so both see the
// same wall-clock value (the registry, audit writer, and renewal-counts
// pruner all read it through `config.now`).
// ---------------------------------------------------------------------------

class FakeClock {
  constructor(public ms: number) {}
  now(): Date {
    return new Date(this.ms);
  }
  advanceMs(delta: number): void {
    this.ms += delta;
  }
  advanceHours(delta: number): void {
    this.ms += delta * 60 * 60 * 1000;
  }
}

// ---------------------------------------------------------------------------
// Mock graph seed
// ---------------------------------------------------------------------------

function seedSingleMarkdownFolder(env: IntegrationEnv): void {
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
      size: 12,
      lastModifiedDateTime: "2026-04-19T05:00:00Z",
      file: { mimeType: "text/markdown" },
      content: "# spec\n",
    },
  ]);
}

// ---------------------------------------------------------------------------
// Picker spies
// ---------------------------------------------------------------------------

/**
 * Spy that drives the `session_init_project` picker pair (folder + file)
 * and then captures every subsequent open URL into `lastUrl` so the test
 * can resolve `session_renew`'s approval form by POSTing to it directly.
 */
function initSpyThenCapture(): {
  spy: (url: string) => Promise<void>;
  lastUrl: { url: string };
} {
  const lastUrl = { url: "" };
  let call = 0;
  const spy = (url: string): Promise<void> => {
    lastUrl.url = url;
    const which = call++;
    setTimeout(() => {
      void (async () => {
        const csrfToken = await fetchCsrfToken(url);
        if (which === 0) {
          await fetch(`${url}/select`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: "folder-proj", label: "/Project Foo", csrfToken }),
          });
          return;
        }
        if (which === 1) {
          await fetch(`${url}/select`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: "file-spec", label: "spec.md", csrfToken }),
          });
        }
        // Subsequent opens (renew approval forms) are driven by the
        // test directly so it can choose to approve or cancel.
      })();
    }, 50);
    return Promise.resolve();
  };
  return { spy, lastUrl };
}

async function approveRenewal(url: string): Promise<void> {
  const csrfToken = await fetchCsrfToken(url);
  await fetch(`${url}/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "approve", label: "Approve session renewal", csrfToken }),
  });
}

/** Wait for the form-factory slot to flip to the renewal kind. */
async function waitForRenewalForm(lastUrl: { url: string }): Promise<void> {
  let attempts = 0;
  while (
    (lastUrl.url === "" || getActiveFormSlotForTest()?.kind !== "session_renew") &&
    attempts < 100
  ) {
    await new Promise((r) => setTimeout(r, 25));
    attempts++;
  }
  expect(getActiveFormSlotForTest()?.kind).toBe("session_renew");
}

/** Drive a single end-to-end approved renewal. */
async function renewOnce(
  c: import("./helpers.js").Client,
  lastUrl: { url: string },
): Promise<ToolResult> {
  // Reset the captured URL so waitForRenewalForm picks up the *next*
  // form opened (rather than echoing whatever was last seen).
  lastUrl.url = "";
  const renewPromise = c.callTool({ name: "session_renew", arguments: {} });
  await waitForRenewalForm(lastUrl);
  await approveRenewal(lastUrl.url);
  return (await renewPromise) as ToolResult;
}

describe("11-renewal-caps", () => {
  beforeEach(async () => {
    resetFormFactoryForTest();
    env = await setupIntegrationEnv();
    seedSingleMarkdownFolder(env);
  });

  afterEach(async () => {
    resetFormFactoryForTest();
    await teardownIntegrationEnv(env);
  });

  it("cap-3-per-session: the fourth renewal returns RenewalCapPerSessionError", async () => {
    const clock = new FakeClock(Date.parse("2026-04-19T05:00:00.000Z"));
    const { spy, lastUrl } = initSpyThenCapture();
    const auth = new MockAuthenticator({
      token: "init-token",
      username: "alice@example.com",
      userOid: USER_OID,
    });
    const c = await createTestClient(env, auth, { openBrowser: spy, now: () => clock.now() });

    const init = (await c.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    expect(init.isError).toBeFalsy();

    // Three approved renewals back to back — the per-session counter
    // climbs from 0 → 3 and the per-window counter mirrors it 1:1.
    for (let i = 1; i <= 3; i++) {
      const r = await renewOnce(c, lastUrl);
      expect(r.isError).toBeFalsy();
      const text = firstText(r);
      expect(text).toContain(`renewals (this session): ${i} / 3`);
      expect(text).toContain(`renewals (rolling 24h): ${i} / 6`);
      // Form-factory slot was released cleanly after each renewal.
      expect(getActiveFormSlotForTest()).toBeUndefined();
    }

    // Fourth attempt — pre-flight cap check refuses *before* opening
    // the browser, so no slot is acquired and `renewOnce`'s wait loop
    // would hang. Drive `session_renew` directly without a form spy.
    const fourth = (await c.callTool({
      name: "session_renew",
      arguments: {},
    })) as ToolResult;
    expect(fourth.isError).toBe(true);
    const errText = firstText(fourth);
    expect(errText).toContain("Per-session renewal cap reached");
    expect(errText).toContain("3 / 3");

    // Slot is not held — no form was opened.
    expect(getActiveFormSlotForTest()).toBeUndefined();

    // session_status confirms the in-memory counter is at 3.
    const status = (await c.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    expect(firstText(status)).toContain("renewals (this session): 3 / 3");
  });

  it("cap-6-per-window: the seventh renewal refuses; advancing past 24h reopens the window", async () => {
    const t0Ms = Date.parse("2026-04-19T05:00:00.000Z");
    const clock = new FakeClock(t0Ms);

    const { spy, lastUrl } = initSpyThenCapture();
    const auth = new MockAuthenticator({
      token: "init-token",
      username: "alice@example.com",
      userOid: USER_OID,
    });
    const c = await createTestClient(env, auth, { openBrowser: spy, now: () => clock.now() });

    const init = (await c.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    expect(init.isError).toBeFalsy();
    const projectIdMatch = /projectId: ([0-9A-HJKMNP-TV-Z]{26})/.exec(firstText(init));
    expect(projectIdMatch).not.toBeNull();
    const projectId = projectIdMatch?.[1] ?? "";

    // Seed the sliding window with 6 renewals spread across the last
    // 23h. We bypass the tool layer (which would hit the per-session
    // cap of 3) and write directly to the renewal-counts sidecar, the
    // single source of truth for the per-window cap. Each entry uses
    // a wall-clock timestamp roughly 4h apart so the oldest is t0-23h.
    const key = renewalKey(USER_OID, projectId);
    for (let hoursAgo = 23; hoursAgo >= 3; hoursAgo -= 4) {
      const seedClock = new FakeClock(t0Ms - hoursAgo * 60 * 60 * 1000);
      await recordRenewal(env.configDir, key, seedClock.now(), testSignal());
    }
    expect(await windowCount(env.configDir, key, clock.now(), testSignal())).toBe(6);

    // Seventh attempt — the per-window pre-flight check refuses with
    // RenewalCapPerWindowError before opening any browser form.
    const refused = (await c.callTool({
      name: "session_renew",
      arguments: {},
    })) as ToolResult;
    expect(refused.isError).toBe(true);
    const errText = firstText(refused);
    expect(errText).toContain("Per-24h-window renewal cap reached");
    expect(errText).toContain("6 / 6");
    expect(getActiveFormSlotForTest()).toBeUndefined();

    // Per-session counter is still 0 (nothing successful yet).
    const status1 = (await c.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    expect(firstText(status1)).toContain("renewals (this session): 0 / 3");

    // Advance the clock by 25h. Every seeded entry (oldest = t0-23h)
    // is now > 24h old and gets pruned on the next read; window count
    // drops to 0 and renewal is allowed again.
    clock.advanceHours(25);
    expect(await windowCount(env.configDir, key, clock.now(), testSignal())).toBe(0);

    const allowed = await renewOnce(c, lastUrl);
    expect(allowed.isError).toBeFalsy();
    const allowedText = firstText(allowed);
    expect(allowedText).toContain("Session renewed.");
    expect(allowedText).toContain("renewals (this session): 1 / 3");
    expect(allowedText).toContain("renewals (rolling 24h): 1 / 6");
  });

  it("cancelled renewal does not increment counters or write to the window file", async () => {
    const clock = new FakeClock(Date.parse("2026-04-19T05:00:00.000Z"));
    const { spy, lastUrl } = initSpyThenCapture();
    const auth = new MockAuthenticator({
      token: "init-token",
      username: "alice@example.com",
      userOid: USER_OID,
    });
    const c = await createTestClient(env, auth, { openBrowser: spy, now: () => clock.now() });

    const init = (await c.callTool({
      name: "session_init_project",
      arguments: {},
    })) as ToolResult;
    expect(init.isError).toBeFalsy();
    const projectIdMatch = /projectId: ([0-9A-HJKMNP-TV-Z]{26})/.exec(firstText(init));
    const projectId = projectIdMatch?.[1] ?? "";

    lastUrl.url = "";
    const renewPromise = c.callTool({ name: "session_renew", arguments: {} });
    await waitForRenewalForm(lastUrl);

    // Cancel via the picker's /cancel endpoint.
    const csrfToken = await fetchCsrfToken(lastUrl.url);
    await fetch(`${lastUrl.url}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csrfToken }),
    });
    const cancelled = (await renewPromise) as ToolResult;
    // Cancellation is not an error — the tool returns a friendly message.
    expect(cancelled.isError).toBeFalsy();
    expect(firstText(cancelled)).toContain("cancelled");

    // No renewal recorded in the window file.
    expect(
      await windowCount(env.configDir, renewalKey(USER_OID, projectId), clock.now(), testSignal()),
    ).toBe(0);

    // session_status shows zero renewals used.
    const status = (await c.callTool({
      name: "session_status",
      arguments: {},
    })) as ToolResult;
    expect(firstText(status)).toContain("renewals (this session): 0 / 3");

    // Form-factory slot was released on cancel.
    expect(getActiveFormSlotForTest()).toBeUndefined();
  });
});
