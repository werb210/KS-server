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
import { brandSettings } from "../licensee/brand.js";
import { brokerageTimeZone } from "../lib/brokerageTime.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import {
  allowancesFor, effectivePlan, storageSummary, trialStatus, type Plan, type PlanState,
} from "./catalogue.js";
import { getPlanState, type Q } from "./state.js";
import { seatCount, storageUsedBytes } from "./storage.js";

export const OVERAGE_RATES = { minute: 0.04, text: 0.03 } as const;

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

export type PooledAllowances = {
  minutes: number;
  texts: number;
  /** null = unlimited */
  assistant_chats: number | null;
  storage_bytes: number;
};

/** Per-seat allowances x seats (min 1); the trial bonus is part of allowancesFor during a trial. */
export function pooledAllowances(state: PlanState, seats: number, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): PooledAllowances {
  const a = allowancesFor(state, now, env);
  const s = Math.max(1, Math.floor(Number(seats) || 0));
  return {
    minutes: a.minutes_per_seat * s,
    texts: a.texts_per_seat * s,
    assistant_chats: a.assistant_chats,
    storage_bytes: storageSummary(0, s, a.storage_gb_per_seat, state.extra_storage_blocks).allowance_bytes,
  };
}

export function overage(used: number, allowance: number): number {
  return Math.max(0, Math.floor(Number(used) || 0) - Math.floor(Number(allowance) || 0));
}

export type UsageCounts = { minutes: number; texts: number; assistant_chats: number };

export async function usageCounts(db: Q, period: string, tz: string = licenseeTimeZone()): Promise<UsageCounts> {
  const { start, end } = periodBounds(period, tz);
  const p = [start.toISOString(), end.toISOString()];
  const [m, t, a] = await Promise.all([db.query(CALL_MINUTES_SQL, p), db.query(TEXTS_SQL, p), db.query(ASSISTANT_CHATS_SQL, p)]);
  return {
    minutes: Number(m.rows[0]?.minutes ?? 0) || 0,
    texts: Number(t.rows[0]?.texts ?? 0) || 0,
    assistant_chats: Number(a.rows[0]?.assistant_chats ?? 0) || 0,
  };
}

/** The instant the period's allowances are judged at: now, or the last moment of a period that has ended. */
export function asOf(period: string, now: Date, tz: string): Date {
  const { end } = periodBounds(period, tz);
  return now.getTime() >= end.getTime() ? new Date(end.getTime() - 1) : now;
}

export type PeriodUsage = {
  period: string;
  minutes: number;
  texts: number;
  assistant_chats: number;
  storage_bytes: number;
  seats: number;
  allowances: PooledAllowances;
  overage: { minutes: number; texts: number };
};

export async function periodUsage(db: Q, period: string, now: Date = new Date(), stateIn?: PlanState): Promise<PeriodUsage> {
  const tz = licenseeTimeZone();
  const state = stateIn ?? await getPlanState(db, now.getTime());
  const [counts, storage, seats] = await Promise.all([usageCounts(db, period, tz), storageUsedBytes(db), seatCount(db)]);
  const allowances = pooledAllowances(state, seats, asOf(period, now, tz));
  return {
    period,
    ...counts,
    storage_bytes: storage,
    seats,
    allowances,
    overage: { minutes: overage(counts.minutes, allowances.minutes), texts: overage(counts.texts, allowances.texts) },
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
  allowances: PooledAllowances;
  overage: { minutes: number; texts: number };
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
