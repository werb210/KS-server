// KS_SHARED_HOSTING_v1 - the registry's encrypted values (database_url_enc, env_enc).
//
// Shared format, identical in KS-Ops, KS-server, KS-Agent and the web host:
//   key    AES-256 key = SHA-256(KS_TENANT_KEY)  (KS_TENANT_KEY is any length string)
//   value  v1:<iv base64>:<auth tag base64>:<ciphertext base64>, AES-256-GCM, 12-byte random IV, UTF-8 plaintext
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { sharedEnv } from "./mode.js";

function keyFrom(secret?: string): Buffer {
  const k = String(secret ?? sharedEnv().KS_TENANT_KEY ?? "");
  if (!k) throw new Error("ks_tenant_key_missing");
  return createHash("sha256").update(k, "utf8").digest();
}

/** Encrypt to the v1 format (KS-Ops writes these; here it is used by tests and tools). */
export function encryptTenantValue(plaintext: string, secret?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/** Decrypt a v1 value. Throws on a wrong key, a tampered value or an unknown format. */
export function decryptTenantValue(value: string, secret?: string): string {
  const parts = String(value ?? "").split(":");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("ks_tenant_value_bad_format");
  const iv = Buffer.from(parts[1]!, "base64");
  const tag = Buffer.from(parts[2]!, "base64");
  const ct = Buffer.from(parts[3]!, "base64");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("ks_tenant_value_bad_format");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** env_enc: an encrypted JSON object of string values. Empty means no values. */
export function decryptTenantEnv(value: string, secret?: string): Record<string, string> {
  if (!String(value ?? "").trim()) return {};
  const parsed = JSON.parse(decryptTenantValue(value, secret)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("ks_tenant_env_not_object");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}
