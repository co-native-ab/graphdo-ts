// Tests for login page templates — structure, tokens, XSS escaping, favicon.

import { describe, it, expect } from "vitest";
import { landingPageHtml, successPageHtml, errorPageHtml } from "../../src/templates/login.js";
import { purple, complementary } from "../../src/templates/tokens.js";

describe("login templates", () => {
  describe("landingPageHtml", () => {
    const html = landingPageHtml("https://login.example.com?client=abc&scope=openid");

    it("returns valid HTML with doctype", () => {
      expect(html).toMatch(/^<!DOCTYPE html>/);
    });

    it("has html, head and body elements", () => {
      expect(html).toContain("<html");
      expect(html).toContain("<head>");
      expect(html).toContain("<body>");
    });

    it("has correct title", () => {
      expect(html).toContain("<title>graphdo - Sign In</title>");
    });

    it("includes Google Fonts link for Lexend", () => {
      expect(html).toContain("fonts.googleapis.com");
      expect(html).toContain("Lexend");
    });

    it("includes Lexend in stylesheet", () => {
      expect(html).toContain("Lexend");
    });

    it("includes brand purple in stylesheet", () => {
      expect(html).toContain(purple.brand);
    });

    it("includes dark mode styles", () => {
      expect(html).toContain("prefers-color-scheme: dark");
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

    it("includes the sign-in button", () => {
      expect(html).toContain("Sign in with Microsoft");
      expect(html).toContain('class="sign-in-btn"');
    });

    it("escapes auth URL (ampersand)", () => {
      expect(html).toContain("client=abc&amp;scope=openid");
      expect(html).not.toContain("client=abc&scope=openid");
    });

    it("does not contain Co-native text", () => {
      expect(html.toLowerCase()).not.toContain("co-native");
    });

    it("escapes angle brackets in auth URL", () => {
      const xssHtml = landingPageHtml("https://evil.com?x=<script>alert(1)</script>");
      expect(xssHtml).not.toContain("<script>alert(1)</script>");
      expect(xssHtml).toContain("&lt;script&gt;");
    });
  });

  describe("successPageHtml", () => {
    const html = successPageHtml();

    it("returns valid HTML with doctype", () => {
      expect(html).toMatch(/^<!DOCTYPE html>/);
    });

    it("has correct title", () => {
      expect(html).toContain("<title>graphdo - Signed In</title>");
    });

    it("shows success message", () => {
      expect(html).toContain("Authentication successful");
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
      expect(html).toContain("data:image/svg+xml;base64,");
    });

    it("does not contain Co-native text", () => {
      expect(html.toLowerCase()).not.toContain("co-native");
    });
  });

  describe("errorPageHtml", () => {
    it("returns valid HTML with doctype", () => {
      const html = errorPageHtml("something went wrong");
      expect(html).toMatch(/^<!DOCTYPE html>/);
    });

    it("has correct title", () => {
      const html = errorPageHtml("test error");
      expect(html).toContain("<title>graphdo - Sign In Failed</title>");
    });

    it("shows the error message", () => {
      const html = errorPageHtml("User cancelled the sign-in");
      expect(html).toContain("User cancelled the sign-in");
    });

    it("includes peach for error color", () => {
      const html = errorPageHtml("test");
      expect(html).toContain(complementary.peach.base);
    });

    it("escapes HTML in error messages", () => {
      const html = errorPageHtml("<img src=x onerror=alert(1)>");
      expect(html).not.toContain("<img src=x");
      expect(html).toContain("&lt;img");
    });

    it("escapes quotes in error messages", () => {
      const html = errorPageHtml('error with "quotes"');
      expect(html).toContain("&quot;quotes&quot;");
    });

    it("includes favicon data URI", () => {
      const html = errorPageHtml("test");
      expect(html).toContain('rel="icon"');
      expect(html).toContain("data:image/svg+xml;base64,");
    });

    it("does not contain Co-native text", () => {
      const html = errorPageHtml("test");
      expect(html.toLowerCase()).not.toContain("co-native");
    });
  });
});
