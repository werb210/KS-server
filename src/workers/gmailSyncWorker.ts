// KS_SERVER_v12_GOOGLE_WORKSPACE - Gmail inbox sync. BUILT BUT OFF.
//
// Reading mail needs gmail.readonly, a RESTRICTED Google scope that requires the yearly CASA security assessment.
// Until GOOGLE_GMAIL_READ_ENABLED=true:
//   - the scope is never requested (services/workspace/googleConfig.ts),
//   - index.ts never starts this worker, and syncGmailOnce() returns without touching the database or Google.
// When switched on (after the assessment), each Google user who has granted gmail.readonly is polled every 3 minutes
// and their mail reaches the CRM exactly as Microsoft 365 mail does:
//   - inbound mail from a CRM contact -> communications_messages (type 'email', direction 'inbound'), the same row
//     mailReplyWorker writes for Outlook, so sequences stop on a reply and the timeline shows it; plus the
//     "New email" notification the Graph mail subscription raises;
//   - mail the user sent from Gmail itself (not the portal) to a CRM contact -> crm_email_log, as the Outlook
//     Sent Items subscription does (sentItemsLog.ts). Portal sends carry the logged-at-send header and are skipped.
import { isNeverLogged, neverLogMatcher } from "../neverLog/neverLog.js"; // KS_SETTINGS_PACK_v1_NEVER_LOG
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { claimedTick } from "./claim.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { gmailReadEnabled, googleConfigProblem, hasScope, SCOPE_GMAIL_READONLY } from "../services/workspace/googleConfig.js";
import { getGoogleForUser, type GoogleClient } from "../services/workspace/googleAuth.js";
import { SENT_LOGGED_HEADER } from "../modules/o365/sentItemsLog.js";

const TICK_MS = 180_000;
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_PER_POLL = 50;

export type GmailHeader = { name?: string; value?: string };
export type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[]; headers?: GmailHeader[] };
export type GmailMessage = { id?: string; threadId?: string; snippet?: string; internalDate?: string; labelIds?: string[]; payload?: GmailPart };

export function header(m: GmailMessage, name: string): string {
  const h = (m.payload?.headers ?? []).find((x) => String(x?.name ?? "").toLowerCase() === name.toLowerCase());
  return String(h?.value ?? "");
}

/** Bare addresses from a header like `"Pat Lee" <pat@x.com>, sam@y.com`. */
export function addresses(value: string): string[] {
  const out: string[] = [];
  for (const m of String(value ?? "").matchAll(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) out.push(m[0].toLowerCase());
  return Array.from(new Set(out));
}

/** The HTML body (or the plain-text body, escaped) of a Gmail message. */
export function bodyHtml(part: GmailPart | undefined): string {
  const find = (p: GmailPart | undefined, type: string): string | null => {
    if (!p) return null;
    if (p.mimeType === type && p.body?.data) return Buffer.from(p.body.data, "base64url").toString("utf8");
    for (const c of p.parts ?? []) { const r = find(c, type); if (r !== null) return r; }
    return null;
  };
  const html = find(part, "text/html");
  if (html !== null) return html;
  const text = find(part, "text/plain") ?? "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br/>");
}

async function gmailJson<T>(g: GoogleClient, path: string): Promise<T> {
  const r = await g.fetch(`${GMAIL}${path}`);
  if (!r.ok) throw new Error(`gmail_${r.status} ${path.split("?")[0]}`);
  return (await r.json()) as T;
}

async function listSince(g: GoogleClient, label: "inbox" | "sent", since: Date): Promise<GmailMessage[]> {
  const q = `in:${label} after:${Math.floor(since.getTime() / 1000)}`;
  const list = await gmailJson<{ messages?: Array<{ id: string }> }>(g, `/messages?${new URLSearchParams({ q, maxResults: String(MAX_PER_POLL) }).toString()}`);
  const out: GmailMessage[] = [];
  for (const { id } of list.messages ?? []) out.push(await gmailJson<GmailMessage>(g, `/messages/${encodeURIComponent(id)}?format=full`));
  return out;
}

async function logInbound(pool: Pool, userId: string, own: string, m: GmailMessage): Promise<boolean> {
  const sender = addresses(header(m, "From"))[0] ?? "";
  const msgId = header(m, "Message-ID") || (m.id ? `gmail:${m.id}` : "");
  if (!sender || sender === own || !msgId) return false;
  if (await isNeverLogged(pool as any, sender)) return false; // KS_SETTINGS_PACK_v1_NEVER_LOG
  const received = m.internalDate ? new Date(Number(m.internalDate)) : new Date();
  const c = await pool.query<{ id: string; silo: string }>(`SELECT id, silo FROM contacts WHERE lower(email) = $1 ORDER BY created_at LIMIT 1`, [sender]);
  const contact = c.rows[0];
  if (!contact) return false;
  const ins = await pool.query(
    `INSERT INTO communications_messages (type, direction, contact_id, body, created_at, silo, from_number, twilio_sid, read_at)
     VALUES ('email','inbound',$1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (twilio_sid) WHERE twilio_sid IS NOT NULL DO NOTHING`,
    [contact.id, String(m.snippet ?? "").slice(0, 2000), received, contact.silo || "BF", sender, msgId],
  );
  if (ins.rowCount) {
    void import("../modules/automation/automationEngine.js")
      .then((mod) => mod.emitAutomationEvent("message.inbound", { silo: contact.silo || "BF", contactId: String(contact.id), data: { channel: "email" } }))
      .catch((err: any) => console.warn("[automation] emit failed", err?.message ?? String(err)));
  }
  void userId;
  return Boolean(ins.rowCount);
}

