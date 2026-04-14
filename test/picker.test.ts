// Tests for the generic browser picker.
//
// Verifies the full flow: start picker → fetch HTML → POST selection → callback fired.

import { describe, it, expect, vi } from "vitest";

import { startBrowserPicker } from "../src/picker.js";
import type { PickerOption } from "../src/picker.js";
import { testSignal } from "./helpers.js";

const sampleOptions: PickerOption[] = [
  { id: "opt-1", label: "Option A" },
  { id: "opt-2", label: "Option B" },
];

describe("browser picker", () => {
  it("serves HTML page with options", async () => {
    const onSelect = vi
      .fn<(opt: PickerOption, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const handle = await startBrowserPicker(
      {
        title: "Pick Something",
        subtitle: "Choose wisely:",
        options: sampleOptions,
        onSelect,
        timeoutMs: 5000,
      },
      testSignal(),
    );

    try {
      const response = await fetch(handle.url);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");

      const html = await response.text();
      expect(html).toContain("Pick Something");
      expect(html).toContain("Choose wisely:");
      expect(html).toContain("Option A");
      expect(html).toContain("Option B");
      expect(html).toContain("opt-1");
      expect(html).toContain("opt-2");
    } finally {
      await fetch(`${handle.url}/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "opt-1", label: "Option A" }),
      });
      await handle.waitForSelection;
    }
  });

  it("calls onSelect and resolves with the selected option", async () => {
    const onSelect = vi
      .fn<(opt: PickerOption, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const handle = await startBrowserPicker(
      {
        title: "Test",
        subtitle: "Test",
        options: sampleOptions,
        onSelect,
        timeoutMs: 5000,
      },
      testSignal(),
    );

    const response = await fetch(`${handle.url}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "opt-2", label: "Option B" }),
    });
    expect(response.status).toBe(200);

    const result = await handle.waitForSelection;
    expect(result.selected).toEqual({ id: "opt-2", label: "Option B" });
    expect(onSelect).toHaveBeenCalledWith(
      { id: "opt-2", label: "Option B" },
      expect.any(AbortSignal),
    );
  });

  it("rejects invalid selection", async () => {
    const onSelect = vi
      .fn<(opt: PickerOption, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const handle = await startBrowserPicker(
      {
        title: "Test",
        subtitle: "Test",
        options: sampleOptions,
        onSelect,
        timeoutMs: 5000,
      },
      testSignal(),
    );

    const response = await fetch(`${handle.url}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "nonexistent", label: "Fake" }),
    });
    expect(response.status).toBe(400);
    expect(onSelect).not.toHaveBeenCalled();

    // Clean up - post a valid selection
    await fetch(`${handle.url}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "opt-1", label: "Option A" }),
    });
    await handle.waitForSelection;
  });

  it("returns 404 for unknown paths", async () => {
    const onSelect = vi
      .fn<(opt: PickerOption, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const handle = await startBrowserPicker(
      {
        title: "Test",
        subtitle: "Test",
        options: sampleOptions,
        onSelect,
        timeoutMs: 5000,
      },
      testSignal(),
    );

    const response = await fetch(`${handle.url}/unknown`);
    expect(response.status).toBe(404);

    // Clean up
    await fetch(`${handle.url}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "opt-1", label: "Option A" }),
    });
    await handle.waitForSelection;
  });

  it("times out when no selection is made", async () => {
    const onSelect = vi
      .fn<(opt: PickerOption, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const handle = await startBrowserPicker(
      {
        title: "Test",
        subtitle: "Test",
        options: sampleOptions,
        onSelect,
        timeoutMs: 100,
      },
      testSignal(),
    );

    await expect(handle.waitForSelection).rejects.toThrow("timed out");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("escapes HTML in option labels", async () => {
    const xssOptions: PickerOption[] = [{ id: "xss", label: '<script>alert("xss")</script>' }];
    const onSelect = vi
      .fn<(opt: PickerOption, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const handle = await startBrowserPicker(
      {
        title: "Test",
        subtitle: "Test",
        options: xssOptions,
        onSelect,
        timeoutMs: 5000,
      },
      testSignal(),
    );

    const response = await fetch(handle.url);
    const html = await response.text();
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");

    // Clean up
    await fetch(`${handle.url}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "xss",
        label: '<script>alert("xss")</script>',
      }),
    });
    await handle.waitForSelection;
  });

  it("returns 413 when POST body exceeds size limit", async () => {
    const onSelect = vi
      .fn<(opt: PickerOption, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const handle = await startBrowserPicker(
      {
        title: "Test",
        subtitle: "Test",
        options: sampleOptions,
        onSelect,
        timeoutMs: 5000,
      },
      testSignal(),
    );

    // Send a body larger than MAX_BODY_SIZE (1 MB)
    const oversizedBody = "x".repeat(1_048_577);
    const response = await fetch(`${handle.url}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversizedBody,
    });
    expect(response.status).toBe(413);
    expect(onSelect).not.toHaveBeenCalled();

    // Clean up - post a valid selection
    await fetch(`${handle.url}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "opt-1", label: "Option A" }),
    });
    await handle.waitForSelection;
  });

  it("returns 500 when onSelect throws", async () => {
    const onSelect = vi
      .fn<(opt: PickerOption, signal: AbortSignal) => Promise<void>>()
      .mockRejectedValue(new Error("save failed"));

    const handle = await startBrowserPicker(
      {
        title: "Test",
        subtitle: "Test",
        options: sampleOptions,
        onSelect,
        timeoutMs: 5000,
      },
      testSignal(),
    );

    const response = await fetch(`${handle.url}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "opt-1", label: "Option A" }),
    });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("save failed");

    // Server should still be running - post again with working callback
    onSelect.mockResolvedValue(undefined);
    await fetch(`${handle.url}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "opt-1", label: "Option A" }),
    });
    await handle.waitForSelection;
  });

  it("rejects waitForSelection with UserCancelledError when /cancel is posted", async () => {
    const onSelect = vi
      .fn<(opt: PickerOption, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const handle = await startBrowserPicker(
      {
        title: "Test",
        subtitle: "Test",
        options: sampleOptions,
        onSelect,
        timeoutMs: 5000,
      },
      testSignal(),
    );

    const [response] = await Promise.all([
      fetch(`${handle.url}/cancel`, { method: "POST" }),
      expect(handle.waitForSelection).rejects.toThrow("Selection cancelled by user"),
    ]);
    expect(response.status).toBe(200);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("picker page includes a Cancel button", async () => {
    const onSelect = vi
      .fn<(opt: PickerOption, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);

    const handle = await startBrowserPicker(
      {
        title: "Choose a list",
        subtitle: "Select one:",
        options: sampleOptions,
        onSelect,
        timeoutMs: 5000,
      },
      testSignal(),
    );

    // Attach cleanup handler before any requests to avoid unhandled rejection
    const cleanup = handle.waitForSelection.catch(() => {
      /* expected rejection */
    });
    try {
      const response = await fetch(handle.url);
      const html = await response.text();
      expect(html).toContain('id="cancel-btn"');
      expect(html).toContain("Cancel");
    } finally {
      await fetch(`${handle.url}/cancel`, { method: "POST" }).catch(() => {
        /* ignore */
      });
      await cleanup;
    }
  });
});
