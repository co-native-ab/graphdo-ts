// Tests for layout template — structure, favicon, font loading.

import { describe, it, expect } from "vitest";
import { layoutHtml } from "../../src/templates/layout.js";

describe("layout template", () => {
  const html = layoutHtml({
    title: "Test Page",
    body: '<div class="content">Hello</div>',
  });

  it("returns valid HTML with doctype", () => {
    expect(html).toMatch(/^<!DOCTYPE html>/);
  });

  it("has lang attribute on html element", () => {
    expect(html).toContain('<html lang="en">');
  });

  it("has charset meta tag", () => {
    expect(html).toContain('charset="utf-8"');
  });

  it("has viewport meta tag", () => {
    expect(html).toContain("viewport");
    expect(html).toContain("width=device-width");
  });

  it("sets the title", () => {
    expect(html).toContain("<title>Test Page</title>");
  });

  it("includes favicon as data URI", () => {
    expect(html).toContain('rel="icon"');
    expect(html).toContain("data:image/svg+xml;base64,");
  });

  it("includes Google Fonts preconnect hints", () => {
    expect(html).toContain('rel="preconnect"');
    expect(html).toContain("fonts.googleapis.com");
    expect(html).toContain("fonts.gstatic.com");
  });

  it("includes Google Fonts stylesheet link for Lexend", () => {
    expect(html).toContain("fonts.googleapis.com/css2");
    expect(html).toContain("Lexend");
    expect(html).toContain('rel="stylesheet"');
  });

  it("includes Lexend in inline stylesheet", () => {
    expect(html).toContain("Lexend");
  });

  it("renders body content", () => {
    expect(html).toContain('<div class="content">Hello</div>');
  });

  it("does not include script block when not provided", () => {
    expect(html).not.toContain("<script>");
  });

  it("includes script block when provided", () => {
    const withScript = layoutHtml({
      title: "Test",
      body: "<p>test</p>",
      script: "console.log('hello');",
    });
    expect(withScript).toContain("<script>");
    expect(withScript).toContain("console.log('hello');");
    expect(withScript).toContain("</script>");
  });

  it("includes extra styles when provided", () => {
    const withExtra = layoutHtml({
      title: "Test",
      body: "<p>test</p>",
      extraStyles: "\n    .custom { color: red; }",
    });
    expect(withExtra).toContain(".custom { color: red; }");
  });

  it("does not contain Co-native text", () => {
    expect(html.toLowerCase()).not.toContain("co-native");
  });
});
