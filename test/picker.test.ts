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

// ---------------------------------------------------------------------------
// Filter / Refresh / Create-link enhancements
// ---------------------------------------------------------------------------

describe("browser picker: enhanced features", () => {
  it("renders a filter input and create-link when configured", async () => {
    const handle = await startBrowserPicker(
      {
        title: "Pick",
        subtitle: "Choose:",
        options: sampleOptions,
        filterPlaceholder: "Type to filter...",
        createLink: {
          url: "https://example.com/new",
          label: "Create a new thing",
          description: "Opens the service in a new tab.",
        },
        onSelect: vi.fn().mockResolvedValue(undefined),
        timeoutMs: 5000,
      },
      testSignal(),
    );
    const cleanup = handle.waitForSelection.catch(() => undefined);
    try {
      const res = await fetch(handle.url);
      const html = await res.text();
      expect(html).toContain('id="filter-input"');
      expect(html).toContain("Type to filter...");
      expect(html).toContain("https://example.com/new");
      expect(html).toContain("Create a new thing");
      expect(html).toContain("Opens the service in a new tab.");
      // Refresh button is hidden unless refreshOptions is provided
      expect(html).not.toContain('id="refresh-btn"');
    } finally {
      await fetch(`${handle.url}/cancel`, { method: "POST" }).catch(() => undefined);
      await cleanup;
    }
  });

  it("escapes HTML special characters in filter placeholder, create link, and options", async () => {
    const handle = await startBrowserPicker(
      {
        title: "Pick",
        subtitle: "Choose:",
        options: [{ id: "x<y>", label: "<script>alert(1)</script>" }],
        filterPlaceholder: 'evil" placeholder',
        createLink: {
          url: "https://example.com/?a=1&b=2",
          label: "<b>bold</b>",
          description: "desc <with> chars",
        },
        onSelect: vi.fn().mockResolvedValue(undefined),
        timeoutMs: 5000,
      },
      testSignal(),
    );
    const cleanup = handle.waitForSelection.catch(() => undefined);
    try {
      const html = await (await fetch(handle.url)).text();
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;");
      expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
      expect(html).toContain("https://example.com/?a=1&amp;b=2");
      expect(html).toContain('placeholder="evil&quot; placeholder"');
    } finally {
      await fetch(`${handle.url}/cancel`, { method: "POST" }).catch(() => undefined);
      await cleanup;
    }
  });

  it("renders a refresh button only when refreshOptions is provided", async () => {
    const handle = await startBrowserPicker(
      {
        title: "Pick",
        subtitle: "Choose:",
        options: sampleOptions,
        refreshOptions: () => Promise.resolve(sampleOptions),
        onSelect: vi.fn().mockResolvedValue(undefined),
        timeoutMs: 5000,
      },
      testSignal(),
    );
    const cleanup = handle.waitForSelection.catch(() => undefined);
    try {
      const html = await (await fetch(handle.url)).text();
      expect(html).toContain('id="refresh-btn"');
    } finally {
      await fetch(`${handle.url}/cancel`, { method: "POST" }).catch(() => undefined);
      await cleanup;
    }
  });

  it("GET /options calls the refresh provider and returns fresh options", async () => {
    const provider = vi
      .fn<(signal: AbortSignal) => Promise<PickerOption[]>>()
      .mockResolvedValueOnce([{ id: "refreshed-1", label: "Refreshed A" }]);

    const handle = await startBrowserPicker(
      {
        title: "Pick",
        subtitle: "Choose:",
        options: sampleOptions,
        refreshOptions: provider,
        onSelect: vi.fn().mockResolvedValue(undefined),
        timeoutMs: 5000,
      },
      testSignal(),
    );
    const cleanup = handle.waitForSelection.catch(() => undefined);
    try {
      const res = await fetch(`${handle.url}/options`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { options: PickerOption[] };
      expect(body.options).toEqual([{ id: "refreshed-1", label: "Refreshed A" }]);
      expect(provider).toHaveBeenCalledTimes(1);
    } finally {
      await fetch(`${handle.url}/cancel`, { method: "POST" }).catch(() => undefined);
      await cleanup;
    }
  });

  it("after a refresh, only options from the refreshed set are selectable", async () => {
    // Initial set offers opt-1 and opt-2. Refresh replaces them.
    const onSelect = vi
      .fn<(opt: PickerOption, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);
    const handle = await startBrowserPicker(
      {
        title: "Pick",
        subtitle: "Choose:",
        options: sampleOptions,
        refreshOptions: () => Promise.resolve([{ id: "new-1", label: "New A" }]),
        onSelect,
        timeoutMs: 5000,
      },
      testSignal(),
    );

    // Refresh first
    await fetch(`${handle.url}/options`);

    // Now try selecting the old ID — must be rejected
    const stale = await fetch(`${handle.url}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "opt-1", label: "Option A" }),
    });
    expect(stale.status).toBe(400);
    expect(onSelect).not.toHaveBeenCalled();

    // The new ID works
    const ok = await fetch(`${handle.url}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "new-1", label: "New A" }),
    });
    expect(ok.status).toBe(200);
    await handle.waitForSelection;
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("GET /options returns 405 when no refresh provider is configured", async () => {
    const handle = await startBrowserPicker(
      {
        title: "Pick",
        subtitle: "Choose:",
        options: sampleOptions,
        onSelect: vi.fn().mockResolvedValue(undefined),
        timeoutMs: 5000,
      },
      testSignal(),
    );
    const cleanup = handle.waitForSelection.catch(() => undefined);
    try {
      const res = await fetch(`${handle.url}/options`);
      expect(res.status).toBe(405);
    } finally {
      await fetch(`${handle.url}/cancel`, { method: "POST" }).catch(() => undefined);
      await cleanup;
    }
  });

  it("GET /options returns 500 with JSON error when the provider throws", async () => {
    const handle = await startBrowserPicker(
      {
        title: "Pick",
        subtitle: "Choose:",
        options: sampleOptions,
        refreshOptions: () => Promise.reject(new Error("graph exploded")),
        onSelect: vi.fn().mockResolvedValue(undefined),
        timeoutMs: 5000,
      },
      testSignal(),
    );
    const cleanup = handle.waitForSelection.catch(() => undefined);
    try {
      const res = await fetch(`${handle.url}/options`);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      // Generic message — internal error details must not leak to the browser.
      expect(body.error).toBe("refresh failed");
      expect(body.error).not.toContain("graph exploded");
    } finally {
      await fetch(`${handle.url}/cancel`, { method: "POST" }).catch(() => undefined);
      await cleanup;
    }
  });
});
