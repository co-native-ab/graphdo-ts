// Tests for picker page template — structure, tokens, XSS escaping, favicon.

import { describe, it, expect } from "vitest";
import { pickerPageHtml } from "../../src/templates/picker.js";
import { purple, complementary } from "../../src/templates/tokens.js";

const sampleConfig = {
  title: "Select a List",
  subtitle: "Choose your todo list:",
  options: [
    { id: "list-1", label: "Work Tasks" },
    { id: "list-2", label: "Personal" },
  ],
};

describe("picker template", () => {
  const html = pickerPageHtml(sampleConfig);

  it("returns valid HTML with doctype", () => {
    expect(html).toMatch(/^<!DOCTYPE html>/);
  });

  it("has html, head and body elements", () => {
    expect(html).toContain("<html");
    expect(html).toContain("<head>");
    expect(html).toContain("<body>");
  });

  it("has correct title", () => {
    expect(html).toContain("<title>graphdo - Select a List</title>");
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
    expect(html).toContain("data:image/png;base64,");
  });

  it("includes page icon in body", () => {
    expect(html).toContain('class="page-icon"');
  });

  it("renders title and subtitle", () => {
    expect(html).toContain("Select a List");
    expect(html).toContain("Choose your todo list:");
  });

  it("renders option buttons with data attributes", () => {
    expect(html).toContain('data-id="list-1"');
    expect(html).toContain('data-label="Work Tasks"');
    expect(html).toContain('data-id="list-2"');
    expect(html).toContain('data-label="Personal"');
  });

  it("renders option labels as button text", () => {
    expect(html).toContain(">Work Tasks</button>");
    expect(html).toContain(">Personal</button>");
  });

  it("includes teal for done state", () => {
    expect(html).toContain(complementary.teal.base);
  });

  it("includes JavaScript for selection handling", () => {
    expect(html).toContain("fetch('/select'");
    expect(html).toContain("option-btn");
  });

  it("does not contain Co-native text", () => {
    expect(html.toLowerCase()).not.toContain("co-native");
  });

  describe("XSS escaping", () => {
    it("escapes HTML in option labels", () => {
      const xssConfig = {
        title: "Test",
        subtitle: "Test",
        options: [{ id: "xss", label: '<script>alert("xss")</script>' }],
      };
      const xssHtml = pickerPageHtml(xssConfig);
      expect(xssHtml).not.toContain('<script>alert("xss")</script>');
      expect(xssHtml).toContain("&lt;script&gt;");
    });

    it("escapes HTML in option IDs", () => {
      const xssConfig = {
        title: "Test",
        subtitle: "Test",
        options: [{ id: 'x"><script>', label: "test" }],
      };
      const xssHtml = pickerPageHtml(xssConfig);
      expect(xssHtml).not.toContain('"><script>');
      expect(xssHtml).toContain("&quot;&gt;&lt;script&gt;");
    });

    it("escapes HTML in title", () => {
      const xssConfig = {
        title: "<b>Bold</b>",
        subtitle: "Test",
        options: [],
      };
      const xssHtml = pickerPageHtml(xssConfig);
      expect(xssHtml).not.toContain("<b>Bold</b>");
      expect(xssHtml).toContain("&lt;b&gt;Bold&lt;/b&gt;");
    });

    it("escapes HTML in subtitle", () => {
      const xssConfig = {
        title: "Test",
        subtitle: '<img src=x onerror="alert(1)">',
        options: [],
      };
      const xssHtml = pickerPageHtml(xssConfig);
      expect(xssHtml).not.toContain("<img src=x");
      expect(xssHtml).toContain("&lt;img");
    });
  });
});
