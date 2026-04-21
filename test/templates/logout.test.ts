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
      // Strict-CSP defence: the success view must use the standard HTML
      // `hidden` attribute, not an inline style="display:none" (which is
      // blocked by the loopback CSP and would leave it visible from page
      // load — see the "Sign out" page bug fix).
      expect(html).toMatch(/id="done-view"[^>]*\bhidden\b/);
      expect(html).not.toMatch(/style="[^"]*display\s*:\s*none/i);
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
      // Same CSP defence as the done-view: must use the `hidden` attribute,
      // not an inline display:none.
      expect(html).toMatch(/id="manual-close"[^>]*\bhidden\b/);
    });

    it("does not contain Co-native text", () => {
      expect(html.toLowerCase()).not.toContain("co-native");
    });

    it("contains graphdo branding", () => {
      expect(html).toContain("graphdo");
    });
  });

  describe("logoutPageHtml with csrfToken and nonce (hardened loopback parity)", () => {
    it('embeds a <meta name="csrf-token"> tag when csrfToken is provided', () => {
      const html = logoutPageHtml({ csrfToken: "abc123" });
      expect(html).toContain('<meta name="csrf-token" content="abc123">');
    });

    it("HTML-escapes the csrfToken in the meta tag", () => {
      const html = logoutPageHtml({ csrfToken: '"><script>alert(1)</script>' });
      expect(html).not.toContain('"><script>alert(1)</script>');
      expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    });

    it("does not embed a CSRF meta tag when csrfToken is omitted", () => {
      const html = logoutPageHtml();
      expect(html).not.toContain('<meta name="csrf-token"');
    });

    it("applies the nonce to inline <script> and <style>", () => {
      const html = logoutPageHtml({ nonce: "nnn-abc" });
      expect(html).toContain('<script nonce="nnn-abc">');
      expect(html).toContain('<style nonce="nnn-abc">');
    });

    it("the inline script reads csrfToken from the meta tag", () => {
      const html = logoutPageHtml({ csrfToken: "tok" });
      expect(html).toContain('meta[name="csrf-token"]');
      expect(html).toContain("getAttribute('content')");
    });

    it("the /confirm POST sends JSON with the csrfToken", () => {
      const html = logoutPageHtml({ csrfToken: "tok" });
      expect(html).toContain("fetch('/confirm'");
      expect(html).toContain("'Content-Type': 'application/json'");
      expect(html).toContain("JSON.stringify({ csrfToken: csrfToken })");
    });

    it("the /cancel POST sends JSON with the csrfToken", () => {
      const html = logoutPageHtml({ csrfToken: "tok" });
      expect(html).toContain("fetch('/cancel'");
      // cancel uses the same JSON body shape
      const cancelIndex = html.indexOf("fetch('/cancel'");
      const cancelBlock = html.slice(cancelIndex, cancelIndex + 300);
      expect(cancelBlock).toContain("'Content-Type': 'application/json'");
      expect(cancelBlock).toContain("JSON.stringify({ csrfToken: csrfToken })");
    });
  });
});
