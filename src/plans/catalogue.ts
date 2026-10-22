// KS_SERVER_v6_PLANS - what each plan includes, and the pure rules for the one free trial.
//
// Three plans: starter < growth < pro. A starter brokerage may start ONE 14-day trial by itself; while it runs the
// copy behaves as pro for features, assistant chats and storage, but calls/texts stay at starter's allowance plus a
// small trial bonus. Growth and pro brokerages are not offered a trial. Nothing here touches the database.

export const PLANS = ["starter", "growth", "pro"] as const;
export type Plan = (typeof PLANS)[number];
export type TrialStatus = "available" | "active" | "used" | "not_offered";

export const TRIAL_DAYS = 14;
export const TRIAL_WARNING_DAYS = 3;
export const GB = 1024 ** 3;
export const STORAGE_BLOCK_GB = 50;
export const STORAGE_BLOCK_PRICE = "$10/month";

export function isPlan(v: unknown): v is Plan {
  return typeof v === "string" && (PLANS as readonly string[]).includes(v);
}

export function planRank(p: Plan): number {
  return PLANS.indexOf(p);
}

export type FeatureDef = { key: string; label: string; plan: Plan };

export const FEATURES: readonly FeatureDef[] = [
  // starter
  { key: "contacts", label: "Contacts", plan: "starter" },
  { key: "pipeline", label: "Pipeline", plan: "starter" },
  { key: "client_portal", label: "Branded client portal and application wizard", plan: "starter" },
  { key: "iphone_dialler", label: "iPhone dialler", plan: "starter" },
  { key: "office_sync", label: "Office 365 / Google sync", plan: "starter" },
  { key: "ai_assistant", label: "AI assistant", plan: "starter" },
  // KS_SERVER_v9_PORTAL_PLANS - lender portal on every plan (Todd, Oct 22): lenders see files and send deals they can't place.
  { key: "lender_portal", label: "Lender portal (lenders can send you deals they can't place)", plan: "starter" },
  // growth
  { key: "call_recording", label: "Call recording", plan: "growth" },
  { key: "call_summaries", label: "AI call summaries", plan: "growth" },
  { key: "voicemail_transcription", label: "Voicemail transcription", plan: "growth" },
  { key: "watch_ipad_apps", label: "Apple Watch and iPad apps", plan: "growth" },
  { key: "templates", label: "Message templates", plan: "growth" },
  { key: "referrer_portal", label: "Referrer portal", plan: "growth" },
  // KS_SERVER_v9_PORTAL_PLANS - co-broker portal (broker sign-up, files, split agreement) growth and up.
  { key: "broker_portal", label: "Broker portal", plan: "growth" },
  // KS_SERVER_v7_NO_REPORTS_ON_STARTER - no reports on starter (Todd, Oct 22); starter keeps a basic dashboard.
  { key: "full_reports", label: "Reports", plan: "growth" },
  { key: "visitor_tracking", label: "Website visitor tracking", plan: "growth" },
  { key: "toll_free_number", label: "Toll-free number", plan: "growth" },
  // pro
  { key: "multiple_lines", label: "Multiple business lines", plan: "pro" },
  { key: "bank_connect", label: "Bank connect", plan: "pro" },
  { key: "ad_attribution", label: "Ad attribution", plan: "pro" },
  { key: "api_access", label: "API access", plan: "pro" },
  { key: "sso", label: "Single sign-on", plan: "pro" },
  // KS_SERVER_v9_FRAUD - the fraud-protection suite (Todd, Oct 23): starter = 1, 2, 4, 5; growth adds 6, 7, 8;
  // pro has all 16. The key number matches the feature list in src/fraud/catalogue.ts.
  { key: "fraud_1", label: "Document tamper scan", plan: "starter" },
  { key: "fraud_2", label: "Bank statement math check", plan: "starter" },
  { key: "fraud_4", label: "Duplicate document check", plan: "starter" },
  { key: "fraud_5", label: "Revenue vs bank deposits", plan: "starter" },
  { key: "fraud_6", label: "Business reality check", plan: "growth" },
  { key: "fraud_7", label: "Phone and email risk", plan: "growth" },
  { key: "fraud_8", label: "ID checks", plan: "growth" },
  { key: "fraud_3", label: "Statement vs live bank data", plan: "pro" },
  { key: "fraud_9", label: "Device and location check", plan: "pro" },
  { key: "fraud_10", label: "Application behaviour signals", plan: "pro" },
  { key: "fraud_11", label: "Loan stacking detector", plan: "pro" },
  { key: "fraud_12", label: "Fraud network map", plan: "pro" },
  { key: "fraud_13", label: "Shared fraud watchlist", plan: "pro" },
  { key: "fraud_14", label: "Inside-job alerts", plan: "pro" },
  { key: "fraud_15", label: "Call voice check", plan: "pro" },
  { key: "fraud_16", label: "Fraud score and lender pre-screen", plan: "pro" },
];

