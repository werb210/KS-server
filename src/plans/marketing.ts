// KS_SERVER_MARKETING_ADDON - what each plan can do in marketing, what the Marketing add-on adds, and the e-signing
// allowance (Todd, Oct 26). Pure: no database. Prices are CAD.
//
// Every plan markets to its own client list at the plan's limits. The Marketing add-on ($49 a month, flat, one per
// brokerage, any plan - Pro does not include it) raises the limits and adds the advanced tools. Both trials (the
// in-app Pro trial and the staff-started free trial) include the add-on for their whole length.
//
// Advanced tools (the ones the add-on adds) are used by Admins plus up to MARKETING_SEATS people with the Marketing
// role. A tool a plan already includes (session replay on Growth and Pro, the full Google Ads tools on Pro) is used as
// before, without that limit.
import { effectivePlan, planIncludes, trialActive, type Plan, type PlanState } from "./catalogue.js";

export type MarketingLimits = {
  /** Campaign emails a month, per brokerage (sent by blasts, text fallbacks and sequences). */
  campaign_emails: number;
  /** People one text campaign may go to. */
  text_to_many: number;
  /** Sequences running at once. null = unlimited. */
  sequences: number | null;
  /** How far back visitor tracking is shown, in days. null = full history. */
  visitor_history_days: number | null;
  /** Website lead forms. null = unlimited. */
  lead_forms: number | null;
};

export const MARKETING_LIMITS: Record<Plan, MarketingLimits> = {
  starter: { campaign_emails: 500, text_to_many: 50, sequences: 2, visitor_history_days: 30, lead_forms: 1 },
  growth: { campaign_emails: 1000, text_to_many: 250, sequences: 5, visitor_history_days: 90, lead_forms: 1 },
  pro: { campaign_emails: 2500, text_to_many: 500, sequences: 10, visitor_history_days: 365, lead_forms: 1 },
};

export const MARKETING_ADDON = {
  key: "marketing",
  name: "Marketing add-on",
  /** CAD a month, flat, one per brokerage. */
  price: 49,
  /** Added to the plan's campaign emails each month. */
  extra_campaign_emails: 10_000,
  /** Over the allowance (add-on only): $10 for each 10,000, or part of it, on the next month's bill. */
  campaign_email_block: 10_000,
  campaign_email_block_price: 10,
  /** Marketing texts a month that do not count against the plan's texts. */
  bonus_marketing_texts: 1000,
  text_to_many: 1000,
  sequences: null,
  visitor_history_days: null,
  lead_forms: null,
  /** People with the Marketing role who may use the advanced tools (Admins are not counted). */
  marketing_seats: 3,
} as const;

/** E-signing: every subscription includes 4 signings a month, whatever the plan or seat count. A signing is one
 *  signature request sent to one signer. Each one after that is $2.50 on the next month's bill. Never blocked. */
export const SIGNINGS = { included: 4, overage_price: 2.5 } as const;

export const MARKETING_SEATS = MARKETING_ADDON.marketing_seats;

/** The advanced tools. "Via plan" means the plan itself already has it (no add-on, no Marketing-seat limit). */
export const MARKETING_TOOLS = [
  "website_kit",          // unlimited lead forms, the AI chat widget and the tracking script for the brokerage's own site
  "session_replay",       // session replay of website visits (Growth and Pro already have it)
  "full_visitor_history", // visitor tracking without the plan's history limit
  "google_ads_full",      // attribution, ad-waste, Customer Match, Monday ads email, AI ads suggestions (Pro has it)
  "lead_scoring",
  "ab_test",              // subject-line A/B test
  "send_time",            // send at each person's best time
  "funded_report",        // the campaign report with applications and funded deals
] as const;
export type MarketingTool = (typeof MARKETING_TOOLS)[number];

export function isMarketingTool(v: unknown): v is MarketingTool {
  return typeof v === "string" && (MARKETING_TOOLS as readonly string[]).includes(v);
}

export const MARKETING_TOOL_LABELS: Record<MarketingTool, string> = {
  website_kit: "Website kit: unlimited lead forms, AI chat widget and tracking script",
  session_replay: "Session replay of website visits",
  full_visitor_history: "Full visitor history",
  google_ads_full: "Google Ads tools: attribution, ad-waste report, Customer Match, Monday ads email and AI ads suggestions",
  lead_scoring: "Lead scoring",
  ab_test: "Subject-line A/B test",
  send_time: "Send at each person's best time",
  funded_report: "Campaign report with applications and funded deals",
};

/** Is the Marketing add-on in force: bought (pushed by Keystone operations), or a trial is running. */
export function marketingAddonActive(s: PlanState, now: Date = new Date()): boolean {
  if (s.addons?.marketing === true) return true;
  return marketingAddonViaTrial(s, now);
}

/** Only because of a trial: the in-app Pro trial, or the staff free trial (service status "trial"). */
export function marketingAddonViaTrial(s: PlanState, now: Date = new Date()): boolean {
  return trialActive(s, now) || s.service_status === "trial";
}

