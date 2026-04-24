// Tests for navigator page template — structure, tokens, dark mode,
// breadcrumb rendering rules, XSS escaping, favicon.

import { describe, it, expect } from "vitest";
import { navigatorPageHtml } from "../../src/templates/navigator.js";
import { purple, complementary } from "../../src/templates/tokens.js";

const sampleConfig = {
  title: "Select a workspace folder",
  subtitle: "Pick a folder in your OneDrive to use as the markdown workspace.",
  driveLabel: "OneDrive",
  csrfToken: "csrf-test-token",
  nonce: "nonce-test-value",
};

describe("navigator template", () => {
  const html = navigatorPageHtml(sampleConfig);

  it("returns valid HTML with doctype", () => {
    expect(html).toMatch(/^<!DOCTYPE html>/);
  });

  it("has correct title", () => {
    expect(html).toContain("<title>graphdo - Select a workspace folder</title>");
  });

  it("includes Google Fonts link for Lexend", () => {
    expect(html).toContain("fonts.googleapis.com");
    expect(html).toContain("Lexend");
  });

  it("includes brand purple in stylesheet", () => {
    expect(html).toContain(purple.brand);
  });

  it("includes favicon data URI", () => {
    expect(html).toContain('rel="icon"');
    expect(html).toContain("data:image/svg+xml;base64,");
  });

  it("includes brand logo footer with dark-mode swap", () => {
    expect(html).toContain('class="brand-footer"');
    expect(html).toContain("<picture>");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("</picture>");
  });

  it("renders title, subtitle, and drive label", () => {
    expect(html).toContain("Select a workspace folder");
    expect(html).toContain("Pick a folder in your OneDrive");
    expect(html).toContain("OneDrive");
  });

  it("includes CSRF meta tag with the supplied token", () => {
    expect(html).toContain('<meta name="csrf-token" content="csrf-test-token">');
  });

  it("applies the per-request CSP nonce to inline style and script", () => {
    expect(html).toContain('<style nonce="nonce-test-value">');
    expect(html).toContain('<script nonce="nonce-test-value">');
  });

  it("does not reference any undefined CSS custom properties", () => {
    // Earlier versions of this template referenced var(--brand),
    // var(--card-bg), var(--text-primary), etc. — none of which were
    // defined anywhere, so the page rendered with broken styling.
    expect(html).not.toMatch(/var\(--/);
  });

  it("includes a dark-mode media block in the navigator stylesheet", () => {
    // Both BASE_STYLE and NAVIGATOR_STYLE should contribute dark-mode
    // overrides; assert the navigator-specific selectors are present.
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain(".folder-list");
    expect(html).toContain(".folder-icon");
  });

  it("uses peach for error styling and teal for the done card", () => {
    expect(html).toContain(complementary.peach.base);
    expect(html).toContain(complementary.teal.base);
  });

  describe("toolbar", () => {
    it("does not render Back / Forward buttons", () => {
      // Removed in favour of breadcrumbs + filter — `‹` / `›` chevron
      // buttons are not self-explanatory and the breadcrumbs already
      // cover going back.
      expect(html).not.toContain('id="back-btn"');
      expect(html).not.toContain('id="forward-btn"');
      expect(html).not.toContain('aria-label="Back"');
      expect(html).not.toContain('aria-label="Forward"');
      expect(html).not.toContain("Alt+Left");
      expect(html).not.toContain("Alt+Right");
    });

    it("renders the filter input with an accessible label", () => {
      expect(html).toContain('id="filter-input"');
      expect(html).toContain('aria-label="Filter folders"');
      expect(html).toContain('placeholder="Filter folders');
    });
  });

  describe("pagination", () => {
    it("includes pagination controls in the markup", () => {
      expect(html).toContain('id="pagination"');
      expect(html).toContain('id="prev-btn"');
      expect(html).toContain('id="next-btn"');
      expect(html).toContain('id="page-status"');
    });

    it("pagination is hidden by default (toggled by JS)", () => {
      // CSP-safe primitive: hidden attribute, not inline style.
      expect(html).toMatch(/id="pagination"[^>]*\bhidden\b/);
    });

    it("script defines a page size of 25 and resets to page 0 on filter change", () => {
      expect(html).toContain("PAGE_SIZE = 25");
      expect(html).toContain("currentPage = 0");
    });
  });

  describe("breadcrumbs", () => {
    it("includes the breadcrumbs container", () => {
      expect(html).toContain('id="breadcrumbs"');
      expect(html).toContain('aria-label="Folder path"');
    });

    it("does not pre-render a literal '/ /' separator pair", () => {
      // Regression guard for the old "/ / [curr dir]" rendering bug.
      // Server-side output should leave the breadcrumbs container empty
      // (the client populates it from history). It must never literally
      // contain two adjacent crumb-sep spans, nor "/ /".
      expect(html).not.toContain("/ /");
      expect(html).not.toMatch(
        /<span class="crumb-sep"[^>]*>\u203A<\/span>\s*<span class="crumb-sep"/,
      );
    });

    it("script renders separators only between crumbs (never trailing)", () => {
      // The renderer pushes separators only when `!isLast`, so the
      // current crumb is never followed by a chevron.
      expect(html).toContain("if (!isLast)");
      expect(html).toContain("crumb-sep");
    });

    it("script renders the root crumb as a home icon (not the literal '/')", () => {
      expect(html).toContain("HOME_ICON");
      expect(html).toContain('aria-label="Drive root"');
    });
  });

  describe("navigation model", () => {
    it("uses a simple stack with breadcrumb-jump truncation", () => {
      expect(html).toContain("const stack");
      expect(html).toContain("function pushAndNavigate");
      expect(html).toContain("function jumpToBreadcrumb");
      // No browser-style cursor / forward-history machinery.
      expect(html).not.toContain("let cursor");
      expect(html).not.toContain("function canForward");
      expect(html).not.toContain("function go(delta)");
    });

    it("breadcrumb jumps truncate the stack to the chosen level", () => {
      // Without a Forward button, the only sensible breadcrumb behaviour
      // is to drop deeper entries when jumping back.
      expect(html).toMatch(/function jumpToBreadcrumb\(index\)[\s\S]*stack\.splice\(index \+ 1\)/);
    });
  });

  describe("primary action", () => {
    it("renders the select button disabled at startup (root)", () => {
      expect(html).toMatch(/id="select-btn"[^>]*\bdisabled\b/);
    });

    it("uses the primary-btn class (not a broken btn / btn-primary combo)", () => {
      expect(html).toContain('class="primary-btn"');
      expect(html).not.toContain('class="btn btn-primary"');
      expect(html).not.toContain('class="btn btn-secondary"');
    });

    it("reuses the shared cancel-btn for the Cancel action", () => {
      expect(html).toContain('class="cancel-btn"');
    });
  });

  describe("XSS escaping", () => {
    it("escapes title", () => {
      const malicious = navigatorPageHtml({
        ...sampleConfig,
        title: '<script>alert("xss")</script>',
      });
      expect(malicious).not.toContain('<script>alert("xss")</script>');
      expect(malicious).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    });

    it("escapes subtitle", () => {
      const malicious = navigatorPageHtml({
        ...sampleConfig,
        subtitle: '" onload="evil()"',
      });
      expect(malicious).not.toContain('" onload="evil()"');
      expect(malicious).toContain("&quot; onload=&quot;evil()&quot;");
    });

    it("escapes driveLabel", () => {
      const malicious = navigatorPageHtml({
        ...sampleConfig,
        driveLabel: "<img src=x onerror=alert(1)>",
      });
      expect(malicious).not.toContain("<img src=x onerror=alert(1)>");
      expect(malicious).toContain("&lt;img src=x onerror=alert(1)&gt;");
    });

    it("escapes csrfToken", () => {
      const malicious = navigatorPageHtml({
        ...sampleConfig,
        csrfToken: '"><script>alert(1)</script>',
      });
      expect(malicious).not.toContain('"><script>alert(1)</script>');
      expect(malicious).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    });
  });
});
