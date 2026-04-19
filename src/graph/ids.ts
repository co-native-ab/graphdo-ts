// ---------------------------------------------------------------------------
// ValidatedGraphId — a branded `string` newtype that proves a value has
// been checked against the opaque-Graph-identifier rules before it is
// spliced into a Graph URL.
//
// See `docs/adr/0007-validated-graph-ids.md` for the rationale. The
// short version: every Graph helper that interpolates an ID into a path
// (`/me/drive/items/${itemId}`, `/me/todo/lists/${listId}/...`) takes a
// `ValidatedGraphId` rather than a raw `string`, so the only way to
// reach a Graph URL is through {@link validateGraphId}. This makes
// missing validation a compile-time error and trivial to grep for at
// review time — the only escape hatch is the loud-named
// {@link unsafeAssumeValidatedGraphId} which must be commented at every
// use site.
//
// The brand is a structural-typing trick: at runtime a
// `ValidatedGraphId` is just a `string` (zero allocation, drop-in
// `encodeURIComponent` / template-literal ergonomics), but the
// `__validatedGraphId` symbol is module-private so external code cannot
// fabricate one without going through the validator.
// ---------------------------------------------------------------------------

declare const validatedGraphIdBrand: unique symbol;

/**
 * A `string` that has been validated as an opaque Microsoft Graph
 * identifier (drive item ID, drive item version ID, To Do list / task /
 * checklist item ID, etc.). The only ways to obtain a value of this
 * type are {@link validateGraphId} / {@link tryValidateGraphId} or the
 * deliberately loud {@link unsafeAssumeValidatedGraphId} escape hatch.
 *
 * The branded type behaves as a `string` everywhere that accepts a
 * `string` (template literals, `encodeURIComponent`, comparisons) — but
 * a raw `string` cannot be passed where a `ValidatedGraphId` is
 * required, which is the whole point.
 */
export type ValidatedGraphId = string & { readonly [validatedGraphIdBrand]: true };

/**
 * Maximum length we accept for an opaque Graph identifier.
 *
 * Real OneDrive drive item IDs are well under 100 chars, drive item version
 * IDs are short numeric strings (e.g. `"1.0"`, `"2.0"`), and we use the same
 * shape internally for mock IDs. 256 is a generous cap that keeps the URL
 * length bounded so a hand-edited config or a hostile caller cannot push an
 * arbitrarily large blob through `encodeURIComponent` into a Graph URL.
 */
export const MAX_GRAPH_ID_LENGTH = 256;

/**
 * Pure, throw-free check returning either the branded value or a short
 * human-readable reason. Used by tool-layer adapters that want to
 * surface a structured `isError: true` response rather than throw.
 */
export function tryValidateGraphId(
  label: string,
  value: unknown,
): { ok: true; value: ValidatedGraphId } | { ok: false; reason: string } {
  if (typeof value !== "string") {
    return { ok: false, reason: `${label} must be a string` };
  }
  if (value.length === 0) {
    return { ok: false, reason: `${label} must not be empty` };
  }
  if (value.length > MAX_GRAPH_ID_LENGTH) {
    return {
      ok: false,
      reason: `${label} is longer than ${String(MAX_GRAPH_ID_LENGTH)} characters`,
    };
  }
  if (/\s/.test(value)) {
    return { ok: false, reason: `${label} must not contain whitespace` };
  }
  if (/[\x00-\x1f\x7f]/u.test(value)) {
    return { ok: false, reason: `${label} must not contain control characters` };
  }
  if (value.includes("/") || value.includes("\\")) {
    return {
      ok: false,
      reason: `${label} must not contain path separators (/ or \\)`,
    };
  }
  // Non-ASCII would be silently re-encoded by encodeURIComponent and is
  // not a shape any real Graph ID has.
  if (/[^\x00-\x7f]/u.test(value)) {
    return { ok: false, reason: `${label} must be ASCII` };
  }
  return { ok: true, value: value as ValidatedGraphId };
}

/**
 * Validate that a value looks like an opaque Microsoft Graph identifier
 * before splicing it into a Graph URL. Returns the branded type on
 * success.
 *
 * Real Graph IDs are short, opaque, ASCII tokens — they never contain
 * path separators, whitespace, control characters, or non-ASCII. While
 * we always `encodeURIComponent` IDs before they hit the wire (so
 * injection of additional path segments is blocked at the URL layer),
 * this is defence in depth: a value that looks nothing like a real
 * Graph ID is almost certainly the result of a config bug, a confused
 * agent, or a malicious caller, and should fail loudly at the boundary
 * instead of producing a confusing 404 / 400 from Graph.
 *
 * @throws Error with the supplied label when the value is empty, too
 *   long, contains whitespace, control characters, path separators
 *   (`/`, `\`), non-ASCII characters, or is otherwise not a plausible
 *   Graph ID.
 */
export function validateGraphId(label: string, value: unknown): ValidatedGraphId {
  const result = tryValidateGraphId(label, value);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.value;
}

/**
 * Escape hatch for the rare case where a value is already known to
 * satisfy {@link validateGraphId}'s rules but type information has been
 * lost (e.g. a Zod-parsed Graph response field, a constant in a test
 * fixture). Every use site MUST be accompanied by a one-line comment
 * explaining why the value is trusted — `grep` for the function name
 * to audit them.
 *
 * Prefer {@link validateGraphId} where possible.
 */
export function unsafeAssumeValidatedGraphId(value: string): ValidatedGraphId {
  return value as ValidatedGraphId;
}
