// KS_SERVER_v22_KYC - ID-verification usage. One completed vendor check (Entrust IDV document + selfie, whatever the
// result) is one usage event of kind 'id_check' (src/kyc/service.ts recordIdCheckUsage). Manual reviews are free.
// Each month includes some checks per brokerage (not per seat); the rest are overage, never blocked, billed by Keystone
// operations on the next bill like extra minutes and texts. Mirrors KS-Ops src/pricing.ts ID_CHECKS.
import { effectivePlan, trialActive, type Plan, type PlanState } from "./catalogue.js";
import type { Q } from "./state.js";

export const ID_CHECKS = {
  /** Checks included each month, per brokerage. Starter has no ID verification (growth and up). */
  included: { starter: 0, growth: 10, pro: 30 } as Record<Plan, number>,
  /** During the in-app Pro trial. */
  trial_included: 5,
  /** Each check over the included number, CAD. */
  overage_price: 4,
} as const;

// $1 = period start, $2 = period end
export const ID_CHECKS_SQL = `SELECT COALESCE(SUM(quantity), 0)::bigint AS id_checks
  FROM usage_events WHERE kind = 'id_check' AND occurred_at >= $1 AND occurred_at < $2`;

export function idChecksIncluded(state: PlanState, at: Date): number {
  if (trialActive(state, at)) return Math.max(ID_CHECKS.trial_included, ID_CHECKS.included[state.plan]);
  return ID_CHECKS.included[effectivePlan(state, at)];
}

export type IdCheckUsage = { id_checks: number; id_checks_included: number; overage_id_checks: number };

export async function idCheckUsage(db: Q, bounds: { start: Date; end: Date }, state: PlanState, at: Date): Promise<IdCheckUsage> {
  const r = await db.query(ID_CHECKS_SQL, [bounds.start.toISOString(), bounds.end.toISOString()]);
  const used = Number(r.rows[0]?.id_checks ?? 0) || 0;
  const included = idChecksIncluded(state, at);
  return { id_checks: used, id_checks_included: included, overage_id_checks: Math.max(0, used - included) };
}
