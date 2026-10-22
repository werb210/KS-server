// KS_SERVER_v9_FRAUD - storage for check results, the fraud queue and the fraud settings.
import type { Q } from "../plans/state.js";
import { getPlanState } from "../plans/state.js";
import { checkFeature } from "../plans/catalogue.js";
import { FRAUD_CHECKS } from "./catalogue.js";
import { ADDON_FRAUD_CHECKS, hasAddon } from "../plans/addons.js"; // KS_SERVER_BANK_CONNECT_ADDON
import type { CheckResult, FraudStatus, Reason } from "./types.js";

export type ResultRow = {
  application_id: string; check_key: string; subject: string; status: FraudStatus; reasons: Reason[];
  details: Record<string, unknown>; provider: string | null; checked_at: string;
};

export async function upsertResult(db: Q, applicationId: string, checkKey: string, subject: string, r: CheckResult): Promise<void> {
  await db.query(
    `INSERT INTO fraud_check_results (application_id, check_key, subject, status, reasons, details, provider, checked_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, now())
     ON CONFLICT (application_id, check_key, subject) DO UPDATE SET
       status = EXCLUDED.status, reasons = EXCLUDED.reasons, details = EXCLUDED.details,
       provider = EXCLUDED.provider, checked_at = now()`,
    [applicationId, checkKey, subject, r.status, JSON.stringify(r.reasons ?? []), JSON.stringify(r.details ?? {}), r.provider ?? null],
  );
}

export async function listResults(db: Q, applicationId: string): Promise<ResultRow[]> {
  const r = await db.query(
    `SELECT application_id, check_key, subject, status, reasons, details, provider, checked_at
       FROM fraud_check_results WHERE application_id = $1 ORDER BY check_key, subject`,
    [applicationId],
  );
  return r.rows.map((x: any) => ({
    ...x,
    reasons: Array.isArray(x.reasons) ? x.reasons : [],
    details: x.details && typeof x.details === "object" ? x.details : {},
    checked_at: x.checked_at instanceof Date ? x.checked_at.toISOString() : String(x.checked_at),
  }));
}

export async function previousResult(db: Q, applicationId: string, checkKey: string, subject = ""): Promise<ResultRow | null> {
  const r = await db.query(
    `SELECT application_id, check_key, subject, status, reasons, details, provider, checked_at
       FROM fraud_check_results WHERE application_id = $1 AND check_key = $2 AND subject = $3 LIMIT 1`,
    [applicationId, checkKey, subject],
  );
  return (r.rows[0] as ResultRow | undefined) ?? null;
}

/** Ask the worker to (re)run the checks for an application. Idempotent: only moves requested_at forward. */
export async function enqueueFraudRun(db: Q, applicationId: string, reason: string): Promise<void> {
  await db.query(
    `INSERT INTO fraud_queue (application_id, requested_at, reason, next_attempt_at) VALUES ($1, now(), $2, now())
     ON CONFLICT (application_id) DO UPDATE SET requested_at = now(), reason = EXCLUDED.reason,
       next_attempt_at = LEAST(fraud_queue.next_attempt_at, now()), attempts = 0, last_error = NULL`,
    [applicationId, reason.slice(0, 80)],
  );
}

export async function queueStatus(db: Q, applicationId: string): Promise<{ queued: boolean; done_at: string | null; last_error: string | null }> {
  const r = await db.query(`SELECT requested_at, done_at, last_error FROM fraud_queue WHERE application_id = $1`, [applicationId]);
  const row = r.rows[0];
  if (!row) return { queued: false, done_at: null, last_error: null };
  const done = row.done_at ? new Date(row.done_at) : null;
  return { queued: !done || done.getTime() < new Date(row.requested_at).getTime(), done_at: done ? done.toISOString() : null, last_error: row.last_error ?? null };
}

export type FraudSettings = { watchlist_opt_in: boolean; include_prescreen_in_package: boolean; updated_at: string | null };

export async function getFraudSettings(db: Q): Promise<FraudSettings> {
  const r = await db.query(`SELECT watchlist_opt_in, include_prescreen_in_package, updated_at FROM fraud_settings WHERE id = 1`, []);
  const row = r.rows[0];
  return {
    watchlist_opt_in: row?.watchlist_opt_in === true,
    include_prescreen_in_package: row?.include_prescreen_in_package === true,
    updated_at: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

export async function saveFraudSettings(db: Q, patch: Partial<Pick<FraudSettings, "watchlist_opt_in" | "include_prescreen_in_package">>, userId: string): Promise<FraudSettings> {
  await db.query(
    `INSERT INTO fraud_settings (id, watchlist_opt_in, include_prescreen_in_package, updated_by, updated_at)
     VALUES (1, COALESCE($1, false), COALESCE($2, false), $3, now())
     ON CONFLICT (id) DO UPDATE SET
       watchlist_opt_in = COALESCE($1, fraud_settings.watchlist_opt_in),
       include_prescreen_in_package = COALESCE($2, fraud_settings.include_prescreen_in_package),
       updated_by = $3, updated_at = now()`,
    [typeof patch.watchlist_opt_in === "boolean" ? patch.watchlist_opt_in : null, typeof patch.include_prescreen_in_package === "boolean" ? patch.include_prescreen_in_package : null, userId || null],
  );
  return getFraudSettings(db);
}

/** The fraud checks the plan in force (or the running trial) includes. KS_SERVER_BANK_CONNECT_ADDON - an add-on check
 *  (fraud_3) is included only while its add-on is on, whatever the plan; when off it is simply not a check here. */
export async function allowedChecks(db: Q, now = new Date()): Promise<Set<string>> {
  const state = await getPlanState(db, now.getTime());
  return new Set(FRAUD_CHECKS.filter((c) => {
    const addon = ADDON_FRAUD_CHECKS[c.key];
    return addon ? hasAddon(state, addon) : checkFeature(state, c.key, now).allowed;
  }).map((c) => c.key));
}
