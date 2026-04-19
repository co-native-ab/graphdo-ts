// Scope resolution algorithm for collab v1 (§4.6).
//
// This module owns the **single primitive** that gates every `path`
// argument across `collab_read`, `collab_list_files`, `collab_write`,
// `collab_create_proposal`, `collab_apply_proposal`, and
// `collab_delete_file`. The algorithm is spelled out verbatim in
// `docs/plans/collab-v1.md` §4.6 and tested row-for-row by
// `test/integration/08-scope-traversal-rejected.test.ts` (per §8.2 row 08).
//
// Public API:
//
//   - {@link validateScopedPathSyntax}: pure, throw-free sieve for
//     §4.6 steps 1–5 (pre-resolution refusals + URL-decode + NFC/NFKC
//     check + segment validation + layout enforcement). Issues **zero**
//     Graph calls. Returns the classification the caller needs to drive
//     the byId path-resolution call in step 6.
//
//   - {@link resolveScopedPath}: full §4.6 algorithm. Calls
//     {@link validateScopedPathSyntax} first, then issues the byId path
//     resolution and runs the post-resolution defence-in-depth checks
//     (steps 6–7). Returns the resolved {@link DriveItem} on success.
//
// All refusals throw {@link OutOfScopeError} (`src/errors.ts`) carrying
// the verbatim `attemptedPath` and a stable `reason` enum value (also
// declared in `src/errors.ts`). The W3 Day 3 audit writer joins on
// `attemptedPath` + `reason` for `scope_denied` entries (§3.6).

import type { GraphClient } from "../graph/client.js";
import { GraphRequestError, HttpMethod, parseResponse } from "../graph/client.js";
import type { ValidatedGraphId } from "../graph/ids.js";
import type { DriveItem } from "../graph/types.js";
import { DriveItemSchema } from "../graph/types.js";
import { OutOfScopeError, type OutOfScopeReason } from "../errors.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum length of a scope-relative `path` argument before any
 * processing. Mirrors §4.6 step 1b.
 */
export const MAX_SCOPED_PATH_LENGTH = 1024;

/**
 * Maximum number of `parentReference` hops the §4.6 step 7 ancestry
 * walk follows before refusing with `ancestry_escape`. Collab projects
 * are shallow (root + the four canonical groups), so the live
 * use-cases all resolve in ≤2 hops. The cap exists purely as a
 * runaway-loop guard.
 */
export const MAX_ANCESTRY_HOPS = 8;

/** Top-level groups recognised by §4.6 step 5. */
const GROUP_PROPOSALS = "proposals";
const GROUP_DRAFTS = "drafts";
const GROUP_ATTACHMENTS = "attachments";

/** Required extension for entries under `proposals/` and `drafts/`. */
const FLAT_GROUP_EXTENSION = ".md";

// ---------------------------------------------------------------------------
// Pure syntactic validation (§4.6 steps 1–5)
// ---------------------------------------------------------------------------

/**
 * Classification of a syntactically-valid scope-relative path. Drives
 * the layout-aware error reporting in step 7 (case-aliasing checks) and
 * lets the caller pick the right audit shape without re-parsing.
 */
export type ScopedPathKind = "authoritative" | "proposals" | "drafts" | "attachments";

export interface ScopedPathSyntax {
  /** The path the agent supplied, verbatim. */
  attemptedPath: string;
  /**
   * NFC-normalised, URL-decoded segments after step 4. Always non-empty
   * by construction. For `kind === "authoritative"` this is a
   * single-element array.
   */
  segments: string[];
  /** §4.6 step 5 layout classification. */
  kind: ScopedPathKind;
}

function refuse(attemptedPath: string, reason: OutOfScopeReason): never {
  throw new OutOfScopeError(attemptedPath, reason);
}

