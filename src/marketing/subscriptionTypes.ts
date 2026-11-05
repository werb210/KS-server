// KS_EMAIL_SUBSCRIPTION_TYPES_v1 - email subscription types (HubSpot gaps batch 2).
// A brokerage sorts its marketing email into types (newsletter, offers, events...). A campaign may name one type;
// it then skips everyone who opted out of that type. Every marketing email carries a link to a preferences page where
// the person picks the types they want, or unsubscribes from all marketing (contacts.marketing_opt_out).
import { createHmac, timingSafeEqual } from "crypto";
import type { Pool } from "pg";
import { serverUrl } from "../licensee/urls.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export type SubscriptionType = { id: string; key: string; name: string; description: string | null; active: boolean; sort_order: number };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function listTypes(db: Q, silo: string, includeInactive = false): Promise<SubscriptionType[]> {
  const { rows } = await db.query(
    `SELECT id::text AS id, key, name, description, active, sort_order
       FROM email_subscription_types
      WHERE silo = $1 AND ($2::boolean OR active)
      ORDER BY sort_order, name`,
    [silo, includeInactive],
  );
  return rows as SubscriptionType[];
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "type";
}

export class SubscriptionTypeError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

export async function saveType(
  db: Q, silo: string, input: { id?: unknown; name?: unknown; description?: unknown; active?: unknown; sort_order?: unknown },
): Promise<SubscriptionType> {
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 80) : "";
  if (!name) throw new SubscriptionTypeError("name_required", "Give the type a name.");
  const description = typeof input.description === "string" ? input.description.trim().slice(0, 300) || null : null;
  const active = input.active !== false;
  const sort = Number.isFinite(Number(input.sort_order)) ? Math.round(Number(input.sort_order)) : 100;
  if (input.id !== undefined && input.id !== null && input.id !== "") {
    const id = String(input.id);
    if (!UUID_RE.test(id)) throw new SubscriptionTypeError("bad_id", "Unknown type.", 404);
    const { rows } = await db.query(
      `UPDATE email_subscription_types SET name = $3, description = $4, active = $5, sort_order = $6, updated_at = now()
        WHERE id = $1::uuid AND silo = $2
        RETURNING id::text AS id, key, name, description, active, sort_order`,
      [id, silo, name, description, active, sort],
    );
    if (!rows[0]) throw new SubscriptionTypeError("not_found", "Unknown type.", 404);
    return rows[0];
  }
  const { rows } = await db.query(
    `INSERT INTO email_subscription_types (silo, key, name, description, active, sort_order)
     VALUES ($1, $2 || CASE WHEN EXISTS (SELECT 1 FROM email_subscription_types WHERE silo = $1 AND key = $2)
                            THEN '-' || substr(md5(random()::text), 1, 4) ELSE '' END, $3, $4, $5, $6)
     RETURNING id::text AS id, key, name, description, active, sort_order`,
    [silo, slug(name), name, description, active, sort],
  );
  return rows[0];
}

/** A campaign's type: a known, active type of this silo, else null (a bad id is refused). */
export async function campaignType(db: Q, silo: string, raw: unknown): Promise<string | null> {
  if (raw === undefined || raw === null || raw === "") return null;
  const id = String(raw);
  if (!UUID_RE.test(id)) throw new SubscriptionTypeError("bad_subscription_type", "Choose an email type from the list.");
  const { rows } = await db.query(
    `SELECT id::text AS id FROM email_subscription_types WHERE id = $1::uuid AND silo = $2 AND active`,
    [id, silo],
  );
  if (!rows[0]) throw new SubscriptionTypeError("bad_subscription_type", "Choose an email type from the list.");
  return id;
}

/** SQL (for a query aliasing contacts as c) that drops people who opted out of the type in parameter $n. */
export function notOptedOutSql(n: number): string {
  return `AND ($${n}::uuid IS NULL OR NOT EXISTS (
            SELECT 1 FROM contact_subscription_optouts o WHERE o.contact_id = c.id AND o.type_id = $${n}::uuid))`;
}

// ---- Preferences link ------------------------------------------------------------------------------------------

function secret(): string {
  const s = process.env.JWT_SECRET || "";
  if (!s) throw new Error("JWT_SECRET is not set");
  return "email-preferences:" + s;
}

