// KS_SERVER_PHONE_PROVISIONING - buying, assigning and releasing this copy's phone numbers through the Twilio REST API.
//
// Kinds: main (a local business line, every plan), toll_free (the toll-free line, growth and up) and direct (one
// person's own line, pro). A bought number gets this copy's webhooks straight away:
//   voice   POST {server}/api/webhooks/twilio/voice/twiml   (inbound calls: direct lines ring their owner, the rest go
//                                                          to the receptionist - see routes/webhooks.ts)
//   status  POST {server}/api/webhooks/twilio/voice         (call status)
//   sms     POST {server}/api/webhooks/twilio/sms-inbound   (inbound texts, STOP / HELP handling)
// Numbers are never released silently: removing a seat, cancelling the service, a plan that no longer includes the
// kind, or an admin pressing Release moves the number to 'releasing' for a grace period (KS_NUMBER_RELEASE_GRACE_DAYS,
// default 30), the admins are emailed and notified in the portal, and only then does the worker give it back to
// Twilio. Every Twilio failure is logged with its code; nothing is swallowed.
import type { Q } from "../plans/state.js";
import { getPlanState, readPlanRow, rowToState } from "../plans/state.js";
import { checkFeature, effectivePlan, featureDef, type Plan, type PlanState } from "../plans/catalogue.js";
import { ACTIVE_STAFF_WHERE, adminEmails, seatCount } from "../plans/storage.js";
import { bodies, sendPlanMail, type PlanMailer } from "../plans/email.js";
import { mainLineNumberSetting } from "../licensee/connections.js";
import { TwilioNumberError, twilioConfigured, type AvailableNumber, type TwilioNumbersApi } from "./twilioNumbers.js";

export const NUMBER_KINDS = ["main", "toll_free", "direct"] as const;
export type NumberKind = (typeof NUMBER_KINDS)[number];
export const isNumberKind = (v: unknown): v is NumberKind => typeof v === "string" && (NUMBER_KINDS as readonly string[]).includes(v);

/** The plan feature each kind needs (main lines are on every plan). */
export const KIND_FEATURE: Record<NumberKind, string | null> = { main: null, toll_free: "toll_free_number", direct: "multiple_lines" };
export const KIND_LABEL: Record<NumberKind, string> = { main: "business line", toll_free: "toll-free line", direct: "direct line" };

/** Business and toll-free lines per plan. Direct lines: pro only, one per seat (each person has at most one). */
export const LINE_LIMITS: Record<Plan, { main: number; toll_free: number }> = {
  starter: { main: 1, toll_free: 0 },
  growth: { main: 1, toll_free: 1 },
  pro: { main: 5, toll_free: 2 },
};

export function limitFor(plan: Plan, kind: NumberKind, seats: number): number {
  if (kind === "direct") return plan === "pro" ? Math.max(0, seats) : 0;
  return LINE_LIMITS[plan][kind];
}

const REGULATORY_CODES = new Set([21615, 21631, 21649, 21650, 21651, 21653, 21658]);
const DAY = 86_400_000;

export function graceDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.KS_NUMBER_RELEASE_GRACE_DAYS ?? "").trim();
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) ? Math.min(365, Math.max(1, Math.floor(n))) : 30;
}

/** This copy's own https address, as set on the App Service. Never the development copy's fallback. */
export function webhookBase(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of ["PUBLIC_BASE_URL", "KS_SERVER_URL", "PUBLIC_SERVER_URL", "SERVER_PUBLIC_URL", "SERVER_URL"]) {
    const v = String(env[name] ?? "").trim().replace(/\/+$/, "");
    if (/^https:\/\/[^\s/]+$/i.test(v)) return v;
  }
  return null;
}

export function webhookUrls(base: string) {
  return {
    voiceUrl: `${base}/api/webhooks/twilio/voice/twiml`,
    statusCallback: `${base}/api/webhooks/twilio/voice`,
    smsUrl: `${base}/api/webhooks/twilio/sms-inbound`,
  };
}

export const REGULATORY_MESSAGE =
  "Twilio needs a registered business address (or a regulatory bundle) on this account before it can buy this number. " +
  "Add the address in the Twilio console (Phone Numbers > Regulatory Compliance > Addresses), set its AD... id as " +
  "TWILIO_ADDRESS_SID on this server (and TWILIO_BUNDLE_SID if Twilio asks for a bundle), then try again.";

export type SetupStatus = { ready: boolean; twilio: boolean; server_url: string | null; address_sid: boolean; bundle_sid: boolean; messages: string[] };

