// KS_SERVER_v10_DEMO - the two demo credentials.
//   staff token  (aud ks-demo-staff)   the prospect in the demo portal; carries only the session id
//   client token (aud ks-demo-client)  the prospect playing the borrower (phone or on-screen); same session id
// Both are signed with demoTokenKey() - a key derived from JWT_SECRET but never equal to it - so they cannot be used
// on any real route, and real tokens cannot be used here. The session id comes ONLY from a verified token; no demo
// route reads a session id from the URL or body, so one prospect can never name another's session.
import { createHash, createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import { demoTokenKey } from "./config.js";

export type DemoAudience = "ks-demo-staff" | "ks-demo-client";
export const ISSUER = "ks-demo";

export function signDemoToken(sessionId: string, aud: DemoAudience, expiresAt: Date, now = new Date()): string {
  const exp = Math.floor(expiresAt.getTime() / 1000);
  const iat = Math.floor(now.getTime() / 1000);
  return jwt.sign({ sid: sessionId, iat, exp }, demoTokenKey(), { algorithm: "HS256", audience: aud, issuer: ISSUER, subject: sessionId });
}

/** The session id in a valid token for this audience, else null. */
export function verifyDemoToken(token: unknown, aud: DemoAudience): string | null {
  if (typeof token !== "string" || !token) return null;
  try {
    const p = jwt.verify(token, demoTokenKey(), { algorithms: ["HS256"], audience: aud, issuer: ISSUER }) as { sid?: unknown; sub?: unknown };
    const sid = typeof p.sid === "string" ? p.sid : null;
    return sid && sid === p.sub ? sid : null;
  } catch {
    return null;
  }
}

export function bearer(header: unknown): string | null {
  const v = String(header ?? "");
  return v.toLowerCase().startsWith("bearer ") ? v.slice(7).trim() : null;
}

const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** The borrower link code for a session: 10 characters from an HMAC of its id (no lookalike letters). */
export function clientCodeFor(sessionId: string): string {
  const mac = createHmac("sha256", demoTokenKey()).update(`client-code:${sessionId}`).digest();
  let out = "";
  for (let i = 0; i < 10; i++) out += CODE_ALPHABET[mac[i]! % CODE_ALPHABET.length];
  return out;
}

export function normalizeCode(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32);
}

export function codeHash(code: string): string {
  return createHash("sha256").update(`demo-code:${code}`).digest("hex");
}
