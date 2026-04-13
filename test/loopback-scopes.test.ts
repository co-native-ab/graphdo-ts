// Tests for the scope flyout on the login landing page and the
// /save-scopes and /restart-login endpoints on the loopback server.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { LoginLoopbackClient } from "../src/loopback.js";
import { loadSelectedScopes, saveSelectedScopes } from "../src/config.js";
import { GraphScope, AVAILABLE_SCOPES } from "../src/scopes.js";
import { ScopeChangeError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function startClient(configDir: string): Promise<{
  client: LoginLoopbackClient;
  uri: string;
  authPromise: Promise<import("@azure/msal-node").AuthorizeResponse>;
}> {
  const client = new LoginLoopbackClient(configDir);
  const authPromise = client.listenForAuthCode();
  await client.waitForReady();
  const uri = client.getRedirectUri();
  return { client, uri, authPromise };
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("login page scope flyout", () => {
  let client: LoginLoopbackClient | undefined;
  let configDir: string;

  afterEach(async () => {
    client?.closeServer();
    if (configDir) {
      await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // -----------------------------------------------------------------------
  // Landing page with scope flyout
  // -----------------------------------------------------------------------

  describe("landing page HTML", () => {
    it("shows scope flyout when auth URL is set", async () => {
      configDir = await mkdtemp(path.join(tmpdir(), "graphdo-scope-test-"));
      const { client: c, uri } = await startClient(configDir);
      client = c;

      c.setAuthUrl("https://login.microsoftonline.com/test");

      const res = await fetch(uri);
      const html = await res.text();

      // Should contain scope flyout elements
      expect(html).toContain("scope-flyout");
      expect(html).toContain("scope-toggle");
      expect(html).toContain("Permissions");
    });

    it("includes checkboxes for each available scope", async () => {
      configDir = await mkdtemp(path.join(tmpdir(), "graphdo-scope-test-"));
      const { client: c, uri } = await startClient(configDir);
      client = c;

      c.setAuthUrl("https://login.microsoftonline.com/test");

      const res = await fetch(uri);
      const html = await res.text();

      for (const scopeDef of AVAILABLE_SCOPES) {
        expect(html).toContain(scopeDef.label);
        expect(html).toContain(scopeDef.description);
      }
    });

    it("marks required scopes as disabled", async () => {
      configDir = await mkdtemp(path.join(tmpdir(), "graphdo-scope-test-"));
      const { client: c, uri } = await startClient(configDir);
      client = c;

      c.setAuthUrl("https://login.microsoftonline.com/test");

      const res = await fetch(uri);
      const html = await res.text();

      // User.Read and offline_access should have the disabled attribute
      expect(html).toContain(`value="User.Read" checked disabled`);
      expect(html).toContain(`value="offline_access" checked disabled`);
    });

    it("respects saved scope selection", async () => {
      configDir = await mkdtemp(path.join(tmpdir(), "graphdo-scope-test-"));

      // Save only MailSend + required scopes
      await saveSelectedScopes(
        [GraphScope.MailSend, GraphScope.UserRead, GraphScope.OfflineAccess],
        configDir,
      );

      const { client: c, uri } = await startClient(configDir);
      client = c;

      c.setAuthUrl("https://login.microsoftonline.com/test");

      const res = await fetch(uri);
      const html = await res.text();

      // Mail.Send should be checked, but Tasks scopes should not be
      expect(html).toContain(`value="Mail.Send" checked`);
      // Tasks.Read should NOT be checked (no "checked" attribute immediately after value)
      // We check that the checkbox for Tasks.Read doesn't have "checked"
      const tasksReadMatch = /value="Tasks\.Read"\s*(checked)?/.exec(html);
      expect(tasksReadMatch?.[1]).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // POST /save-scopes
  // -----------------------------------------------------------------------

  describe("POST /save-scopes", () => {
    it("saves valid scopes to config", async () => {
      configDir = await mkdtemp(path.join(tmpdir(), "graphdo-scope-test-"));
      const { client: c, uri } = await startClient(configDir);
      client = c;

      const res = await postJson(`${uri}/save-scopes`, {
        scopes: ["Mail.Send", "User.Read", "offline_access"],
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean };
      expect(json.ok).toBe(true);

      // Verify persisted to disk
      const saved = await loadSelectedScopes(configDir);
      expect(saved).toContain(GraphScope.MailSend);
      expect(saved).toContain(GraphScope.UserRead);
      expect(saved).toContain(GraphScope.OfflineAccess);
    });

    it("filters out invalid scope strings", async () => {
      configDir = await mkdtemp(path.join(tmpdir(), "graphdo-scope-test-"));
      const { client: c, uri } = await startClient(configDir);
      client = c;

      const res = await postJson(`${uri}/save-scopes`, {
        scopes: ["Mail.Send", "not-a-scope", "Tasks.ReadWrite"],
      });
      expect(res.status).toBe(200);

      const saved = await loadSelectedScopes(configDir);
      expect(saved).toContain(GraphScope.MailSend);
      expect(saved).toContain(GraphScope.TasksReadWrite);
      // Always-required scopes should be added
      expect(saved).toContain(GraphScope.UserRead);
      expect(saved).toContain(GraphScope.OfflineAccess);
    });

    it("returns 400 when scopes is not an array", async () => {
      configDir = await mkdtemp(path.join(tmpdir(), "graphdo-scope-test-"));
      const { client: c, uri } = await startClient(configDir);
      client = c;

      const res = await postJson(`${uri}/save-scopes`, { scopes: "not-array" });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toContain("array");
    });
  });

  // -----------------------------------------------------------------------
  // POST /restart-login
  // -----------------------------------------------------------------------

  describe("POST /restart-login", () => {
    it("rejects auth promise with ScopeChangeError", async () => {
      configDir = await mkdtemp(path.join(tmpdir(), "graphdo-scope-test-"));
      const { client: c, uri, authPromise } = await startClient(configDir);
      client = c;

      // Attach a catch handler before triggering the rejection to avoid unhandled promise warnings
      const rejectionPromise = authPromise.catch((err: unknown) => err);

      const res = await postJson(`${uri}/restart-login`, {
        scopes: ["Mail.Send", "User.Read", "offline_access"],
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; restarting: boolean };
      expect(json.ok).toBe(true);
      expect(json.restarting).toBe(true);

      // The auth promise should reject with ScopeChangeError
      const err = await rejectionPromise;
      expect(err).toBeInstanceOf(ScopeChangeError);
    });

    it("saves scopes to config before rejecting", async () => {
      configDir = await mkdtemp(path.join(tmpdir(), "graphdo-scope-test-"));
      const { client: c, uri, authPromise } = await startClient(configDir);
      client = c;

      // Attach catch handler before triggering rejection
      const rejectionPromise = authPromise.catch(() => undefined);

      await postJson(`${uri}/restart-login`, {
        scopes: ["Tasks.ReadWrite", "User.Read", "offline_access"],
      });

      await rejectionPromise;

      // Verify scopes were saved
      const saved = await loadSelectedScopes(configDir);
      expect(saved).toContain(GraphScope.TasksReadWrite);
      expect(saved).toContain(GraphScope.UserRead);
      expect(saved).toContain(GraphScope.OfflineAccess);
    });
  });
});
