// Read-with-recovery helpers for the authoritative `.md` file (collab v1
// §3.1, §9 "Week 2"). Pure — no I/O. The collab tools orchestrate the
// side effects (Graph fetch, audit append, local-cache update) at their
// own composition layer. Split out from `frontmatter.ts`; re-exported
// through the barrel.

import { DocIdRecoveryRequiredError } from "../errors.js";

import type { CollabFrontmatter } from "./frontmatter-schema.js";
import { FrontmatterParseError, parseFrontmatter, splitFrontmatter } from "./frontmatter-codec.js";

/**
 * Why the read path produced default frontmatter instead of a parsed
 * block. Mirrors the `frontmatter_reset.reason` enum in `§3.6`
 * (audit-log table); kept in sync with the typed audit envelope below.
 */
export type FrontmatterResetReason = "missing" | "malformed";

/**
 * Outcome of {@link readMarkdownFrontmatter}.
 *
 * - `parsed` — leading envelope present and the inner YAML satisfied
 *   the strict schema. The caller uses `frontmatter` directly; no
 *   audit entry is required.
 * - `reset` — envelope was missing or malformed. The caller treats
 *   `frontmatter` as defaults (no `collab` state — schema does not
 *   permit a `null` `doc_id`, so we expose `null` for the doc_id
 *   field instead of synthesising one), records a `frontmatter_reset`
 *   audit entry, and falls back to local metadata for `doc_id` on the
 *   next write via {@link resolveDocId}.
 *
 * In both cases `body` is the markdown body following the (possibly
 * absent) closing delimiter, normalised to LF line endings.
 */
export type ReadFrontmatterResult =
  | {
      kind: "parsed";
      frontmatter: CollabFrontmatter;
      body: string;
    }
  | {
      kind: "reset";
      reason: FrontmatterResetReason;
      body: string;
      /**
       * Underlying parser failure when {@link FrontmatterResetReason}
       * is `"malformed"`. Surfaced for diagnostic logging only — the
       * audit envelope intentionally records `reason` and not the raw
       * parse message (which can leak parts of a cooperator-edited
       * file body). `undefined` when `reason === "missing"`.
       */
      parseError?: FrontmatterParseError;
    };

/**
 * Read the authoritative-file content into either a parsed
 * frontmatter block or a structured "reset" outcome with the body
 * preserved. Pure — no I/O. Performs no `doc_id` recovery itself; pair
 * with {@link resolveDocId} once the caller has loaded the local
 * project metadata.
 */
export function readMarkdownFrontmatter(content: string): ReadFrontmatterResult {
  const split = splitFrontmatter(content);
  if (split === null) {
    // Either no leading `---\n…\n---\n` envelope at all, or the
    // opening `---` had no closing partner. Both are "missing" from
    // the read-path's perspective: there is no parseable frontmatter.
    // Preserve the body so `collab_read` can still echo the file
    // content and so the next `collab_write` does not stomp on what
    // the human typed.
    return {
      kind: "reset",
      reason: "missing",
      body: content.replace(/\r\n/g, "\n"),
    };
  }
  try {
    const frontmatter = parseFrontmatter(split.yaml);
    return { kind: "parsed", frontmatter, body: split.body };
  } catch (err) {
    // The hardened parser surfaces every failure as
    // `FrontmatterParseError` (yaml errors, schema mismatch,
    // prototype-pollution attempts, oversize bodies, multi-doc
    // separators). All of these are "malformed" from the read-path's
    // perspective; the writer-side codepath is identical regardless
    // of which sub-reason fired.
    if (err instanceof FrontmatterParseError) {
      return {
        kind: "reset",
        reason: "malformed",
        body: split.body,
        parseError: err,
      };
    }
    // Any other throw is a programmer error inside the codec — let it
    // propagate so it is caught by the call site rather than silently
    // demoted to "malformed" (which would mask a regression).
    throw err;
  }
}

/**
 * Resolved `doc_id` outcome from {@link resolveDocId}.
 *
 * `source` records which input wins so the caller can emit the right
 * audit entry: a `parsed` read with `source: "frontmatter"` is the
 * happy path (no extra audit), while a `reset` read with
 * `source: "local-cache"` is the recovery path that pairs with a
 * `frontmatter_reset` audit entry carrying `recoveredDocId: true`.
 */
export interface DocIdResolution {
  docId: string;
  source: "frontmatter" | "local-cache";
}

/**
 * Resolve the `doc_id` for the authoritative file given the read
 * outcome and the local project metadata's cached `docId`.
 *
 * - Read returned `parsed` ⇒ frontmatter wins. The cached value (if
 *   any) is ignored; §3.1 says the embedded value is authoritative
 *   when present and parseable.
 * - Read returned `reset` and `cachedDocId` is non-null ⇒ recovery
 *   from local cache. The next write re-injects this `doc_id`.
 * - Read returned `reset` and `cachedDocId` is null ⇒ throw
 *   {@link DocIdRecoveryRequiredError} so the writer refuses and
 *   directs the agent at `session_recover_doc_id`.
 *
 * `projectId` is used only to compose a helpful error message —
 * pass the locally-known id, not the (possibly missing) frontmatter
 * one.
 */
export function resolveDocId(
  read: ReadFrontmatterResult,
  cachedDocId: string | null,
  projectId: string,
): DocIdResolution {
  if (read.kind === "parsed") {
    return { docId: read.frontmatter.collab.doc_id, source: "frontmatter" };
  }
  if (cachedDocId !== null) {
    return { docId: cachedDocId, source: "local-cache" };
  }
  throw new DocIdRecoveryRequiredError(projectId);
}

/**
 * Typed envelope for the `frontmatter_reset` audit entry (§3.6).
 *
 * The W3 Day 3 audit writer composes this from the read outcome plus
 * the file's pre-read revision and whether {@link resolveDocId}
 * succeeded. Defined here next to the helpers that produce its
 * inputs so a future schema bump touches one file, not two.
 *
 * Field meanings (per §3.6):
 *
 * - `reason` — which read-path branch fired.
 * - `previousRevision` — the file's `cTag` immediately before the
 *   read that triggered this reset, or `null` when the file had no
 *   revision history (created in the same operation). Carried
 *   verbatim from the Graph response; the audit writer is
 *   responsible for redacting any sensitive substrings (§3.6).
 * - `recoveredDocId` — `true` if `doc_id` was recoverable from local
 *   cache, `false` if `DocIdRecoveryRequiredError` was raised. The
 *   writer logs the reset entry **before** the recovery throw
 *   propagates so the unrecoverable case is auditable too.
 */
export interface FrontmatterResetAudit {
  reason: FrontmatterResetReason;
  previousRevision: string | null;
  recoveredDocId: boolean;
}
