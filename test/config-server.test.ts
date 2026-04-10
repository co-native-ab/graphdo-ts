// Tests for the browser-based config server.
//
// Verifies the full flow: start server → fetch HTML → POST selection → config saved.

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { startConfigServer } from "../src/tools/config-server.js";
import { loadConfig } from "../src/config.js";

let configDir: string;

describe("config server", () => {
  beforeEach(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), "graphdo-config-test-"));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  it("serves HTML page with list options", async () => {
    const lists = [
      { id: "list-1", displayName: "My Tasks" },
      { id: "list-2", displayName: "Work" },
    ];

    const handle = await startConfigServer(lists, configDir, {
      timeoutMs: 5000,
    });

    try {
      const response = await fetch(handle.url);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");

      const html = await response.text();
      expect(html).toContain("My Tasks");
      expect(html).toContain("Work");
      expect(html).toContain("list-1");
      expect(html).toContain("list-2");
      expect(html).toContain("Configure Todo List");
    } finally {
      // POST a selection to shut down the server cleanly
      await fetch(`${handle.url}/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listId: "list-1", listName: "My Tasks" }),
      });
      await handle.waitForSelection;
    }
  });

  it("saves config when user selects a list", async () => {
    const lists = [
      { id: "list-1", displayName: "My Tasks" },
      { id: "list-2", displayName: "Work" },
    ];

    const handle = await startConfigServer(lists, configDir, {
      timeoutMs: 5000,
    });

    // POST selection
    const response = await fetch(`${handle.url}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listId: "list-2", listName: "Work" }),
    });
    expect(response.status).toBe(200);

    const result = await handle.waitForSelection;
    expect(result.listId).toBe("list-2");
    expect(result.listName).toBe("Work");

    // Verify config was persisted
    const config = await loadConfig(configDir);
    expect(config).not.toBeNull();
    expect(config!.todoListId).toBe("list-2");
    expect(config!.todoListName).toBe("Work");
  });

  it("rejects invalid list selection", async () => {
    const lists = [{ id: "list-1", displayName: "My Tasks" }];

    const handle = await startConfigServer(lists, configDir, {
      timeoutMs: 5000,
    });

    // POST an invalid list
    const response = await fetch(`${handle.url}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listId: "nonexistent", listName: "Fake" }),
    });
    expect(response.status).toBe(400);

    // Server should still be running — post a valid selection to clean up
    const validResponse = await fetch(`${handle.url}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listId: "list-1", listName: "My Tasks" }),
    });
    expect(validResponse.status).toBe(200);
    await handle.waitForSelection;
  });

  it("returns 404 for unknown paths", async () => {
    const lists = [{ id: "list-1", displayName: "My Tasks" }];

    const handle = await startConfigServer(lists, configDir, {
      timeoutMs: 5000,
    });

    const response = await fetch(`${handle.url}/unknown`);
    expect(response.status).toBe(404);

    // Clean up
    await fetch(`${handle.url}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listId: "list-1", listName: "My Tasks" }),
    });
    await handle.waitForSelection;
  });

  it("times out when no selection is made", async () => {
    const lists = [{ id: "list-1", displayName: "My Tasks" }];

    const handle = await startConfigServer(lists, configDir, {
      timeoutMs: 100, // Very short timeout for testing
    });

    await expect(handle.waitForSelection).rejects.toThrow("timed out");
  });

  it("escapes HTML in list names", async () => {
    const lists = [
      { id: "list-xss", displayName: '<script>alert("xss")</script>' },
    ];

    const handle = await startConfigServer(lists, configDir, {
      timeoutMs: 5000,
    });

    const response = await fetch(handle.url);
    const html = await response.text();
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");

    // Clean up
    await fetch(`${handle.url}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        listId: "list-xss",
        listName: '<script>alert("xss")</script>',
      }),
    });
    await handle.waitForSelection;
  });
});
