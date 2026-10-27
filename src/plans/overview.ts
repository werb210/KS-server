// KS_SERVER_v6_PLANS - what GET /api/plan returns.
import {
  FEATURES, allowancesFor, effectivePlan, featuresFor, storageSummary, trialDaysLeft, trialStatus,
  type PlanState, type StorageSummary,
} from "./catalogue.js";
import { getPlanState, trialUsage, type Q } from "./state.js";
import { seatCount, storageUsedBytes } from "./storage.js";
import { planUsageBlock } from "./usage.js"; // KS_SERVER_v8_USAGE
import {
  MARKETING_ADDON, MARKETING_LIMITS, MARKETING_SEATS, MARKETING_TOOLS, SIGNINGS, addonSummary, marketingAddonActive,
  marketingAddonViaTrial, marketingLimitsFor, toolViaPlan,
} from "./marketing.js"; // KS_SERVER_MARKETING_ADDON

/** KS_SERVER_MARKETING_ADDON - the marketing block of GET /api/plan: the add-on, the limits in force, every plan's limits
 *  for the comparison, and which advanced tools this brokerage has (and how). */
export function marketingBlock(state: PlanState, now: Date = new Date()) {
  const active = marketingAddonActive(state, now);
  const purchased = state.addons?.marketing === true;
  return {
    addon: {
      key: MARKETING_ADDON.key,
      name: MARKETING_ADDON.name,
      price: MARKETING_ADDON.price,
      currency: "CAD",
      active,
      purchased,
      via: purchased ? "purchase" : active && marketingAddonViaTrial(state, now) ? "trial" : null,
      adds: addonSummary(),
      marketing_seats: MARKETING_SEATS,
      limits: {
        extra_campaign_emails: MARKETING_ADDON.extra_campaign_emails,
        campaign_email_block: MARKETING_ADDON.campaign_email_block,
        campaign_email_block_price: MARKETING_ADDON.campaign_email_block_price,
        bonus_marketing_texts: MARKETING_ADDON.bonus_marketing_texts,
        text_to_many: MARKETING_ADDON.text_to_many,
        sequences: MARKETING_ADDON.sequences,
        visitor_history_days: MARKETING_ADDON.visitor_history_days,
        lead_forms: MARKETING_ADDON.lead_forms,
      },
    },
    limits: marketingLimitsFor(state, now),
    plan_limits: { ...MARKETING_LIMITS },
    tools: Object.fromEntries(MARKETING_TOOLS.map((t) => [t, toolViaPlan(t, state, now) ? "plan" : active ? "addon" : null])),
  };
}

export async function storageFor(db: Q, state: PlanState, now: Date = new Date()): Promise<StorageSummary> {
  const [used, seats] = await Promise.all([storageUsedBytes(db), seatCount(db)]);
  return storageSummary(used, seats, allowancesFor(state, now).storage_gb_per_seat, state.extra_storage_blocks);
}

export async function planOverview(db: Q, now: Date = new Date()) {
  const state = await getPlanState(db, now.getTime());
  const [usage, storage, monthly] = await Promise.all([trialUsage(db), storageFor(db, state, now), planUsageBlock(db, state, now)]);
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
    // KS_SERVER_v8_SERVICE_STATUS - suspended / cancelled stop the service; cancelled data is purged 180 days on.
    service_status: state.service_status ?? "active",
    cancelled_at: state.cancelled_at ? state.cancelled_at.toISOString() : null,
    purge_after: state.cancelled_at ? new Date(state.cancelled_at.getTime() + 180 * 86_400_000).toISOString() : null,
    usage: monthly, // KS_SERVER_v8_USAGE - this month's minutes, texts, assistant chats, storage vs pooled allowances
    // KS_SERVER_BANK_CONNECT_ADDON - only the add-ons that are ON ({} when none). Off add-ons are never named.
    addons: { ...(state.addons ?? {}) },
    marketing: marketingBlock(state, now), // KS_SERVER_MARKETING_ADDON
    signings: { included: SIGNINGS.included, overage_price: SIGNINGS.overage_price, currency: "CAD" }, // KS_SERVER_MARKETING_ADDON
  };
}
