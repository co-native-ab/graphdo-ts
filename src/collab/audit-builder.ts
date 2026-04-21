// Envelope shaper, intent normaliser, hash + sanitisation helpers, and
// the JSONL line builder for collab audit (§3.6). Split out from
// `audit.ts`; re-exported through the barrel.

import * as crypto from "node:crypto";

import {
  AUDIT_DIFF_SUMMARY_HASH_HEX_CHARS,
  AUDIT_INTENT_MAX_CHARS,
  AUDIT_MAX_LINE_BYTES,
  AUDIT_SCHEMA_VERSION,
  AuditTruncationStage,
  type AuditEnvelope,
  type AuditInputSummary,
} from "./audit-types.js";

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
