// Tests for logout page template — structure, tokens, countdown, favicon.

import { describe, it, expect } from "vitest";
import { logoutPageHtml } from "../../src/templates/logout.js";
import { complementary } from "../../src/templates/tokens.js";

describe("logout template", () => {
  describe("logoutPageHtml", () => {
    const html = logoutPageHtml();

    it("returns valid HTML with doctype", () => {
      expect(html).toMatch(/^<!DOCTYPE html>/);
    });

    it("has html, head and body elements", () => {
      expect(html).toContain("<html");
      expect(html).toContain("<head>");
      expect(html).toContain("<body>");
    });

    it("has correct title", () => {
      expect(html).toContain("<title>graphdo - Signed Out</title>");
    });

    it("includes Google Fonts link for Lexend", () => {
      expect(html).toContain("fonts.googleapis.com");
      expect(html).toContain("Lexend");
    });

    it("shows signed out message", () => {
      expect(html).toContain("Signed out successfully");
    });

    it("mentions token clearing", () => {
      expect(html).toContain("cached tokens have been cleared");
    });

    it("has countdown script", () => {
      expect(html).toContain("countdown");
      expect(html).toContain("setInterval");
    });

    it("includes teal for success color", () => {
      expect(html).toContain(complementary.teal.base);
    });

    it("includes favicon data URI", () => {
      expect(html).toContain('rel="icon"');
      expect(html).toContain("data:image/png;base64,");
    });

    it("includes page icon in body", () => {
      expect(html).toContain('class="page-icon"');
    });

    it("includes checkmark", () => {
      expect(html).toContain('class="checkmark"');
    });

    it("includes manual close fallback", () => {
      expect(html).toContain("manual-close");
      expect(html).toContain("close it manually");
    });

    it("does not contain Co-native text", () => {
      expect(html.toLowerCase()).not.toContain("co-native");
    });
  });
});
