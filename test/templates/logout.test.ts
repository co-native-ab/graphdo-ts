// Tests for logout page template — structure, tokens, buttons, favicon.

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
      expect(html).toContain("<title>graphdo - Sign Out</title>");
    });

    it("includes Google Fonts link for Lexend", () => {
      expect(html).toContain("fonts.googleapis.com");
      expect(html).toContain("Lexend");
    });

    it("shows confirmation prompt before sign-out", () => {
      expect(html).toContain("Sign out?");
    });

    it("has a Sign Out confirm button", () => {
      expect(html).toContain('id="sign-out-btn"');
      expect(html).toContain("Sign Out");
    });

    it("has a Cancel button", () => {
      expect(html).toContain('id="cancel-btn"');
      expect(html).toContain("Cancel");
    });

    it("has a done-view with signed-out success message (hidden initially)", () => {
      expect(html).toContain('id="done-view"');
      expect(html).toContain("Signed out successfully");
    });

    it("mentions token clearing in the done-view", () => {
      expect(html).toContain("cached tokens have been cleared");
    });

    it("confirm button POSTs to /confirm", () => {
      expect(html).toContain("fetch('/confirm'");
    });

    it("cancel button POSTs to /cancel", () => {
      expect(html).toContain("fetch('/cancel'");
    });

    it("has countdown script in done view", () => {
      expect(html).toContain("countdown");
      expect(html).toContain("setInterval");
    });

    it("uses peach color for sign-out button (destructive action)", () => {
      expect(html).toContain(complementary.peach.base);
    });

    it("includes teal for success color in done view", () => {
      expect(html).toContain(complementary.teal.base);
    });

    it("includes favicon data URI", () => {
      expect(html).toContain('rel="icon"');
      expect(html).toContain("data:image/svg+xml;base64,");
    });

    it("includes brand logo footer below card", () => {
      expect(html).toContain('class="brand-footer"');
    });

    it("uses picture element for dark mode logo swap", () => {
      expect(html).toContain("<picture>");
      expect(html).toContain("prefers-color-scheme: dark");
      expect(html).toContain("</picture>");
    });

    it("includes manual close fallback", () => {
      expect(html).toContain("manual-close");
      expect(html).toContain("close it manually");
    });

    it("does not contain Co-native text", () => {
      expect(html.toLowerCase()).not.toContain("co-native");
    });

    it("contains graphdo branding", () => {
      expect(html).toContain("graphdo");
    });
  });
});
