// KS_SERVER_v6_PLANS - what GET /api/plan returns.
import {
  FEATURES, allowancesFor, effectivePlan, featuresFor, storageSummary, trialDaysLeft, trialStatus,
  type PlanState, type StorageSummary,
} from "./catalogue.js";
import { getPlanState, trialUsage, type Q } from "./state.js";
import { seatCount, storageUsedBytes } from "./storage.js";

export async function storageFor(db: Q, state: PlanState, now: Date = new Date()): Promise<StorageSummary> {
  const [used, seats] = await Promise.all([storageUsedBytes(db), seatCount(db)]);
  return storageSummary(used, seats, allowancesFor(state, now).storage_gb_per_seat, state.extra_storage_blocks);
}

export async function planOverview(db: Q, now: Date = new Date()) {
  const state = await getPlanState(db, now.getTime());
  const [usage, storage] = await Promise.all([trialUsage(db), storageFor(db, state, now)]);
  const eff = effectivePlan(state, now);
  return {
    ok: true as const,
    plan: state.plan,
    effective_plan: eff,
    trial: {
      status: trialStatus(state, now),
      started_at: state.trial_started_at ? state.trial_started_at.toISOString() : null,
      ends_at: state.trial_ends_at ? state.trial_ends_at.toISOString() : null,
      days_left: trialDaysLeft(state, now),
    },
    features: featuresFor(eff),
    catalogue: FEATURES.map((f) => ({ key: f.key, label: f.label, plan: f.plan })),
    allowances: allowancesFor(state, now),
    storage,
    trial_usage: usage,
  };
}
