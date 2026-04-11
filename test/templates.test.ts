// Tests for the frontend design system: tokens, styles, scripts, and templates.
//
// Verifies:
// - Design token values match the Co-native brand
// - CSS custom properties are generated correctly
// - Extracted scripts contain expected logic
// - Templates render with tokens (no hardcoded hex values)

import { describe, it, expect } from "vitest";

import { DESIGN_TOKENS, cssCustomProperties } from "../src/templates/tokens.js";
import {
  BASE_STYLE,
  LOGIN_STYLES,
  SUCCESS_STYLES,
  ERROR_STYLES,
  PICKER_STYLES,
  escapeHtml,
} from "../src/templates/styles.js";
import {
  countdownScript,
  pickerSelectionScript,
} from "../src/templates/scripts.js";
import {
  landingPageHtml,
  successPageHtml,
  errorPageHtml,
} from "../src/templates/login.js";
import { pickerPageHtml } from "../src/templates/picker.js";

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------

describe("design tokens", () => {
  it("has Co-native brand purple as primary color", () => {
    expect(DESIGN_TOKENS.color.primary).toBe("#70638c");
  });

  it("has darker shades for hover and active states", () => {
    expect(DESIGN_TOKENS.color.primaryHover).toBe("#5d5275");
    expect(DESIGN_TOKENS.color.primaryActive).toBe("#4a4260");
  });

  it("has semantic colors for success and error", () => {
    expect(DESIGN_TOKENS.color.success).toBe("#107c10");
    expect(DESIGN_TOKENS.color.error).toBe("#d13438");
  });

  it("has neutral palette for backgrounds and text", () => {
    expect(DESIGN_TOKENS.color.background).toBe("#f5f5f5");
    expect(DESIGN_TOKENS.color.surface).toBe("#ffffff");
    expect(DESIGN_TOKENS.color.textPrimary).toBe("#333333");
    expect(DESIGN_TOKENS.color.textSecondary).toBe("#666666");
    expect(DESIGN_TOKENS.color.textMuted).toBe("#999999");
    expect(DESIGN_TOKENS.color.border).toBe("#dddddd");
  });

  it("defines system font stack", () => {
    expect(DESIGN_TOKENS.font.family).toContain("-apple-system");
    expect(DESIGN_TOKENS.font.family).toContain("Segoe UI");
    expect(DESIGN_TOKENS.font.family).toContain("sans-serif");
  });

  it("token object shape is stable", () => {
    // The `as const` assertion makes the type read-only at compile time.
    // Verify the token object shape is stable via snapshot.
    expect(DESIGN_TOKENS).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// CSS custom properties
// ---------------------------------------------------------------------------

describe("cssCustomProperties", () => {
  const css = cssCustomProperties();

  it("generates a :root block", () => {
    expect(css).toContain(":root {");
    expect(css).toContain("}");
  });

  it("includes all color tokens", () => {
    expect(css).toContain("--color-primary: #70638c");
    expect(css).toContain("--color-primary-hover: #5d5275");
    expect(css).toContain("--color-primary-active: #4a4260");
    expect(css).toContain("--color-success: #107c10");
    expect(css).toContain("--color-error: #d13438");
    expect(css).toContain("--color-bg: #f5f5f5");
    expect(css).toContain("--color-surface: #ffffff");
    expect(css).toContain("--color-text: #333333");
    expect(css).toContain("--color-text-secondary: #666666");
    expect(css).toContain("--color-text-muted: #999999");
    expect(css).toContain("--color-border: #dddddd");
  });

  it("includes font tokens", () => {
    expect(css).toContain("--font-family:");
    expect(css).toContain("--font-size-heading:");
    expect(css).toContain("--font-weight-bold:");
  });

  it("includes spacing tokens", () => {
    expect(css).toContain("--spacing-page:");
    expect(css).toContain("--spacing-card:");
    expect(css).toContain("--spacing-gap8:");
    expect(css).toContain("--spacing-gap16:");
  });

  it("includes radius and shadow tokens", () => {
    expect(css).toContain("--radius-button:");
    expect(css).toContain("--radius-card:");
    expect(css).toContain("--shadow-card:");
    expect(css).toContain("--shadow-btn-hover:");
  });
});

// ---------------------------------------------------------------------------
// Style modules
// ---------------------------------------------------------------------------

describe("style modules", () => {
  it("BASE_STYLE includes :root custom properties", () => {
    expect(BASE_STYLE).toContain(":root {");
    expect(BASE_STYLE).toContain("--color-primary:");
  });

  it("BASE_STYLE uses CSS variables for layout", () => {
    expect(BASE_STYLE).toContain("var(--font-family)");
    expect(BASE_STYLE).toContain("var(--color-bg)");
    expect(BASE_STYLE).toContain("var(--color-surface)");
    expect(BASE_STYLE).toContain("var(--radius-card)");
    expect(BASE_STYLE).toContain("var(--shadow-card)");
  });

  it("LOGIN_STYLES uses CSS variables for brand colors", () => {
    expect(LOGIN_STYLES).toContain("var(--color-primary)");
    expect(LOGIN_STYLES).toContain("var(--color-primary-hover)");
    expect(LOGIN_STYLES).toContain("var(--color-primary-active)");
    expect(LOGIN_STYLES).toContain("var(--shadow-btn-hover)");
  });

  it("SUCCESS_STYLES uses success color variable", () => {
    expect(SUCCESS_STYLES).toContain("var(--color-success)");
  });

  it("ERROR_STYLES uses error color variables", () => {
    expect(ERROR_STYLES).toContain("var(--color-error)");
    expect(ERROR_STYLES).toContain("var(--color-error-bg)");
    expect(ERROR_STYLES).toContain("var(--color-error-light)");
  });

  it("PICKER_STYLES uses CSS variables for option buttons", () => {
    expect(PICKER_STYLES).toContain("var(--color-primary)");
    expect(PICKER_STYLES).toContain("var(--color-border)");
    expect(PICKER_STYLES).toContain("var(--shadow-option-hover)");
    expect(PICKER_STYLES).toContain("var(--color-primary-light-solid)");
  });

  it("no style module contains hardcoded brand hex values", () => {
    const allStyles = [BASE_STYLE, LOGIN_STYLES, SUCCESS_STYLES, ERROR_STYLES, PICKER_STYLES].join("");
    // Should not contain the old Microsoft blue or raw Co-native purple in style rules
    expect(allStyles).not.toContain("#0078d4");
    expect(allStyles).not.toContain("#106ebe");
    expect(allStyles).not.toContain("#005a9e");
    // Hardcoded semantic colors should be in tokens only, not in style rules.
    // The :root block in cssCustomProperties() contains them as values — strip
    // all :root blocks first (simple non-greedy match, safe because our :root
    // blocks do not contain nested braces).
    const withoutRoot = allStyles.replace(/:root\s*\{[\s\S]*?\n  \}/g, "");
    expect(withoutRoot).not.toContain("#70638c");
    expect(withoutRoot).not.toContain("#107c10");
    expect(withoutRoot).not.toContain("#d13438");
  });
});

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

describe("scripts", () => {
  describe("countdownScript", () => {
    const script = countdownScript("countdown", "manual-close", 5);

    it("initializes remaining seconds from parameter", () => {
      expect(script).toContain("let remaining = 5");
    });

    it("references the countdown element by ID", () => {
      expect(script).toContain("getElementById('countdown')");
    });

    it("references the manual-close element by ID", () => {
      expect(script).toContain("getElementById('manual-close')");
    });

    it("calls window.close()", () => {
      expect(script).toContain("window.close()");
    });

    it("uses setInterval for countdown", () => {
      expect(script).toContain("setInterval");
      expect(script).toContain("1000");
    });

    it("accepts custom parameters", () => {
      const custom = countdownScript("timer", "fallback-msg", 10);
      expect(custom).toContain("let remaining = 10");
      expect(custom).toContain("getElementById('timer')");
      expect(custom).toContain("getElementById('fallback-msg')");
    });
  });

  describe("pickerSelectionScript", () => {
    const script = pickerSelectionScript("countdown", "manual-close", 5);

    it("attaches click listeners to option buttons", () => {
      expect(script).toContain("querySelectorAll('.option-btn')");
      expect(script).toContain("addEventListener('click'");
    });

    it("POSTs to /select endpoint", () => {
      expect(script).toContain("fetch('/select'");
      expect(script).toContain("method: 'POST'");
      expect(script).toContain("application/json");
    });

    it("handles success: shows done view with countdown", () => {
      expect(script).toContain("getElementById('done')");
      expect(script).toContain("getElementById('selected-label')");
      expect(script).toContain("let remaining = 5");
    });

    it("handles errors: shows error and re-enables buttons", () => {
      expect(script).toContain("getElementById('error')");
      expect(script).toContain("b.disabled = false");
      expect(script).toContain("classList.remove('selected')");
    });
  });
});

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

describe("template rendering", () => {
  describe("landingPageHtml", () => {
    const html = landingPageHtml("https://login.example.com?client_id=abc&scope=openid");

    it("renders a complete HTML page", () => {
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("<html lang=\"en\">");
      expect(html).toContain("</html>");
    });

    it("includes CSS custom properties in <style>", () => {
      expect(html).toContain(":root {");
      expect(html).toContain("--color-primary:");
    });

    it("renders the graphdo brand", () => {
      expect(html).toContain("graphdo");
      expect(html).toContain("Sign in with Microsoft");
    });

    it("escapes the auth URL in the href", () => {
      expect(html).toContain("client_id=abc&amp;scope=openid");
    });

    it("uses token-based styles (no hardcoded hex in style rules)", () => {
      expect(html).not.toContain("#0078d4");
    });
  });

  describe("successPageHtml", () => {
    const html = successPageHtml();

    it("renders success message", () => {
      expect(html).toContain("Authentication successful");
      expect(html).toContain("close this window");
    });

    it("includes countdown script", () => {
      expect(html).toContain("<script>");
      expect(html).toContain("window.close()");
      expect(html).toContain("let remaining = 5");
    });

    it("includes CSS custom properties", () => {
      expect(html).toContain("--color-success:");
    });
  });

  describe("errorPageHtml", () => {
    const html = errorPageHtml("Something went wrong");

    it("renders error message", () => {
      expect(html).toContain("Authentication failed");
      expect(html).toContain("Something went wrong");
    });

    it("escapes HTML in error messages", () => {
      const xssHtml = errorPageHtml('<script>alert("xss")</script>');
      expect(xssHtml).not.toContain('<script>alert("xss")</script>');
      expect(xssHtml).toContain("&lt;script&gt;");
    });

    it("includes CSS custom properties", () => {
      expect(html).toContain("--color-error:");
    });
  });

  describe("pickerPageHtml", () => {
    const html = pickerPageHtml({
      title: "Select a list",
      subtitle: "Choose one:",
      options: [
        { id: "list-1", label: "Work" },
        { id: "list-2", label: "Personal" },
      ],
    });

    it("renders a complete HTML page", () => {
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("</html>");
    });

    it("renders title and subtitle", () => {
      expect(html).toContain("Select a list");
      expect(html).toContain("Choose one:");
    });

    it("renders option buttons with data attributes", () => {
      expect(html).toContain('data-id="list-1"');
      expect(html).toContain('data-label="Work"');
      expect(html).toContain('data-id="list-2"');
      expect(html).toContain('data-label="Personal"');
    });

    it("includes picker selection script", () => {
      expect(html).toContain("<script>");
      expect(html).toContain("fetch('/select'");
    });

    it("includes CSS custom properties", () => {
      expect(html).toContain(":root {");
      expect(html).toContain("--color-primary:");
    });

    it("uses token-based styles (no hardcoded brand hex)", () => {
      expect(html).not.toContain("#0078d4");
    });

    it("escapes HTML in option labels", () => {
      const xssHtml = pickerPageHtml({
        title: "Test",
        subtitle: "Test",
        options: [{ id: "xss", label: '<img src=x onerror=alert(1)>' }],
      });
      expect(xssHtml).not.toContain('<img src=x');
      expect(xssHtml).toContain("&lt;img");
    });
  });
});

// ---------------------------------------------------------------------------
// escapeHtml utility
// ---------------------------------------------------------------------------

describe("escapeHtml", () => {
  it("escapes ampersands", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("escapes angle brackets", () => {
    expect(escapeHtml("<div>")).toBe("&lt;div&gt;");
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('"hello"')).toBe("&quot;hello&quot;");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("passes through safe strings unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});
