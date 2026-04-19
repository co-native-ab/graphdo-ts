// Frontmatter codec tests (collab v1 §3.1 — W2 Day 1).
//
// Covers:
//
// 1. Round-trip determinism — `serialize(parse(serialize(x))) === serialize(x)`
//    is the §3.1 contract that makes collab writes byte-stable across
//    consecutive ops with no human edit in between.
// 2. Hardened-parse rejections — strict schema, custom-tag refusal,
//    multi-document refusal, prototype-pollution refusal, oversize
//    refusal, schema-version refusal.
// 3. Envelope helpers — `splitFrontmatter` / `joinFrontmatter` on LF and
//    CRLF inputs, frontmatter-absent inputs, missing-closer inputs.
//
// The byte-exact snapshot for a canonical fixture covering every §3.1
// field lives next door in `frontmatter-snapshot.test.ts` so a future
// `yaml` minor bump fails it before it fails users.

import { describe, it, expect } from "vitest";

import {
  CollabFrontmatterSchema,
  COLLAB_FRONTMATTER_VERSION,
  FrontmatterParseError,
  FrontmatterRoundtripError,
  joinFrontmatter,
  parseFrontmatter,
  serializeFrontmatter,
  splitFrontmatter,
  type CollabFrontmatter,
} from "../../src/collab/frontmatter.js";

function makeFrontmatter(overrides: Partial<CollabFrontmatter["collab"]> = {}): CollabFrontmatter {
  return {
    collab: {
      version: COLLAB_FRONTMATTER_VERSION,
      doc_id: "01JABCDE0FGHJKMNPQRSTV0WXY",
      created_at: "2026-04-19T05:30:00Z",
      sections: [
        { id: "intro", title: "Introduction" },
        { id: "design", title: "Design" },
      ],
      proposals: [],
      authorship: [],
      ...overrides,
    },
  };
}