/** What is missing before numbers can be bought, as plain sentences for the admin. */
export function setupStatus(env: NodeJS.ProcessEnv = process.env): SetupStatus {
  const twilio = twilioConfigured(env);
  const base = webhookBase(env);
  const messages: string[] = [];
  if (!twilio) messages.push("Twilio is not connected: TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are not set on this server. Ask Keystone support to connect it.");
  if (!base) messages.push("This server's https address (KS_SERVER_URL) is not set, so new numbers could not be pointed at it. Ask Keystone support to set it.");
  messages.push("Texting from a toll-free number needs toll-free verification in Twilio, and texting US numbers from a local line needs A2P 10DLC registration. Calls work straight away.");
  return {
    ready: twilio && Boolean(base),
    twilio,
    server_url: base,
    address_sid: Boolean(String(env.TWILIO_ADDRESS_SID ?? "").trim()),
    bundle_sid: Boolean(String(env.TWILIO_BUNDLE_SID ?? "").trim()),
    messages,
  };
}

export function isRegulatory(err: unknown): boolean {
  const e = err as { code?: number | null; message?: string } | null;
  if (e?.code && REGULATORY_CODES.has(Number(e.code))) return true;
  return /address|bundle|regulat/i.test(String(e?.message ?? ""));
}

function logTwilio(op: string, err: unknown, extra: Record<string, unknown> = {}): void {
  const e = err as { message?: string; code?: unknown; status?: unknown } | null;
  console.error(`[phone-numbers] twilio ${op} failed`, { ...extra, code: e?.code ?? null, status: e?.status ?? null, message: e?.message ?? String(err) });
}

