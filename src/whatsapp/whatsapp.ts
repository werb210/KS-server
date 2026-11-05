// KS_WHATSAPP_v1 - WhatsApp through Twilio (HubSpot gaps batch 2).
// WhatsApp messages sit in the same conversation as texts (communications_messages.type = 'whatsapp').
//   * Inbound: the brokerage's WhatsApp sender in Twilio posts to the same inbound address as texts
//     (/api/webhooks/twilio/sms); a From of "whatsapp:+1..." is filed as WhatsApp.
//   * Outbound: WhatsApp only allows free text within 24 hours of the person's last message to us. Outside that
//     window only an approved template (a Twilio Content template, sent with its ContentSid) may start a conversation.
// Setting (per brokerage, like every TWILIO_ value): TWILIO_WHATSAPP_FROM, the WhatsApp sender, e.g. +18255550100.
import type { Pool } from "pg";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const WINDOW_HOURS = 24;

export function isWhatsApp(addr: unknown): boolean {
  return typeof addr === "string" && addr.toLowerCase().startsWith("whatsapp:");
}

/** "whatsapp:+1780..." -> "+1780..." (anything else unchanged). */
export function stripWhatsApp(addr: string): string {
  return isWhatsApp(addr) ? addr.slice("whatsapp:".length) : addr;
}

/** The sender as Twilio wants it ("whatsapp:+1..."), or null when WhatsApp is not set up. */
export function whatsappFrom(e: NodeJS.ProcessEnv = process.env): string | null {
  const raw = String(e.TWILIO_WHATSAPP_FROM ?? "").trim();
  if (!raw) return null;
  const n = stripWhatsApp(raw).replace(/[^\d+]/g, "");
  return /^\+\d{8,15}$/.test(n) ? `whatsapp:${n}` : null;
}

/** E.164 for a phone number (North American 10 digits get +1), or null. */
export function toE164(phone: unknown): string | null {
  const s = stripWhatsApp(String(phone ?? "").trim());
  const d = s.replace(/\D/g, "");
  if (s.startsWith("+") && d.length >= 8 && d.length <= 15) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

const last10 = (e164: string) => e164.replace(/\D/g, "").slice(-10);

/** When the person last wrote to us on WhatsApp (null = never). */
export async function lastInbound(db: Q, e164: string): Promise<Date | null> {
  const { rows } = await db.query(
    `SELECT max(created_at) AS at FROM communications_messages
      WHERE type = 'whatsapp' AND direction = 'inbound'
        AND right(regexp_replace(coalesce(from_number, ''), '[^0-9]', '', 'g'), 10) = $1`,
    [last10(e164)],
  );
  const at = rows[0]?.at;
  return at ? new Date(at) : null;
}

export type WindowState = { open: boolean; closesAt: string | null; lastInboundAt: string | null };

export function windowState(last: Date | null, now = new Date()): WindowState {
  if (!last) return { open: false, closesAt: null, lastInboundAt: null };
  const closes = new Date(last.getTime() + WINDOW_HOURS * 3600_000);
  return { open: closes > now, closesAt: closes.toISOString(), lastInboundAt: last.toISOString() };
}

export class WhatsAppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

export type SendInput = {
  to: string; contactId: string | null; body?: string | null; contentSid?: string | null;
  contentVariables?: Record<string, string> | null; staffName?: string | null; silo: string;
};

export type TwilioLike = { messages: { create: (o: Record<string, unknown>) => Promise<{ sid: string; status?: string }> } };

/**
 * Sends one WhatsApp message and files it on the conversation. Free text needs the 24-hour window; a template
 * (contentSid HX...) can be sent any time.
 */
export async function sendWhatsApp(db: Q, client: TwilioLike, input: SendInput, opts: { from?: string | null; now?: Date; statusCallback?: string } = {}) {
  const from = opts.from ?? whatsappFrom();
  if (!from) throw new WhatsAppError("whatsapp_not_configured", "WhatsApp is not set up for this brokerage yet.", 503);
  const to = toE164(input.to);
  if (!to) throw new WhatsAppError("invalid_number", "Enter a full phone number with country code.");
  const body = String(input.body ?? "").trim().slice(0, 1600);
  const contentSid = input.contentSid ? String(input.contentSid).trim() : "";
  if (contentSid && !/^HX[0-9a-f]{32}$/i.test(contentSid)) throw new WhatsAppError("bad_template", "Choose an approved template.");
  if (!body && !contentSid) throw new WhatsAppError("body_required", "Type a message or choose a template.");
  if (!contentSid) {
    const w = windowState(await lastInbound(db, to), opts.now);
    if (!w.open) {
      throw new WhatsAppError("window_closed",
        "WhatsApp only allows a free message within 24 hours of the client's last message. Send an approved template to start the conversation.", 409);
    }
  }
  const vars = input.contentVariables && typeof input.contentVariables === "object"
    ? Object.fromEntries(Object.entries(input.contentVariables).slice(0, 20).map(([k, v]) => [String(k).slice(0, 10), String(v ?? "").slice(0, 500)]))
    : null;
  const msg = await client.messages.create({
    from, to: `whatsapp:${to}`,
    ...(contentSid ? { contentSid, ...(vars ? { contentVariables: JSON.stringify(vars) } : {}) } : { body }),
    ...(opts.statusCallback ? { statusCallback: opts.statusCallback } : {}),
  });
  const shown = contentSid ? (body || `Template ${contentSid}`) : body;
  const { rows } = await db.query(
    `INSERT INTO communications_messages
       (id, type, channel, direction, status, contact_id, body, from_number, to_number, phone_number, twilio_sid, staff_name, silo, created_at)
     VALUES (gen_random_uuid(), 'whatsapp', 'whatsapp', 'outbound', $1, $2, $3, $4, $5, $5, $6, $7, $8, now())
     RETURNING id::text AS id, created_at`,
    [msg.status ?? "queued", input.contactId, shown, stripWhatsApp(from), to, msg.sid, input.staffName ?? null, input.silo],
  );
  return { id: rows[0]?.id ?? null, sid: msg.sid, status: msg.status ?? "queued", to };
}

export type Template = { sid: string; name: string; language: string; body: string; variables: string[] };

/** Approved WhatsApp templates from Twilio's Content API. */
export async function approvedTemplates(accountSid: string, authToken: string, f: typeof fetch = fetch): Promise<Template[]> {
  const r = await f("https://content.twilio.com/v1/ContentAndApprovals?PageSize=100", {
    headers: { Authorization: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64") },
  });
  if (!r.ok) throw new WhatsAppError("templates_unavailable", "Could not load WhatsApp templates from Twilio.", 502);
  const data: any = await r.json();
  const out: Template[] = [];
  for (const c of Array.isArray(data?.contents) ? data.contents : []) {
    const status = String(c?.approval_requests?.status ?? c?.approval_requests?.whatsapp?.status ?? "").toLowerCase();
    if (status !== "approved") continue;
    const types = c?.types ?? {};
    const text = String(types["twilio/text"]?.body ?? types["twilio/quick-reply"]?.body ?? types["twilio/call-to-action"]?.body ?? Object.values(types).map((t: any) => t?.body).find(Boolean) ?? "");
    out.push({
      sid: String(c.sid), name: String(c.friendly_name ?? c.sid), language: String(c.language ?? ""),
      body: text, variables: Object.keys(c.variables ?? {}),
    });
  }
  return out;
}

export type { Pool };
