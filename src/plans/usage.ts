// KS_SERVER_v8_USAGE - what the brokerage used this calendar month, against its pooled allowances.
//
// A month is a calendar month in the licensee's time zone (licensee settings time_zone, default Alberta). Alberta is
// computed as ALBERTA_TZ (UTC-6 all year, see src/lib/albertaTime.ts), not with the old Edmonton clock changes.
//   minutes          call_logs: every call (inbound and outbound) that lasted > 0 s, each rounded UP to the whole
//                    minute (a 61 s call is 2 minutes), by the call's started_at. Duration is duration_seconds, else
//                    the legacy duration column.
//   texts            usage_events kind 'text': one row per outbound SMS/MMS that Twilio accepted, quantity = segments
//                    Twilio reported (1 when it did not say). Outbound texts are sent from several places and not all
//                    of them keep a record, so each send records itself (recordOutboundText below).
//   assistant_chats  chat_sessions created in the month: each is one conversation started with the AI assistant
//                    (website, client app and staff assistant widgets, and the staff portal's AI page).
//   storage_bytes    the pooled document storage in use right now (./storage.ts).
// Allowances are pooled: per-seat allowance x seats (+ the trial bonus during a trial, already in allowancesFor).
// Minutes and texts are never cut off; what goes over is overage, billed at OVERAGE_RATES.
// KS_SERVER_MARKETING_ADDON - three more meters, per brokerage (usage_events, see ./meters.ts):
//   campaign_emails  the plan's campaign emails (+10,000 with the Marketing add-on). Without the add-on a send stops at
//                    the allowance; with it extra emails are billed at $10 per 10,000 (or part).
//   marketing_texts  marketing texts (also in texts). With the add-on up to 1,000 of them do not count against texts.
//   signings         4 included a month on every plan; each one over is $2.50. Signings are never blocked.
import { brandSettings } from "../licensee/brand.js";
import { brokerageTimeZone } from "../lib/brokerageTime.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import {
  allowancesFor, effectivePlan, storageSummary, trialStatus, type Plan, type PlanState,
} from "./catalogue.js";
import {
  MARKETING_ADDON, SIGNINGS, bonusTextsApplied, campaignEmailOverage, marketingAddonActive, marketingLimitsFor, signingOverage,
} from "./marketing.js";
import { getPlanState, type Q } from "./state.js";
import { seatCount, storageUsedBytes } from "./storage.js";

export const OVERAGE_RATES = {
  minute: 0.04,
  text: 0.03,
  // KS_SERVER_MARKETING_ADDON
  signing: SIGNINGS.overage_price,
  campaign_email_block: MARKETING_ADDON.campaign_email_block_price,
  campaign_email_block_size: MARKETING_ADDON.campaign_email_block,
} as const;

/** The licensee's IANA time zone when it is a valid one, else Alberta. Alberta (the default zone name) is computed as
 *  ALBERTA_TZ, UTC-6 all year. */
export function licenseeTimeZone(raw: unknown = brandSettings().time_zone): string {
  // KS_SETTINGS_PACK_v1_TIME_ZONE - one rule for the whole server (src/lib/brokerageTime.ts).
  return brokerageTimeZone(raw);
}

function parts(d: Date, tz: string): { y: number; m: number; day: number } {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return { y: get("year"), m: get("month"), day: get("day") };
}

/** "YYYY-MM" of the moment in the time zone. */
export function periodOf(d: Date, tz: string = licenseeTimeZone()): string {
  const { y, m } = parts(d, tz);
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" of the moment in the time zone. */
export function localDayOf(d: Date, tz: string = licenseeTimeZone()): string {
  const { y, m, day } = parts(d, tz);
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function isPeriod(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}$/.test(v)) return false;
  const m = Number(v.slice(5));
  return m >= 1 && m <= 12;
}

