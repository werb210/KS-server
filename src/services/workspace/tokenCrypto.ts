// KS_SERVER_v12_GOOGLE_WORKSPACE - Google tokens are encrypted at rest (AES-256-GCM).
// Key: GOOGLE_TOKEN_ENCRYPTION_KEY - 32 random bytes as base64 or 64 hex characters (openssl rand -base64 32).
// Any other non-empty value is stretched with SHA-256 so a typo never stores plaintext. Stored form:
// "v1:<iv b64>:<tag b64>:<ciphertext b64>". Changing the key disconnects everyone (they reconnect once).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// KS_SERVER_v13_QUICKBOOKS - the key's env name is a parameter so QuickBooks tokens use QBO_TOKEN_ENCRYPTION_KEY.
export type TokenKeyName = "GOOGLE_TOKEN_ENCRYPTION_KEY" | "QBO_TOKEN_ENCRYPTION_KEY";

function keyBytes(e: NodeJS.ProcessEnv = process.env, keyName: TokenKeyName = "GOOGLE_TOKEN_ENCRYPTION_KEY"): Buffer {
  const raw = String(e[keyName] ?? "").trim();
  if (!raw) throw new Error(keyName === "GOOGLE_TOKEN_ENCRYPTION_KEY" ? "google_token_key_missing" : "qbo_token_key_missing");
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  const b64 = Buffer.from(raw, "base64");
  if (b64.length === 32 && /^[A-Za-z0-9+/=_-]+$/.test(raw)) return b64;
  return createHash("sha256").update(raw, "utf8").digest();
}

export function encryptToken(plain: string, e: NodeJS.ProcessEnv = process.env, keyName: TokenKeyName = "GOOGLE_TOKEN_ENCRYPTION_KEY"): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(e, keyName), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

/** Plaintext, or null when the value is missing, malformed or was sealed with another key. */
export function decryptToken(sealed: string | null | undefined, e: NodeJS.ProcessEnv = process.env, keyName: TokenKeyName = "GOOGLE_TOKEN_ENCRYPTION_KEY"): string | null {
  if (!sealed) return null;
  const parts = String(sealed).split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyBytes(e, keyName), Buffer.from(parts[1]!, "base64"));
    decipher.setAuthTag(Buffer.from(parts[2]!, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
