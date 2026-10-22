// KS_SERVER_v8_SUPPORT_TICKETS - support tickets from the licensee's staff to Keystone operations.
// Each ticket is stored here first (support_tickets) and then relayed to KS-Ops (POST /api/licensees/{id}/tickets).
// A relay that fails is kept with its error; the ticket still exists locally and the caller is told it was not sent.
import { brandName } from "../licensee/brand.js";
import { opsConfig, postToOps, type OpsFetch } from "./opsLink.js";
import type { Q } from "./state.js";

export const TICKET_PRIORITIES = ["normal", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export type TicketInput = { subject: string; body: string; priority: TicketPriority };

export function checkTicket(raw: any): { ok: true; value: TicketInput } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const subject = String(raw?.subject ?? "").trim();
  const body = String(raw?.body ?? "").trim();
  const p = raw?.priority === undefined || raw?.priority === null || raw?.priority === "" ? "normal" : String(raw.priority).trim().toLowerCase();
  if (!subject) errors.subject = "required";
  else if (subject.length > 200) errors.subject = "200 characters at most";
  if (!body) errors.body = "required";
  else if (body.length > 10_000) errors.body = "10,000 characters at most";
  if (!(TICKET_PRIORITIES as readonly string[]).includes(p)) errors.priority = "normal or urgent";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { subject, body, priority: p as TicketPriority } };
}

const COLS = "id, created_by, subject, body, priority, status, ops_ticket_id, relayed_at, relay_error, created_at";

export type Author = { id: string; email?: string | null; name?: string | null; role?: string | null };

export async function createTicket(
  db: Q, input: TicketInput, by: Author, opts: { env?: NodeJS.ProcessEnv; fetchImpl?: OpsFetch } = {},
): Promise<{ ticket: Record<string, any>; relayed: boolean; relay_error: string | null }> {
  const ins = await db.query(
    `INSERT INTO support_tickets (created_by, subject, body, priority) VALUES ($1, $2, $3, $4) RETURNING ${COLS}`,
    [by.id || null, input.subject, input.body, input.priority],
  );
  const ticket = ins.rows[0];
  if (!opsConfig(opts.env)) {
    await db.query(`UPDATE support_tickets SET relay_error = $2 WHERE id = $1`, [ticket.id, "ops_not_configured"]);
    console.warn("[support-tickets] not relayed: the operations link is not configured", { id: ticket.id });
    return { ticket: { ...ticket, relay_error: "ops_not_configured" }, relayed: false, relay_error: "ops_not_configured" };
  }
  const r = await postToOps("tickets", {
    local_ticket_id: ticket.id,
    subject: input.subject,
    body: input.body,
    priority: input.priority,
    company_name: brandName(),
    created_by: { id: by.id || null, email: by.email ?? null, name: by.name ?? null, role: by.role ?? null },
    created_at: new Date(ticket.created_at ?? Date.now()).toISOString(),
  }, opts);
  if (!r.ok) {
    console.warn("[support-tickets] relay to operations failed", { id: ticket.id, error: r.error });
    const u = await db.query(`UPDATE support_tickets SET relay_error = $2 WHERE id = $1 RETURNING ${COLS}`, [ticket.id, r.error.slice(0, 500)]);
    return { ticket: u.rows[0] ?? ticket, relayed: false, relay_error: r.error };
  }
  const opsId = r.body?.id ?? r.body?.ticket_id ?? r.body?.ticket?.id ?? null;
  const u = await db.query(
    `UPDATE support_tickets SET ops_ticket_id = $2, relayed_at = now(), relay_error = NULL WHERE id = $1 RETURNING ${COLS}`,
    [ticket.id, opsId == null ? null : String(opsId)],
  );
  return { ticket: u.rows[0] ?? ticket, relayed: true, relay_error: null };
}

export async function listTickets(db: Q, limit = 200): Promise<Record<string, any>[]> {
  const r = await db.query(`SELECT ${COLS} FROM support_tickets ORDER BY created_at DESC LIMIT $1`, [limit]);
  return r.rows;
}
