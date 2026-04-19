// Byte-exact snapshot for the canonical §3.1 frontmatter fixture (collab v1).
//
// Per ADR-0008, the `yaml` library is pinned with `~` so patch updates are
// allowed but minor bumps require a deliberate version change. Minor bumps
// have historically changed default serialisation (quoting of keys
// matching reserved words, line-break handling near block boundaries).
// This snapshot fails before any such drift reaches users.
//
// The fixture intentionally exercises every §3.1 field:
//
// - All three `version` / `doc_id` / `created_at` core keys.
// - `sections[]` with a synthetic preamble slug, a regular slug, a slug
//   with an em-dash, and a collision-suffixed slug (`design-1`).
// - `proposals[]` with `rationale` containing a colon and a `#` hash —
//   both YAML sentinel-adjacent characters that exercise the
//   always-quoted determinism contract.
// - `authorship[]` with both `agent` and `human` kinds, a Unicode
//   display name, and a non-zero `revision`.
//
// If this test fails after a `yaml` upgrade, treat it as a release
// blocker per `collab-v1.md` §6: roll back the `yaml` minor, file an
// ADR amendment that explains the re-baseline, and only then update
// the snapshot.

import { describe, it, expect } from "vitest";

import {
  COLLAB_FRONTMATTER_VERSION,
  parseFrontmatter,
  serializeFrontmatter,
  type CollabFrontmatter,
} from "../../src/collab/frontmatter.js";

const CANONICAL_FIXTURE: CollabFrontmatter = {
  collab: {
    version: COLLAB_FRONTMATTER_VERSION,
    doc_id: "01JABCDE0FGHJKMNPQRSTV0WXY",
    created_at: "2026-04-19T05:30:00Z",
    sections: [
      { id: "__preamble__", title: "(preamble)" },
      { id: "intro", title: "Introduction" },
      { id: "design", title: "Design — Round 1" },
      { id: "design-1", title: "Design" },
    ],
    proposals: [
      {
        id: "01JCDEF00000000000000000A1",
        target_section_slug: "intro",
        target_section_content_hash_at_create: "sha256:def56789abcdef0123456789",
        author_agent_id: "a3f2c891-1111-2222-3333-444455556666",
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
        section_content_hash: "sha256:abcd1234567890abcdef1234567890ab",
        author_kind: "agent",
        author_agent_id: "a3f2c891-1111-2222-3333-444455556666",
        author_display_name: "Åsa Müller-O'Brien",
        written_at: "2026-04-19T05:50:00Z",
        revision: 17,
      },
      {
        target_section_slug: "design",
        section_content_hash: "sha256:99887766554433221100ffeeddccbbaa",
        author_kind: "human",
        author_agent_id: "human-onedrive-web",
        author_display_name: "Bob",
        written_at: "2026-04-19T06:00:00Z",
        revision: 18,
      },
    ],
  },
};

const CANONICAL_SNAPSHOT = `collab:
  version: 1
  doc_id: "01JABCDE0FGHJKMNPQRSTV0WXY"
  created_at: "2026-04-19T05:30:00Z"
  sections:
    - id: "__preamble__"
      title: "(preamble)"
    - id: "intro"
      title: "Introduction"
    - id: "design"
      title: "Design — Round 1"
    - id: "design-1"
      title: "Design"
  proposals:
    - id: "01JCDEF00000000000000000A1"
      target_section_slug: "intro"
      target_section_content_hash_at_create: "sha256:def56789abcdef0123456789"
      author_agent_id: "a3f2c891-1111-2222-3333-444455556666"
      author_display_name: "Alice"
      created_at: "2026-04-19T05:51:00Z"
      status: "open"
      body_path: "proposals/01JCDEF00000000000000000A1.md"
      rationale: "tighten: includes a colon and # hash"
      source: "chat"
  authorship:
    - target_section_slug: "intro"
      section_content_hash: "sha256:abcd1234567890abcdef1234567890ab"
      author_kind: "agent"
      author_agent_id: "a3f2c891-1111-2222-3333-444455556666"
      author_display_name: "Åsa Müller-O'Brien"
      written_at: "2026-04-19T05:50:00Z"
      revision: 17
    - target_section_slug: "design"
      section_content_hash: "sha256:99887766554433221100ffeeddccbbaa"
      author_kind: "human"
      author_agent_id: "human-onedrive-web"
      author_display_name: "Bob"
      written_at: "2026-04-19T06:00:00Z"
      revision: 18
`;

describe("frontmatter byte-exact snapshot (ADR-0008)", () => {
  it("serialises the canonical §3.1 fixture to the locked byte sequence", () => {
    const out = serializeFrontmatter(CANONICAL_FIXTURE);
    expect(out).toBe(CANONICAL_SNAPSHOT);
  });

  it("the snapshot parses back to the canonical fixture", () => {
    const parsed = parseFrontmatter(CANONICAL_SNAPSHOT);
    expect(parsed).toEqual(CANONICAL_FIXTURE);
  });

  it("the snapshot uses LF line endings only (no CRLF)", () => {
    expect(CANONICAL_SNAPSHOT.includes("\r")).toBe(false);
  });

  it("the snapshot uses two-space indent (no tabs)", () => {
    expect(CANONICAL_SNAPSHOT.includes("\t")).toBe(false);
  });
});
