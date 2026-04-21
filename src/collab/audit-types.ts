// Audit envelope types, enums, constants, and path helpers (collab v1 §3.6).
//
// This module contains only declarations: schema constants, the discriminated
// union of envelope shapes, and the on-disk path resolver. All consumers
// import from `audit.js`; this file is split out from the original
// `audit.ts` for cohesion and is re-exported by the barrel.

import * as path from "node:path";

import { assertValidProjectId } from "./ulid.js";

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
