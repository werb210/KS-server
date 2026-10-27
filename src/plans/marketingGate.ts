// KS_SERVER_MARKETING_ADDON - database-backed marketing checks: the limits in force, this month's campaign email
// budget, who holds the Marketing seats, the route gate for the advanced tools, and the Marketing-role limit that User
// Management enforces while the add-on is on.
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { pool } from "../db.js";
import {
  MARKETING_LIMITS, MARKETING_SEATS, MARKETING_TOOL_LABELS, marketingAddonActive, marketingLimitsFor, toolAccess,
  type EffectiveMarketingLimits, type MarketingTool,
} from "./marketing.js";
import { effectivePlan } from "./catalogue.js";
import { getPlanState, type Q } from "./state.js";
import { licenseeTimeZone, periodBounds, periodOf } from "./usage.js";

const defaultDb = (): Q => pool as unknown as Q;

export async function currentMarketingLimits(db: Q = defaultDb(), now: Date = new Date()): Promise<EffectiveMarketingLimits> {
  return marketingLimitsFor(await getPlanState(db, now.getTime()), now);
}

/** An active (not disabled, not deleted) user with the Marketing role. */
export const ACTIVE_MARKETING_WHERE = `role = 'Marketing' AND COALESCE(active, true) = true AND COALESCE(is_active, true) = true
   AND COALESCE(disabled, false) = false AND deleted_at IS NULL AND COALESCE(status, 'ACTIVE') = 'ACTIVE'`;

/**
 * The Marketing users who hold the advanced-tool seats: the first MARKETING_SEATS active Marketing users, oldest
 * first. User Management keeps it at 3 or fewer while the add-on is on; if there were more before it was switched on,
 * the three who have had the role longest keep the tools.
 */
export async function marketingSeatHolders(db: Q = defaultDb()): Promise<string[]> {
  const r = await db.query(
    `SELECT id::text AS id FROM users WHERE ${ACTIVE_MARKETING_WHERE} ORDER BY created_at ASC NULLS LAST, id ASC LIMIT $1`,
    [MARKETING_SEATS],
  );
  return r.rows.map((x: any) => String(x.id));
}

export async function activeMarketingUserCount(db: Q = defaultDb(), exceptUserId?: string | null): Promise<number> {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM users WHERE ${ACTIVE_MARKETING_WHERE} AND ($1::text IS NULL OR id::text <> $1::text)`,
    [exceptUserId ?? null],
  );
  return Number(r.rows[0]?.n ?? 0) || 0;
}

type Person = { role: string | null; userId: string | null };

export function personOf(req: any): Person {
  const role = typeof req?.user?.role === "string" ? req.user.role : null;
  const id = String(req?.user?.userId ?? req?.user?.id ?? req?.user?.sub ?? "").trim();
  return { role, userId: id || null };
}

export type ToolCheck =
  | { allowed: true; via: "plan" | "addon" }
  | { allowed: false; status: 402 | 403; body: Record<string, unknown> };

/** May this person use the advanced tool now? */
export async function checkMarketingTool(db: Q, tool: MarketingTool, person: Person, now: Date = new Date()): Promise<ToolCheck> {
  const state = await getPlanState(db, now.getTime());
  const seat = person.role === "Marketing" && person.userId ? (await marketingSeatHolders(db)).includes(person.userId) : false;
  const a = toolAccess(tool, state, { role: person.role, marketingSeat: seat }, now);
  if (a.allowed) return a;
  if (a.reason === "addon_required") {
    return {
      allowed: false, status: 402,
      body: {
        ok: false, error: "marketing_addon_required", tool, addon: "marketing",
        message: `${MARKETING_TOOL_LABELS[tool]} comes with the Marketing add-on. An Admin can ask for it on the Plan page.`,
      },
    };
  }
  return {
    allowed: false, status: 403,
    body: {
      ok: false, error: "marketing_seat_required", tool,
      message: `With the Marketing add-on, ${MARKETING_TOOL_LABELS[tool].charAt(0).toLowerCase()}${MARKETING_TOOL_LABELS[tool].slice(1)} is used by Admins and up to ${MARKETING_SEATS} people with the Marketing role. Ask an Admin.`,
    },
  };
}

/** Route gate for an advanced marketing tool: 402 without the add-on, 403 for someone without a Marketing seat. */
export function requireMarketingTool(tool: MarketingTool, dbOverride?: Q): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const c = await checkMarketingTool(dbOverride ?? defaultDb(), tool, personOf(req));
      if (!c.allowed) {
        res.status(c.status).json(c.body);
        return;
      }
      next();
    })().catch(next);
  };
}

/** For handlers that only change what they return (not whether they answer): may this request use the tool? */
export async function requestMayUse(req: any, tool: MarketingTool, db: Q = defaultDb()): Promise<boolean> {
  return (await checkMarketingTool(db, tool, personOf(req))).allowed;
}

// ------------------------------------------------------------------------------------------------- campaign emails

export const CAMPAIGN_EMAILS_SQL = `SELECT COALESCE(SUM(quantity), 0)::bigint AS n
  FROM usage_events WHERE kind = 'campaign_email' AND occurred_at >= $1 AND occurred_at < $2`;

export type CampaignEmailBudget = {
  period: string;
  used: number;
  allowance: number;
  addon: boolean;
  /** Emails left before the allowance; null with the add-on (it never stops: extra emails are billed). */
  remaining: number | null;
};

export async function campaignEmailsUsed(db: Q, period: string, tz: string = licenseeTimeZone()): Promise<number> {
  const { start, end } = periodBounds(period, tz);
  const r = await db.query(CAMPAIGN_EMAILS_SQL, [start.toISOString(), end.toISOString()]);
  return Number(r.rows[0]?.n ?? 0) || 0;
}

export async function campaignEmailBudget(db: Q = defaultDb(), now: Date = new Date()): Promise<CampaignEmailBudget> {
  const tz = licenseeTimeZone();
  const period = periodOf(now, tz);
  const state = await getPlanState(db, now.getTime());
  const limits = marketingLimitsFor(state, now);
  const used = await campaignEmailsUsed(db, period, tz);
  return {
    period, used, allowance: limits.campaign_emails, addon: limits.addon,
    remaining: limits.addon ? null : Math.max(0, limits.campaign_emails - used),
  };
}

/** The message staff see when a campaign would go over the plan's campaign emails (no add-on). */
export function campaignEmailLimitMessage(b: CampaignEmailBudget, wanted: number): string {
  const left = b.remaining ?? 0;
  return `This campaign is to ${wanted.toLocaleString("en-CA")} people, but only ${left.toLocaleString("en-CA")} of this month's ` +
    `${b.allowance.toLocaleString("en-CA")} campaign emails are left. Choose a smaller audience, wait for the 1st, or ask ` +
    "an Admin about the Marketing add-on (10,000 more emails a month).";
}

