// ULID generator for collab v1 identifiers (`projectId`, `sessionId`,
// `proposalId`, etc.). See `docs/plans/collab-v1.md` §3.2 — sentinel
// validates `projectId` only as a non-empty string, but the canonical
// generator emits a 26-character Crockford-base32 ULID.
//
// Implementation notes:
//
// - Crockford-base32 alphabet (excludes I, L, O, U). 10-character
//   timestamp prefix (millisecond precision) + 16-character random suffix.
// - Random bytes come from `node:crypto.randomBytes` so the value is
//   suitable for use as a stable identifier (we are not relying on it for
//   secrecy — the audit log records these in plaintext).
// - We keep this in-tree rather than pull a `ulid` npm dep because the
//   algorithm fits in ~30 lines and the project's "minimal dependencies"
//   posture (see ServerConfig discussion in `src/index.ts`) is
//   well-established.

import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RAND_LEN = 16;
const ULID_LEN = TIME_LEN + RAND_LEN;

function encodeTime(ts: number): string {
  if (!Number.isFinite(ts) || ts < 0) {
    throw new Error(`ulid timestamp must be a non-negative finite number, got ${String(ts)}`);
  }
  let remaining = Math.floor(ts);
  const out: string[] = new Array<string>(TIME_LEN);
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = remaining % 32;
    out[i] = ALPHABET[mod] ?? "0";
    remaining = (remaining - mod) / 32;
  }
  return out.join("");
}

function encodeRandom(bytes: Buffer): string {
  // Encode the 80 random bits as 16 base32 characters by reading 5-bit
  // groups MSB-first across the byte buffer.
  let bits = 0;
  let acc = 0;
  const out: string[] = [];
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      const idx = (acc >> bits) & 0x1f;
      out.push(ALPHABET[idx] ?? "0");
    }
  }
  if (out.length !== RAND_LEN) {
    throw new Error(`ulid: encoded ${String(out.length)} chars, expected ${String(RAND_LEN)}`);
  }
  return out.join("");
}

/**
 * Generate a new ULID. `now` defaults to `Date.now()` and exists so tests
 * can supply a fake clock (mirrors `ServerConfig.now` usage elsewhere).
 */
export function newUlid(now: () => number = Date.now): string {
  const ts = now();
  // 80 random bits = 10 bytes.
  const random = randomBytes(10);
  const ulid = encodeTime(ts) + encodeRandom(random);
  if (ulid.length !== ULID_LEN) {
    throw new Error(
      `ulid: produced ${String(ulid.length)}-char string, expected ${String(ULID_LEN)}`,
    );
  }
  return ulid;
}

/** Strict shape check for a Crockford-base32 ULID. */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Returns true when `value` is a syntactically-valid Crockford-base32 ULID. */
export function isUlid(value: string): boolean {
  return ULID_RE.test(value);
}

/**
 * Throws when `value` is not a syntactically-valid ULID. Used by
 * filesystem-path helpers (`auditFilePath`, `projectMetadataPath`)
 * so a maliciously-shaped `projectId` (e.g. `"../../etc/foo"`) cannot
 * be interpolated into a path under `<configDir>/sessions/audit/` or
 * `<configDir>/projects/`. The Error message includes the field name
 * so the audit log shows which input failed; the value itself is
 * truncated to 64 chars to avoid logging unbounded attacker input.
 */
export function assertValidProjectId(field: string, value: string): void {
  if (isUlid(value)) return;
  const display = value.length > 64 ? `${value.slice(0, 64)}…` : value;
  throw new Error(
    `${field}: expected 26-char Crockford-base32 ULID, got ${JSON.stringify(display)}`,
  );
}
