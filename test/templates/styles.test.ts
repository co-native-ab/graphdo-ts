// Tests for shared styles — verifies CSS is built from tokens.

import { describe, it, expect } from "vitest";
import {
  BASE_STYLE,
  LOGIN_STYLE,
  SUCCESS_STYLE,
  ERROR_STYLE,
  PICKER_STYLE,
} from "../../src/templates/styles.js";
import { escapeHtml } from "../../src/templates/escape.js";
import { purple, grey, complementary, fontFamily } from "../../src/templates/tokens.js";

describe("shared styles", () => {
  describe("BASE_STYLE", () => {
    it("uses Lexend font family from tokens", () => {
      expect(BASE_STYLE).toContain("Lexend");
      expect(BASE_STYLE).toContain(fontFamily);
    });

    it("uses brand purple page background", () => {
      expect(BASE_STYLE).toContain(purple.minus3);
    });

    it("uses grey from tokens for text color", () => {
      expect(BASE_STYLE).toContain(grey.grey4);
    });

    it("uses white from tokens for card background", () => {
      expect(BASE_STYLE).toContain(grey.white);
    });

    it("uses low opacity for brand footer", () => {
      expect(BASE_STYLE).toContain("opacity: 0.18");
    });

    it("includes dark mode media query", () => {
      expect(BASE_STYLE).toContain("prefers-color-scheme: dark");
    });

    it("hardens the [hidden] attribute with display:none !important", () => {
      // Loopback pages rely on the standard HTML `hidden` attribute as
      // their CSP-safe visibility primitive. The strict CSP blocks inline
      // `style` attributes, and any page-specific `display:` rule could
      // otherwise un-hide a [hidden] element. The !important guard keeps
      // the primitive reliable across all templates.
      expect(BASE_STYLE).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
    });
  });

  describe("LOGIN_STYLE", () => {
    it("uses brand purple for button background", () => {
      expect(LOGIN_STYLE).toContain(purple.brand);
    });

    it("uses purple +1 for hover state", () => {
      expect(LOGIN_STYLE).toContain(purple.plus1);
    });

    it("uses purple +2 for active state", () => {
      expect(LOGIN_STYLE).toContain(purple.plus2);
    });
  });

  describe("SUCCESS_STYLE", () => {
    it("uses teal for success color", () => {
      expect(SUCCESS_STYLE).toContain(complementary.teal.base);
    });
  });

  describe("ERROR_STYLE", () => {
    it("uses peach for error color", () => {
      expect(ERROR_STYLE).toContain(complementary.peach.base);
    });

    it("uses peach light for error background", () => {
      expect(ERROR_STYLE).toContain(complementary.peach.light);
    });
  });

  describe("PICKER_STYLE", () => {
    it("uses brand purple for hover border", () => {
      expect(PICKER_STYLE).toContain(purple.brand);
    });

    it("uses grey for border color", () => {
      expect(PICKER_STYLE).toContain(grey.grey2);
    });

    it("uses teal for done heading color", () => {
      expect(PICKER_STYLE).toContain(complementary.teal.base);
    });

    it("uses Lexend font family", () => {
      expect(PICKER_STYLE).toContain("Lexend");
    });

    it("includes dark mode media query", () => {
      expect(PICKER_STYLE).toContain("prefers-color-scheme: dark");
    });
  });
});

describe("escapeHtml", () => {
  it("escapes ampersand", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("escapes less-than", () => {
    expect(escapeHtml("a<b")).toBe("a&lt;b");
  });

  it("escapes greater-than", () => {
    expect(escapeHtml("a>b")).toBe("a&gt;b");
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('a"b')).toBe("a&quot;b");
  });

  it("escapes all special chars together", () => {
    expect(escapeHtml('<script>"alert(1)&</script>')).toBe(
      "&lt;script&gt;&quot;alert(1)&amp;&lt;/script&gt;",
    );
  });

  it("leaves safe strings unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});
