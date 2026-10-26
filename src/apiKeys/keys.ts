// KS_SERVER_SSO_API_KEYS - API keys for the public REST API (Pro).
//
// A key looks like  ks_live_<32 hex: the key's id>_<43 random base64url characters>.
// The id makes the lookup a primary-key read; the whole key is then checked against the stored HMAC-SHA256 in
// constant time. The key itself is shown to the Admin once and never stored. The HMAC key (pepper) is
// KS_API_KEY_PEPPER; when that is not set the server's JWT_SECRET is used instead, and each key records which one
// hashed it (pepper_source), so setting KS_API_KEY_PEPPER later does not break existing keys.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Q } from "../plans/state.js";

export const KEY_PREFIX = "ks_live_";
export const API_KEY_SCOPES = ["read", "read_write"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
export const MAX_ACTIVE_KEYS = 25;

export function isApiKeyScope(v: unknown): v is ApiKeyScope {
  return typeof v === "string" && (API_KEY_SCOPES as readonly string[]).includes(v);
}

export type PepperSource = "env" | "jwt";

/** The pepper for a source, or null when that source is not set on this server. */
export function pepperFor(source: PepperSource, e: NodeJS.ProcessEnv = process.env): string | null {
  const v = String((source === "env" ? e.KS_API_KEY_PEPPER : e.JWT_SECRET) ?? "").trim();
  return v.length >= 10 ? v : null;
}

/** The pepper new keys are hashed with: KS_API_KEY_PEPPER when set, else JWT_SECRET. Null = keys cannot be made. */
export function currentPepper(e: NodeJS.ProcessEnv = process.env): { source: PepperSource; pepper: string } | null {
  const env = pepperFor("env", e);
  if (env) return { source: "env", pepper: env };
  const jwtSecret = pepperFor("jwt", e);
  return jwtSecret ? { source: "jwt", pepper: jwtSecret } : null;
}

export function hashApiKey(key: string, pepper: string): string {
  return createHmac("sha256", pepper).update(key, "utf8").digest("hex");
}

export function idToHex(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

export function hexToId(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const KEY_SHAPE = /^ks_live_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;

/** The key's id, or null when the string is not shaped like one of our keys. */
export function parseApiKey(raw: string): { id: string } | null {
  const m = KEY_SHAPE.exec(String(raw ?? "").trim());
  return m ? { id: hexToId(m[1]) } : null;
}

export type NewKey = { id: string; key: string; key_prefix: string; key_hash: string; pepper_source: PepperSource };

export function generateApiKey(pepper: { source: PepperSource; pepper: string }, id: string = randomUUID()): NewKey {
  const secret = randomBytes(32).toString("base64url");
  const hex = idToHex(id);
  const key = `${KEY_PREFIX}${hex}_${secret}`;
  return { id, key, key_prefix: `${KEY_PREFIX}${hex.slice(0, 8)}`, key_hash: hashApiKey(key, pepper.pepper), pepper_source: pepper.source };
}

export type ApiKeyRow = {
  id: string; name: string; scope: ApiKeyScope; key_prefix: string; key_hash: string; pepper_source: PepperSource;
  created_by: string | null; created_at: string | Date; last_used_at: string | Date | null; revoked_at: string | Date | null;
};

export type PublicApiKey = Omit<ApiKeyRow, "key_hash" | "pepper_source">;

export function publicKey(row: ApiKeyRow): PublicApiKey {
  const { key_hash: _h, pepper_source: _p, ...rest } = row;
  return rest;
}

/** Does the presented key match the stored row? Constant-time compare; a missing pepper never matches. */
export function keyMatches(row: Pick<ApiKeyRow, "key_hash" | "pepper_source">, presented: string, e: NodeJS.ProcessEnv = process.env): boolean {
  const pepper = pepperFor(row.pepper_source === "jwt" ? "jwt" : "env", e);
  if (!pepper) return false;
  const a = Buffer.from(hashApiKey(presented, pepper), "hex");
  const b = Buffer.from(String(row.key_hash ?? ""), "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

const SELECT = `SELECT id::text AS id, name, scope, key_prefix, key_hash, pepper_source, created_by, created_at, last_used_at, revoked_at FROM api_keys`;

export type Authenticated = { ok: true; key: ApiKeyRow } | { ok: false; reason: "malformed" | "unknown" | "revoked" };

/** Finds and checks the key. */
export async function authenticateApiKey(db: Q, presented: string, e: NodeJS.ProcessEnv = process.env): Promise<Authenticated> {
  const parsed = parseApiKey(presented);
  if (!parsed) return { ok: false, reason: "malformed" };
  const r = await db.query(`${SELECT} WHERE id = $1::uuid LIMIT 1`, [parsed.id]);
  const row = r.rows[0] as ApiKeyRow | undefined;
  if (!row || !keyMatches(row, presented.trim(), e)) return { ok: false, reason: "unknown" };
  if (row.revoked_at) return { ok: false, reason: "revoked" };
  return { ok: true, key: row };
}

/** Records use, at most once a minute per key (so a busy integration is not a write per request). */
export async function touchApiKey(db: Q, id: string): Promise<void> {
  await db.query(
    `UPDATE api_keys SET last_used_at = now() WHERE id = $1::uuid AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [id],
  );
}

export async function listApiKeys(db: Q): Promise<PublicApiKey[]> {
  const r = await db.query(`${SELECT} ORDER BY revoked_at IS NOT NULL, created_at DESC LIMIT 200`);
  return (r.rows as ApiKeyRow[]).map(publicKey);
}

export async function countActiveKeys(db: Q): Promise<number> {
  const r = await db.query(`SELECT count(*)::int AS n FROM api_keys WHERE revoked_at IS NULL`);
  return Number(r.rows[0]?.n ?? 0) || 0;
}

export async function insertApiKey(db: Q, k: NewKey, name: string, scope: ApiKeyScope, by: string | null): Promise<PublicApiKey> {
  const r = await db.query(
    `INSERT INTO api_keys (id, name, scope, key_prefix, key_hash, pepper_source, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
     RETURNING id::text AS id, name, scope, key_prefix, key_hash, pepper_source, created_by, created_at, last_used_at, revoked_at`,
    [k.id, name, scope, k.key_prefix, k.key_hash, k.pepper_source, by],
  );
  return publicKey(r.rows[0] as ApiKeyRow);
}

export async function revokeApiKey(db: Q, id: string, by: string | null): Promise<PublicApiKey | null> {
  const r = await db.query(
    `UPDATE api_keys SET revoked_at = now(), revoked_by = $2 WHERE id = $1::uuid AND revoked_at IS NULL
     RETURNING id::text AS id, name, scope, key_prefix, key_hash, pepper_source, created_by, created_at, last_used_at, revoked_at`,
    [id, by],
  );
  return r.rows[0] ? publicKey(r.rows[0] as ApiKeyRow) : null;
}

/** Writes need a read_write key. */
export function scopeAllows(scope: string, method: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return scope === "read" || scope === "read_write";
  return scope === "read_write";
}