describe("frontmatter codec", () => {
  describe("round-trip determinism", () => {
    it("serialize(parse(serialize(x))) === serialize(x) for a minimal document", () => {
      const fm = makeFrontmatter();
      const a = serializeFrontmatter(fm);
      const b = serializeFrontmatter(parseFrontmatter(a));
      expect(b).toBe(a);
    });

    it("serialize(parse(serialize(x))) === serialize(x) for a fully-populated document", () => {
      const fm = makeFrontmatter({
        proposals: [
          {
            id: "01JCDEF00000000000000000A1",
            target_section_slug: "intro",
            target_section_content_hash_at_create: "sha256:def56789",
            author_agent_id: "a3f2c891-...",
            author_display_name: "Alice",
            created_at: "2026-04-19T05:51:00Z",
            status: "open",
            body_path: "proposals/01JCDEF00000000000000000A1.md",
            rationale: "tighten: includes a colon and # hash",
            source: "chat",
          },
        ],
        authorship: [
          {
            target_section_slug: "intro",
            section_content_hash: "sha256:abcd1234",
            author_kind: "agent",
            author_agent_id: "agent-xyz",
            author_display_name: "Åsa Müller-O'Brien",
            written_at: "2026-04-19T05:50:00Z",
            revision: 17,
          },
        ],
      });
      const a = serializeFrontmatter(fm);
      const b = serializeFrontmatter(parseFrontmatter(a));
      expect(b).toBe(a);
    });

    it("emits the schema-declared key order regardless of input insertion order", () => {
      // Hand-construct the input with `authorship` before `version` to
      // confirm that `canonicalise` rewrites the order.
      const scrambled = {
        collab: {
          authorship: [],
          proposals: [],
          sections: [{ id: "intro", title: "Introduction" }],
          created_at: "2026-04-19T05:30:00Z",
          doc_id: "01JABCDE0FGHJKMNPQRSTV0WXY",
          version: 1 as const,
        },
      };
      const ordered = makeFrontmatter({
        sections: [{ id: "intro", title: "Introduction" }],
      });
      expect(serializeFrontmatter(scrambled)).toBe(serializeFrontmatter(ordered));
    });

    it("emits two-space indent, LF line endings, and quoted strings", () => {
      const out = serializeFrontmatter(makeFrontmatter());
      expect(out.endsWith("\n")).toBe(true);
      expect(out.includes("\r")).toBe(false);
      expect(out).toContain('doc_id: "01JABCDE0FGHJKMNPQRSTV0WXY"');
      expect(out).toContain('created_at: "2026-04-19T05:30:00Z"');
      expect(out).toContain("\n  sections:\n    - id: ");
    });

    it("does not emit a YAML directives header (`%YAML 1.2`)", () => {
      const out = serializeFrontmatter(makeFrontmatter());
      expect(out.startsWith("%YAML")).toBe(false);
      expect(out.startsWith("---")).toBe(false);
    });

    it("preserves Unicode strings byte-for-byte through round-trip", () => {
      const fm = makeFrontmatter({
        sections: [{ id: "résumé", title: "Résumé — v2 (réviewed)" }],
      });
      const a = serializeFrontmatter(fm);
      const parsed = parseFrontmatter(a);
      expect(parsed.collab.sections[0]?.title).toBe("Résumé — v2 (réviewed)");
      expect(serializeFrontmatter(parsed)).toBe(a);
    });
  });

  describe("schema validation", () => {
    it("rejects unknown top-level keys (strict schema, §3.1)", () => {
      expect(() =>
        parseFrontmatter(
          "collab: {version: 1, doc_id: x, created_at: '2026-04-19T05:30:00Z'}\nextra: nope",
        ),
      ).toThrow(FrontmatterParseError);
    });

    it("rejects unknown keys inside the collab block", () => {
      const yaml = [
        "collab:",
        "  version: 1",
        '  doc_id: "01J"',
        '  created_at: "2026-04-19T05:30:00Z"',
        '  smuggled: "no"',
      ].join("\n");
      expect(() => parseFrontmatter(yaml)).toThrow(FrontmatterParseError);
    });

    it("rejects unknown keys inside a proposal entry", () => {
      const yaml = [
        "collab:",
        "  version: 1",
        '  doc_id: "01J"',
        '  created_at: "2026-04-19T05:30:00Z"',
        "  proposals:",
        '    - id: "01JCDEF"',
        '      target_section_slug: "intro"',
        '      target_section_content_hash_at_create: "sha256:abcd"',
        '      author_agent_id: "a"',
        '      author_display_name: "Alice"',
        '      created_at: "2026-04-19T05:51:00Z"',
        '      status: "open"',
        '      body_path: "proposals/x.md"',
        '      rationale: "ok"',
        '      source: "chat"',
        '      smuggled: "no"',
      ].join("\n");
      expect(() => parseFrontmatter(yaml)).toThrow(FrontmatterParseError);
    });

    it("rejects schemaVersion other than 1", () => {
      const yaml = [
        "collab:",
        "  version: 2",
        '  doc_id: "01J"',
        '  created_at: "2026-04-19T05:30:00Z"',
      ].join("\n");
      expect(() => parseFrontmatter(yaml)).toThrow(FrontmatterParseError);
    });

    it("rejects malformed YAML", () => {
      expect(() => parseFrontmatter("collab: {not closed")).toThrow(FrontmatterParseError);
    });

    it("rejects an empty body", () => {
      expect(() => parseFrontmatter("")).toThrow(FrontmatterParseError);
      expect(() => parseFrontmatter("   \n  ")).toThrow(FrontmatterParseError);
    });

    it("rejects YAML whose root is a sequence rather than a mapping", () => {
      expect(() => parseFrontmatter("- one\n- two\n")).toThrow(FrontmatterParseError);
    });

    it("rejects an oversized body before parsing YAML", () => {
      const huge = "a: " + "x".repeat(257 * 1024);
      expect(() => parseFrontmatter(huge)).toThrow(FrontmatterParseError);
    });

    it("rejects custom YAML tags (no !!js/function-style extensions)", () => {
      // `yaml@2.x` strict mode + empty `customTags` rejects unknown
      // explicit tags. Anchors like `!!str` are fine; arbitrary tags are
      // not. This matches the §6 hardening: the parser must not honour
      // application-level extension tags it has not been told about.
      const yaml = [
        "collab:",
        "  version: 1",
        '  doc_id: "01J"',
        '  created_at: "2026-04-19T05:30:00Z"',
        "  rogue: !badtag {}",
      ].join("\n");
      expect(() => parseFrontmatter(yaml)).toThrow(FrontmatterParseError);
    });

    it("rejects multi-document YAML input (parser-confusion vector)", () => {
      const yaml = [
        "collab:",
        "  version: 1",
        '  doc_id: "01J"',
        '  created_at: "2026-04-19T05:30:00Z"',
        "---",
        "collab:",
        "  version: 1",
        '  doc_id: "02J"',
        '  created_at: "2026-04-19T05:30:00Z"',
      ].join("\n");
      expect(() => parseFrontmatter(yaml)).toThrow(FrontmatterParseError);
    });

    it("rejects a __proto__ key smuggled at the root (prototype-pollution defence)", () => {
      const yaml = [
        "collab:",
        "  version: 1",
        '  doc_id: "01J"',
        '  created_at: "2026-04-19T05:30:00Z"',
        "__proto__:",
        "  polluted: true",
      ].join("\n");
      // Either the strict-schema check rejects the unknown root key, or
      // the prototype-shape check trips first — both are acceptable.
      expect(() => parseFrontmatter(yaml)).toThrow(FrontmatterParseError);
    });

    it("serializeFrontmatter rejects an invalid object constructed in code", () => {
      const bad = {
        collab: { version: 1, doc_id: "", created_at: "2026-04-19T05:30:00Z" },
      } as unknown as CollabFrontmatter;
      expect(() => serializeFrontmatter(bad)).toThrow();
    });

    it("the schema is exported and re-usable as a Zod parser", () => {
      const fm = makeFrontmatter();
      const parsed = CollabFrontmatterSchema.parse(fm);
      expect(parsed.collab.version).toBe(1);
    });
  });

  describe("envelope helpers", () => {
    it("splitFrontmatter returns null for a body without the `---` envelope", () => {
      expect(splitFrontmatter("# Just markdown\n\nNo frontmatter here.\n")).toBeNull();
    });

    it("splitFrontmatter returns null when the closing `---` is missing", () => {
      expect(splitFrontmatter("---\ncollab: {}\n# unfinished")).toBeNull();
    });

    it("splitFrontmatter peels the envelope cleanly on LF input", () => {
      const yaml = serializeFrontmatter(makeFrontmatter());
      const wrapped = `---\n${yaml}---\n# Project Title\n\nHello.\n`;
      const split = splitFrontmatter(wrapped);
      expect(split).not.toBeNull();
      expect(split?.yaml).toBe(yaml);
      expect(split?.body).toBe("# Project Title\n\nHello.\n");
    });

    it("splitFrontmatter normalises CRLF input to LF", () => {
      const yaml = serializeFrontmatter(makeFrontmatter());
      const wrapped = `---\n${yaml}---\n# Project Title\n`.replace(/\n/g, "\r\n");
      const split = splitFrontmatter(wrapped);
      expect(split).not.toBeNull();
      expect(split?.yaml).toBe(yaml);
      expect(split?.body).toBe("# Project Title\n");
      expect(split?.yaml.includes("\r")).toBe(false);
      expect(split?.body.includes("\r")).toBe(false);
    });

    it("splitFrontmatter accepts an empty body", () => {
      const yaml = serializeFrontmatter(makeFrontmatter());
      const split = splitFrontmatter(`---\n${yaml}---\n`);
      expect(split?.body).toBe("");
    });

    it("joinFrontmatter wraps with `---` delimiters and preserves the body verbatim", () => {
      const yaml = serializeFrontmatter(makeFrontmatter());
      const joined = joinFrontmatter(yaml, "# Title\n\nBody.\n");
      expect(joined.startsWith("---\n")).toBe(true);
      expect(joined.endsWith("# Title\n\nBody.\n")).toBe(true);
      expect(joined).toContain(`\n---\n# Title`);
    });

    it("joinFrontmatter requires its yaml argument to end in a newline", () => {
      expect(() => joinFrontmatter("collab: {}", "body")).toThrow(FrontmatterRoundtripError);
    });

    it("split → parse → serialize → join is a clean round-trip on a wrapped document", () => {
      const yaml = serializeFrontmatter(makeFrontmatter());
      const wrapped = joinFrontmatter(yaml, "# Title\n");
      const split = splitFrontmatter(wrapped);
      expect(split).not.toBeNull();
      const parsed = parseFrontmatter(split!.yaml);
      const reEmittedYaml = serializeFrontmatter(parsed);
      const reJoined = joinFrontmatter(reEmittedYaml, split!.body);
      expect(reJoined).toBe(wrapped);
    });
  });
});
