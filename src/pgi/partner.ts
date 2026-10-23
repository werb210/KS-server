// KS_SERVER_v11_PGI - Personal Guarantee Insurance referrals to Keystone's insurance partner.
//
// Every licensee is automatically a referral source of the partner (Boreal Insurance), paid a referral fee of 20%
// of the partner's commission on each bound policy. The partner places the policy with the carrier. This file is
// the only place the partner is named in text this server sends (scripts/check-brand-strings.mjs allows it here).
//
// The link (partner server URL, this licensee's referral source id, API key and callback secret) is pushed by
// Keystone operations (PUT /api/pgi/link) and stored encrypted (AES-256-GCM). Key: KS_SECRETS_KEY when set, else
// derived from JWT_SECRET.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const PGI_PARTNER_NAME = "Boreal Insurance";
export const PGI_REFERRAL_FEE_RATE = 0.2;

function key(env: NodeJS.ProcessEnv = process.env): Buffer {
  const base = String(env.KS_SECRETS_KEY ?? "").trim() || String(env.JWT_SECRET ?? "").trim();
  if (base.length < 10) throw new Error("KS_SECRETS_KEY or JWT_SECRET is required to store the insurance partner link");
  return createHash("sha256").update("ks-pgi-link-v1:" + base).digest();
}

/** "v1:" + base64(iv | tag | ciphertext). */
export function sealSecret(plain: string, env: NodeJS.ProcessEnv = process.env): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(env), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function openSecret(sealed: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!sealed.startsWith("v1:")) throw new Error("unknown secret format");
  const buf = Buffer.from(sealed.slice(3), "base64");
  const d = createDecipheriv("aes-256-gcm", key(env), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

/** The partner server may only be an https Azure host (or a host listed in KS_PGI_ALLOWED_HOSTS). */
export function allowedPartnerUrl(raw: unknown, env: NodeJS.ProcessEnv = process.env): string | null {
  let u: URL;
  try { u = new URL(String(raw ?? "").trim()); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  const host = u.hostname.toLowerCase();
  const extra = String(env.KS_PGI_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const ok = host.endsWith(".azurewebsites.net") || extra.some((h) => (h.startsWith(".") ? host.endsWith(h) : host === h));
  return ok ? `https://${host}` : null;
}
