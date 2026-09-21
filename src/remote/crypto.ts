import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const IV_LEN = 12; // 96-bit nonce, recommended for GCM
const TAG_LEN = 16;

/**
 * Encrypt a UTF-8 string with AES-256-GCM.
 * Output format (base64): iv(12) || authTag(16) || ciphertext.
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

/** Decrypt a value produced by {@link encrypt}. */
export function decrypt(encoded: string, key: Buffer): string {
  const buf = Buffer.from(encoded, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** SHA-256 hex digest — used so we only ever persist token/code hashes. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A URL-safe random secret (default 32 bytes → 43-char base64url). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
