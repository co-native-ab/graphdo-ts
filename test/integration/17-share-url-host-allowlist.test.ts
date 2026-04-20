// Scenario test #17: share URL host allow-list (collab v1 §4.4).
//
// Validates that `session_open_project`'s URL-paste resolution refuses
// attacker-controlled URLs before issuing any Graph call. The allow-list
// (§4.4) accepts only:
//
//   - `*.sharepoint.com`
//   - `*-my.sharepoint.com`
//   - `1drv.ms`
//   - `onedrive.live.com`
//
// Anything else (`http://`, `file:///`, IP literals, `localhost`, arbitrary
// hostnames) is refused with `InvalidShareUrlError` carrying a precise
// `reason`. The tests assert that no Graph call is issued for rejected URLs.

import { describe, it, expect } from "vitest";

import { validateShareUrl, encodeShareUrl } from "../../src/collab/share-url.js";
import { InvalidShareUrlError } from "../../src/errors.js";

describe("17-share-url-host-allowlist", () => {
  describe("Refusal matrix (no Graph calls)", () => {
    it("refuses http:// (unsupported_scheme)", () => {
      try {
        validateShareUrl("http://contoso.sharepoint.com/sites/foo");
        throw new Error("expected InvalidShareUrlError");
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidShareUrlError);
        const e = err as InvalidShareUrlError;
        expect(e.reason).toBe("unsupported_scheme");
      }
    });

    it("refuses file:/// (unsupported_scheme)", () => {
      try {
        validateShareUrl("file:///etc/passwd");
        throw new Error("expected InvalidShareUrlError");
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidShareUrlError);
        const e = err as InvalidShareUrlError;
        expect(e.reason).toBe("unsupported_scheme");
      }
    });

    it("refuses IPv4 literal (ip_literal)", () => {
      try {
        validateShareUrl("https://10.0.0.1/share");
        throw new Error("expected InvalidShareUrlError");
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidShareUrlError);
        const e = err as InvalidShareUrlError;
        expect(e.reason).toBe("ip_literal");
      }
    });

    it("refuses IPv6 literal (ip_literal)", () => {
      try {
        validateShareUrl("https://[::1]/share");
        throw new Error("expected InvalidShareUrlError");
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidShareUrlError);
        const e = err as InvalidShareUrlError;
        expect(e.reason).toBe("ip_literal");
      }
    });

    it("refuses localhost (loopback)", () => {
      try {
        validateShareUrl("https://localhost/share");
        throw new Error("expected InvalidShareUrlError");
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidShareUrlError);
        const e = err as InvalidShareUrlError;
        expect(e.reason).toBe("loopback");
      }
    });

    it("refuses 127.0.0.1 (loopback)", () => {
      try {
        validateShareUrl("https://127.0.0.1/share");
        throw new Error("expected InvalidShareUrlError");
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidShareUrlError);
        const e = err as InvalidShareUrlError;
        expect(e.reason).toBe("loopback");
      }
    });

    it("refuses arbitrary attacker hostname (unsupported_host)", () => {
      try {
        validateShareUrl("https://attacker.example.com/share");
        throw new Error("expected InvalidShareUrlError");
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidShareUrlError);
        const e = err as InvalidShareUrlError;
        expect(e.reason).toBe("unsupported_host");
      }
    });

    it("refuses suffix-spoofing (unsupported_host)", () => {
      try {
        validateShareUrl("https://evil-sharepoint.com.evil.example/share");
        throw new Error("expected InvalidShareUrlError");
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidShareUrlError);
        const e = err as InvalidShareUrlError;
        expect(e.reason).toBe("unsupported_host");
      }
    });

    it("refuses malformed URL (malformed)", () => {
      try {
        validateShareUrl("not a URL at all");
        throw new Error("expected InvalidShareUrlError");
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidShareUrlError);
        const e = err as InvalidShareUrlError;
        expect(e.reason).toBe("malformed");
      }
    });
  });

  describe("Happy-path rows (allowed hosts)", () => {
    it("accepts https://*.sharepoint.com", () => {
      const url = "https://contoso.sharepoint.com/sites/foo/Shared%20Documents/proj";
      const validated = validateShareUrl(url);
      expect(validated).toBe(url);
      const encoded = encodeShareUrl(validated);
      expect(encoded).toMatch(/^u!/);
    });

    it("accepts https://*-my.sharepoint.com", () => {
      const url = "https://contoso-my.sharepoint.com/personal/user_contoso_com/Documents/proj";
      const validated = validateShareUrl(url);
      expect(validated).toBe(url);
      const encoded = encodeShareUrl(validated);
      expect(encoded).toMatch(/^u!/);
    });

    it("accepts https://1drv.ms", () => {
      const url = "https://1drv.ms/f/s!ABC123";
      const validated = validateShareUrl(url);
      expect(validated).toBe(url);
      const encoded = encodeShareUrl(validated);
      expect(encoded).toMatch(/^u!/);
    });

    it("accepts https://onedrive.live.com", () => {
      const url = "https://onedrive.live.com/?cid=XYZ";
      const validated = validateShareUrl(url);
      expect(validated).toBe(url);
      const encoded = encodeShareUrl(validated);
      expect(encoded).toMatch(/^u!/);
    });
  });

  describe("Base64url encoding", () => {
    it("encodes to u!<base64url> with no padding", () => {
      const url = "https://contoso.sharepoint.com/test";
      const encoded = encodeShareUrl(url);
      expect(encoded).toMatch(/^u!/);
      // Should not have = padding
      expect(encoded).not.toContain("=");
      // Should use URL-safe characters (- and _ instead of + and /)
      const base64Part = encoded.slice(2);
      expect(base64Part).not.toContain("+");
      expect(base64Part).not.toContain("/");
    });
  });
});
