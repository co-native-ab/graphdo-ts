// Unit tests for the openBrowser URL validation logic.
//
// The actual browser-opening side effect is not tested here (it requires a
// real display), but the validation guards that run before spawning any
// process are fully exercised.

import { describe, it, expect } from "vitest";

import { openBrowser } from "../src/browser.js";

describe("openBrowser", () => {
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

  it("rejects a remote hostname", async () => {
    await expect(
      openBrowser("http://example.com/anything"),
    ).rejects.toThrow("URL must be a localhost address, got: example.com");
  });

  it("rejects a remote IP address", async () => {
    await expect(openBrowser("http://192.168.1.1:8080/")).rejects.toThrow(
      "URL must be a localhost address, got: 192.168.1.1",
    );
  });

  it("accepts http://localhost with a port", async () => {
    // Validation passes — the actual execFile call will fail in CI (no browser),
    // so we only assert the rejection message is about the browser, not validation.
    const result = openBrowser("http://localhost:12345/");
    await expect(result).rejects.toThrow("Failed to open browser:");
  });

  it("accepts http://127.0.0.1 with a port", async () => {
    const result = openBrowser("http://127.0.0.1:9999/");
    await expect(result).rejects.toThrow("Failed to open browser:");
  });
});
