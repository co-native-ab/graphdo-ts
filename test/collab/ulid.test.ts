// Unit tests for the collab v1 ULID generator.
//
// We do not test cryptographic randomness — `node:crypto.randomBytes`
// is the source — but we do verify the structural guarantees the rest
// of the codec relies on (length, alphabet, monotonic prefix, fake
// clock injection).

import { describe, it, expect } from "vitest";

import { newUlid, isUlid } from "../../src/collab/ulid.js";

describe("collab/ulid", () => {
  it("produces a 26-character Crockford-base32 string", () => {
    const id = newUlid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("isUlid accepts produced values and rejects malformed ones", () => {
    const id = newUlid();
    expect(isUlid(id)).toBe(true);
    expect(isUlid(id.toLowerCase())).toBe(false);
    expect(isUlid("not-a-ulid")).toBe(false);
    expect(isUlid("01ABCDEFGHJKMNPQRSTV0WXYZI")).toBe(false); // contains banned 'I'
    expect(isUlid("01ABCDEFGHJKMNPQRSTV0WXYZ")).toBe(false); // 25 chars
  });

  it("encodes the timestamp in the first 10 characters monotonically", () => {
    const a = newUlid(() => 1_700_000_000_000);
    const b = newUlid(() => 1_700_000_000_001);
    expect(a.slice(0, 10) <= b.slice(0, 10)).toBe(true);
    expect(a.slice(0, 10)).not.toBe("0000000000");
  });

  it("rejects negative or non-finite timestamps", () => {
    expect(() => newUlid(() => -1)).toThrow();
    expect(() => newUlid(() => Number.NaN)).toThrow();
    expect(() => newUlid(() => Number.POSITIVE_INFINITY)).toThrow();
  });

  it("two consecutive ULIDs at the same timestamp differ in the random suffix", () => {
    const stamp = (): number => 1_700_000_000_000;
    const a = newUlid(stamp);
    const b = newUlid(stamp);
    expect(a).not.toBe(b);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
  });
});
