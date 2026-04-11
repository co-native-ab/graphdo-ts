// Tests for design tokens — verifies token values match the brand spec.

import { describe, it, expect } from "vitest";
import {
  purple,
  grey,
  complementary,
  fontFamily,
  fontWeight,
  fontSize,
  spacing,
  borderRadius,
  shadow,
  googleFontsUrl,
} from "../../src/templates/tokens.js";

describe("design tokens", () => {
  describe("purple scale", () => {
    it("has correct brand purple", () => {
      expect(purple.brand).toBe("#6659a7");
    });

    it("has correct purple +1 (hover)", () => {
      expect(purple.plus1).toBe("#3c2f7f");
    });

    it("has correct purple +2 (deepest)", () => {
      expect(purple.plus2).toBe("#120457");
    });

    it("has correct purple -1 (lighter tint)", () => {
      expect(purple.minus1).toBe("#9289c0");
    });

    it("has correct purple -2 (subtle backgrounds)", () => {
      expect(purple.minus2).toBe("#beb8da");
    });

    it("has correct purple -3 (page backgrounds)", () => {
      expect(purple.minus3).toBe("#eae8f3");
    });
  });

  describe("greyscale", () => {
    it("has correct values", () => {
      expect(grey.black).toBe("#000000");
      expect(grey.grey4).toBe("#636466");
      expect(grey.grey3).toBe("#8a8c8e");
      expect(grey.grey2).toBe("#c7c8ca");
      expect(grey.grey1).toBe("#efeff0");
      expect(grey.white).toBe("#ffffff");
    });
  });

  describe("complementary palette", () => {
    it("has correct sandstone values", () => {
      expect(complementary.sandstone.base).toBe("#dac48a");
      expect(complementary.sandstone.light).toBe("#F8F2E6");
    });

    it("has correct teal values", () => {
      expect(complementary.teal.base).toBe("#AABDB5");
      expect(complementary.teal.light).toBe("#dae2df");
    });

    it("has correct cobalt values", () => {
      expect(complementary.cobalt.base).toBe("#5271AC");
      expect(complementary.cobalt.light).toBe("#DCE2EE");
    });

    it("has correct peach values", () => {
      expect(complementary.peach.base).toBe("#F9AA8F");
      expect(complementary.peach.light).toBe("#FDE4DC");
    });
  });

  describe("typography", () => {
    it("includes Lexend as primary font", () => {
      expect(fontFamily).toContain("Lexend");
    });

    it("includes Arial as fallback", () => {
      expect(fontFamily).toContain("Arial");
    });

    it("includes sans-serif as final fallback", () => {
      expect(fontFamily).toContain("sans-serif");
    });

    it("has all required font weights", () => {
      expect(fontWeight.light).toBe(300);
      expect(fontWeight.regular).toBe(400);
      expect(fontWeight.semibold).toBe(600);
      expect(fontWeight.bold).toBe(700);
    });
  });

  describe("spacing, border radius, shadow", () => {
    it("exports spacing scale", () => {
      expect(Object.keys(spacing).length).toBeGreaterThanOrEqual(5);
    });

    it("exports border radius scale", () => {
      expect(Object.keys(borderRadius).length).toBeGreaterThanOrEqual(3);
    });

    it("exports shadow values", () => {
      expect(shadow.card).toBeDefined();
      expect(shadow.hover).toBeDefined();
    });
  });

  describe("font sizes", () => {
    it("exports font size scale", () => {
      expect(Object.keys(fontSize).length).toBeGreaterThanOrEqual(6);
    });
  });

  describe("google fonts URL", () => {
    it("points to Lexend on Google Fonts", () => {
      expect(googleFontsUrl).toContain("fonts.googleapis.com");
      expect(googleFontsUrl).toContain("Lexend");
    });

    it("requests required weights", () => {
      expect(googleFontsUrl).toContain("400");
      expect(googleFontsUrl).toContain("600");
      expect(googleFontsUrl).toContain("700");
    });

    it("uses display=swap for graceful loading", () => {
      expect(googleFontsUrl).toContain("display=swap");
    });
  });
});
