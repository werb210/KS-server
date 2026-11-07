// KS_SERVER_NUMBER_PORTING_v1 - "Keep your existing phone number".
//
// The brokerage asks to transfer (port) a number it already has into Keystone. Keystone operations (KS-Ops) keeps the
// request, the carrier details (encrypted there), the bill and the signed letter of authorization, and its staff
// submit it to Twilio. This copy only:
//   - tells the portal each person's temporary Keystone number (their direct line, else the main line), so they can
//     forward the old number to it while the transfer runs;
//   - relays the portal's requests to KS-Ops (see routes/portRequests.ts); and
//   - when KS-Ops says the transfer is complete, attaches the number: finds it in this copy's Twilio account, points it
//     at this server like every other number, gives it to the right person (their direct line, so the dialler's
//     caller ID uses it) or makes it the main line, and moves the temporary number into the release grace period
//     (7 days by default, from KS-Ops) with a notice that tells the admins to turn off call forwarding.
// Account numbers and PINs never pass through here except in the relayed request body; they are never logged.
import type { Q } from "../plans/state.js";
import { ACTIVE_STAFF_WHERE } from "../plans/storage.js";
import { mainLineNumberSetting } from "../licensee/connections.js";
import { scheduleRelease, setupStatus, toE164, webhookUrls, type NumberKind, type NumberRow, type Refusal } from "./numbers.js";
import type { TwilioNumbersApi } from "./twilioNumbers.js";

export const PORT_NUMBER_TYPES = ["local", "mobile", "toll_free"] as const;
export type PortNumberType = (typeof PORT_NUMBER_TYPES)[number];

export const DEFAULT_PORT_GRACE_DAYS = 7;

const refuse = (status: number, error: string, message: string): Refusal => ({ ok: false, status, error, message });

export type Person = { id: string; name: string; email: string | null; role: string; temporary_number: string | null; temporary_kind: "direct" | "main" | null };

/** Every active person (Admins, brokers, marketing) with the Keystone number calls to them go to today. */
export async function portingPeople(db: Q, env: NodeJS.ProcessEnv = process.env): Promise<{ people: Person[]; main_line: string | null }> {
  const main = mainLineNumberSetting(env) || null;
  const r = await db.query(
    `SELECT id::text AS id, trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) AS name, email, role, direct_number
       FROM users WHERE ${ACTIVE_STAFF_WHERE} ORDER BY lower(coalesce(first_name, email, '')), id`);
  const people = r.rows.map((u: any): Person => {
    const direct = u.direct_number ? String(u.direct_number) : null;
    return {
      id: String(u.id),
      name: String(u.name || u.email || "Team member"),
      email: u.email ? String(u.email) : null,
      role: String(u.role ?? ""),
      temporary_number: direct ?? main,
      temporary_kind: direct ? "direct" : main ? "main" : null,
    };
  });
  return { people, main_line: main };
}

export type AttachInput = {
  phone_number: unknown;
  number_type: unknown;
  /** The person whose number it is; empty = the brokerage's main (or toll-free) line. */
  user_id?: unknown;
  /** The Keystone number calls were forwarded to while the transfer ran. */
  temporary_number?: unknown;
  port_request_id?: unknown;
  grace_days?: unknown;
  actor: string;
};

export type AttachResult = {
  ok: true;
  number: NumberRow;
  status: "attached" | "already_attached";
  /** The temporary number now waiting out its grace period, if one was released. */
  released: string | null;
  release_after: string | null;
};

async function event(db: Q, id: string | null, name: string, detail: Record<string, unknown>, actor: string): Promise<void> {
  try {
    await db.query(`INSERT INTO phone_number_events (phone_number_id, event, detail, actor) VALUES ($1, $2, $3::jsonb, $4)`,
      [id, name, JSON.stringify(detail), actor]);
  } catch (err) {
    console.error("[porting] event not recorded", { id, event: name, message: (err as Error)?.message ?? String(err) });
  }
}

/** "turn off forwarding" paragraphs, shared by the release notice. */
export function forwardingOffNote(oldNumber: string, temporary: string): string {
  return `Your own number ${oldNumber} now rings in Keystone directly. Turn off the call forwarding you set up on it to ${temporary} ` +
    "(on most landlines dial *73; on most mobiles dial ##21#; or turn it off in your phone system's settings), because the " +
    `temporary number ${temporary} is given back after the grace period.`;
}

/**
 * Attaches a number that finished transferring into this copy's Twilio account. Safe to call again: a number already
 * attached is reported as already_attached and nothing else changes.
 */