export type FeatureKey = string;

/** KS_SERVER_v7_NO_REPORTS_ON_STARTER - the Dashboard sections every plan keeps. Every other report card, the Reports
 *  page, goals, commission tracking and the mobile-apps report need full_reports (growth and up). */
export const STARTER_DASHBOARD_REPORTS: ReadonlySet<string> = new Set([
  "dash_kpis", "dash_pipeline", "dash_dropoffs", "dash_doc_issues", "dash_team",
]);

export function featureDef(key: string): FeatureDef | undefined {
  return FEATURES.find((f) => f.key === key);
}

/** Does this plan include the feature? Unknown keys are never included. */
export function planIncludes(plan: Plan, key: string): boolean {
  const def = featureDef(key);
  return Boolean(def) && planRank(plan) >= planRank(def!.plan);
}

export function featuresFor(plan: Plan): Record<string, boolean> {
  return Object.fromEntries(FEATURES.map((f) => [f.key, planIncludes(plan, f.key)]));
}

export type PlanAllowance = {
  minutes_per_seat: number;
  texts_per_seat: number;
  /** null = unlimited */
  assistant_chats: number | null;
  storage_gb_per_seat: number;
};

export const ALLOWANCES: Record<Plan, PlanAllowance> = {
  starter: { minutes_per_seat: 50, texts_per_seat: 100, assistant_chats: 200, storage_gb_per_seat: 10 },
  growth: { minutes_per_seat: 500, texts_per_seat: 500, assistant_chats: 1000, storage_gb_per_seat: 25 },
  pro: { minutes_per_seat: 1500, texts_per_seat: 1500, assistant_chats: null, storage_gb_per_seat: 50 },
};