/** "+1 (403) 555-0100" -> "+14035550100"; anything else unusable -> null. */
export function toE164(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (s.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

export type Refusal = { ok: false; status: number; error: string; message: string; [k: string]: unknown };

function refuse(status: number, error: string, message: string, extra: Record<string, unknown> = {}): Refusal {
  return { ok: false, status, error, message, ...extra };
}

/** The same 402 body requireFeature sends, when a kind's feature is not in the plan in force. */
function planRefusal(state: PlanState, kind: NumberKind, now: Date): Refusal | null {
  const feature = KIND_FEATURE[kind];
  if (!feature) return null;
  const c = checkFeature(state, feature, now);
  if (c.allowed) return null;
  return refuse(402, "feature_not_in_plan", `A ${KIND_LABEL[kind]} needs the ${featureDef(feature)?.label ?? feature} feature.`, {
    feature, required_plan: c.required_plan, trial_available: c.trial_available,
  });
}

async function event(db: Q, id: string | null, name: string, detail: Record<string, unknown>, actor: string): Promise<void> {
  try {
    await db.query(`INSERT INTO phone_number_events (phone_number_id, event, detail, actor) VALUES ($1, $2, $3::jsonb, $4)`,
      [id, name, JSON.stringify(detail), actor]);
  } catch (err) {
    console.error("[phone-numbers] event not recorded", { id, event: name, message: (err as Error)?.message ?? String(err) });
  }
}

const LIVE = `status IN ('purchasing', 'active')`;

async function liveCount(db: Q, kind: NumberKind): Promise<number> {
  const r = await db.query(`SELECT count(*)::int AS n FROM phone_numbers WHERE kind = $1 AND ${LIVE}`, [kind]);
  return Number(r.rows[0]?.n ?? 0) || 0;
}

async function activeStaff(db: Q, userId: string): Promise<{ id: string; name: string; direct_number: string | null } | null> {
  const r = await db.query(
    `SELECT id::text AS id, trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) AS name, email, direct_number
       FROM users WHERE id::text = $1 AND ${ACTIVE_STAFF_WHERE} LIMIT 1`, [userId]);
  const u = r.rows[0];
  return u ? { id: String(u.id), name: String(u.name || u.email || "this person"), direct_number: u.direct_number ?? null } : null;
}

export type SearchInput = { kind?: unknown; country?: unknown; area_code?: unknown; region?: unknown; contains?: unknown; limit?: unknown };

/** Numbers Twilio has for sale: local (by area code, province or state) for main and direct lines, toll-free otherwise. */
export async function searchNumbers(api: TwilioNumbersApi, input: SearchInput, env: NodeJS.ProcessEnv = process.env)
  : Promise<{ ok: true; numbers: Array<AvailableNumber & { needs_address: boolean }> } | Refusal> {
  if (!twilioConfigured(env)) return refuse(503, "twilio_not_configured", setupStatus(env).messages[0]);
  const kind = isNumberKind(input.kind) ? input.kind : "main";
  const country = String(input.country ?? "CA").trim().toUpperCase();
  if (country !== "CA" && country !== "US") return refuse(400, "invalid_country", "Numbers can be bought in Canada (CA) or the US (US).");
  const areaCode = String(input.area_code ?? "").trim();
  if (areaCode && !/^\d{3}$/.test(areaCode)) return refuse(400, "invalid_area_code", "An area code is 3 digits, e.g. 403.");
  const region = String(input.region ?? "").trim().toUpperCase();
  if (region && !/^[A-Z]{2}$/.test(region)) return refuse(400, "invalid_region", "Use the 2-letter province or state code, e.g. AB.");
  const contains = String(input.contains ?? "").trim();
  if (contains && !/^[0-9*]{1,7}$/.test(contains)) return refuse(400, "invalid_contains", "Search for up to 7 digits.");
  const limit = Math.min(30, Math.max(1, Math.floor(Number(input.limit) || 20)));
  const hasAddress = Boolean(String(env.TWILIO_ADDRESS_SID ?? "").trim());
  try {
    const found = kind === "toll_free"
      ? await api.searchTollFree({ country, contains: contains || undefined, limit })
      : await api.searchLocal({ country, areaCode: areaCode || undefined, inRegion: region || undefined, contains: contains || undefined, limit });
    const numbers = found
      .filter((n) => n.phone_number && n.capabilities.voice)
      .map((n) => ({ ...n, needs_address: n.address_requirements !== "none" && !hasAddress }));
    return { ok: true, numbers };
  } catch (err) {
    logTwilio("search", err, { kind, country, areaCode, region });
    return refuse(502, "twilio_error", `Twilio could not search for numbers: ${(err as Error)?.message ?? String(err)}`);
  }
}

export type PurchaseInput = {
  kind: unknown;
  phone_number: unknown;
  user_id?: unknown;
  actor: string;
  address_requirements?: unknown;
  locality?: unknown;
  region?: unknown;
  iso_country?: unknown;
};

export type NumberRow = Record<string, any>;

/** Buys one number into this copy's Twilio account, points it at this server, stores it and (for direct lines)
 *  gives it to the person. Plan features and limits are checked first. */
export async function purchaseNumber(db: Q, api: TwilioNumbersApi, input: PurchaseInput, env: NodeJS.ProcessEnv = process.env, now: Date = new Date())
  : Promise<{ ok: true; number: NumberRow } | Refusal> {
  if (!isNumberKind(input.kind)) return refuse(400, "invalid_kind", "kind must be main, toll_free or direct.");
  const kind = input.kind;
  const setup = setupStatus(env);
  if (!setup.twilio) return refuse(503, "twilio_not_configured", setup.messages[0]);
  if (!setup.server_url) return refuse(503, "server_url_not_set", setup.messages[0]);
  const number = toE164(input.phone_number);
  if (!number) return refuse(400, "invalid_number", "Pick a number from the search results.");
  if (String(input.address_requirements ?? "none") !== "none" && !setup.address_sid) {
    return refuse(409, "regulatory_requirement", REGULATORY_MESSAGE);
  }

  const state = await getPlanState(db, now.getTime());
  const gate = planRefusal(state, kind, now);
  if (gate) return gate;
  const plan = effectivePlan(state, now);
  const seats = await seatCount(db);
  const limit = limitFor(plan, kind, seats);
  if ((await liveCount(db, kind)) >= limit) {
    return refuse(409, "limit_reached", kind === "direct"
      ? `Every seat already has a direct line (${limit}).`
      : `Your plan includes ${limit} ${KIND_LABEL[kind]}${limit === 1 ? "" : "s"}, and ${limit === 1 ? "it is" : "they are"} already in use.`, { limit });
  }

  let userId: string | null = null;
  let userName = "";
  if (kind === "direct") {
    const u = await activeStaff(db, String(input.user_id ?? ""));
    if (!u) return refuse(400, "invalid_user", "Choose an active staff member for the direct line.");
    const has = await db.query(`SELECT phone_number FROM phone_numbers WHERE kind = 'direct' AND assigned_user_id::text = $1 AND ${LIVE} LIMIT 1`, [u.id]);
    if (has.rows[0]) return refuse(409, "already_has_line", `${u.name} already has the direct line ${has.rows[0].phone_number}.`);
    if (u.direct_number) return refuse(409, "already_has_line", `${u.name} already has the direct number ${u.direct_number}. Clear it first.`);
    userId = u.id;
    userName = u.name;
  }

  let row: NumberRow;
  try {
    const ins = await db.query(
      `INSERT INTO phone_numbers (phone_number, kind, status, assigned_user_id, purchased_by, iso_country, locality, region)
       VALUES ($1, $2, 'purchasing', $3, $4, $5, $6, $7) RETURNING *`,
      [number, kind, userId, input.actor, String(input.iso_country ?? "") || null, String(input.locality ?? "") || null, String(input.region ?? "") || null]);
    row = ins.rows[0];
  } catch (err) {
    if ((err as { code?: string })?.code === "23505") return refuse(409, "number_in_use", "That number (or that person's line) is already being set up.");
    throw err;
  }

  const hooks = webhookUrls(setup.server_url);
  let bought: { sid: string; phone_number: string };
  try {
    bought = await api.purchase({
      phoneNumber: number,
      friendlyName: kind === "direct" ? `Direct line - ${userName}`.slice(0, 64) : kind === "toll_free" ? "Toll-free line" : "Business line",
      ...hooks,
      addressSid: String(env.TWILIO_ADDRESS_SID ?? "").trim() || undefined,
      bundleSid: String(env.TWILIO_BUNDLE_SID ?? "").trim() || undefined,
    });
  } catch (err) {
    logTwilio("purchase", err, { number, kind });
    const regulatory = isRegulatory(err);
    const message = regulatory ? REGULATORY_MESSAGE : `Twilio did not sell the number: ${(err as Error)?.message ?? String(err)}`;
    await db.query(`UPDATE phone_numbers SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`, [row.id, message]);
    await event(db, row.id, "purchase_failed", { code: (err as TwilioNumberError)?.code ?? null, message }, input.actor);
    return refuse(regulatory ? 409 : 502, regulatory ? "regulatory_requirement" : "twilio_error", message);
  }

  let saved: NumberRow;
  try {
    const upd = await db.query(
      `UPDATE phone_numbers SET status = 'active', twilio_sid = $2, phone_number = $3, purchased_at = $4, last_error = NULL, updated_at = now()
        WHERE id = $1 RETURNING *`, [row.id, bought.sid, bought.phone_number || number, now]);
    saved = upd.rows[0] ?? { ...row, status: "active", twilio_sid: bought.sid };
  } catch (err) {
    // Bought but not saved: never release it automatically - an admin must see it.
    console.error("[phone-numbers] number bought in Twilio but not saved", { sid: bought.sid, number, message: (err as Error)?.message ?? String(err) });
    throw err;
  }
  await event(db, saved.id, "purchased", { sid: bought.sid, kind, user_id: userId, webhooks: hooks }, input.actor);

  if (kind === "direct" && userId) {
    await db.query(`UPDATE users SET direct_number = $2 WHERE id::text = $1`, [userId, saved.phone_number]);
  }
  if (kind !== "direct" && !mainLineNumberSetting(env)) {
    // The first business or toll-free line becomes the caller ID for staff without a direct line.
    const { updateLicenseeSettings } = await import("../licensee/settings.js");
    const r = await updateLicenseeSettings(db as any, { twilio_main_number: saved.phone_number }, input.actor);
    if (!r.ok) console.error("[phone-numbers] main line setting not saved", { number: saved.phone_number, errors: r.errors });
  }
  console.log(`[phone-numbers] bought ${kind} ${saved.phone_number} (${bought.sid}) by ${input.actor}`);
  return { ok: true, number: saved };
}

async function adminUserIds(db: Q): Promise<string[]> {
  const r = await db.query(`SELECT id::text AS id FROM users WHERE role = 'Admin' AND ${ACTIVE_STAFF_WHERE}`);
  return r.rows.map((x: any) => String(x.id));
}

/** Tells every active Admin, by email and in the portal. Failures are logged, never thrown. */
export async function notifyAdmins(db: Q, numberId: string | null, subject: string, paragraphs: string[], send: PlanMailer = sendPlanMail): Promise<void> {
  try {
    const to = await adminEmails(db);
    if (to.length) {
      const r = await send({ to, subject, ...bodies(paragraphs) });
      if (!r.ok) console.error("[phone-numbers] admin email not sent", { subject, error: r.error });
    } else {
      console.warn("[phone-numbers] no admin email to notify", { subject });
    }
  } catch (err) {
    console.error("[phone-numbers] admin email failed", { subject, message: (err as Error)?.message ?? String(err) });
  }
  try {
    for (const id of await adminUserIds(db)) {
      await db.query(
        `INSERT INTO notifications (user_id, type, ref_table, ref_id, body, context_url) VALUES ($1, 'phone_number', 'phone_numbers', $2, $3, '/settings/phone')`,
        [id, numberId, `${subject}. ${paragraphs[0] ?? ""}`.slice(0, 500)]);
    }
  } catch (err) {
    console.error("[phone-numbers] admin notification failed", { subject, message: (err as Error)?.message ?? String(err) });
  }
}

const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

/** Moves an active number to 'releasing' for the grace period and tells the admins. Calls to a direct line go to the
 *  main line meanwhile. Nothing is given back to Twilio here. */
export async function scheduleRelease(db: Q, id: string, opts: { reason: string; actor: string; now?: Date; env?: NodeJS.ProcessEnv; send?: PlanMailer })
  : Promise<{ ok: true; number: NumberRow } | Refusal> {
  const now = opts.now ?? new Date();
  const days = graceDays(opts.env);
  const after = new Date(now.getTime() + days * DAY);
  const r = await db.query(
    `UPDATE phone_numbers SET status = 'releasing', release_after = $2, release_reason = $3, updated_at = now()
      WHERE id::text = $1 AND status = 'active' RETURNING *`, [id, after, opts.reason]);
  const row = r.rows[0];
  if (!row) return refuse(409, "not_active", "Only an active number can be released.");
  if (row.kind === "direct" && row.assigned_user_id) {
    await db.query(`UPDATE users SET direct_number = NULL WHERE id::text = $1 AND direct_number = $2`, [String(row.assigned_user_id), row.phone_number]);
  }
  await event(db, row.id, "release_scheduled", { reason: opts.reason, release_after: after.toISOString() }, opts.actor);
  const mainNote = row.phone_number === mainLineNumberSetting(opts.env) ? " It is your main line: choose another main line on the Company page before then." : "";
  await notifyAdmins(db, row.id, `Phone number ${row.phone_number} will be released on ${fmtDate(after)}`, [
    `The ${KIND_LABEL[row.kind as NumberKind] ?? "number"} ${row.phone_number} will be given back to the phone company on ${fmtDate(after)} (${days} days from now). Reason: ${opts.reason}.${mainNote}`,
    row.kind === "direct" ? "Until then, calls to it go to your main line." : "Until then it keeps working.",
    "To keep it, open Settings > Phone lines in the staff portal and press Keep before that date. After it is released the number may not be available again.",
  ], opts.send);
  console.log(`[phone-numbers] release of ${row.phone_number} scheduled for ${after.toISOString()} (${opts.reason}) by ${opts.actor}`);
  return { ok: true, number: row };
}

/** Cancels a scheduled release. A direct line needs a person to go to (its old owner, if still on the team). */
export async function keepNumber(db: Q, id: string, input: { user_id?: unknown; actor: string; now?: Date })
  : Promise<{ ok: true; number: NumberRow } | Refusal> {
  const now = input.now ?? new Date();
  const cur = (await db.query(`SELECT * FROM phone_numbers WHERE id::text = $1 AND status = 'releasing'`, [id])).rows[0];
  if (!cur) return refuse(409, "not_releasing", "That number is not waiting to be released.");
  const kind = cur.kind as NumberKind;
  const state = await getPlanState(db, now.getTime());
  if (state.service_status === "cancelled") return refuse(409, "service_cancelled", "The service is cancelled, so numbers cannot be kept.");
  const gate = planRefusal(state, kind, now);
  if (gate) return gate;
  const plan = effectivePlan(state, now);
  const limit = limitFor(plan, kind, await seatCount(db));
  if ((await liveCount(db, kind)) >= limit) return refuse(409, "limit_reached", `Your plan includes ${limit} ${KIND_LABEL[kind]}${limit === 1 ? "" : "s"}, already in use.`, { limit });
  let userId: string | null = null;
  if (kind === "direct") {
    const u = await activeStaff(db, String(input.user_id ?? cur.assigned_user_id ?? ""));
    if (!u) return refuse(400, "invalid_user", "Choose an active staff member to give the direct line to.");
    const has = await db.query(`SELECT 1 FROM phone_numbers WHERE kind = 'direct' AND assigned_user_id::text = $1 AND ${LIVE} LIMIT 1`, [u.id]);
    if (has.rows[0] || u.direct_number) return refuse(409, "already_has_line", `${u.name} already has a direct line.`);
    userId = u.id;
  }
  const r = await db.query(
    `UPDATE phone_numbers SET status = 'active', release_after = NULL, release_reason = NULL, assigned_user_id = $2, updated_at = now()
      WHERE id::text = $1 AND status = 'releasing' RETURNING *`, [id, kind === "direct" ? userId : cur.assigned_user_id ?? null]);
  const row = r.rows[0];
  if (!row) return refuse(409, "not_releasing", "That number is not waiting to be released.");
  if (kind === "direct" && userId) await db.query(`UPDATE users SET direct_number = $2 WHERE id::text = $1`, [userId, row.phone_number]);
  await event(db, row.id, "release_cancelled", { user_id: userId }, input.actor);
  return { ok: true, number: row };
}

/** Gives an active direct line to someone else (the old owner loses it). */
export async function reassignDirect(db: Q, id: string, input: { user_id: unknown; actor: string }): Promise<{ ok: true; number: NumberRow } | Refusal> {
  const cur = (await db.query(`SELECT * FROM phone_numbers WHERE id::text = $1 AND status = 'active' AND kind = 'direct'`, [id])).rows[0];
  if (!cur) return refuse(409, "not_active_direct", "Only an active direct line can be reassigned.");
  const u = await activeStaff(db, String(input.user_id ?? ""));
  if (!u) return refuse(400, "invalid_user", "Choose an active staff member.");
  if (String(cur.assigned_user_id ?? "") === u.id) return { ok: true, number: cur };
  const has = await db.query(`SELECT 1 FROM phone_numbers WHERE kind = 'direct' AND assigned_user_id::text = $1 AND ${LIVE} LIMIT 1`, [u.id]);
  if (has.rows[0] || u.direct_number) return refuse(409, "already_has_line", `${u.name} already has a direct line.`);
  if (cur.assigned_user_id) await db.query(`UPDATE users SET direct_number = NULL WHERE id::text = $1 AND direct_number = $2`, [String(cur.assigned_user_id), cur.phone_number]);
  const row = (await db.query(`UPDATE phone_numbers SET assigned_user_id = $2, updated_at = now() WHERE id::text = $1 RETURNING *`, [id, u.id])).rows[0];
  await db.query(`UPDATE users SET direct_number = $2 WHERE id::text = $1`, [u.id, cur.phone_number]);
  await event(db, cur.id, "reassigned", { from: cur.assigned_user_id ?? null, to: u.id }, input.actor);
  return { ok: true, number: row };
}

/** Gives back to Twilio every number whose grace period is over. Failures are logged and retried on the next run. */
export async function releaseDue(db: Q, api: TwilioNumbersApi, now: Date = new Date()): Promise<{ released: string[]; failed: string[] }> {
  const out = { released: [] as string[], failed: [] as string[] };
  const due = await db.query(
    `SELECT * FROM phone_numbers WHERE status = 'releasing' AND release_after <= $1 ORDER BY release_after LIMIT 20`, [now]);
  for (const row of due.rows) {
    let note = "released";
    if (row.twilio_sid) {
      try {
        await api.release(String(row.twilio_sid));
      } catch (err) {
        const gone = (err as TwilioNumberError)?.status === 404 || (err as TwilioNumberError)?.code === 20404;
        if (!gone) {
          logTwilio("release", err, { number: row.phone_number, sid: row.twilio_sid });
          const message = (err as Error)?.message ?? String(err);
          await db.query(`UPDATE phone_numbers SET release_attempts = release_attempts + 1, last_error = $2, updated_at = now() WHERE id = $1`, [row.id, message]);
          await event(db, row.id, "release_failed", { message, code: (err as TwilioNumberError)?.code ?? null }, "phone-number worker");
          out.failed.push(row.phone_number);
          continue;
        }
        console.warn("[phone-numbers] number already gone from Twilio; marking it released", { number: row.phone_number, sid: row.twilio_sid });
        note = "already gone from Twilio";
      }
    }
    await db.query(`UPDATE phone_numbers SET status = 'released', released_at = $2, last_error = NULL, updated_at = now() WHERE id = $1`, [row.id, now]);
    if (row.kind === "direct" && row.assigned_user_id) {
      await db.query(`UPDATE users SET direct_number = NULL WHERE id::text = $1 AND direct_number = $2`, [String(row.assigned_user_id), row.phone_number]);
    }
    await event(db, row.id, "released", { note }, "phone-number worker");
    if (row.phone_number === mainLineNumberSetting()) {
      console.warn("[phone-numbers] the released number was the main line setting", { number: row.phone_number });
    }
    console.log(`[phone-numbers] released ${row.phone_number} (${row.release_reason ?? "no reason"})`);
    out.released.push(row.phone_number);
  }
  return out;
}

/**
 * Finds numbers that should go and schedules their release (with the grace period and the admin notice):
 * direct lines whose person left (seat removed), everything after the service is cancelled, and kinds the plan no
 * longer includes (or more lines than it allows). The plan is read straight from the database: if it cannot be read,
 * only the seat check runs, so a database blip never releases a number.
 */
export async function reconcileNumbers(db: Q, opts: { now?: Date; env?: NodeJS.ProcessEnv; send?: PlanMailer } = {}): Promise<string[]> {
  const now = opts.now ?? new Date();
  const scheduled: string[] = [];
  const schedule = async (id: string, reason: string) => {
    const r = await scheduleRelease(db, id, { reason, actor: "phone-number worker", now, env: opts.env, send: opts.send });
    if (r.ok) scheduled.push(r.number.phone_number);
  };
  const active = (await db.query(`SELECT * FROM phone_numbers WHERE status = 'active' ORDER BY created_at`)).rows as NumberRow[];
  if (!active.length) return scheduled;

  let state: PlanState | null = null;
  try {
    const row = await readPlanRow(db);
    state = row ? rowToState(row) : null;
  } catch (err) {
    console.error("[phone-numbers] plan not read; only checking seats", { message: (err as Error)?.message ?? String(err) });
  }
  if (state?.service_status === "cancelled") {
    for (const n of active) await schedule(n.id, "the service was cancelled");
    return scheduled;
  }
  const done = new Set<string>();
  if (state) {
    for (const kind of ["toll_free", "direct"] as const) {
      if (planRefusal(state, kind, now)) {
        for (const n of active.filter((x) => x.kind === kind)) {
          await schedule(n.id, `your plan no longer includes ${kind === "direct" ? "direct lines" : "a toll-free line"}`);
          done.add(n.id);
        }
      }
    }
    const plan = effectivePlan(state, now);
    for (const kind of ["main", "toll_free"] as const) {
      const live = active.filter((x) => x.kind === kind && !done.has(x.id));
      const limit = LINE_LIMITS[plan][kind];
      for (const n of live.slice(limit).reverse()) {
        await schedule(n.id, `your plan includes ${limit} ${KIND_LABEL[kind]}${limit === 1 ? "" : "s"}`);
        done.add(n.id);
      }
    }
  }
  for (const n of active.filter((x) => x.kind === "direct" && !done.has(x.id))) {
    const u = n.assigned_user_id ? await activeStaff(db, String(n.assigned_user_id)) : null;
    if (!u) await schedule(n.id, "the person it belonged to no longer has a seat");
  }
  return scheduled;
}

const POSTAL_PROVINCE: Record<string, string> = {
  A: "NL", B: "NS", C: "PE", E: "NB", G: "QC", H: "QC", J: "QC", K: "ON", L: "ON", M: "ON", N: "ON", P: "ON",
  R: "MB", S: "SK", T: "AB", V: "BC", X: "NT", Y: "YT",
};
const REGIONS = new Set(["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT",
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA",
  "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN",
  "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC"]);

/** The area code of a North American number that is not toll-free, else "". */
export function areaCodeOf(raw: unknown): string {
  const d = String(raw ?? "").replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return ten.length === 10 && /^[2-9]/.test(ten) && !/^8(00|33|44|55|66|77|88)/.test(ten) ? ten.slice(0, 3) : "";
}

/** Where "Get a number" searches first: the area code of the main line or the brokerage's phone, and the province or
 *  state from its mailing address (a Canadian postal code tells the province). */
export function defaultSearch(s: { country?: string; mailing_address?: string; support_phone?: string }, mainLine: string | null) {
  const country = String(s.country ?? "").trim().toUpperCase() === "US" ? "US" : "CA";
  const area_code = areaCodeOf(mainLine) || areaCodeOf(s.support_phone);
  const addr = String(s.mailing_address ?? "").toUpperCase();
  const token = (addr.match(/\b[A-Z]{2}\b/g) ?? []).reverse().find((t) => REGIONS.has(t) && !(t === "CA" && country === "CA"));
  const postal = addr.match(/\b([ABCEGHJ-NPRSTVXY])\d[A-Z]\s?\d[A-Z]\d\b/);
  const region = token ?? (postal ? POSTAL_PROVINCE[postal[1]] : "") ?? "";
  return { country, area_code, region };
}

/** "Change number": the old number goes into the grace period (admins told) and a new one of the same kind is bought
 *  for the same person. If Twilio will not sell the new one, the old one is kept as it was. */
export async function changeNumber(db: Q, api: TwilioNumbersApi, id: string, input: Omit<PurchaseInput, "kind" | "user_id">, env: NodeJS.ProcessEnv = process.env, now: Date = new Date())
  : Promise<{ ok: true; number: NumberRow; replaced: string } | Refusal> {
  const cur = (await db.query(`SELECT * FROM phone_numbers WHERE id::text = $1 AND status = 'active'`, [id])).rows[0];
  if (!cur) return refuse(409, "not_active", "Only an active number can be changed.");
  const next = toE164(input.phone_number);
  if (!next) return refuse(400, "invalid_number", "Pick a number from the search results.");
  const rel = await scheduleRelease(db, id, { reason: `replaced by ${next}`, actor: input.actor, now, env });
  if (!rel.ok) return rel;
  const bought = await purchaseNumber(db, api, { ...input, kind: cur.kind, user_id: cur.assigned_user_id ?? undefined }, env, now);
  if (!bought.ok) {
    const kept = await keepNumber(db, id, { user_id: cur.assigned_user_id ?? undefined, actor: input.actor, now });
    if (!kept.ok) console.error("[phone-numbers] old number not restored after a failed change", { id, error: kept.error, message: kept.message });
    return bought;
  }
  await event(db, cur.id, "replaced", { by: bought.number.phone_number }, input.actor);
  return { ok: true, number: bought.number, replaced: cur.phone_number };
}

/** Everything the Phone lines page shows. */
export async function listNumbers(db: Q, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()) {
  const rows = await db.query(
    `SELECT p.id::text AS id, p.phone_number, p.kind, p.status, p.assigned_user_id::text AS assigned_user_id, p.locality, p.region,
            p.iso_country, p.release_after, p.release_reason, p.last_error, p.purchased_at,
            trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')) AS assigned_name
       FROM phone_numbers p LEFT JOIN users u ON u.id = p.assigned_user_id
      WHERE p.status IN ('purchasing', 'active', 'releasing')
      ORDER BY CASE p.kind WHEN 'main' THEN 0 WHEN 'toll_free' THEN 1 ELSE 2 END, p.created_at`);
  const state = await getPlanState(db, now.getTime());
  const plan = effectivePlan(state, now);
  const seats = await seatCount(db);
  const limits = Object.fromEntries(NUMBER_KINDS.map((k) => [k, limitFor(plan, k, seats)]));
  const allowed = Object.fromEntries(NUMBER_KINDS.map((k) => [k, !planRefusal(state, k, now)]));
  const { getLicenseeSettings } = await import("../licensee/settings.js");
  let search = { country: "CA", area_code: "", region: "" };
  try {
    search = defaultSearch(await getLicenseeSettings(db as any), mainLineNumberSetting(env) || null);
  } catch (err) {
    console.error("[phone-numbers] licensee settings not read for the default search", { message: (err as Error)?.message ?? String(err) });
  }
  const used = Object.fromEntries(NUMBER_KINDS.map((k) => [k, rows.rows.filter((r: any) => r.kind === k && r.status !== "releasing").length]));
  return { plan, numbers: rows.rows, limits, used, allowed, grace_days: graceDays(env), main_line: mainLineNumberSetting(env) || null, default_search: search, setup: setupStatus(env) };
}

export type MainLineRequest = { area_code?: unknown; region?: unknown; country?: unknown; actor: string };
export type MainLineResult = { kind: "main" | "toll_free"; status: "bought" | "already_had" | "not_in_plan" | "failed"; number?: string; error?: string; message?: string };

/** KS-Ops provisioning: the business line (every plan) and the toll-free line (growth and up), each bought once.
 *  Tries the area code, then the province or state, then the whole country; skips numbers that need an address
 *  when none is set. Safe to call again. */
export async function provisionMainLines(db: Q, api: TwilioNumbersApi, req: MainLineRequest, env: NodeJS.ProcessEnv = process.env, now: Date = new Date())
  : Promise<{ ok: true; results: MainLineResult[] } | Refusal> {
  const setup = setupStatus(env);
  if (!setup.twilio) return refuse(503, "twilio_not_configured", setup.messages[0]);
  if (!setup.server_url) return refuse(503, "server_url_not_set", setup.messages[0]);
  const state = await getPlanState(db, now.getTime());
  const country = String(req.country ?? "CA").trim().toUpperCase() === "US" ? "US" : "CA";
  const areaCode = /^\d{3}$/.test(String(req.area_code ?? "").trim()) ? String(req.area_code).trim() : "";
  const region = /^[A-Za-z]{2}$/.test(String(req.region ?? "").trim()) ? String(req.region).trim().toUpperCase() : "";
  const results: MainLineResult[] = [];
  for (const kind of ["main", "toll_free"] as const) {
    if (planRefusal(state, kind, now)) { results.push({ kind, status: "not_in_plan" }); continue; }
    const have = await db.query(`SELECT phone_number FROM phone_numbers WHERE kind = $1 AND status IN ('purchasing', 'active') LIMIT 1`, [kind]);
    if (have.rows[0]) { results.push({ kind, status: "already_had", number: have.rows[0].phone_number }); continue; }
    const searches: SearchInput[] = kind === "toll_free"
      ? [{ kind, country }]
      : [...(areaCode ? [{ kind, country, area_code: areaCode }] : []), ...(region ? [{ kind, country, region }] : []), { kind, country }];
    let candidate: (AvailableNumber & { needs_address: boolean }) | null = null;
    let lastError: Refusal | null = null;
    for (const s of searches) {
      const found = await searchNumbers(api, { ...s, limit: 10 }, env);
      if (!found.ok) { lastError = found; continue; }
      candidate = found.numbers.find((n) => !n.needs_address && (kind === "toll_free" || n.capabilities.sms)) ?? null;
      if (candidate) break;
      if (found.numbers.some((n) => n.needs_address)) lastError = refuse(409, "regulatory_requirement", REGULATORY_MESSAGE);
    }
    if (!candidate) {
      results.push({ kind, status: "failed", error: lastError?.error ?? "no_numbers", message: lastError?.message ?? "Twilio had no numbers for sale for that search." });
      continue;
    }
    const bought = await purchaseNumber(db, api, {
      kind, phone_number: candidate.phone_number, actor: req.actor, address_requirements: candidate.address_requirements,
      locality: candidate.locality, region: candidate.region, iso_country: candidate.iso_country,
    }, env, now);
    results.push(bought.ok
      ? { kind, status: "bought", number: bought.number.phone_number }
      : { kind, status: "failed", error: bought.error, message: bought.message });
  }
  return { ok: true, results };
}
