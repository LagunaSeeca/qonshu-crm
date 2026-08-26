// Server-only. Symmetric encryption for partner API keys at rest, using Node's
// crypto (AES-256-GCM). NEVER import this from a client component and NEVER log
// plaintext secrets, ciphertext, or the key. Requires Node's `crypto`, so it can
// only ever run server-side.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32; // AES-256 → 32-byte key
const IV_BYTES = 12; // GCM standard 96-bit nonce

// Resolve the master key from env at call time (not module load) so tests and
// deploys can set it late. Accepts a 32-byte key encoded as hex (64 chars) or
// base64; anything else is a misconfiguration and throws a clear, secret-free error.
function loadKey(): Buffer {
  const raw = process.env.PARTNER_API_KEY_SECRET;
  if (!raw || raw.trim() === "") {
    throw new Error("PARTNER_API_KEY_SECRET is not set");
  }
  const value = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (key.length !== KEY_BYTES) {
    // Report the decoded length only — never the key material itself.
    throw new Error(
      `PARTNER_API_KEY_SECRET must decode to a 32-byte key (hex or base64); got ${key.length} bytes`,
    );
  }
  return key;
}

// Encrypt `plaintext` → `base64(iv):base64(authTag):base64(ciphertext)`.
// A fresh random IV per call means the same plaintext never yields the same output.
export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

// Decrypt a value produced by `encryptSecret`. Throws if the payload is malformed
// or if the GCM auth tag doesn't verify (tampering / wrong key).
export function decryptSecret(ciphertext: string): string {
  const key = loadKey();
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed ciphertext: expected base64(iv):base64(authTag):base64(ciphertext)");
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  // `.final()` throws "Unsupported state or unable to authenticate data" when the
  // tag doesn't match — this is the tamper / wrong-key failure path.
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

// Last 4 characters for masked display (e.g. "••••1234"). Safe to render; not a secret.
export function last4(plaintext: string): string {
  return plaintext.slice(-4);
}
