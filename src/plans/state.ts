// KS_SERVER_v6_PLANS - the licensee_plan row: read (cached), trial start, ops plan changes, trial feature usage.
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import {
  TRIAL_DAYS, checkFeature, defaultPlan, isPlan, trialStatus, type Plan, type PlanState,
} from "./catalogue.js";

export type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

const CACHE_MS = 30_000;
const FAILED_CACHE_MS = 10_000;
let cache: { at: number; ttl: number; value: PlanState } | null = null;

export function clearPlanCache(): void {
  cache = null;
}

function asDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A row (or nothing) as a PlanState. A missing or unknown plan is the default plan. */
export function rowToState(row: Record<string, unknown> | null | undefined): PlanState {
  const plan = String(row?.plan ?? "").trim().toLowerCase();
  const blocks = Number(row?.extra_storage_blocks ?? 0);
  return {
    plan: isPlan(plan) ? plan : defaultPlan(),
    trial_started_at: asDate(row?.trial_started_at),
    trial_ends_at: asDate(row?.trial_ends_at),
    extra_storage_blocks: Number.isFinite(blocks) && blocks > 0 ? Math.floor(blocks) : 0,
  };
}

const SELECT_PLAN_SQL = `SELECT plan, trial_started_at, trial_ends_at, extra_storage_blocks FROM licensee_plan WHERE id = 1`;

/**
 * The stored plan state, cached for 30 s. If the row cannot be read (table missing before the migration ran, database
 * blip) the failure is logged and the default plan applies for 10 s - a read error must not take features away.
 */
export async function getPlanState(db: Q, nowMs = Date.now()): Promise<PlanState> {
  if (cache && nowMs - cache.at < cache.ttl) return cache.value;
  try {
    const r = await db.query(SELECT_PLAN_SQL);
    const value = rowToState(r?.rows?.[0]);
    cache = { at: nowMs, ttl: CACHE_MS, value };
    return value;
  } catch (err) {
    const value = logWarnSwallowed(err, "plans/state.ts:getPlanState", rowToState(null));
    cache = { at: nowMs, ttl: FAILED_CACHE_MS, value };
    return value;
  }
}

/** Reads the row bypassing the cache (for writes and the notices job). */
export async function readPlanRow(db: Q): Promise<Record<string, any> | null> {
  const r = await db.query(
    `SELECT plan, trial_started_at, trial_ends_at, trial_started_by, extra_storage_blocks, updated_at, updated_by,
            trial_warning_sent_at, trial_ended_sent_at, storage_80_sent_at, storage_100_sent_at
       FROM licensee_plan WHERE id = 1`,
  );
  return r.rows[0] ?? null;
}

async function ensureRow(db: Q): Promise<void> {
  await db.query(
    `INSERT INTO licensee_plan (id, plan) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
    [defaultPlan()],
  );
}

export type StartTrialResult =
  | { ok: true; state: PlanState }
  | { ok: false; reason: "active" | "used" | "not_offered" };

/** Starts the one free trial. Atomic: only a starter copy that has never started one gets it. */
export async function startTrial(db: Q, userId: string, now: Date = new Date()): Promise<StartTrialResult> {
  await ensureRow(db);
  const ends = new Date(now.getTime() + TRIAL_DAYS * 86_400_000);
  const r = await db.query(
    `UPDATE licensee_plan
        SET trial_started_at = $1, trial_ends_at = $2, trial_started_by = $3, updated_at = now(), updated_by = $3
      WHERE id = 1 AND plan = 'starter' AND trial_started_at IS NULL
      RETURNING plan, trial_started_at, trial_ends_at, extra_storage_blocks`,
    [now.toISOString(), ends.toISOString(), userId || null],
  );
  clearPlanCache();
  if (r.rows[0]) return { ok: true, state: rowToState(r.rows[0]) };
  const state = rowToState(await readPlanRow(db));
  const status = trialStatus(state, now);
  return { ok: false, reason: status === "available" ? "used" : status };
}

export type SetPlanInput = { plan?: Plan; extra_storage_blocks?: number };

/**
 * Boreal operations sets the plan and/or the extra storage blocks. Moving off starter ends any running trial now
 * (trial_started_at stays, so it is never offered again).
 */
export async function setPlan(db: Q, input: SetPlanInput, by: string, now: Date = new Date()): Promise<PlanState> {
  await ensureRow(db);
  const sets: string[] = ["updated_at = now()", "updated_by = $1"];
  const params: unknown[] = [by];
  if (input.plan) {
    params.push(input.plan);
    sets.push(`plan = $${params.length}`);
    if (input.plan !== "starter") {
      params.push(now.toISOString());
      sets.push(`trial_ends_at = CASE WHEN trial_ends_at IS NOT NULL AND trial_ends_at > $${params.length}::timestamptz THEN $${params.length}::timestamptz ELSE trial_ends_at END`);
      // An upgrade is not "your trial has ended": mark both trial notices as done.
      sets.push("trial_warning_sent_at = CASE WHEN trial_started_at IS NOT NULL THEN COALESCE(trial_warning_sent_at, now()) ELSE trial_warning_sent_at END");
      sets.push("trial_ended_sent_at = CASE WHEN trial_started_at IS NOT NULL THEN COALESCE(trial_ended_sent_at, now()) ELSE trial_ended_sent_at END");
    }
  }
  if (input.extra_storage_blocks !== undefined) {
    params.push(input.extra_storage_blocks);
    sets.push(`extra_storage_blocks = $${params.length}`);
  }
  await db.query(`UPDATE licensee_plan SET ${sets.join(", ")} WHERE id = 1`, params);
  clearPlanCache();
  return rowToState(await readPlanRow(db));
}

/** Counts one use of a feature that is open only because of the trial. Best effort: a failure is logged. */
export async function recordTrialUsage(db: Q, key: string): Promise<void> {
  try {
    await db.query(
      `INSERT INTO plan_trial_feature_usage (feature, uses, first_used_at, last_used_at) VALUES ($1, 1, now(), now())
       ON CONFLICT (feature) DO UPDATE SET uses = plan_trial_feature_usage.uses + 1, last_used_at = now()`,
      [key],
    );
  } catch (err) {
    logWarnSwallowed(err, "plans/state.ts:recordTrialUsage");
  }
}

export async function trialUsage(db: Q): Promise<Record<string, number>> {
  const r = await db.query(`SELECT feature, uses FROM plan_trial_feature_usage ORDER BY uses DESC, feature`);
  return Object.fromEntries(r.rows.map((x: any) => [String(x.feature), Number(x.uses) || 0]));
}

/**
 * For background work (voicemail transcription, automatic call summaries): may the copy use this feature now?
 * Counts the use when it is open only because of the trial.
 */
export async function planAllows(db: Q, key: string, now: Date = new Date()): Promise<boolean> {
  const c = checkFeature(await getPlanState(db, now.getTime()), key, now);
  if (c.allowed && c.viaTrial) await recordTrialUsage(db, key);
  return c.allowed;
}
