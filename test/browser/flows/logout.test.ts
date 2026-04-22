// Tests for the logout flow descriptor.
//
// Exercises the flow via runBrowserFlow directly.
// Logout-specific: confirm calls onConfirm and resolves, cancel rejects
// with UserCancelledError, onConfirm failure surfaces as 500.

import { describe, it, expect, vi } from "vitest";

import { logoutFlow } from "../../../src/browser/flows/logout.js";
import { runBrowserFlow } from "../../../src/browser/server.js";
import type { FlowHandle } from "../../../src/browser/server.js";
import { UserCancelledError } from "../../../src/errors.js";
import { fetchCsrfToken, testSignal } from "../../helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** POST /confirm with a properly-formed CSRF body. */
async function postConfirm(uri: string, csrfToken: string): Promise<Response> {
  return fetch(`${uri}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csrfToken }),
  });
}

/** POST /cancel with a properly-formed CSRF body. */
async function postCancel(uri: string, csrfToken: string): Promise<Response> {
  return fetch(`${uri}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csrfToken }),
  });
}

async function startLogoutFlow(
  onConfirm?: (signal: AbortSignal) => Promise<void>,
): Promise<{ handle: FlowHandle<void>; uri: string }> {
  const handler =
    onConfirm ?? vi.fn<(signal: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
  const handle = await runBrowserFlow(logoutFlow(handler, testSignal()), testSignal());
  // Pre-arm rejection so Node doesn't flag unhandled rejections.
  void handle.result.catch(() => undefined);
  return { handle, uri: handle.url };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("logoutFlow descriptor", () => {
  it("serves the logout page at /", async () => {
    const { handle, uri } = await startLogoutFlow();
    try {
      const res = await fetch(uri);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Sign Out");
    } finally {
      const csrfToken = await fetchCsrfToken(uri);
      await postCancel(uri, csrfToken).catch(() => undefined);
      await handle.result.catch(() => undefined);
    }
  });

  it("confirm calls onConfirm and resolves", async () => {
    const onConfirm = vi.fn<(signal: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
    const { handle, uri } = await startLogoutFlow(onConfirm);

    const csrfToken = await fetchCsrfToken(uri);
    const res = await postConfirm(uri, csrfToken);
    expect(res.status).toBe(200);

    await expect(handle.result).resolves.toBeUndefined();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("cancel rejects with UserCancelledError", async () => {
    const { handle, uri } = await startLogoutFlow();

    const csrfToken = await fetchCsrfToken(uri);
    const [res] = await Promise.all([
      postCancel(uri, csrfToken),
      expect(handle.result).rejects.toThrow(UserCancelledError),
    ]);
    expect(res.status).toBe(200);
  });

  it("cancel rejects with 'Logout cancelled by user' message", async () => {
    const { handle, uri } = await startLogoutFlow();

    const csrfToken = await fetchCsrfToken(uri);
    await postCancel(uri, csrfToken);
    await expect(handle.result).rejects.toThrow("Logout cancelled by user");
  });

  it("onConfirm failure surfaces as 500", async () => {
    const onConfirm = vi
      .fn<(signal: AbortSignal) => Promise<void>>()
      .mockRejectedValue(new Error("disk full"));
    const { handle, uri } = await startLogoutFlow(onConfirm);

    const csrfToken = await fetchCsrfToken(uri);
    const res = await postConfirm(uri, csrfToken);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("Failed to sign out");

    await expect(handle.result).rejects.toThrow("disk full");
  });

  it("returns 404 for unknown paths", async () => {
    const { handle, uri } = await startLogoutFlow();

    try {
      const res = await fetch(`${uri}/unknown`);
      expect(res.status).toBe(404);
    } finally {
      const csrfToken = await fetchCsrfToken(uri);
      await postCancel(uri, csrfToken).catch(() => undefined);
      await handle.result.catch(() => undefined);
    }
  });

  it("page embeds a CSRF meta tag and nonce", async () => {
    const { handle, uri } = await startLogoutFlow();

    try {
      const html = await (await fetch(uri)).text();
      expect(html).toMatch(/<meta name="csrf-token" content="[0-9a-f]{64}">/);
      expect(html).toMatch(/<script nonce="[0-9a-f]{64}">/);
      expect(html).toMatch(/<style nonce="[0-9a-f]{64}">/);
    } finally {
      const csrfToken = await fetchCsrfToken(uri);
      await postCancel(uri, csrfToken).catch(() => undefined);
      await handle.result.catch(() => undefined);
    }
  });
});