export function previousPeriod(period: string): string {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** UTC instant at which local wall-clock time y-m-d 00:00 happens in tz. */
function localMidnightUtc(y: number, m: number, d: number, tz: string): Date {
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 3; i += 1) {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(guess));
    const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
    const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
    const offset = asUtc - guess;
    const next = Date.UTC(y, m - 1, d) - offset;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

/** [start, end) of the period as UTC instants. */
export function periodBounds(period: string, tz: string = licenseeTimeZone()): { start: Date; end: Date } {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return { start: localMidnightUtc(y, m, 1, tz), end: localMidnightUtc(ny, nm, 1, tz) };
}

// $1 = period start, $2 = period end (timestamptz).
export const CALL_MINUTES_SQL = `SELECT COALESCE(SUM(CEIL(secs / 60.0)), 0)::bigint AS minutes
  FROM (SELECT GREATEST(COALESCE(duration_seconds, duration, 0), 0) AS secs
          FROM call_logs WHERE started_at >= $1 AND started_at < $2) c
 WHERE secs > 0`;

export const TEXTS_SQL = `SELECT COALESCE(SUM(quantity), 0)::bigint AS texts
  FROM usage_events WHERE kind = 'text' AND occurred_at >= $1 AND occurred_at < $2`;

export const ASSISTANT_CHATS_SQL = `SELECT COUNT(*)::bigint AS assistant_chats
  FROM chat_sessions WHERE created_at >= $1 AND created_at < $2`;

// KS_SERVER_MARKETING_ADDON - campaign emails, marketing texts and signings, one query ($1 start, $2 end).
export const MARKETING_METERS_SQL = `SELECT
  COALESCE(SUM(quantity) FILTER (WHERE kind = 'campaign_email'), 0)::bigint AS campaign_emails,
  COALESCE(SUM(quantity) FILTER (WHERE kind = 'marketing_text'), 0)::bigint AS marketing_texts,
  COALESCE(SUM(quantity) FILTER (WHERE kind = 'signing'), 0)::bigint AS signings
  FROM usage_events WHERE kind IN ('campaign_email', 'marketing_text', 'signing') AND occurred_at >= $1 AND occurred_at < $2`;

export type PooledAllowances = {
  minutes: number;
  texts: number;
  /** null = unlimited */
  assistant_chats: number | null;
  storage_bytes: number;
  /** KS_SERVER_MARKETING_ADDON - per brokerage: the plan's (+10,000 with the add-on). */
  campaign_emails: number;
  /** KS_SERVER_MARKETING_ADDON - 4 on every plan. */
  signings: number;
  /** KS_SERVER_MARKETING_ADDON - marketing texts the add-on covers on top of texts (0 without it). */
  bonus_marketing_texts: number;
};

/** Per-seat allowances x seats (min 1); the trial bonus is part of allowancesFor during a trial. */
export function pooledAllowances(state: PlanState, seats: number, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): PooledAllowances {
  const a = allowancesFor(state, now, env);
  const s = Math.max(1, Math.floor(Number(seats) || 0));
  const m = marketingLimitsFor(state, now);
  return {
    minutes: a.minutes_per_seat * s,
    texts: a.texts_per_seat * s,
    assistant_chats: a.assistant_chats,
    storage_bytes: storageSummary(0, s, a.storage_gb_per_seat, state.extra_storage_blocks).allowance_bytes,
    campaign_emails: m.campaign_emails,
    signings: SIGNINGS.included,
    bonus_marketing_texts: m.bonus_marketing_texts,
  };
}

export function overage(used: number, allowance: number): number {
  return Math.max(0, Math.floor(Number(used) || 0) - Math.floor(Number(allowance) || 0));
}

export type UsageCounts = {
  minutes: number; texts: number; assistant_chats: number;
  campaign_emails: number; marketing_texts: number; signings: number; // KS_SERVER_MARKETING_ADDON
};

export async function usageCounts(db: Q, period: string, tz: string = licenseeTimeZone()): Promise<UsageCounts> {
  const { start, end } = periodBounds(period, tz);
  const p = [start.toISOString(), end.toISOString()];
  const [m, t, a, k] = await Promise.all([
    db.query(CALL_MINUTES_SQL, p), db.query(TEXTS_SQL, p), db.query(ASSISTANT_CHATS_SQL, p), db.query(MARKETING_METERS_SQL, p),
  ]);
  const mk = k.rows[0] ?? {};
  return {
    minutes: Number(m.rows[0]?.minutes ?? 0) || 0,
    texts: Number(t.rows[0]?.texts ?? 0) || 0,
    assistant_chats: Number(a.rows[0]?.assistant_chats ?? 0) || 0,
    campaign_emails: Number(mk.campaign_emails ?? 0) || 0,
    marketing_texts: Number(mk.marketing_texts ?? 0) || 0,
    signings: Number(mk.signings ?? 0) || 0,
  };
}

export type UsageOverage = {
  minutes: number;
  texts: number;
  /** KS_SERVER_MARKETING_ADDON - campaign emails over the allowance (only billed with the add-on), in 10,000 blocks. */
  campaign_emails: number;
  campaign_email_blocks: number;
  signings: number;
};

/** What goes over each allowance. Texts: the add-on's bonus covers up to 1,000 marketing texts first. */
export function overageOf(counts: UsageCounts, allowances: PooledAllowances, addon: boolean): UsageOverage {
  const bonus = Math.min(bonusTextsApplied(counts.marketing_texts, addon), allowances.bonus_marketing_texts);
  const ce = campaignEmailOverage(counts.campaign_emails, allowances.campaign_emails, addon);
  return {
    minutes: overage(counts.minutes, allowances.minutes),
    texts: overage(counts.texts, allowances.texts + bonus),
    campaign_emails: ce.emails,
    campaign_email_blocks: ce.blocks,
    signings: signingOverage(counts.signings).signings,
  };
}

/** The instant the period's allowances are judged at: now, or the last moment of a period that has ended. */
export function asOf(period: string, now: Date, tz: string): Date {
  const { end } = periodBounds(period, tz);
  return now.getTime() >= end.getTime() ? new Date(end.getTime() - 1) : now;
}

export type PeriodUsage = UsageCounts & {
  period: string;
  storage_bytes: number;
  seats: number;
  allowances: PooledAllowances;
  overage: UsageOverage;
  /** KS_SERVER_MARKETING_ADDON - the Marketing add-on was in force (bought, or a trial) when judged. */
  marketing_addon: boolean;
};

export async function periodUsage(db: Q, period: string, now: Date = new Date(), stateIn?: PlanState): Promise<PeriodUsage> {
  const tz = licenseeTimeZone();
  const state = stateIn ?? await getPlanState(db, now.getTime());
  const [counts, storage, seats] = await Promise.all([usageCounts(db, period, tz), storageUsedBytes(db), seatCount(db)]);
  const at = asOf(period, now, tz);
  const allowances = pooledAllowances(state, seats, at);
  const addon = marketingAddonActive(state, at);
  return {
    period,
    ...counts,
    storage_bytes: storage,
    seats,
    allowances,
    overage: overageOf(counts, allowances, addon),
    marketing_addon: addon,
  };
}

export async function currentUsage(db: Q, now: Date = new Date(), state?: PlanState): Promise<PeriodUsage> {
  return periodUsage(db, periodOf(now, licenseeTimeZone()), now, state);
}

export type UsageReport = {
  licensee_id: string;
  period: string;
  generated_at: string;
  plan: Plan;
  effective_plan: Plan;
  trial: { status: string; started_at: string | null; ends_at: string | null };
  seats: number;
  minutes: number;
  texts: number;
  assistant_chats: number;
  storage_bytes: number;
  // KS_SERVER_MARKETING_ADDON - KS-Ops bills campaign emails and signings from these (and checks the add-on itself).
  campaign_emails: number;
  marketing_texts: number;
  signings: number;
  marketing_addon: boolean;
  addons: Record<string, true>;
  allowances: PooledAllowances;
  overage: UsageOverage;
  extra_storage_blocks: number;
};

export function licenseeId(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.KS_LICENSEE_ID ?? "").trim();
}