function sign(contactId: string): string {
  return createHmac("sha256", secret()).update(contactId).digest("base64url").slice(0, 32);
}

export function preferencesToken(contactId: string): string {
  return `${contactId}.${sign(contactId)}`;
}

/** The contact id inside a valid token, else null. */
export function contactFromToken(token: string): string | null {
  const [id, sig] = String(token ?? "").split(".");
  if (!id || !sig || !UUID_RE.test(id)) return null;
  const want = Buffer.from(sign(id));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? id : null;
}

export function preferencesUrl(contactId: string): string {
  return `${serverUrl().replace(/\/+$/, "")}/api/public/email-preferences/${preferencesToken(contactId)}`;
}

/**
 * Puts the person's preferences link into a marketing email: {{preferences_url}} where the template has it,
 * otherwise a short footer line before </body> (or at the end).
 */
export function withPreferencesLink(html: string, contactId: string): string {
  let url: string;
  try { url = preferencesUrl(contactId); } catch { return html; }
  if (html.includes("{{preferences_url}}")) return html.split("{{preferences_url}}").join(url);
  const footer =
    `<p style="font-family:Arial,sans-serif;font-size:12px;color:#4b5563;text-align:center;margin:16px 0">` +
    `<a href="${url}" style="color:#1f2937">Choose which emails you get, or unsubscribe</a></p>`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, footer + "</body>") : html + footer;
}

// ---- What one person has chosen --------------------------------------------------------------------------------

export type PersonChoices = {
  contact: { id: string; silo: string; email: string | null; first_name: string | null };
  allOff: boolean;
  types: Array<SubscriptionType & { subscribed: boolean }>;
};

export async function choicesFor(db: Q, contactId: string): Promise<PersonChoices | null> {
  const c = await db.query(
    `SELECT id::text AS id, silo, email, COALESCE(NULLIF(first_name, ''), split_part(COALESCE(name, ''), ' ', 1)) AS first_name,
            COALESCE(marketing_opt_out, false) AS opt_out
       FROM contacts WHERE id = $1::uuid`,
    [contactId],
  );
  const row = c.rows[0];
  if (!row) return null;
  const types = await listTypes(db, row.silo);
  const outs = await db.query(`SELECT type_id::text AS type_id FROM contact_subscription_optouts WHERE contact_id = $1::uuid`, [contactId]);
  const off = new Set(outs.rows.map((r: any) => String(r.type_id)));
  return {
    contact: { id: row.id, silo: row.silo, email: row.email, first_name: row.first_name || null },
    allOff: row.opt_out === true,
    types: types.map((t) => ({ ...t, subscribed: !row.opt_out && !off.has(t.id) })),
  };
}

/** Saves the person's choices. `all_off` unsubscribes from every marketing email; otherwise it is cleared. */
export async function saveChoices(db: Q, contactId: string, input: { all_off?: unknown; subscribed?: unknown }): Promise<PersonChoices | null> {
  const before = await choicesFor(db, contactId);
  if (!before) return null;
  const allOff = input.all_off === true || input.all_off === "1" || input.all_off === "on";
  const wanted = new Set((Array.isArray(input.subscribed) ? input.subscribed : input.subscribed ? [input.subscribed] : []).map(String));
  await db.query(`UPDATE contacts SET marketing_opt_out = $2, updated_at = now() WHERE id = $1::uuid`, [contactId, allOff]);
  for (const t of before.types) {
    if (allOff || wanted.has(t.id)) {
      if (!allOff) await db.query(`DELETE FROM contact_subscription_optouts WHERE contact_id = $1::uuid AND type_id = $2::uuid`, [contactId, t.id]);
    } else {
      await db.query(
        `INSERT INTO contact_subscription_optouts (contact_id, type_id, source) VALUES ($1::uuid, $2::uuid, 'preferences_page')
         ON CONFLICT (contact_id, type_id) DO NOTHING`,
        [contactId, t.id],
      );
    }
  }
  await db.query(
    `INSERT INTO crm_timeline_events (contact_id, event_type, payload) VALUES ($1, 'email_preferences_updated', $2)`,
    [contactId, JSON.stringify({ all_off: allOff, subscribed: before.types.filter((t) => !allOff && wanted.has(t.id)).map((t) => t.name) })],
  );
  return choicesFor(db, contactId);
}

export type { Pool };