/**
 * §4.6 steps 1–5. Pure, throw-free of Graph: refuses the path with
 * {@link OutOfScopeError} for any rule that does not require a Graph
 * call. Returns the syntactic classification on success so
 * {@link resolveScopedPath} can issue the correct byId path-resolution
 * call.
 *
 * `pinnedAuthoritativeFileName` is compared NFC-equal, case-sensitive
 * (matches the algorithm spec — OneDrive on Windows folds case server-
 * side, so a `Spec.md` agent input that resolves to `spec.md` on disk
 * is caught by the case-aliasing check in step 7, not here).
 */
export function validateScopedPathSyntax(
  rawPath: string,
  pinnedAuthoritativeFileName: string,
): ScopedPathSyntax {
  const attemptedPath = rawPath;

  // ---- Step 1: pre-normalisation refusals ----
  if (rawPath.length === 0) {
    refuse(attemptedPath, "empty_path");
  }
  if (rawPath.length > MAX_SCOPED_PATH_LENGTH) {
    refuse(attemptedPath, "path_too_long");
  }
  // Step 1b: NUL, CR, LF, or any C0/C1 control char (< 0x20). DEL (0x7f)
  // and the C1 range 0x80–0x9f are also blocked because they carry the
  // same control-char risk in a path argument.
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(rawPath)) {
    refuse(attemptedPath, "control_character");
  }
  // Step 1c: backslash refused outright (Windows-style separator).
  // Step 1e (drive-letter prefix) is checked *before* backslash so a
  // path like `C:\foo` surfaces as `drive_letter` rather than the
  // generic backslash refusal.
  if (/^[A-Za-z]:[\/\\]/u.test(rawPath)) {
    refuse(attemptedPath, "drive_letter");
  }
  if (rawPath.includes("\\")) {
    refuse(attemptedPath, "backslash");
  }
  // Step 1e: absolute path refused before URL-decode so encoded
  // variants surface as `double_encoded` below.
  if (rawPath.startsWith("/")) {
    refuse(attemptedPath, "absolute_path");
  }
  // Step 1d: `%` in the raw path forces explicit decoding before
  // reasoning. Any `%` triggers the decode in step 2; if a `%`
  // survives the decode, it is double-encoding and refused.
  // (We do not refuse here — the decode in step 2 is the single
  // gate per the spec.)

  // ---- Step 2: URL-decode once ----
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    // Malformed escape sequence — treat as double-encoded refusal so
    // the agent sees a stable reason rather than a JS-level surprise.
    refuse(attemptedPath, "double_encoded");
  }
  // Re-check the same step-1 invariants on the decoded form so an
  // encoded backslash / leading slash / drive letter / control char /
  // NUL cannot bypass the gate.
  if (decoded.includes("%")) {
    refuse(attemptedPath, "double_encoded");
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(decoded)) {
    refuse(attemptedPath, "control_character");
  }
  if (/^[A-Za-z]:[\/\\]/u.test(decoded)) {
    refuse(attemptedPath, "drive_letter");
  }
  if (decoded.includes("\\")) {
    refuse(attemptedPath, "backslash");
  }
  if (decoded.startsWith("/")) {
    refuse(attemptedPath, "absolute_path");
  }
  // ---- Step 3: Unicode NFC normalisation + NFKC equality ----
  const nfc = decoded.normalize("NFC");
  const nfkc = decoded.normalize("NFKC");
  if (nfkc !== nfc) {
    // Catches full-width ".." / "/", zero-width chars, RTL overrides,
    // ligatures, compatibility forms, etc.
    refuse(attemptedPath, "homoglyph_or_compatibility_form");
  }

  // ---- Step 4: split + per-segment validation ----
  const segments = nfc.split("/");
  for (const seg of segments) {
    if (seg.length === 0) {
      refuse(attemptedPath, "empty_segment");
    }
    if (seg === ".") {
      refuse(attemptedPath, "dot_segment");
    }
    if (seg === "..") {
      refuse(attemptedPath, "dotdot_segment");
    }
    if (seg.startsWith(".")) {
      // Belt-and-braces: dot-prefixed segments are excluded so
      // `.collab/` and any sibling dotfile remain unreachable.
      refuse(attemptedPath, "dot_prefixed_segment");
    }
  }

  // ---- Step 5: layout enforcement ----
  if (segments.length === 1 && segments[0] === pinnedAuthoritativeFileName.normalize("NFC")) {
    return { attemptedPath, segments, kind: "authoritative" };
  }

  const head = segments[0];
  if (head !== GROUP_PROPOSALS && head !== GROUP_DRAFTS && head !== GROUP_ATTACHMENTS) {
    refuse(attemptedPath, "path_layout_violation");
  }

  if (head === GROUP_PROPOSALS || head === GROUP_DRAFTS) {
    // Flat group: exactly two segments, second must end in `.md`
    // (NFC-equal, lowercase).
    if (segments.length !== 2) {
      refuse(attemptedPath, "subfolder_in_flat_group");
    }
    const tail = segments[1] ?? "";
    // Lowercase the extension comparison so `.MD` is folded server-
    // side and caught here uniformly.
    if (!tail.toLowerCase().endsWith(FLAT_GROUP_EXTENSION)) {
      refuse(attemptedPath, "wrong_extension");
    }
    return {
      attemptedPath,
      segments,
      kind: head === GROUP_PROPOSALS ? "proposals" : "drafts",
    };
  }

  // attachments/ — recursive, no extension constraint. Length ≥ 2
  // ensures we never address the bare folder.
  if (segments.length < 2) {
    refuse(attemptedPath, "path_layout_violation");
  }
  return { attemptedPath, segments, kind: "attachments" };
}