/** The UsageReport of the KS-Ops contract for one period. */
export async function buildUsageReport(db: Q, period: string, now: Date = new Date()): Promise<UsageReport> {
  const state = await getPlanState(db, now.getTime());
  const u = await periodUsage(db, period, now, state);
  const at = asOf(period, now, licenseeTimeZone());
  return {
    licensee_id: licenseeId(),
    period,
    generated_at: now.toISOString(),
    plan: state.plan,
    effective_plan: effectivePlan(state, at),
    trial: {
      status: trialStatus(state, at),
      started_at: state.trial_started_at ? state.trial_started_at.toISOString() : null,
      ends_at: state.trial_ends_at ? state.trial_ends_at.toISOString() : null,
    },
    seats: u.seats,
    minutes: u.minutes,
    texts: u.texts,
    assistant_chats: u.assistant_chats,
    storage_bytes: u.storage_bytes,
    campaign_emails: u.campaign_emails,
    marketing_texts: u.marketing_texts,
    signings: u.signings,
    marketing_addon: u.marketing_addon,
    addons: Object.fromEntries(Object.entries(state.addons ?? {}).filter(([, v]) => v === true).map(([k]) => [k, true as const])),
    allowances: u.allowances,
    overage: u.overage,
    extra_storage_blocks: state.extra_storage_blocks,
  };
}

/** The usage block of GET /api/plan. */
export async function planUsageBlock(db: Q, state: PlanState, now: Date = new Date()) {
  const u = await currentUsage(db, now, state);
  return {
    period: u.period,
    minutes: u.minutes,
    texts: u.texts,
    assistant_chats: u.assistant_chats,
    storage_bytes: u.storage_bytes,
    campaign_emails: u.campaign_emails, // KS_SERVER_MARKETING_ADDON
    marketing_texts: u.marketing_texts,
    signings: u.signings,
    marketing_addon: u.marketing_addon,
    allowances: u.allowances,
    overage: u.overage,
    overage_rates: { ...OVERAGE_RATES },
  };
}

/**
 * Records one outbound SMS/MMS Twilio accepted, for the monthly text count. Never throws: the text has already gone,
 * so a failed insert is logged and the send goes on. Idempotent per message SID.
 */
export async function recordOutboundText(db: Q, msg: { sid?: unknown; numSegments?: unknown } | null | undefined): Promise<void> {
  try {
    const sid = String(msg?.sid ?? "").trim();
    if (!sid) return;
    const seg = Math.floor(Number(msg?.numSegments));
    const quantity = Number.isFinite(seg) && seg > 0 ? seg : 1;
    await db.query(
      `INSERT INTO usage_events (kind, ref, quantity) VALUES ('text', $1, $2) ON CONFLICT (kind, ref) DO NOTHING`,
      [sid, quantity],
    );
  } catch (err) {
    logWarnSwallowed(err, "plans/usage.ts:recordOutboundText");
  }
}

/** recordOutboundText against the server's pool (loaded lazily, so senders need not import the database). */
export async function countOutboundText(msg: { sid?: unknown; numSegments?: unknown } | null | undefined): Promise<void> {
  try {
    const { pool } = await import("../db.js");
    await recordOutboundText(pool as unknown as Q, msg);
  } catch (err) {
    logWarnSwallowed(err, "plans/usage.ts:countOutboundText");
  }
}
