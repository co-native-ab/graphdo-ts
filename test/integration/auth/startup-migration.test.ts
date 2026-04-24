// Integration test: createMcpServer migrates an older on-disk config.json
// at startup, before any tool calls are made.

import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import {
  setupIntegrationEnv,
  teardownIntegrationEnv,
  createTestClient,
  MockAuthenticator,
  type IntegrationEnv,
} from "../helpers.js";
import { CURRENT_CONFIG_VERSION } from "../../../src/config.js";

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "config",
);

let env: IntegrationEnv;

describe("integration: startup config migration", () => {
  beforeAll(async () => {
    env = await setupIntegrationEnv();
  });

  afterAll(async () => {
    await teardownIntegrationEnv(env);
  });

  it("rewrites a v2 on-disk config to the current version when the server starts, with no tool calls", async () => {
    // Seed a v2 fixture into the integration env's configDir.
    const target = path.join(env.configDir, "config.json");
    await copyFile(path.join(FIXTURES_DIR, "v2", "full.json"), target);

    // Sanity: file is v2 before startup.
    const before = JSON.parse(await readFile(target, "utf-8")) as Record<string, unknown>;
    expect(before["config_version"]).toBe(2);
    expect(before["markdown"]).toBeDefined();

    // Boot the server. Do NOT invoke any tools.
    const auth = new MockAuthenticator();
    const client = await createTestClient(env, auth);
    await client.close();

    // After startup: file is at the current version, $schema URL refreshed,
    // and the v2-only `markdown` subsystem has been replaced by `workspace`.
    const after = JSON.parse(await readFile(target, "utf-8")) as Record<string, unknown>;
    expect(after["config_version"]).toBe(CURRENT_CONFIG_VERSION);
    expect(after["$schema"]).toBe(
      `https://raw.githubusercontent.com/co-native-ab/graphdo-ts/main/schemas/config-v${String(CURRENT_CONFIG_VERSION)}.json`,
    );
    expect(after["markdown"]).toBeUndefined();
    expect(after["workspace"]).toBeDefined();
  });
});
