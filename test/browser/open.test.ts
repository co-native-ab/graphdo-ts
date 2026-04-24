// Unit tests for the openBrowser URL validation logic.
//
// The actual browser-opening side effect is mocked — the `open` package is
// stubbed so no real process is spawned. This keeps tests safe on desktop
// machines and lets us assert that the URL is forwarded verbatim (no
// re-encoding, no query-parameter dropping). See ADR-0011.

import { describe, it, expect, vi, beforeEach } from "vitest";

const openMock = vi.fn<(url: string) => Promise<void>>();

vi.mock("open", () => ({
  default: (url: string) => openMock(url),
}));

import { openBrowser } from "../../src/browser/open.js";

describe("openBrowser", () => {
  beforeEach(() => {
    openMock.mockReset();
    openMock.mockResolvedValue(undefined);
  });

  it("rejects an invalid URL without invoking open", async () => {
    await expect(openBrowser("not a url")).rejects.toThrow("Invalid URL");
    expect(openMock).not.toHaveBeenCalled();
  });

  it("rejects a non-http(s) protocol without invoking open", async () => {
    await expect(openBrowser("ftp://localhost:3000")).rejects.toThrow(
      "Unsupported URL protocol: ftp:",
    );
    expect(openMock).not.toHaveBeenCalled();
  });

  it("rejects a file: URL without invoking open", async () => {
    await expect(openBrowser("file:///etc/passwd")).rejects.toThrow(
      "Unsupported URL protocol: file:",
    );
    expect(openMock).not.toHaveBeenCalled();
  });

  it("rejects plain http:// to a non-localhost hostname without invoking open", async () => {
    await expect(openBrowser("http://example.com/anything")).rejects.toThrow(
      "Plain http:// URLs must be a localhost address, got: example.com",
    );
    expect(openMock).not.toHaveBeenCalled();
  });

  it("rejects plain http:// to a remote IP address without invoking open", async () => {
    await expect(openBrowser("http://192.168.1.1:8080/")).rejects.toThrow(
      "Plain http:// URLs must be a localhost address, got: 192.168.1.1",
    );
    expect(openMock).not.toHaveBeenCalled();
  });

  it("forwards an https:// URL to open verbatim", async () => {
    const url =
      "https://contoso-my.sharepoint.com/my?id=%2Fpersonal%2Fu%2FDocuments%2Fmd%2Ffile.md";
    await expect(openBrowser(url)).resolves.toBeUndefined();
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(openMock).toHaveBeenCalledWith(url);
  });

  it("forwards http://localhost with a port to open verbatim", async () => {
    const url = "http://localhost:12345/";
    await expect(openBrowser(url)).resolves.toBeUndefined();
    expect(openMock).toHaveBeenCalledWith(url);
  });

  it("forwards http://127.0.0.1 with a port to open verbatim", async () => {
    const url = "http://127.0.0.1:9999/";
    await expect(openBrowser(url)).resolves.toBeUndefined();
    expect(openMock).toHaveBeenCalledWith(url);
  });

  // Regression test for the Windows / Claude Desktop bug where the previous
  // `cmd.exe /c start "" <url>` implementation dropped everything after the
  // first `&` (cmd treats it as a command separator) and re-encoded
  // unreserved chars (`_`, `-`, `.` → `%5F`, `%2D`, `%2E`) via
  // ShellExecute. After delegating to the `open` package the URL is
  // handed off verbatim. We assert that here at the seam — `openBrowser`
  // must not mutate the URL before it reaches `open`.
  it("forwards a SharePoint preview URL with `&` and unreserved chars verbatim", async () => {
    const url =
      "https://conativeab-my.sharepoint.com/my?id=%2Fpersonal%2Fsimon_co-native_com%2FDocuments%2Fmarkdown%2Fgraphdo-test-2026-04-24.md&parent=%2Fpersonal%2Fsimon_co-native_com%2FDocuments%2Fmarkdown";
    await expect(openBrowser(url)).resolves.toBeUndefined();
    expect(openMock).toHaveBeenCalledWith(url);
    const passed = openMock.mock.calls[0]?.[0] ?? "";
    // `&parent=` must survive — the original Windows bug dropped it.
    expect(passed).toContain("&parent=");
    // Unreserved characters must NOT have been percent-encoded by us.
    expect(passed).not.toContain("%5F");
    expect(passed).not.toContain("%2D");
    expect(passed).not.toContain("%2E");
  });

  it("wraps an open() rejection as a 'Failed to open browser' error", async () => {
    openMock.mockRejectedValueOnce(new Error("no browser"));
    await expect(openBrowser("https://example.com/")).rejects.toThrow(
      "Failed to open browser: no browser",
    );
  });

  it("wraps a non-Error rejection from open() with stringified message", async () => {
    openMock.mockRejectedValueOnce("explode");
    await expect(openBrowser("https://example.com/")).rejects.toThrow(
      "Failed to open browser: explode",
    );
  });
});