// ---------------------------------------------------------------------------
// Full algorithm (§4.6 steps 1–7)
// ---------------------------------------------------------------------------

export interface ResolveScopedPathArgs {
  /** Pinned project folder id (from local project metadata, §3.3). */
  projectFolderId: ValidatedGraphId;
  /** Pinned drive id (from local project metadata, §3.3). */
  driveId: string;
  /** Pinned authoritative file name (from local project metadata, §3.3). */
  authoritativeFileName: string;
  /** The agent-supplied scope-relative path. */
  path: string;
}

export interface ResolveScopedPathResult {
  item: DriveItem;
  syntax: ScopedPathSyntax;
}

/**
 * Run the §4.6 scope resolution algorithm end-to-end. On success
 * returns the resolved {@link DriveItem} plus the syntactic
 * classification (so the caller can branch on `kind` without re-parsing
 * the path). On any refusal throws {@link OutOfScopeError}.
 *
 * Mirrors the algorithm spec verbatim:
 *
 *   1–5. {@link validateScopedPathSyntax} — pure, no Graph calls.
 *   6.  Resolve via Graph using the byId path expression
 *       `/me/drive/items/{projectFolderId}:/{joined}:`.
 *   7.  Defence-in-depth post-resolution checks:
 *       - `remoteItem` populated → `shortcut_redirect`
 *       - `parentReference.driveId !== pinned driveId` → `cross_drive`
 *       - Walking `parentReference.id` ancestry up to N=8 hops does
 *         not surface `projectFolderId` → `ancestry_escape`
 *       - Returned `name` (NFC) ≠ requested last segment →
 *         `case_aliasing`
 */