export async function attachPortedNumber(db: Q, api: TwilioNumbersApi, input: AttachInput, env: NodeJS.ProcessEnv = process.env, now: Date = new Date())
  : Promise<AttachResult | Refusal> {
  const number = toE164(input.phone_number);
  if (!number) return refuse(400, "invalid_number", "phone_number must be a phone number like +14035550100.");
  const type = String(input.number_type ?? "") as PortNumberType;
  if (!(PORT_NUMBER_TYPES as readonly string[]).includes(type)) return refuse(400, "invalid_number_type", "number_type must be local, mobile or toll_free.");
  const setup = setupStatus(env);
  if (!setup.twilio) return refuse(503, "twilio_not_configured", setup.messages[0]);
  if (!setup.server_url) return refuse(503, "server_url_not_set", setup.messages[0]);
  const userId = String(input.user_id ?? "").trim();
  const temporary = toE164(input.temporary_number);
  const portRef = String(input.port_request_id ?? "").trim().slice(0, 100) || null;
  const graceRaw = Number(input.grace_days);
  const grace = Number.isFinite(graceRaw) && graceRaw >= 1 ? Math.min(365, Math.floor(graceRaw)) : DEFAULT_PORT_GRACE_DAYS;

  let person: { id: string; name: string; direct_number: string | null } | null = null;
  if (userId) {
    const u = await db.query(
      `SELECT id::text AS id, trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) AS name, email, direct_number
         FROM users WHERE id::text = $1 AND ${ACTIVE_STAFF_WHERE} LIMIT 1`, [userId]);
    const row = u.rows[0];
    if (!row) return refuse(400, "invalid_user", "The person this number belongs to is no longer an active user. Choose someone else (or the main line).");
    person = { id: String(row.id), name: String(row.name || row.email || "this person"), direct_number: row.direct_number ?? null };
  }
  const kind: NumberKind = person ? "direct" : type === "toll_free" ? "toll_free" : "main";

  const existing = (await db.query(
    `SELECT * FROM phone_numbers WHERE phone_number = $1 AND status IN ('purchasing', 'active', 'releasing') LIMIT 1`, [number])).rows[0];
  if (existing?.ported && existing.status === "active") {
    return { ok: true, number: existing, status: "already_attached", released: null, release_after: null };
  }
  if (existing) return refuse(409, "number_in_use", `${number} is already one of this brokerage's Keystone numbers.`);

  let owned: { sid: string; phone_number: string } | null;
  try {
    owned = await api.findOwned(number);
  } catch (err) {
    const e = err as { code?: unknown; status?: unknown; message?: string };
    console.error("[porting] twilio lookup failed", { number, code: e?.code ?? null, status: e?.status ?? null, message: e?.message ?? String(err) });
    return refuse(502, "twilio_error", `Twilio could not be asked about ${number}: ${e?.message ?? String(err)}`);
  }
  if (!owned) {
    return refuse(409, "not_in_account", `Twilio does not show ${number} in this brokerage's Twilio account yet. Check that the transfer finished and was made into the brokerage's own sub-account, then try again.`);
  }
  const hooks = webhookUrls(setup.server_url);
  try {
    await api.setWebhooks(owned.sid, hooks);
  } catch (err) {
    const e = err as { code?: unknown; status?: unknown; message?: string };
    console.error("[porting] twilio webhooks not set", { number, sid: owned.sid, code: e?.code ?? null, status: e?.status ?? null, message: e?.message ?? String(err) });
    return refuse(502, "twilio_error", `Twilio did not accept the call and text settings for ${number}: ${e?.message ?? String(err)}`);
  }

  // The temporary number goes into its grace period first, so the person's one live direct line is free for this one.
  const replace = async (row: NumberRow | undefined): Promise<{ released: string | null; releaseAfter: string | null }> => {
    if (!row || row.ported) return { released: null, releaseAfter: null };
    const r = await scheduleRelease(db, String(row.id), {
      reason: `replaced by your own number ${number}, transferred to Keystone`, actor: input.actor, now, env, days: grace,
      extra: [forwardingOffNote(number, row.phone_number)],
    });
    if (r.ok) return { released: String(row.phone_number), releaseAfter: r.number.release_after ? new Date(r.number.release_after).toISOString() : null };
    console.error("[porting] temporary number not scheduled for release", { number: row.phone_number, error: r.error });
    return { released: null, releaseAfter: null };
  };
  let current: NumberRow | undefined;
  if (person) {
    current = (await db.query(
      `SELECT * FROM phone_numbers WHERE kind = 'direct' AND assigned_user_id::text = $1 AND status = 'active' LIMIT 1`, [person.id])).rows[0];
  } else if (temporary) {
    current = (await db.query(
      `SELECT * FROM phone_numbers WHERE phone_number = $1 AND kind = $2 AND status = 'active' LIMIT 1`, [temporary, kind])).rows[0];
  }
  const { released, releaseAfter } = await replace(current);

  let saved: NumberRow;
  try {
    const ins = await db.query(
      `INSERT INTO phone_numbers (phone_number, kind, status, assigned_user_id, purchased_by, twilio_sid, purchased_at, ported, port_request_id, ported_at)
       VALUES ($1, $2, 'active', $3, $4, $5, $6, true, $7, $6) RETURNING *`,
      [owned.phone_number || number, kind, person?.id ?? null, input.actor, owned.sid, now, portRef]);
    saved = ins.rows[0];
  } catch (err) {
    console.error("[porting] transferred number not saved", { number, sid: owned.sid, message: (err as Error)?.message ?? String(err) });
    if ((err as { code?: string })?.code === "23505") return refuse(409, "number_in_use", `${number} (or that person's direct line) is already set up.`);
    throw err;
  }
  await event(db, saved.id, "ported_in", { sid: owned.sid, kind, user_id: person?.id ?? null, port_request_id: portRef, replaced: released, webhooks: hooks }, input.actor);

  if (person) {
    await db.query(`UPDATE users SET direct_number = $2 WHERE id::text = $1`, [person.id, saved.phone_number]);
  } else if (kind === "main" && (!mainLineNumberSetting(env) || mainLineNumberSetting(env) === temporary)) {
    // The brokerage's own number becomes the caller ID for everyone without a direct line.
    const { updateLicenseeSettings } = await import("../licensee/settings.js");
    const r = await updateLicenseeSettings(db as any, { twilio_main_number: saved.phone_number }, input.actor);
    if (!r.ok) console.error("[porting] main line setting not saved", { number: saved.phone_number, errors: r.errors });
  }
  console.log(`[porting] attached ${kind} ${saved.phone_number} (${owned.sid})${person ? ` for user ${person.id}` : ""}${released ? `; ${released} released after ${grace} days` : ""}`);
  return { ok: true, number: saved, status: "attached", released, release_after: releaseAfter };
}
