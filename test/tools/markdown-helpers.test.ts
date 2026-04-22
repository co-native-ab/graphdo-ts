// Unit tests for src/tools/markdown/helpers.ts — the smaller branches that
// are not reached by the integration suite.

import { describe, it, expect } from "vitest";

import type { GraphClient } from "../../src/graph/client.js";
import {
  DEFAULT_ONEDRIVE_WEB_URL,
  formatRevision,
  formatSize,
  resolveDriveItem,
  tryGetDriveWebUrl,
} from "../../src/tools/markdown/helpers.js";
import { gid, testSignal } from "../helpers.js";

// Minimal stub for GraphClient that returns a canned /me/drive response via
// `request()`. Only the bits exercised by markdown-helpers are implemented.
function makeStubClient(response: {
  status: number;
  body: unknown;
  throwOnRequest?: Error;
}): GraphClient {
  return {
    request(_method: string, _path: string): Promise<Response> {
      if (response.throwOnRequest) return Promise.reject(response.throwOnRequest);
      return Promise.resolve(
        new Response(JSON.stringify(response.body), {
          status: response.status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    },
  } as unknown as GraphClient;
}

describe("markdown-helpers", () => {
  describe("formatSize", () => {
    it("returns 'unknown size' when bytes is undefined", () => {
      expect(formatSize(undefined)).toBe("unknown size");
    });

    it("renders bytes as a plain number with a bytes suffix", () => {
      expect(formatSize(0)).toBe("0 bytes");
      expect(formatSize(123_456)).toBe("123456 bytes");
    });
  });

  describe("formatRevision", () => {
    it("returns the revision verbatim when known", () => {
      expect(formatRevision("1.0")).toBe("1.0");
    });

    it("directs the agent to list versions when unknown", () => {
      expect(formatRevision(undefined)).toMatch(/markdown_list_file_versions/);
    });
  });

  describe("resolveDriveItem", () => {
    it("throws when neither itemId nor fileName is provided", async () => {
      const client = makeStubClient({ status: 200, body: {} });
      await expect(resolveDriveItem(client, gid("folder-1"), {}, testSignal())).rejects.toThrow(
        /Either itemId or fileName/,
      );
    });
  });

  describe("tryGetDriveWebUrl", () => {
    it("returns the drive webUrl when /me/drive succeeds", async () => {
      const client = makeStubClient({
        status: 200,
        body: { id: "d", webUrl: "https://contoso-my.sharepoint.com/personal/x" },
      });
      await expect(tryGetDriveWebUrl(client, testSignal())).resolves.toBe(
        "https://contoso-my.sharepoint.com/personal/x",
      );
    });

    it("falls back when /me/drive returns no webUrl", async () => {
      const client = makeStubClient({ status: 200, body: { id: "d" } });
      await expect(tryGetDriveWebUrl(client, testSignal())).resolves.toBe(DEFAULT_ONEDRIVE_WEB_URL);
    });

    it("falls back when /me/drive throws", async () => {
      const client = makeStubClient({
        status: 500,
        body: {},
        throwOnRequest: new Error("network down"),
      });
      await expect(tryGetDriveWebUrl(client, testSignal())).resolves.toBe(DEFAULT_ONEDRIVE_WEB_URL);
    });
  });
});
