import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encryptSecret, decryptSecret, last4 } from "./secret";

// A deterministic 32-byte key (64 hex chars) for the round-trip / tamper tests.
const HEX_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("secret crypto", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.PARTNER_API_KEY_SECRET;
    process.env.PARTNER_API_KEY_SECRET = HEX_KEY;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.PARTNER_API_KEY_SECRET;
    else process.env.PARTNER_API_KEY_SECRET = saved;
  });

  it("round-trips encrypt → decrypt", () => {
    const plain = "sk_live_abcdEFGH1234";
    const enc = encryptSecret(plain);
    expect(enc).not.toContain(plain); // ciphertext never contains the plaintext
    expect(decryptSecret(enc)).toBe(plain);
  });

  it("emits base64(iv):base64(authTag):base64(ciphertext) with a fresh IV each time", () => {
    const a = encryptSecret("same-input");
    const b = encryptSecret("same-input");
    expect(a.split(":")).toHaveLength(3);
    expect(a).not.toBe(b); // random IV → different ciphertext for identical plaintext
    expect(decryptSecret(a)).toBe("same-input");
    expect(decryptSecret(b)).toBe("same-input");
  });

  it("accepts a base64-encoded key too", () => {
    process.env.PARTNER_API_KEY_SECRET = Buffer.alloc(32, 7).toString("base64");
    expect(decryptSecret(encryptSecret("via-base64-key"))).toBe("via-base64-key");
  });

  it("fails authentication when the ciphertext is tampered with", () => {
    const enc = encryptSecret("tamper-me");
    const [iv, tag, data] = enc.split(":");
    const buf = Buffer.from(data, "base64");
    buf[0] ^= 0xff; // flip a bit in the ciphertext
    const tampered = [iv, tag, buf.toString("base64")].join(":");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("fails authentication when the auth tag is tampered with", () => {
    const enc = encryptSecret("tamper-tag");
    const [iv, tag, data] = enc.split(":");
    const buf = Buffer.from(tag, "base64");
    buf[0] ^= 0xff;
    const tampered = [iv, buf.toString("base64"), data].join(":");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("rejects a malformed payload", () => {
    expect(() => decryptSecret("not-a-valid-payload")).toThrow(/malformed/i);
  });

  it("throws a clear error when the key is missing", () => {
    delete process.env.PARTNER_API_KEY_SECRET;
    expect(() => encryptSecret("x")).toThrow(/not set/i);
    expect(() => decryptSecret("a:b:c")).toThrow(/not set/i);
  });

  it("throws a clear error when the key is the wrong size", () => {
    process.env.PARTNER_API_KEY_SECRET = "deadbeef"; // 4 bytes, not 32
    expect(() => encryptSecret("x")).toThrow(/32-byte/i);
  });

  it("last4 returns the trailing 4 chars for display", () => {
    expect(last4("sk_live_abcd1234")).toBe("1234");
    expect(last4("ab")).toBe("ab"); // shorter than 4 → whole string
  });
});
