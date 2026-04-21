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

  describe("pagination", () => {
    it("includes pagination controls in the markup", () => {
      expect(html).toContain('id="pagination"');
      expect(html).toContain('id="prev-btn"');
      expect(html).toContain('id="next-btn"');
      expect(html).toContain('id="page-status"');
    });

    it("pagination is hidden by default (toggled by JS)", () => {
      // The server renders the bar with the HTML `hidden` attribute (CSP-
      // safe primitive); the client script reveals it once it knows how
      // many matches exist. Inline style="display:none" is forbidden — it
      // is blocked by the strict loopback CSP.
      expect(html).toMatch(/id="pagination"[^>]*\bhidden\b/);
    });

    it("script defines a page size of 10 and resets to page 0 on filter change", () => {
      expect(html).toContain("PAGE_SIZE = 10");
      // Filter input handler must reset currentPage so matches on later
      // pages don't stay hidden when the user types.
      expect(html).toContain("currentPage = 0");
    });

    it("script still filters across the full option set", () => {
      // Guard: filter must evaluate label.indexOf(q) over every
      // .option-btn, not just the ones currently visible.
      expect(html).toContain("list.querySelectorAll('.option-btn')");
      expect(html).toContain("label.indexOf(q)");
    });

    it("script wires prev and next buttons", () => {
      expect(html).toContain("prevBtn.addEventListener('click'");
      expect(html).toContain("nextBtn.addEventListener('click'");
    });
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

    it("escapes HTML in filterPlaceholder (attribute breakout)", () => {
      const xssConfig = {
        title: "Test",
        subtitle: "Test",
        options: [],
        filterPlaceholder: '" autofocus onfocus="alert(1)',
      };
      const xssHtml = pickerPageHtml(xssConfig);
      // Must not allow the attacker to close the placeholder attribute and
      // inject new attributes on the <input> element.
      expect(xssHtml).not.toContain('placeholder="" autofocus');
      expect(xssHtml).toContain("&quot; autofocus onfocus=&quot;alert(1)");
    });

    it("escapes HTML in createLink.url (attribute breakout)", () => {
      const xssConfig = {
        title: "Test",
        subtitle: "Test",
        options: [],
        createLink: {
          url: 'https://example.com/"><script>alert(1)</script>',
          label: "Create",
        },
      };
      const xssHtml = pickerPageHtml(xssConfig);
      expect(xssHtml).not.toContain('"><script>');
      expect(xssHtml).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    });

    it("escapes HTML in createLink.label", () => {
      const xssConfig = {
        title: "Test",
        subtitle: "Test",
        options: [],
        createLink: {
          url: "https://example.com",
          label: "<b>Create</b>",
        },
      };
      const xssHtml = pickerPageHtml(xssConfig);
      expect(xssHtml).not.toContain("<b>Create</b>");
      expect(xssHtml).toContain("&lt;b&gt;Create&lt;/b&gt;");
    });

    it("escapes HTML in createLink.description", () => {
      const xssConfig = {
        title: "Test",
        subtitle: "Test",
        options: [],
        createLink: {
          url: "https://example.com",
          label: "Create",
          description: '<img src=x onerror="alert(1)">',
        },
      };
      const xssHtml = pickerPageHtml(xssConfig);
      expect(xssHtml).not.toContain("<img src=x");
      expect(xssHtml).toContain("&lt;img");
    });
  });

  describe("loopback hardening", () => {
    it("embeds the CSRF token in a <meta> tag when provided", () => {
      const out = pickerPageHtml({ ...sampleConfig, csrfToken: "deadbeef".repeat(8) });
      expect(out).toContain(`<meta name="csrf-token" content="${"deadbeef".repeat(8)}">`);
    });

    it("does not emit the CSRF meta tag when not provided", () => {
      expect(html).not.toContain('<meta name="csrf-token"');
    });

    it("escapes the CSRF token (defense in depth)", () => {
      const out = pickerPageHtml({ ...sampleConfig, csrfToken: '"><script>' });
      expect(out).not.toContain('content=""><script>');
      expect(out).toContain("&quot;&gt;&lt;script&gt;");
    });

    it("threads the CSP nonce through to inline <style> and <script>", () => {
      const out = pickerPageHtml({ ...sampleConfig, nonce: "abc123" });
      expect(out).toContain('<style nonce="abc123">');
      expect(out).toContain('<script nonce="abc123">');
    });

    it("client-side handlers read the meta tag and send the token in JSON", () => {
      const out = pickerPageHtml({ ...sampleConfig, csrfToken: "tok" });
      expect(out).toContain("querySelector('meta[name=\"csrf-token\"]')");
      expect(out).toContain("csrfToken: csrfToken");
    });
  });
});

describe("Done card visibility", () => {
  it("hides Done card on initial render (hidden attribute, CSP-safe)", () => {
    const html = pickerPageHtml(sampleConfig);
    // The #done element must carry the standard HTML `hidden` attribute,
    // which the BASE_STYLE `[hidden] { display: none !important; }` rule
    // hardens. Inline style="display:none" is blocked by the strict
    // loopback CSP and must not be relied upon anywhere in the template.
    expect(html).toMatch(/id="done"[^>]*\bhidden\b/);
  });

  it("never relies on inline style='display:none' for initially-hidden elements", () => {
    const html = pickerPageHtml(sampleConfig);
    // Defence-in-depth: `style="display:none"` (or any `display:none`
    // inside a style attribute) is silently dropped under the strict
    // loopback CSP. All hidden-by-default elements must use the `hidden`
    // attribute instead.
    expect(html).not.toMatch(/style="[^"]*display\s*:\s*none/i);
  });
});
