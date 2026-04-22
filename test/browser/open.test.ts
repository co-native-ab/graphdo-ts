// Unit tests for the openBrowser URL validation logic.
//
// The actual browser-opening side effect is mocked — execFile is stubbed so
// no real process is spawned. This keeps tests safe on desktop machines.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node:child_process before importing the module under test.
vi.mock("node:child_process", () => ({
  execFile: (_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
    // Simulate "browser not found" so the promise rejects predictably.
    cb(new Error("mocked: no browser"));
  },
}));

import { openBrowser } from "../../src/browser/open.js";

describe("openBrowser", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("rejects an invalid URL", async () => {
    await expect(openBrowser("not a url")).rejects.toThrow("Invalid URL");
  });

  it("rejects a non-http(s) protocol", async () => {
    await expect(openBrowser("ftp://localhost:3000")).rejects.toThrow(
      "Unsupported URL protocol: ftp:",
    );
  });

  it("rejects a file: URL", async () => {
    await expect(openBrowser("file:///etc/passwd")).rejects.toThrow(
      "Unsupported URL protocol: file:",
    );
  });

  it("rejects plain http:// to a non-localhost hostname", async () => {
    await expect(openBrowser("http://example.com/anything")).rejects.toThrow(
      "Plain http:// URLs must be a localhost address, got: example.com",
    );
  });

  it("rejects plain http:// to a remote IP address", async () => {
    await expect(openBrowser("http://192.168.1.1:8080/")).rejects.toThrow(
      "Plain http:// URLs must be a localhost address, got: 192.168.1.1",
    );
  });

  it("accepts https:// to a remote hostname (e.g. SharePoint preview links)", async () => {
    // Validation passes — the mocked execFile rejects, confirming we reached
    // the actual browser-open step.
    const result = openBrowser(
      "https://contoso-my.sharepoint.com/my?id=%2Fpersonal%2Fu%2FDocuments%2Fmd%2Ffile.md",
    );
    await expect(result).rejects.toThrow("Failed to open browser:");
  });

  it("accepts http://localhost with a port", async () => {
    // Validation passes — the mocked execFile rejects, confirming we reached
    // the actual browser-open step (past all validation guards).
    const result = openBrowser("http://localhost:12345/");
    await expect(result).rejects.toThrow("Failed to open browser:");
  });

  it("accepts http://127.0.0.1 with a port", async () => {
    const result = openBrowser("http://127.0.0.1:9999/");
    await expect(result).rejects.toThrow("Failed to open browser:");
  });
});

describe("openBrowser Windows branch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("uses cmd.exe on Windows platform with success", async () => {
    // Mock os.platform() to return "win32"
    vi.doMock("node:os", () => ({
      platform: () => "win32",
    }));

    // Mock execFile to succeed
    vi.doMock("node:child_process", () => ({
      execFile: (cmd: string, args: string[], cb: (err: Error | null) => void) => {
        expect(cmd).toBe("cmd.exe");
        expect(args).toEqual(["/c", "start", "", "http://localhost:5000/"]);
        cb(null);
      },
    }));

    const { openBrowser: openBrowserWin } = await import("../../src/browser/open.js");
    await expect(openBrowserWin("http://localhost:5000/")).resolves.toBeUndefined();
  });

  it("uses cmd.exe on Windows platform with error", async () => {
    // Mock os.platform() to return "win32"
    vi.doMock("node:os", () => ({
      platform: () => "win32",
    }));

    // Mock execFile to error
    const mockError = new Error("cmd.exe failed");
    vi.doMock("node:child_process", () => ({
      execFile: (_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
        cb(mockError);
      },
    }));

    const { openBrowser: openBrowserWinErr } = await import("../../src/browser/open.js");
    await expect(openBrowserWinErr("http://localhost:5000/")).rejects.toThrow(
      "Failed to open browser: cmd.exe failed",
    );
  });
});

describe("isWsl() catch branch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("handles readFileSync error and falls back to xdg-open", async () => {
    // Mock fs.readFileSync to throw (simulating /proc/version not found)
    vi.doMock("node:fs", () => ({
      readFileSync: () => {
        throw new Error("ENOENT: no such file or directory");
      },
    }));

    // Mock os.platform() to return "linux"
    vi.doMock("node:os", () => ({
      platform: () => "linux",
    }));

    // Mock execFile to capture the command being called
    let capturedCmd = "";
    vi.doMock("node:child_process", () => ({
      execFile: (cmd: string, _args: string[], cb: (err: Error | null) => void) => {
        capturedCmd = cmd;
        cb(new Error("mocked: no browser"));
      },
    }));

    const { openBrowser: openBrowserFallback } = await import("../../src/browser/open.js");
    // isWsl() catch branch should set _isWsl = false, so it will use xdg-open
    await expect(openBrowserFallback("http://localhost:5000/")).rejects.toThrow(
      "Failed to open browser:",
    );
    // Should use xdg-open (fallback) not wslview
    expect(capturedCmd).toBe("xdg-open");
  });
});