// ------------------------------------------------------------------------------------------- Marketing role limit

export class MarketingSeatLimitError extends Error {
  readonly code = "marketing_seat_limit";
  readonly status = 409;
  constructor() {
    super(`With the Marketing add-on, up to ${MARKETING_SEATS} people can have the Marketing role (Admins are not counted). ` +
      "Give this person another role, or change someone else's Marketing role first.");
  }
}

/**
 * User Management: while the add-on is on, giving someone the Marketing role (new user, role change, or turning a
 * Marketing user back on) is refused once MARKETING_SEATS active people already have it. Without the add-on any number
 * of seats can have the role (they use the plan's marketing tools).
 */
export async function assertMarketingRoleAvailable(db: Q, targetUserId: string | null, now: Date = new Date()): Promise<void> {
  const state = await getPlanState(db, now.getTime());
  if (!marketingAddonActive(state, now)) return;
  if ((await activeMarketingUserCount(db, targetUserId)) >= MARKETING_SEATS) throw new MarketingSeatLimitError();
}

const USER_ACTIVE_SQL = `COALESCE(active, true) = true AND COALESCE(is_active, true) = true AND COALESCE(disabled, false) = false
   AND deleted_at IS NULL AND COALESCE(status, 'ACTIVE') = 'ACTIVE'`;

/**
 * For a change to an existing user (role and/or on/off): refused when it would add an active Marketing user while the
 * add-on is on and the 3 Marketing seats are taken. A user who already is an active Marketing user is never refused.
 * targetUserId null = a new user.
 */
export async function assertMarketingRoleChange(
  db: Q, targetUserId: string | null, next: { role?: string | null; active?: boolean }, now: Date = new Date(),
): Promise<void> {
  let currentRole: string | null = null;
  let currentActive = true;
  if (targetUserId) {
    const r = await db.query(`SELECT role, (${USER_ACTIVE_SQL}) AS active FROM users WHERE id::text = $1`, [targetUserId]);
    if (!r.rows[0]) return;
    currentRole = r.rows[0].role ?? null;
    currentActive = r.rows[0].active === true;
  }
  const role = next.role ?? currentRole;
  const active = next.active ?? currentActive;
  const was = Boolean(targetUserId) && currentRole === "Marketing" && currentActive;
  if (role !== "Marketing" || !active || was) return;
  await assertMarketingRoleAvailable(db, targetUserId, now);
}

/**
 * How many days of visitor tracking this person sees: the plan's (30 / 90 / 365), or the full history with the
 * Marketing add-on (Admins and the Marketing seats). null = full history.
 */
export async function visitorHistoryDays(req: any, db: Q = defaultDb(), now: Date = new Date()): Promise<number | null> {
  if ((await checkMarketingTool(db, "full_visitor_history", personOf(req), now)).allowed) return null;
  const state = await getPlanState(db, now.getTime());
  return MARKETING_LIMITS[effectivePlan(state, now)].visitor_history_days;
}

/** A requested window (days) cut to the visitor history this person may see. */
export function clampDays(requested: number, historyDays: number | null): number {
  return historyDays === null ? requested : Math.min(requested, historyDays);
}