export async function resolveScopedPath(
  client: GraphClient,
  args: ResolveScopedPathArgs,
  signal: AbortSignal,
): Promise<ResolveScopedPathResult> {
  const syntax = validateScopedPathSyntax(args.path, args.authoritativeFileName);

  // Step 6: byId path resolution. The colon-delimited path expression
  // anchors at the project folder via its opaque id, so a stale or
  // spoofed root reference cannot escape. Each segment is
  // `encodeURIComponent`'d so reserved characters (e.g. `?`, `#`) are
  // transported as bytes.
  const joined = syntax.segments.map((s) => encodeURIComponent(s)).join("/");
  const projectFolderEncoded = encodeURIComponent(args.projectFolderId);
  const requestPath = `/me/drive/items/${projectFolderEncoded}:/${joined}:`;
  logger.debug("resolving scoped path", {
    attemptedPath: syntax.attemptedPath,
    kind: syntax.kind,
    requestPath,
  });

  let item: DriveItem;
  try {
    const response = await client.request(HttpMethod.GET, requestPath, signal);
    item = await parseResponse(response, DriveItemSchema, HttpMethod.GET, requestPath);
  } catch (err) {
    // 404 from the byId path resolution is left as a {@link
    // GraphRequestError}: it indicates "no such item under scope",
    // which is a `FileNotFoundError`-shaped condition that the calling
    // tool surfaces separately. The §4.6 algorithm only owns the
    // out-of-scope verdicts.
    throw err;
  }

  // ---- Step 7: defence-in-depth ----
  if (item.remoteItem !== undefined) {
    throw new OutOfScopeError(syntax.attemptedPath, "shortcut_redirect", item.id);
  }

  const parent = item.parentReference;
  if (parent?.driveId !== undefined && parent.driveId !== args.driveId) {
    throw new OutOfScopeError(syntax.attemptedPath, "cross_drive", item.id);
  }

  // Ancestry walk: climb parentReference.id until we hit the pinned
  // project folder or run out of hops. The byId path resolution above
  // usually guarantees this, so the walk is defensive.
  await assertAncestry(client, item, args.projectFolderId, syntax.attemptedPath, signal);

  // Case-aliasing: the returned name (NFC) must equal the requested
  // last segment exactly. Catches Windows/OneDrive case folding, e.g.
  // a write to `Proposals/foo.md` that resolves to `proposals/foo.md`.
  const lastSegment = syntax.segments[syntax.segments.length - 1] ?? "";
  if (item.name.normalize("NFC") !== lastSegment) {
    throw new OutOfScopeError(syntax.attemptedPath, "case_aliasing", item.id);
  }

  return { item, syntax };
}

/**
 * Walk `parentReference.id` from `item` up to {@link MAX_ANCESTRY_HOPS}
 * hops looking for `projectFolderId`. Throws {@link OutOfScopeError}
 * with `ancestry_escape` if the project folder is not reached.
 *
 * `getDriveItem`-style calls are issued on demand so the common case
 * (item directly under `proposals/` etc.) costs at most one extra GET.
 *
 * `attemptedPath` is the agent's original path (verbatim) — used as the
 * `OutOfScopeError.attemptedPath` so the audit entry joins on the same
 * key the resolver caller would expect, not on the resolved item's name.
 */
async function assertAncestry(
  client: GraphClient,
  item: DriveItem,
  projectFolderId: ValidatedGraphId,
  attemptedPath: string,
  signal: AbortSignal,
): Promise<void> {
  // The item itself might be the project folder (e.g. a hypothetical
  // future caller passes the bare project root). Walk from the item's
  // parent because the pinned folder is the *containing* folder for
  // every legal path; the layout enforcement above also guarantees
  // length ≥ 1.
  let cursorParentId: string | undefined = item.parentReference?.id;

  for (let hop = 0; hop < MAX_ANCESTRY_HOPS; hop++) {
    if (cursorParentId === undefined) {
      // Can't climb further: the resolved item isn't anchored at the
      // pinned folder.
      throw new OutOfScopeError(attemptedPath, "ancestry_escape", item.id);
    }
    if (cursorParentId === projectFolderId) {
      return;
    }
    // Fetch the next ancestor's `parentReference.id` so we can keep
    // climbing.
    const ancestorPath = `/me/drive/items/${encodeURIComponent(cursorParentId)}`;
    let ancestor: DriveItem;
    try {
      const response = await client.request(HttpMethod.GET, ancestorPath, signal);
      ancestor = await parseResponse(response, DriveItemSchema, HttpMethod.GET, ancestorPath);
    } catch (err) {
      if (err instanceof GraphRequestError && err.statusCode === 404) {
        throw new OutOfScopeError(attemptedPath, "ancestry_escape", item.id);
      }
      throw err;
    }
    cursorParentId = ancestor.parentReference?.id;
  }
  throw new OutOfScopeError(attemptedPath, "ancestry_escape", item.id);
}
