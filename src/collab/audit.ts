// Audit JSONL writer for collab v1 (`docs/plans/collab-v1.md` §3.6).
//
// Single point of truth for every audit emission. All collab tools route
// through {@link writeAudit} so the redaction policy, ≤4096-byte cap,
// `Bearer ` substring rejection, and atomic-append semantics are
// enforced uniformly.
//
// Path layout:
//
//   `<configDir>/sessions/audit/<projectId>.jsonl`  — scoped events
//   `<configDir>/sessions/audit/_unscoped.jsonl`    — failed-init events
//
// Format: plain JSONL, one envelope per line, LF terminated. No hash
// chain, no signing (constraint per §3.6). On POSIX, `O_APPEND` writes
// ≤ PIPE_BUF (~4096 bytes) are atomic across concurrent appenders. The
// 4096-byte cap is therefore a *correctness* contract, not just a size
// limit. On Windows the same atomicity does not hold; the parser's
// partial-line tolerance covers the corruption case (any line that
// fails JSON parse is logged and skipped).
//
// Best-effort: any failure to append (disk full, EACCES, signal
// aborted) is logged at `warn` and swallowed. Audit is never on the
// hot path of a tool's success contract — losing a line is preferable
// to failing a tool call.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { logger } from "../logger.js";
import { appendFileOptions, mkdirOptions } from "../fs-options.js";
import { assertValidProjectId } from "./ulid.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Schema version emitted on every audit envelope. Bumped on breaking change. */
export const AUDIT_SCHEMA_VERSION = 1 as const;

/** Hard cap on a single serialised JSONL line (POSIX `PIPE_BUF` floor). */
export const AUDIT_MAX_LINE_BYTES = 4096;

/** Maximum kept length of `intent` before truncation. */
export const AUDIT_INTENT_MAX_CHARS = 200;

/** Length (hex chars) of the `diffSummaryHash` prefix. */
export const AUDIT_DIFF_SUMMARY_HASH_HEX_CHARS = 16;

/** Filename used for events that have no project context (`_unscoped`). */
export const AUDIT_UNSCOPED_FILE_NAME = "_unscoped.jsonl";

/** Subdirectory under `<configDir>/sessions/`. */
export const AUDIT_DIR_NAME = "audit";

// ---------------------------------------------------------------------------
// Envelope enums
// ---------------------------------------------------------------------------
//
// Per the codebase convention (see {@link import("../scopes.js").GraphScope},
// {@link import("../graph/client.js").HttpMethod},
// {@link import("../graph/markdown.js").MarkdownFolderEntryKind},
// {@link import("../tools/collab/ops.js").DocIdSource}), audit-envelope
// discriminator strings are modelled as TypeScript string enums. The
// values match the §3.6 wire format byte-for-byte so JSON.stringify
// produces the documented schema and consumers (e.g. operators
// reviewing JSONL on disk) see the canonical lower-case strings.

/** Tool source classification per §5.2.4. */
export enum AuditWriteSource {
  Chat = "chat",
  Project = "project",
  External = "external",
}

/** `collab_write.conflictMode` reflected into audit. */
export enum AuditConflictMode {
  Fail = "fail",
  Proposal = "proposal",
}

/** Why a session ended (§3.6 `session_end`). */
export enum AuditSessionEndReason {
  Ttl = "ttl",
  Budget = "budget",
  McpShutdown = "mcp_shutdown",
  ManualStop = "manual_stop",
}

/** Outcome of a re-prompt form (destructive / external-source). */
export enum AuditApprovalOutcome {
  Approved = "approved",
  Declined = "declined",
  Timeout = "timeout",
}

/** Top-level result marker for an envelope. */
export enum AuditResult {
  Success = "success",
  Failure = "failure",
}

/** Why a `frontmatter_reset` envelope was emitted. Mirrors {@link import("./frontmatter.js").FrontmatterResetReason}. */
export enum AuditFrontmatterResetReason {
  Missing = "missing",
  Malformed = "malformed",
}

/** What anchored a `slug_drift_resolved` recovery. */
export enum AuditMatchedBy {
  ContentHash = "content_hash",
}

/**
 * Which field the cap cascade dropped to fit a line under
 * {@link AUDIT_MAX_LINE_BYTES}. {@link AuditTruncationStage.None}
 * is the no-op state set on the happy path.
 */
