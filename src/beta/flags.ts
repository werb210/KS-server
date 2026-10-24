// KS_SERVER_BETA_v1 - beta feature flags for this copy.
//
// Keystone operations (KS-Ops) owns the beta catalogue and who is in each beta. It sends this copy its view of the
// catalogue with the plan push (PUT /api/plan { beta_features: [...] }) and in the answer to a join or leave, and it is
// stored in licensee_plan.beta_features. Gate a code path with:
//
//   if (await isEnabled("ai_call_notes")) { ... }          // anywhere on the server
//   router.post("/x", requireBeta("ai_call_notes"), ...)    // a route: 404 while the flag is off
//
// The portal and the client read the same flags from GET /api/beta/flags (enabled keys only) and, for admins,
// GET /api/beta/features (the whole list for the Labs page). A read failure means "off" (logged), never an error.
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { pool } from "../db.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";

export type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const BETA_STATUSES = ["private_beta", "public_beta", "ga", "retired"] as const;
export type BetaStatus = (typeof BETA_STATUSES)[number];
export const BETA_KEY_RE = /^[a-z][a-z0-9_]{1,62}$/;
export const MAX_FEATURES = 200;

export type BetaFeature = {
  key: string;
  name: string;
  description: string;
  status: BetaStatus;
  enabled: boolean;
  enrolled: boolean;
  can_join: boolean;
  can_leave: boolean;
  feedback_url: string | null;
  docs_url: string | null;
};

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const httpsOrNull = (v: unknown): string | null => (typeof v === "string" && /^https:\/\/\S+$/i.test(v) && v.length <= 500 ? v : null);

/** One pushed item as a BetaFeature, or null when it is not one (unknown keys and fields are dropped). */
export function normaliseFeature(raw: unknown): BetaFeature | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const key = str(r.key, 63);
  if (!BETA_KEY_RE.test(key)) return null;
  const status = (BETA_STATUSES as readonly unknown[]).includes(r.status) ? (r.status as BetaStatus) : null;
  if (!status || status === "retired") return null;
  return {
    key,
    name: str(r.name, 120) || key,
    description: str(r.description, 2000),
    status,
    enabled: r.enabled === true,
    enrolled: r.enrolled === true,
    can_join: r.can_join === true,
    can_leave: r.can_leave === true,
    feedback_url: httpsOrNull(r.feedback_url),
    docs_url: httpsOrNull(r.docs_url),
  };
}

/** The stored jsonb (or anything else) as a clean list. */
export function normaliseFeatures(raw: unknown): BetaFeature[] {
  let v: unknown = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { v = null; }
  }
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: BetaFeature[] = [];
  for (const item of v.slice(0, MAX_FEATURES)) {
    const f = normaliseFeature(item);
    if (f && !seen.has(f.key)) { seen.add(f.key); out.push(f); }
  }
  return out;
}

/** Validates PUT /api/plan { beta_features }: an array (an empty one switches everything off). */
export function parseBetaPatch(raw: unknown): { ok: true; value: BetaFeature[] | undefined } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw) || raw.length > MAX_FEATURES) return { ok: false };
  return { ok: true, value: normaliseFeatures(raw) };
}

export const enabledKeys = (features: BetaFeature[]): string[] => features.filter((f) => f.enabled).map((f) => f.key);

const CACHE_MS = 30_000;
const FAILED_CACHE_MS = 10_000;
let cache: { at: number; ttl: number; value: BetaFeature[] } | null = null;

export function clearBetaCache(): void {
  cache = null;
}

const SELECT_SQL = "SELECT beta_features FROM licensee_plan WHERE id = 1";
const defaultDb = (): Q => pool as unknown as Q;

/** This copy's beta features, cached for 30 s. A read failure is logged and means "nothing on" for 10 s. */
export async function getBetaFeatures(db: Q = defaultDb(), nowMs = Date.now()): Promise<BetaFeature[]> {
  if (cache && nowMs - cache.at < cache.ttl) return cache.value;
  try {
    const r = await db.query(SELECT_SQL);
    const value = normaliseFeatures(r?.rows?.[0]?.beta_features);
    cache = { at: nowMs, ttl: CACHE_MS, value };
    return value;
  } catch (err) {
    const value = logWarnSwallowed<BetaFeature[]>(err, "beta/flags.ts:getBetaFeatures", []);
    cache = { at: nowMs, ttl: FAILED_CACHE_MS, value };
    return value;
  }
}

/** Is this beta feature on for this copy now? */
export async function isEnabled(flag: string, db: Q = defaultDb()): Promise<boolean> {
  return (await getBetaFeatures(db)).some((f) => f.key === flag && f.enabled);
}

/** Replaces the stored list (what KS-Ops sent is the whole truth). */
export async function setBetaFeatures(db: Q, features: BetaFeature[]): Promise<BetaFeature[]> {
  await db.query(`INSERT INTO licensee_plan (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  await db.query(
    `UPDATE licensee_plan SET beta_features = $1::jsonb, beta_features_synced_at = now() WHERE id = 1`,
    [JSON.stringify(features)],
  );
  clearBetaCache();
  return features;
}

/** Route gate: 404 { ok:false, error:"not_found" } unless the flag is on - an off beta does not exist. */
export function requireBeta(flag: string, dbOverride?: Q): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      if (!(await isEnabled(flag, dbOverride ?? defaultDb()))) {
        res.status(404).json({ ok: false, error: "not_found" });
        return;
      }
      next();
    })().catch(next);
  };
}