/** The plan a staff free trial or an in-app trial behaves as for marketing limits. */
function limitsPlan(s: PlanState, now: Date): Plan {
  return effectivePlan(s, now);
}

export type EffectiveMarketingLimits = MarketingLimits & {
  plan_campaign_emails: number;
  bonus_marketing_texts: number;
  addon: boolean;
};

/** The limits in force now: the plan's, or with the add-on the add-on's (campaign emails are the plan's plus 10,000). */
export function marketingLimitsFor(s: PlanState, now: Date = new Date()): EffectiveMarketingLimits {
  const base = MARKETING_LIMITS[limitsPlan(s, now)];
  if (!marketingAddonActive(s, now)) return { ...base, plan_campaign_emails: base.campaign_emails, bonus_marketing_texts: 0, addon: false };
  return {
    campaign_emails: base.campaign_emails + MARKETING_ADDON.extra_campaign_emails,
    plan_campaign_emails: base.campaign_emails,
    text_to_many: MARKETING_ADDON.text_to_many,
    sequences: MARKETING_ADDON.sequences,
    visitor_history_days: MARKETING_ADDON.visitor_history_days,
    lead_forms: MARKETING_ADDON.lead_forms,
    bonus_marketing_texts: MARKETING_ADDON.bonus_marketing_texts,
    addon: true,
  };
}

/** Does the plan (or its running trial) already include the tool, without the add-on? */
export function toolViaPlan(tool: MarketingTool, s: PlanState, now: Date = new Date()): boolean {
  const plan = effectivePlan(s, now);
  if (tool === "session_replay") return planIncludes(plan, "session_replay");
  if (tool === "google_ads_full") return planIncludes(plan, "ad_attribution");
  return false;
}

export type ToolAccess =
  | { allowed: true; via: "plan" | "addon" }
  | { allowed: false; reason: "addon_required" | "seat_required" };

/**
 * May this person use the tool? Via the plan: yes. Via the add-on: Admins, and Marketing users who hold one of the
 * MARKETING_SEATS marketing seats (marketingSeat). Without either: the add-on is required.
 */
export function toolAccess(
  tool: MarketingTool,
  s: PlanState,
  person: { role: string | null | undefined; marketingSeat: boolean },
  now: Date = new Date(),
): ToolAccess {
  if (toolViaPlan(tool, s, now)) return { allowed: true, via: "plan" };
  if (!marketingAddonActive(s, now)) return { allowed: false, reason: "addon_required" };
  if (person.role === "Admin") return { allowed: true, via: "addon" };
  if (person.role === "Marketing" && person.marketingSeat) return { allowed: true, via: "addon" };
  return { allowed: false, reason: "seat_required" };
}

/** Campaign emails over the allowance are billed only with the add-on, in blocks of 10,000 (a part block is a block). */
export function campaignEmailOverage(used: number, allowance: number, addon: boolean): { emails: number; blocks: number; amount: number } {
  const emails = addon ? Math.max(0, Math.floor(Number(used) || 0) - Math.floor(Number(allowance) || 0)) : 0;
  const blocks = emails > 0 ? Math.ceil(emails / MARKETING_ADDON.campaign_email_block) : 0;
  return { emails, blocks, amount: blocks * MARKETING_ADDON.campaign_email_block_price };
}

/** Signings over the 4 included, and what they add to the next bill. */
export function signingOverage(used: number): { signings: number; amount: number } {
  const signings = Math.max(0, Math.floor(Number(used) || 0) - SIGNINGS.included);
  return { signings, amount: Math.round(signings * SIGNINGS.overage_price * 100) / 100 };
}

/** The bonus marketing texts that cover texts over the plan's allowance (only marketing texts, at most 1,000). */
export function bonusTextsApplied(marketingTexts: number, addon: boolean): number {
  return addon ? Math.min(Math.max(0, Math.floor(Number(marketingTexts) || 0)), MARKETING_ADDON.bonus_marketing_texts) : 0;
}

/** Plain-English "what the add-on adds" lines, for the Plan page and emails. */
export function addonSummary(): string[] {
  return [
    `${MARKETING_ADDON.extra_campaign_emails.toLocaleString("en-CA")} campaign emails a month on top of your plan's, then $${MARKETING_ADDON.campaign_email_block_price} per ${MARKETING_ADDON.campaign_email_block.toLocaleString("en-CA")} on next month's bill`,
    `${MARKETING_ADDON.bonus_marketing_texts.toLocaleString("en-CA")} bonus marketing texts a month`,
    `Send one text to up to ${MARKETING_ADDON.text_to_many.toLocaleString("en-CA")} people at a time`,
    "Unlimited sequences running at once",
    "Unlimited website lead forms, plus an AI chat widget and tracking script for your own website",
    "Full visitor history and session replay",
    "Full Google Ads tools: attribution, ad-waste report, Customer Match, Monday ads email and AI ads suggestions",
    "Lead scoring",
    "Subject-line A/B test and send-time choice",
    "Campaign report with applications and funded deals by campaign",
  ];
}