export enum AuditTruncationStage {
  None = "none",
  InputSummary = "inputSummary",
  Intent = "intent",
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Returns `<configDir>/sessions/audit`. */
export function auditDir(configDir: string): string {
  return path.join(configDir, "sessions", AUDIT_DIR_NAME);
}

/**
 * Returns the on-disk path for the audit file matching the (optional)
 * `projectId`. `null` routes to the `_unscoped.jsonl` fallback.
 *
 * Throws when `projectId` is not a syntactically-valid ULID — defends
 * against `projectId = "../../etc/foo"` style path-injection that
 * could otherwise direct audit writes outside `<configDir>/sessions/audit/`
 * or read arbitrary `*.jsonl` files. The audit writer is the project's
 * primary forensic record so suppressing it (by writing to an
 * unwritable path) is itself a threat.
 */
export function auditFilePath(configDir: string, projectId: string | null): string {
  if (projectId !== null) assertValidProjectId("projectId", projectId);
  const file = projectId === null ? AUDIT_UNSCOPED_FILE_NAME : `${projectId}.jsonl`;
  return path.join(auditDir(configDir), file);
}

// ---------------------------------------------------------------------------
// Envelope types
// ---------------------------------------------------------------------------

/**
 * Allow-listed `inputSummary` shape per §3.6 — the only fields we ever
 * persist about a tool invocation. Never `content`, never `body`,
 * never `rationale` text.
 */
export interface AuditInputSummary {
  path?: string;
  source?: AuditWriteSource;
  conflictMode?: AuditConflictMode;
  contentSizeBytes?: number;
  sectionId?: string;
  proposalId?: string;
  rationaleSizeBytes?: number;
  rationaleHashPrefix?: string;
}

/** Per-type detail shapes — see §3.6 of `collab-v1.md`. */
export interface SessionStartDetails {
  ttlSeconds: number;
  writeBudget: number;
  destructiveBudget: number;
  clientName: string | null;
  clientVersion: string | null;
  /**
   * Test-persona override marker (`docs/plans/two-instance-e2e.md`,
   * ADR-0009). `"default"` for production runs (back-compat — same
   * audit shape as before the override existed). `"test-persona"`
   * when `GRAPHDO_AGENT_PERSONA` was set; the persona id is also
   * surfaced in {@link agentPersona} so post-hoc forensic reads can
   * trivially identify sessions where the override was in effect.
   */
  mode?: "default" | "test-persona";
  /** Persona id (e.g. `"persona:alice"`) when {@link mode} is `"test-persona"`. */
  agentPersona?: { id: string; source: "env" };
}

export interface SessionEndDetails {
  reason: AuditSessionEndReason;
  writesUsed: number;
  renewalsUsed: number;
}

export interface ToolCallDetails {
  inputSummary: AuditInputSummary;
  cTagBefore?: string | null;
  cTagAfter?: string | null;
  revisionAfter?: number | string | null;
  bytes?: number;
  source?: AuditWriteSource;
  resolvedItemId?: string;
}

export interface ScopeDeniedDetails {
  reason: string;
  attemptedPath: string;
  resolvedItemId?: string;
}

export interface DestructiveApprovalDetails {
  tool: string;
  outcome: AuditApprovalOutcome;
  diffSummaryHash: string;
  csrfTokenMatched: boolean;
}

export interface RenewalDetails {
  windowCountBefore: number;
  windowCountAfter: number;
  sessionRenewalsBefore: number;
  sessionRenewalsAfter: number;
}

export interface ExternalSourceApprovalDetails {
  tool: string;
  path: string;
  outcome: AuditApprovalOutcome;
  csrfTokenMatched: boolean;
}

export interface FrontmatterResetDetails {
  reason: AuditFrontmatterResetReason;
  previousRevision: string | number | null;
  recoveredDocId: boolean;
}

export interface SlugDriftResolvedDetails {
  proposalId: string;
  oldSlug: string;
  newSlug: string;
  matchedBy: AuditMatchedBy;
}

export interface DocIdRecoveredDetails {
  recoveredFrom: string;
  versionsInspected: number;
}

export interface AgentNameUnknownDetails {
  clientInfoPresent: boolean;
  agentIdAssigned: string;
}

export interface SentinelChangedDetails {
  pinnedAuthoritativeFileId: string;
  currentAuthoritativeFileId: string;
  pinnedAtFirstSeenCTag: string;
  currentSentinelCTag: string;
}

export interface ExternalChangeDetectedDetails {
  pinnedCTag: string;
  liveCTag: string;
  liveRevision: number | string | null;
}

export interface ErrorDetails {
  errorName: string;
  errorMessage: string;
  graphCode?: string;
  graphStatus?: number;
}

/**
 * Common envelope fields shared by every audit type. The writer fills
 * `ts` and `schemaVersion` from `config.now()` so callers cannot drift.
 */
export interface AuditEnvelopeBase {
  /** ISO-8601 timestamp; populated by the writer if omitted. */
  ts?: string;
  sessionId: string;
  agentId: string;
  /** Full Entra `oid` (UUID) — visible in any id token, not a secret. */
  userOid: string;
  /** `null` routes to the `_unscoped.jsonl` fallback. */
  projectId: string | null;
  /** Tool name (e.g. `"collab_write"`). Optional for non-tool events. */
  tool?: string;
  /** Outcome marker for the envelope. */
  result?: AuditResult;
  /**
   * Free-text intent shown on re-prompt forms. Truncated to
   * {@link AUDIT_INTENT_MAX_CHARS} after NFKC normalisation and control-
   * char strip; longer values get a `…(truncated)` suffix.
   */
  intent?: string;
}

/** Discriminated union of every envelope the writer accepts. */
export type AuditEnvelope = AuditEnvelopeBase &
  (
    | { type: "session_start"; details: SessionStartDetails }
    | { type: "session_end"; details: SessionEndDetails }
    | { type: "tool_call"; details: ToolCallDetails }
    | { type: "scope_denied"; details: ScopeDeniedDetails }
    | { type: "destructive_approval"; details: DestructiveApprovalDetails }
    | { type: "renewal"; details: RenewalDetails }
    | { type: "external_source_approval"; details: ExternalSourceApprovalDetails }
    | { type: "frontmatter_reset"; details: FrontmatterResetDetails }
    | { type: "slug_drift_resolved"; details: SlugDriftResolvedDetails }
    | { type: "doc_id_recovered"; details: DocIdRecoveredDetails }
    | { type: "agent_name_unknown"; details: AgentNameUnknownDetails }
    | { type: "sentinel_changed"; details: SentinelChangedDetails }
    | { type: "external_change_detected"; details: ExternalChangeDetectedDetails }
    | { type: "error"; details: ErrorDetails }
  );

// ---------------------------------------------------------------------------
// Redaction primitives
// ---------------------------------------------------------------------------

/**
 * Allow-list of inputSummary keys that are safe to persist. Anything
 * outside this set is dropped silently. The list mirrors §3.6 row
 * `tool_call.inputSummary` and is the **single point** at which we
 * decide what tool input data ever reaches disk.
 */
const INPUT_SUMMARY_ALLOWED_KEYS: ReadonlySet<keyof AuditInputSummary> = new Set([
  "path",
  "source",
  "conflictMode",
  "contentSizeBytes",
  "sectionId",
  "proposalId",
  "rationaleSizeBytes",
  "rationaleHashPrefix",
]);

/** Filter an arbitrary object down to the allow-listed inputSummary keys. */
export function sanitizeInputSummary(input: Record<string, unknown>): AuditInputSummary {
  // Iterate over the allow-list (not the input) so a malicious caller
  // cannot smuggle a key that happens to satisfy `keyof AuditInputSummary`
  // by inheritance, prototype pollution, or unexpected casing.
  const out: Record<string, unknown> = {};
  for (const key of INPUT_SUMMARY_ALLOWED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = input[key];
    if (value !== undefined && value !== null) {
      out[key] = value;
    }
  }
  return out as AuditInputSummary;
}

/**
 * Compute the §3.6 `diffSummaryHash`: SHA-256 of the input text, first
 * {@link AUDIT_DIFF_SUMMARY_HASH_HEX_CHARS} hex chars. Provides
 * cross-event correlation without enabling reconstruction from a
 * leaked audit log.
 */
export function hashDiffSummary(text: string): string {
  return crypto
    .createHash("sha256")
    .update(text, "utf-8")
    .digest("hex")
    .slice(0, AUDIT_DIFF_SUMMARY_HASH_HEX_CHARS);
}

/**
 * Normalise and bound an `intent` field per §3.6: NFKC normalise, strip
 * control characters except whitespace, truncate to
 * {@link AUDIT_INTENT_MAX_CHARS} with a `…(truncated)` suffix when
 * shortened. Returns `undefined` for `undefined`/`null` inputs so the
 * field can be omitted from the serialised envelope.
 */
export function normaliseIntent(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  // NFKC strips compat variants (e.g. fullwidth → ASCII) so cooperating
  // and adversarial agents both produce comparable strings.
  const normalised = raw.normalize("NFKC");
  // Drop ASCII C0/C1 control chars (0x00–0x1F + 0x7F + 0x80–0x9F) but
  // keep the basic whitespace runs (\t, \n, \r) so multi-line intents
  // remain legible.

  const stripped = normalised.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
  if (stripped.length <= AUDIT_INTENT_MAX_CHARS) {
    return stripped;
  }
  return stripped.slice(0, AUDIT_INTENT_MAX_CHARS) + "…(truncated)";
}

// ---------------------------------------------------------------------------
// Envelope shaping
// ---------------------------------------------------------------------------

interface BuiltEnvelope {
  /** The serialised envelope ready for `appendFile`, ending in `\n`. */
  line: string;
  /** Bytes of `line` (utf-8). */
  bytes: number;
  /** Which field (if any) the cap cascade had to drop. */
  truncated: AuditTruncationStage;
  /** Whether the envelope was replaced by a smaller `error` envelope. */
  replaced: boolean;
}

/**
 * Build the final JSONL line for an envelope, applying the §3.6
 * shaping rules:
 *
 * 1. Inject `schemaVersion` and `ts` (writer-controlled).
 * 2. Sanitise `inputSummary` (when present) against the allow-list.
 * 3. Normalise + truncate `intent` per {@link normaliseIntent}.
 * 4. Reject the envelope if its serialised form contains the substring
 *    `"Bearer "` (defence in depth — every legitimate code path
 *    already strips Bearer from error messages).
 * 5. Enforce the {@link AUDIT_MAX_LINE_BYTES} cap by truncating
 *    `inputSummary`, then `intent`; if still too large, replace the
 *    whole envelope with a smaller `error` shape.
 *
 * Throws when the envelope must be dropped entirely (the caller logs
 * `warn` and discards). All other adjustments return the rebuilt line
 * with metadata for observability.
 */
export function buildAuditLine(envelope: AuditEnvelope, now: Date): BuiltEnvelope {
  // 1 + 2 + 3: shape the writer-controlled fields.
  const shaped = shapeEnvelope(envelope, now);

  // 4. Bearer defence — applies to every byte of the serialised line,
  // including details / errorMessage. We check before the cap because
  // a Bearer-bearing line that fits is still rejected.
  let serialised = JSON.stringify(shaped);
  if (containsBearer(serialised)) {
    throw new BearerSubstringError();
  }

  // 5. Size cap with cascading truncation.
  if (byteLength(serialised) <= AUDIT_MAX_LINE_BYTES - 1 /* trailing \n */) {
    return {
      line: serialised + "\n",
      bytes: byteLength(serialised) + 1,
      truncated: AuditTruncationStage.None,
      replaced: false,
    };
  }

  // 5a. Drop inputSummary first (writes only — but generic enough to
  //     cover any future caller that adds an inputSummary).
  const droppedSummary = withoutInputSummary(shaped);
  if (droppedSummary !== null) {
    serialised = JSON.stringify(droppedSummary);
    if (containsBearer(serialised)) throw new BearerSubstringError();
    if (byteLength(serialised) <= AUDIT_MAX_LINE_BYTES - 1) {
      return {
        line: serialised + "\n",
        bytes: byteLength(serialised) + 1,
        truncated: AuditTruncationStage.InputSummary,
        replaced: false,
      };
    }
  }

  // 5b. Drop intent next.
  const droppedIntent = withoutIntent(droppedSummary ?? shaped);
  serialised = JSON.stringify(droppedIntent);
  if (containsBearer(serialised)) throw new BearerSubstringError();
  if (byteLength(serialised) <= AUDIT_MAX_LINE_BYTES - 1) {
    return {
      line: serialised + "\n",
      bytes: byteLength(serialised) + 1,
      truncated: AuditTruncationStage.Intent,
      replaced: false,
    };
  }

  // 5c. Replace the whole envelope with a smaller error placeholder so
  //     the post-hoc reviewer at least sees that *something* was
  //     emitted at this point in time.
  const fallback = buildOversizeFallback(shaped);
  serialised = JSON.stringify(fallback);
  if (containsBearer(serialised)) throw new BearerSubstringError();
  if (byteLength(serialised) > AUDIT_MAX_LINE_BYTES - 1) {
    // Should be impossible — the fallback is a fixed small shape — but
    // guard so we never write an oversize line by mistake.
    throw new EnvelopeTooLargeError(byteLength(serialised));
  }
  return {
    line: serialised + "\n",
    bytes: byteLength(serialised) + 1,
    truncated: AuditTruncationStage.Intent,
    replaced: true,
  };
}

/**
 * Returns true if the serialised envelope contains a bearer-shaped
 * substring. Defence-in-depth — every legitimate code path already
 * strips bearer tokens from error messages.
 *
 * Matches:
 *  - Case-insensitive `bearer` followed by any whitespace character
 *    (`Bearer `, `BEARER\t`) or by a JSON-escaped whitespace char
 *    (`\\n`, `\\t`, `\\r`) since the input is the post-`JSON.stringify`
 *    line and real `\n` is encoded as the two characters `\` `n`.
 *  - Bare JWTs (`eyJ…\.eyJ…\.…`) in case a token leaks into a field
 *    without the `Bearer` prefix (e.g. an `Authorization` header value
 *    that was logged verbatim).
 */
const BEARER_RE = /\bbearer(?:\s|\\[ntr])/i;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

function containsBearer(serialised: string): boolean {
  return BEARER_RE.test(serialised) || JWT_RE.test(serialised);
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

function shapeEnvelope(envelope: AuditEnvelope, now: Date): Record<string, unknown> {
  const ts = envelope.ts ?? now.toISOString();
  const out: Record<string, unknown> = {
    ts,
    schemaVersion: AUDIT_SCHEMA_VERSION,
    type: envelope.type,
    sessionId: envelope.sessionId,
    agentId: envelope.agentId,
    userOid: envelope.userOid,
    projectId: envelope.projectId,
  };
  if (envelope.tool !== undefined) out["tool"] = envelope.tool;
  if (envelope.result !== undefined) out["result"] = envelope.result;
  const intent = normaliseIntent(envelope.intent);
  if (intent !== undefined) out["intent"] = intent;

  // Per-type detail handling: most types pass through verbatim, but
  // `tool_call.inputSummary` goes through the allow-list filter so a
  // forgetful caller cannot leak content.
  const details = shapeDetails(envelope);
  out["details"] = details;
  return out;
}

function shapeDetails(envelope: AuditEnvelope): Record<string, unknown> {
  if (envelope.type === "tool_call") {
    const sanitised = sanitizeInputSummary(
      envelope.details.inputSummary as unknown as Record<string, unknown>,
    );
    const out: Record<string, unknown> = { inputSummary: sanitised };
    const d = envelope.details;
    if (d.cTagBefore !== undefined) out["cTagBefore"] = d.cTagBefore;
    if (d.cTagAfter !== undefined) out["cTagAfter"] = d.cTagAfter;
    if (d.revisionAfter !== undefined) out["revisionAfter"] = d.revisionAfter;
    if (d.bytes !== undefined) out["bytes"] = d.bytes;
    if (d.source !== undefined) out["source"] = d.source;
    if (d.resolvedItemId !== undefined) out["resolvedItemId"] = d.resolvedItemId;
    return out;
  }
  return { ...(envelope.details as unknown as Record<string, unknown>) };
}

function withoutInputSummary(shaped: Record<string, unknown>): Record<string, unknown> | null {
  const details = shaped["details"] as Record<string, unknown> | undefined;
  if (details === undefined || !("inputSummary" in details)) return null;
  const nextDetails = { ...details, inputSummary: { truncated: true } };
  return { ...shaped, details: nextDetails };
}

function withoutIntent(shaped: Record<string, unknown>): Record<string, unknown> {
  if (!("intent" in shaped)) return shaped;
  const out = { ...shaped };
  delete out["intent"];
  return out;
}

function buildOversizeFallback(shaped: Record<string, unknown>): Record<string, unknown> {
  return {
    ts: shaped["ts"],
    schemaVersion: AUDIT_SCHEMA_VERSION,
    type: "error",
    sessionId: shaped["sessionId"],
    agentId: shaped["agentId"],
    userOid: shaped["userOid"],
    projectId: shaped["projectId"],
    tool: shaped["tool"] ?? null,
    result: "failure",
    details: {
      errorName: "AuditEnvelopeTooLargeError",
      errorMessage: `audit envelope (type=${String(shaped["type"])}) exceeded ${AUDIT_MAX_LINE_BYTES}-byte cap; replaced with placeholder`,
    },
  };
}

// ---------------------------------------------------------------------------
// Errors raised internally — all caught by writeAudit.
// ---------------------------------------------------------------------------

export class BearerSubstringError extends Error {
  constructor() {
    super("audit envelope contains 'Bearer ' substring; line dropped (defence in depth)");
    this.name = "BearerSubstringError";
  }
}

export class EnvelopeTooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(`audit envelope still exceeds cap after truncation (${bytes} bytes)`);
    this.name = "EnvelopeTooLargeError";
  }
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/** Minimum config the writer needs from the host {@link import("../index.js").ServerConfig}. */
export interface AuditWriterConfig {
  configDir: string;
  now?: () => Date;
}

/**
 * Append a single audit envelope to the appropriate JSONL file.
 *
 * **Best-effort.** Failures (disk full, EACCES, parse violations,
 * Bearer rejection, abort) are logged at `warn` and swallowed. Audit
 * is never on the success path of a tool call.
 */
export async function writeAudit(
  config: AuditWriterConfig,
  envelope: AuditEnvelope,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    logger.warn("audit append skipped — signal aborted before write", {
      type: envelope.type,
      projectId: envelope.projectId,
    });
    return;
  }
  const now = config.now?.() ?? new Date();
  let built: BuiltEnvelope;
  try {
    built = buildAuditLine(envelope, now);
  } catch (err: unknown) {
    logger.warn("audit envelope rejected before write", {
      type: envelope.type,
      projectId: envelope.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (built.truncated !== AuditTruncationStage.None) {
    logger.warn("audit envelope truncated to fit cap", {
      type: envelope.type,
      projectId: envelope.projectId,
      truncated: built.truncated,
      replaced: built.replaced,
      bytes: built.bytes,
    });
  }

  const filePath = auditFilePath(config.configDir, envelope.projectId);
  try {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, mkdirOptions());
    // O_APPEND is implied by `flag: "a"`. Per POSIX, writes ≤
    // PIPE_BUF are atomic across concurrent appenders.
    // Note: `fs.appendFile` does not accept an AbortSignal in this Node
    // typings version; the caller already aborted-checked above so a
    // late-arriving signal will surface from `mkdir` / `appendFile` as
    // an `AbortError` and be swallowed by the outer catch below.
    await fs.appendFile(filePath, built.line, appendFileOptions());
  } catch (err: unknown) {
    logger.warn("audit append failed", {
      type: envelope.type,
      projectId: envelope.projectId,
      path: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Parser (partial-line tolerant)
// ---------------------------------------------------------------------------

/** Result of {@link parseAuditLines}. */
export interface ParsedAuditLines {
  /** All lines that parsed cleanly as JSON, in file order. */
  entries: Record<string, unknown>[];
  /** Number of lines skipped due to JSON parse failure (e.g. crash mid-write). */
  skipped: number;
}

/**
 * Parse a JSONL file's text into envelopes. Tolerates a partial trailing
 * line (e.g. a process killed mid-write) by silently skipping any line
 * that fails JSON parse. The number of skipped lines is reported so a
 * caller (e.g. an operator) can detect corruption.
 */
export function parseAuditLines(content: string): ParsedAuditLines {
  const entries: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const rawLine of content.split("\n")) {
    if (rawLine.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      skipped += 1;
      continue;
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      entries.push(parsed as Record<string, unknown>);
    } else {
      skipped += 1;
    }
  }
  return { entries, skipped };
}

/**
 * Read and parse the audit file for `projectId` (or `_unscoped` when
 * `null`). Returns an empty result if the file does not exist.
 */
export async function readAuditFile(
  configDir: string,
  projectId: string | null,
  signal: AbortSignal,
): Promise<ParsedAuditLines> {
  const filePath = auditFilePath(configDir, projectId);
  let content: string;
  try {
    content = await fs.readFile(filePath, { encoding: "utf-8", signal });
  } catch (err: unknown) {
    if (
      err !== null &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: unknown }).code === "ENOENT"
    ) {
      return { entries: [], skipped: 0 };
    }
    throw err;
  }
  return parseAuditLines(content);
}