async function logSent(pool: Pool, userId: string, own: string, m: GmailMessage): Promise<number> {
  if (!m.id || header(m, SENT_LOGGED_HEADER)) return 0; // portal sends were logged when they were sent
  const to = addresses(header(m, "To"));
  const cc = addresses(header(m, "Cc"));
  const never = await neverLogMatcher(pool as any); // KS_SETTINGS_PACK_v1_NEVER_LOG
  const recipients = Array.from(new Set([...to, ...cc])).filter((a) => a !== own && !never(a));
  if (!recipients.length) return 0;
  const owner = await pool.query<{ silo: string | null }>(`SELECT silo FROM users WHERE id = $1 LIMIT 1`, [userId]);
  const silo = owner.rows[0]?.silo || "BF";
  const matched = await pool.query<{ id: string }>(
    `SELECT id FROM contacts WHERE silo = $1 AND (lower(email) = ANY($2::text[]) OR lower(secondary_email) = ANY($2::text[]))`,
    [silo, recipients],
  );
  let written = 0;
  for (const contact of matched.rows) {
    const r = await pool.query(
      `INSERT INTO crm_email_log
         (from_address,to_addresses,cc_addresses,bcc_addresses,subject,body_html,owner_id,contact_id,company_id,silo,gmail_message_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10)
       ON CONFLICT (gmail_message_id, contact_id) WHERE gmail_message_id IS NOT NULL DO NOTHING`,
      [own, to, cc, [], header(m, "Subject"), bodyHtml(m.payload), userId, contact.id, silo, m.id],
    ).catch((err: unknown) => logWarnSwallowed(err, "workers/gmailSyncWorker.ts:sent", { rowCount: 0 }));
    written += r.rowCount ?? 0;
  }
  return written;
}

export async function syncGmailForUser(pool: Pool, userId: string, since: Date): Promise<{ inbound: number; sent: number; until: Date }> {
  const g = await getGoogleForUser(pool, userId);
  if (!g || !hasScope(g.scopes, SCOPE_GMAIL_READONLY)) return { inbound: 0, sent: 0, until: since };
  const own = g.email.toLowerCase();
  let until = since;
  let inbound = 0, sent = 0;
  const bump = (m: GmailMessage) => { const t = Number(m.internalDate ?? 0); if (t > until.getTime()) until = new Date(t); };
  for (const m of await listSince(g, "inbox", since)) {
    bump(m);
    if (await logInbound(pool, userId, own, m)) inbound++;
  }
  if (inbound) {
    const { createNotification } = await import("../modules/notifications/notifications.repo.js");
    await createNotification({ notificationId: randomUUID(), userId, applicationId: null, type: "email_received", title: "New email", body: inbound === 1 ? "You have a new message in your inbox." : `You have ${inbound} new messages in your inbox.`, metadata: { source: "gmail_sync" } })
      .catch((err: unknown) => console.warn("[gmail-sync] notification failed", { message: (err as Error)?.message }));
  }
  for (const m of await listSince(g, "sent", since)) {
    bump(m);
    sent += await logSent(pool, userId, own, m);
  }
  return { inbound, sent, until };
}

/** One pass over every Google user who granted gmail.readonly. A no-op while the read switch is off. */
export async function syncGmailOnce(pool: Pool, env: NodeJS.ProcessEnv = process.env): Promise<{ ran: boolean; users: number }> {
  if (!gmailReadEnabled(env) || googleConfigProblem(env)) return { ran: false, users: 0 };
  const accounts = await pool.query<{ user_id: string; gmail_last_synced_at: Date | string | null }>(
    `SELECT user_id::text AS user_id, gmail_last_synced_at FROM google_workspace_accounts
      WHERE status = 'connected' AND position($1 in scopes) > 0`,
    [SCOPE_GMAIL_READONLY],
  );
  for (const a of accounts.rows) {
    try {
      const since = a.gmail_last_synced_at ? new Date(a.gmail_last_synced_at) : new Date(Date.now() - 24 * 3600 * 1000);
      const r = await syncGmailForUser(pool, a.user_id, since);
      await pool.query(`UPDATE google_workspace_accounts SET gmail_last_synced_at = $2 WHERE user_id = $1::uuid`, [a.user_id, r.until]);
    } catch (err) {
      console.warn("[gmail-sync] user sync failed", { userId: a.user_id, message: (err as Error)?.message });
    }
  }
  return { ran: true, users: accounts.rows.length };
}

export function startGmailSyncWorker(pool: Pool): { stop: () => void } {
  let running = false;
  const tickUnclaimed = async () => {
    if (running) return;
    running = true;
    try { await syncGmailOnce(pool); }
    catch (err) { logWarnSwallowed(err, "workers/gmailSyncWorker.ts:tick"); }
    finally { running = false; }
  };
  const tick = claimedTick("gmail_sync", tickUnclaimed);
  const timer = setInterval(() => void tick(), TICK_MS);
  void tick();
  return { stop: () => clearInterval(timer) };
}
