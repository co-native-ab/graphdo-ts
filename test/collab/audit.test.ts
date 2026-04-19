// Unit tests for the collab v1 audit JSONL writer (`src/collab/audit.ts`).
//
// Covers the §3.6 contract:
//
//   - JSONL append + schema fidelity for every envelope type we use today.
//   - Path routing (scoped → `<projectId>.jsonl`, unscoped → `_unscoped.jsonl`).
//   - ≤4096-byte cap with the cascade truncation (inputSummary → intent →
//     replaced with smaller `error` envelope).
//   - `intent` truncation at 200 chars after NFKC + control-strip.
//   - `diffSummaryHash` length 16 hex chars.
//   - `Bearer ` substring rejection — even when a Graph error message
//     would otherwise carry one, the writer drops the line and never
//     fails the caller.
//   - Partial-line tolerance — a process killed mid-write leaves a
//     trailing partial line that the parser silently skips.
//   - Best-effort: write failure does not throw out of `writeAudit`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AUDIT_DIFF_SUMMARY_HASH_HEX_CHARS,
  AUDIT_INTENT_MAX_CHARS,
  AUDIT_MAX_LINE_BYTES,
  AUDIT_SCHEMA_VERSION,
  auditDir,
  auditFilePath,
  buildAuditLine,
  hashDiffSummary,
  normaliseIntent,
  parseAuditLines,
  readAuditFile,
  sanitizeInputSummary,
  writeAudit,
  type AuditEnvelope,
} from "../../src/collab/audit.js";
import { testSignal } from "../helpers.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "graphdo-audit-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sampleEnvelope = (overrides: Partial<AuditEnvelope> = {}): AuditEnvelope => {
  const base = {
    sessionId: "01JSESSIO0FGHJKMNPQRSTV0WXY",
    agentId: "a3f2c891-claude-desktop-01jsessio",
    userOid: "00000000-0000-0000-0000-0000a3f2c891",
    projectId: "01JABCDE0FGHJKMNPQRSTV0WXY" as string | null,
    tool: "collab_write",
    result: "success" as "success" | "failure",
    type: "tool_call" as const,
    details: {
      inputSummary: { path: "spec.md", source: "chat", contentSizeBytes: 42 } as const,
      cTagBefore: '"c:1,1"',
      cTagAfter: '"c:1,2"',
      revisionAfter: 2,
      bytes: 42,
      source: "chat" as const,
      resolvedItemId: "file-spec",
    },
  } satisfies AuditEnvelope;
  return { ...base, ...(overrides as Partial<typeof base>) } as AuditEnvelope;
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

describe("auditFilePath / auditDir", () => {
  it("routes scoped envelopes to <projectId>.jsonl", () => {
    expect(auditFilePath(dir, "01JABCDE0FGHJKMNPQRSTV0WXY")).toBe(
      path.join(dir, "sessions", "audit", "01JABCDE0FGHJKMNPQRSTV0WXY.jsonl"),
    );
  });

  it("routes unscoped envelopes to _unscoped.jsonl", () => {
    expect(auditFilePath(dir, null)).toBe(path.join(dir, "sessions", "audit", "_unscoped.jsonl"));
  });

  it("auditDir is <configDir>/sessions/audit", () => {
    expect(auditDir(dir)).toBe(path.join(dir, "sessions", "audit"));
  });
});

// ---------------------------------------------------------------------------
// Redaction primitives
// ---------------------------------------------------------------------------

describe("sanitizeInputSummary", () => {
  it("keeps allow-listed keys", () => {
    const result = sanitizeInputSummary({
      path: "spec.md",
      source: "chat",
      conflictMode: "fail",
      contentSizeBytes: 42,
      sectionId: "intro",
      proposalId: "p-1",
      rationaleSizeBytes: 12,
      rationaleHashPrefix: "deadbeef12345678",
    });
    expect(result).toEqual({
      path: "spec.md",
      source: "chat",
      conflictMode: "fail",
      contentSizeBytes: 42,
      sectionId: "intro",
      proposalId: "p-1",
      rationaleSizeBytes: 12,
      rationaleHashPrefix: "deadbeef12345678",
    });
  });

  it("drops keys outside the allow-list (content, body, rationale, etc.)", () => {
    const result = sanitizeInputSummary({
      path: "spec.md",
      content: "SECRET BODY", // dropped
      body: "ALSO SECRET", // dropped
      rationale: "NOT ALLOWED", // dropped
      arbitrary: 123, // dropped
    } as unknown as Record<string, unknown>);
    expect(result).toEqual({ path: "spec.md" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("rationale");
  });

  it("drops null/undefined values to keep the JSON tidy", () => {
    const result = sanitizeInputSummary({
      path: "spec.md",
      source: undefined,
      conflictMode: null,
    } as unknown as Record<string, unknown>);
    expect(result).toEqual({ path: "spec.md" });
  });
});

describe("hashDiffSummary", () => {
  it(`returns ${AUDIT_DIFF_SUMMARY_HASH_HEX_CHARS} hex characters`, () => {
    const hash = hashDiffSummary("hello diff");
    expect(hash).toHaveLength(AUDIT_DIFF_SUMMARY_HASH_HEX_CHARS);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic for the same input", () => {
    expect(hashDiffSummary("payload")).toBe(hashDiffSummary("payload"));
  });

  it("differs for different inputs", () => {
    expect(hashDiffSummary("a")).not.toBe(hashDiffSummary("b"));
  });
});

describe("normaliseIntent", () => {
  it("returns undefined for undefined / null", () => {
    expect(normaliseIntent(undefined)).toBeUndefined();
    expect(normaliseIntent(null)).toBeUndefined();
  });

  it("passes short, clean strings through unchanged", () => {
    expect(normaliseIntent("Add a section about login")).toBe("Add a section about login");
  });

  it("NFKC-normalises fullwidth characters to ASCII", () => {
    // U+FF21 'Ａ' (fullwidth A) → 'A'
    expect(normaliseIntent("Ａdd")).toBe("Add");
  });

  it("strips ASCII control characters but keeps tabs / newlines", () => {
    expect(normaliseIntent("hello\u0007world")).toBe("helloworld");
    expect(normaliseIntent("line1\nline2\tend")).toBe("line1\nline2\tend");
  });

  it(`truncates strings longer than ${AUDIT_INTENT_MAX_CHARS} chars with a marker suffix`, () => {
    const long = "x".repeat(AUDIT_INTENT_MAX_CHARS + 50);
    const out = normaliseIntent(long);
    expect(out).toBeDefined();
    expect(out!.startsWith("x".repeat(AUDIT_INTENT_MAX_CHARS))).toBe(true);
    expect(out!.endsWith("…(truncated)")).toBe(true);
  });

  it("does not append truncation marker when input is exactly at the cap", () => {
    const exactly = "y".repeat(AUDIT_INTENT_MAX_CHARS);
    expect(normaliseIntent(exactly)).toBe(exactly);
  });
});

// ---------------------------------------------------------------------------
// Envelope shaping (buildAuditLine)
// ---------------------------------------------------------------------------

describe("buildAuditLine", () => {
  it("emits the §3.6 common envelope for tool_call", () => {
    const envelope = sampleEnvelope();
    const fixedNow = new Date("2026-04-19T05:50:00.000Z");
    const built = buildAuditLine(envelope, fixedNow);
    const parsed = JSON.parse(built.line.trimEnd()) as Record<string, unknown>;
    expect(parsed["ts"]).toBe("2026-04-19T05:50:00.000Z");
    expect(parsed["schemaVersion"]).toBe(AUDIT_SCHEMA_VERSION);
    expect(parsed["type"]).toBe("tool_call");
    expect(parsed["sessionId"]).toBe(envelope.sessionId);
    expect(parsed["agentId"]).toBe(envelope.agentId);
    expect(parsed["userOid"]).toBe(envelope.userOid);
    expect(parsed["projectId"]).toBe(envelope.projectId);
    expect(parsed["tool"]).toBe("collab_write");
    expect(parsed["result"]).toBe("success");
    expect(built.truncated).toBe(false);
    expect(built.line.endsWith("\n")).toBe(true);
  });

  it("uses the provided ts when present", () => {
    const envelope = sampleEnvelope({ ts: "2026-01-01T00:00:00.000Z" });
    const built = buildAuditLine(envelope, new Date("2099-01-01T00:00:00Z"));
    const parsed = JSON.parse(built.line.trimEnd()) as Record<string, unknown>;
    expect(parsed["ts"]).toBe("2026-01-01T00:00:00.000Z");
  });

  it("filters tool_call.inputSummary against the allow-list", () => {
    const envelope: AuditEnvelope = {
      ...sampleEnvelope(),
      details: {
        inputSummary: {
          path: "spec.md",
          contentSizeBytes: 100,
        },
        bytes: 100,
      } as never,
    };
    // Call sanitiser-equivalent path through builder by smuggling extra
    // keys via cast.
    const detailsAny = envelope.details as unknown as Record<string, unknown>;
    (detailsAny["inputSummary"] as Record<string, unknown>)["content"] = "SECRET CONTENT";
    const built = buildAuditLine(envelope, new Date());
    expect(built.line).not.toContain("SECRET CONTENT");
    const parsed = JSON.parse(built.line.trimEnd()) as { details: { inputSummary: object } };
    expect(parsed.details.inputSummary).not.toHaveProperty("content");
  });

  it("normalises intent into the envelope when present", () => {
    const envelope = sampleEnvelope({ intent: "  hello\u0001world  " });
    const built = buildAuditLine(envelope, new Date());
    const parsed = JSON.parse(built.line.trimEnd()) as { intent?: string };
    expect(parsed.intent).toBe("  helloworld  ");
  });

  it("omits the intent field entirely when not provided", () => {
    const built = buildAuditLine(sampleEnvelope(), new Date());
    const parsed = JSON.parse(built.line.trimEnd()) as Record<string, unknown>;
    expect("intent" in parsed).toBe(false);
  });

  it("rejects envelopes whose serialised JSON contains 'Bearer '", () => {
    const envelope: AuditEnvelope = {
      ...sampleEnvelope(),
      type: "error",
      details: {
        errorName: "GraphRequestError",
        errorMessage: "GET /me/drive failed: Authorization=Bearer eyJhbGc... rejected",
      },
    };
    expect(() => buildAuditLine(envelope, new Date())).toThrow(/Bearer/);
  });

  it(`truncates inputSummary first when the line exceeds ${AUDIT_MAX_LINE_BYTES} bytes`, () => {
    const fatPath = "x".repeat(5000);
    const envelope = {
      ...sampleEnvelope(),
      type: "tool_call",
      details: {
        inputSummary: { path: fatPath, contentSizeBytes: 1 },
        bytes: 1,
      },
    } as AuditEnvelope;
    const built = buildAuditLine(envelope, new Date());
    expect(built.bytes).toBeLessThanOrEqual(AUDIT_MAX_LINE_BYTES);
    expect(built.truncated).toBe("inputSummary");
    expect(built.replaced).toBe(false);
    const parsed = JSON.parse(built.line.trimEnd()) as {
      details: { inputSummary: { truncated: boolean } };
    };
    expect(parsed.details.inputSummary).toEqual({ truncated: true });
  });

  it("replaces the envelope with a smaller error placeholder when both truncations are insufficient", () => {
    // An `error` envelope with a 5KB errorMessage cannot be fixed by
    // dropping inputSummary (none) or intent (none) — it must be
    // replaced with the placeholder.
    const envelope: AuditEnvelope = {
      ...sampleEnvelope(),
      type: "error",
      details: {
        errorName: "BigError",
        errorMessage: "z".repeat(5000),
      },
    };
    const built = buildAuditLine(envelope, new Date());
    expect(built.bytes).toBeLessThanOrEqual(AUDIT_MAX_LINE_BYTES);
    expect(built.replaced).toBe(true);
    const parsed = JSON.parse(built.line.trimEnd()) as {
      type: string;
      details: { errorName: string };
    };
    expect(parsed.type).toBe("error");
    expect(parsed.details.errorName).toBe("AuditEnvelopeTooLargeError");
  });
});

// ---------------------------------------------------------------------------
// Writer + parser
// ---------------------------------------------------------------------------

describe("writeAudit + parseAuditLines", () => {
  it("appends a single line to the scoped file and parses it back", async () => {
    await writeAudit({ configDir: dir }, sampleEnvelope(), testSignal());
    const result = await readAuditFile(dir, "01JABCDE0FGHJKMNPQRSTV0WXY", testSignal());
    expect(result.entries).toHaveLength(1);
    expect(result.skipped).toBe(0);
    const entry = result.entries[0]!;
    expect(entry["type"]).toBe("tool_call");
    expect(entry["projectId"]).toBe("01JABCDE0FGHJKMNPQRSTV0WXY");
  });

  it("appends multiple lines and preserves order", async () => {
    await writeAudit(
      { configDir: dir },
      sampleEnvelope({ ts: "2026-04-19T00:00:00.000Z" }),
      testSignal(),
    );
    await writeAudit(
      { configDir: dir },
      sampleEnvelope({ ts: "2026-04-19T00:00:01.000Z" }),
      testSignal(),
    );
    await writeAudit(
      { configDir: dir },
      sampleEnvelope({ ts: "2026-04-19T00:00:02.000Z" }),
      testSignal(),
    );
    const result = await readAuditFile(dir, "01JABCDE0FGHJKMNPQRSTV0WXY", testSignal());
    expect(result.entries).toHaveLength(3);
    expect(result.entries.map((e) => e["ts"])).toEqual([
      "2026-04-19T00:00:00.000Z",
      "2026-04-19T00:00:01.000Z",
      "2026-04-19T00:00:02.000Z",
    ]);
  });

  it("routes unscoped envelopes (projectId=null) to _unscoped.jsonl", async () => {
    const envelope: AuditEnvelope = {
      ...sampleEnvelope(),
      projectId: null,
      type: "agent_name_unknown",
      details: { clientInfoPresent: false, agentIdAssigned: "abc-unknown-01jsessio" },
    };
    await writeAudit({ configDir: dir }, envelope, testSignal());
    const scoped = await readAuditFile(dir, "anything", testSignal());
    const unscoped = await readAuditFile(dir, null, testSignal());
    expect(scoped.entries).toHaveLength(0);
    expect(unscoped.entries).toHaveLength(1);
    expect(unscoped.entries[0]!["projectId"]).toBeNull();
  });

  it("returns empty results when the audit file does not exist", async () => {
    const result = await readAuditFile(dir, "01JNOFILE0FGHJKMNPQRSTV0WXY", testSignal());
    expect(result.entries).toEqual([]);
    expect(result.skipped).toBe(0);
  });

  it("uses config.now() to populate ts when omitted", async () => {
    const fixed = new Date("2026-12-31T23:59:00.000Z");
    await writeAudit(
      { configDir: dir, now: () => fixed },
      sampleEnvelope({ ts: undefined }),
      testSignal(),
    );
    const result = await readAuditFile(dir, "01JABCDE0FGHJKMNPQRSTV0WXY", testSignal());
    expect(result.entries[0]!["ts"]).toBe("2026-12-31T23:59:00.000Z");
  });

  it("never includes the substring 'Bearer ' on disk even when error messages would carry one", async () => {
    const envelope: AuditEnvelope = {
      ...sampleEnvelope(),
      type: "error",
      details: {
        errorName: "GraphRequestError",
        errorMessage: 'GET /me failed (401): Authorization header "Bearer eyJhbGc..." was rejected',
      },
    };
    await writeAudit({ configDir: dir }, envelope, testSignal());
    const filePath = auditFilePath(dir, envelope.projectId);
    let raw: string;
    try {
      raw = await readFile(filePath, { encoding: "utf-8" });
    } catch {
      raw = "";
    }
    expect(raw).not.toContain("Bearer ");
    // The line itself was dropped (defence in depth).
    const result = await readAuditFile(dir, envelope.projectId, testSignal());
    expect(result.entries).toHaveLength(0);
  });

  it("does not throw when the underlying append fails (best-effort)", async () => {
    // Point at a path that is itself a *file* so mkdir/append both fail.
    const blocker = path.join(dir, "blocker");
    await writeFile(blocker, "occupied", "utf-8");
    // The audit writer would create `<blocker>/sessions/audit/...` but
    // `<blocker>` is a regular file → mkdir fails with ENOTDIR.
    await expect(
      writeAudit({ configDir: blocker }, sampleEnvelope(), testSignal()),
    ).resolves.toBeUndefined();
  });

  it("does not throw when the abort signal is already aborted (best-effort)", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("test abort"));
    await expect(
      writeAudit({ configDir: dir }, sampleEnvelope(), ctrl.signal),
    ).resolves.toBeUndefined();
  });

  it("tolerates a partial trailing line written by a crashed process", async () => {
    // Simulate a clean line followed by a partially-written second line
    // (process killed mid-`appendFile`).
    const target = auditFilePath(dir, "01JABCDE0FGHJKMNPQRSTV0WXY");
    await mkdir(path.dirname(target), { recursive: true });
    const firstEnvelope = sampleEnvelope({ ts: "2026-04-19T00:00:00.000Z" });
    const built = buildAuditLine(firstEnvelope, new Date());
    await appendFile(target, built.line, "utf-8");
    // Now append the start of a second line but no trailing `\n`.
    await appendFile(target, '{"ts":"2026-04-19T00:00:01.000Z","sch', "utf-8");

    const result = await readAuditFile(dir, "01JABCDE0FGHJKMNPQRSTV0WXY", testSignal());
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!["ts"]).toBe("2026-04-19T00:00:00.000Z");
    expect(result.skipped).toBe(1);
  });

  it("counts non-object lines (e.g. arrays, primitives) as skipped", () => {
    const text = '[1,2,3]\n42\n"plain"\n{"ts":"x","valid":true}\n';
    const result = parseAuditLines(text);
    expect(result.entries).toHaveLength(1);
    expect(result.skipped).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Per-type envelopes — sanity check that every type we emit today round-trips.
// ---------------------------------------------------------------------------

describe("writeAudit per-type round-trip", () => {
  const types: AuditEnvelope[] = [
    {
      sessionId: "s",
      agentId: "a",
      userOid: "u",
      projectId: "p",
      type: "session_start",
      details: {
        ttlSeconds: 7200,
        writeBudget: 50,
        destructiveBudget: 10,
        clientName: "claude",
        clientVersion: "1.0",
      },
    },
    {
      sessionId: "s",
      agentId: "a",
      userOid: "u",
      projectId: "p",
      type: "session_end",
      details: { reason: "ttl", writesUsed: 3, renewalsUsed: 0 },
    },
    {
      sessionId: "s",
      agentId: "a",
      userOid: "u",
      projectId: "p",
      type: "frontmatter_reset",
      details: { reason: "missing", previousRevision: 1, recoveredDocId: true },
    },
    {
      sessionId: "s",
      agentId: "a",
      userOid: "u",
      projectId: "p",
      type: "external_source_approval",
      details: {
        tool: "collab_write",
        path: "spec.md",
        outcome: "approved",
        csrfTokenMatched: true,
      },
    },
    {
      sessionId: "s",
      agentId: "a",
      userOid: "u",
      projectId: "p",
      type: "scope_denied",
      details: { reason: "ancestry_escape", attemptedPath: "../../etc", resolvedItemId: "x" },
    },
  ];

  for (const envelope of types) {
    it(`round-trips type=${envelope.type}`, async () => {
      await writeAudit({ configDir: dir }, envelope, testSignal());
      const result = await readAuditFile(dir, "p", testSignal());
      expect(result.entries.at(-1)!["type"]).toBe(envelope.type);
    });
  }
});
