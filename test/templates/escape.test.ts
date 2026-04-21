// Tests for the escapeHtml helper.
//
// `escapeHtml` is the single sink that every variable interpolation in
// `src/templates/{login,picker,logout}.ts` must pass through to prevent XSS.

import { describe, it, expect } from "vitest";
import { escapeHtml } from "../../src/templates/escape.js";

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

  it("escapes single quotes", () => {
    expect(escapeHtml("a'b")).toBe("a&#39;b");
  });

  it("escapes all special chars together", () => {
    expect(escapeHtml('<script>"alert(1)&</script>')).toBe(
      "&lt;script&gt;&quot;alert(1)&amp;&lt;/script&gt;",
    );
  });

  it("leaves safe strings unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("returns an empty string for an empty input", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("escapes ampersand first so existing entities are not collapsed", () => {
    // Naive escape orders that replace `<` before `&` would corrupt a
    // pre-existing `&lt;` into `&amp;lt;` only if `&` were processed
    // afterwards. Verify our order keeps the literal text round-trippable.
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  it("neutralises an attribute-breakout payload", () => {
    const out = escapeHtml('" onclick="alert(1)');
    expect(out).not.toContain('"');
    expect(out).toContain("&quot; onclick=&quot;alert(1)");
  });

  it("neutralises a tag-injection payload", () => {
    const out = escapeHtml("</script><img src=x onerror=alert(1)>");
    expect(out).not.toContain("</script>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;");
  });
});