function envInt(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const n = Number(String(env[name] ?? "").trim());
  return String(env[name] ?? "").trim() !== "" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function trialBonus(env: NodeJS.ProcessEnv = process.env): { minutes: number; texts: number } {
  return { minutes: envInt("KS_TRIAL_BONUS_MINUTES", 100, env), texts: envInt("KS_TRIAL_BONUS_TEXTS", 100, env) };
}

/** KS_PLAN when it names a plan, else pro (copies made before plans existed keep every feature). */
export function defaultPlan(env: NodeJS.ProcessEnv = process.env): Plan {
  const v = String(env.KS_PLAN ?? "").trim().toLowerCase();
  return isPlan(v) ? v : "pro";
}

/** KS_SERVER_v8_SERVICE_STATUS - set by Keystone operations. suspended / cancelled stop the service. */
export const SERVICE_STATUSES = ["trial", "active", "past_due", "suspended", "cancelled"] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export function isServiceStatus(v: unknown): v is ServiceStatus {
  return typeof v === "string" && (SERVICE_STATUSES as readonly string[]).includes(v);
}

/** suspended and cancelled: every service is stopped (sign-in, the Plan page and Help stay). */
export function serviceBlocked(status: ServiceStatus | undefined): boolean {
  return status === "suspended" || status === "cancelled";
}

export type PlanState = {
  plan: Plan;
  trial_started_at: Date | null;
  trial_ends_at: Date | null;
  extra_storage_blocks: number;
  /** KS_SERVER_v8_SERVICE_STATUS - missing = active */
  service_status?: ServiceStatus;
  cancelled_at?: Date | null;
};

export function trialActive(s: PlanState, now: Date = new Date()): boolean {
  return s.plan === "starter" && !!s.trial_started_at && !!s.trial_ends_at && now.getTime() < s.trial_ends_at.getTime();
}

export function trialStatus(s: PlanState, now: Date = new Date()): TrialStatus {
  if (trialActive(s, now)) return "active";
  if (s.plan !== "starter") return "not_offered";
  return s.trial_started_at ? "used" : "available";
}

/** The plan the copy behaves as right now: pro while a trial runs, else the stored plan. */
export function effectivePlan(s: PlanState, now: Date = new Date()): Plan {
  return trialActive(s, now) ? "pro" : s.plan;
}

/** Whole days left in an active trial (rounded up), else null. */
export function trialDaysLeft(s: PlanState, now: Date = new Date()): number | null {
  if (!trialActive(s, now)) return null;
  return Math.max(0, Math.ceil((s.trial_ends_at!.getTime() - now.getTime()) / 86_400_000));
}

export type EffectiveAllowances = PlanAllowance & { trial_bonus_minutes: number; trial_bonus_texts: number };

/**
 * The allowances in force. During a trial: features, assistant chats and storage are pro's; minutes and texts are
 * starter's plus the trial bonus (the bonus is already included in minutes_per_seat / texts_per_seat, and reported
 * separately). Outside a trial the bonus is 0.
 */
export function allowancesFor(s: PlanState, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): EffectiveAllowances {
  if (!trialActive(s, now)) return { ...ALLOWANCES[s.plan], trial_bonus_minutes: 0, trial_bonus_texts: 0 };
  const bonus = trialBonus(env);
  const starter = ALLOWANCES.starter;
  const pro = ALLOWANCES.pro;
  return {
    minutes_per_seat: starter.minutes_per_seat + bonus.minutes,
    texts_per_seat: starter.texts_per_seat + bonus.texts,
    assistant_chats: pro.assistant_chats,
    storage_gb_per_seat: pro.storage_gb_per_seat,
    trial_bonus_minutes: bonus.minutes,
    trial_bonus_texts: bonus.texts,
  };
}

export type FeatureCheck =
  | { allowed: true; viaTrial: boolean }
  | { allowed: false; required_plan: Plan; trial_available: boolean };

/** May the copy use this feature now? viaTrial = allowed only because a trial is running. */
export function checkFeature(s: PlanState, key: string, now: Date = new Date()): FeatureCheck {
  const def = featureDef(key);
  if (!def) return { allowed: false, required_plan: "pro", trial_available: false };
  if (planIncludes(s.plan, key)) return { allowed: true, viaTrial: false };
  if (planIncludes(effectivePlan(s, now), key)) return { allowed: true, viaTrial: true };
  return { allowed: false, required_plan: def.plan, trial_available: trialStatus(s, now) === "available" };
}

export type StorageSummary = {
  used_bytes: number;
  allowance_bytes: number;
  extra_blocks: number;
  seats: number;
  percent: number;
};

/** Pooled storage: seats x GB per seat, plus 50 GB per extra block. Seats is at least 1. */
export function storageSummary(usedBytes: number, seats: number, gbPerSeat: number, extraBlocks: number): StorageSummary {
  const s = Math.max(1, Math.floor(Number(seats) || 0));
  const blocks = Math.max(0, Math.floor(Number(extraBlocks) || 0));
  const used = Math.max(0, Math.floor(Number(usedBytes) || 0));
  const allowance = s * gbPerSeat * GB + blocks * STORAGE_BLOCK_GB * GB;
  const percent = allowance > 0 ? Math.round((used / allowance) * 1000) / 10 : 0;
  return { used_bytes: used, allowance_bytes: allowance, extra_blocks: blocks, seats: s, percent };
}

/** Which storage notice is due: 100 beats 80. Also which markers to clear because usage fell back below them. */
export function storageNoticeDue(percent: number, sent80: boolean, sent100: boolean)
  : { send: 80 | 100 | null; clear80: boolean; clear100: boolean } {
  const clear100 = sent100 && percent < 100;
  const clear80 = sent80 && percent < 80;
  if (percent >= 100 && !sent100) return { send: 100, clear80: false, clear100: false };
  if (percent >= 80 && percent < 100 && !sent80) return { send: 80, clear80: false, clear100 };
  return { send: null, clear80, clear100 };
}
