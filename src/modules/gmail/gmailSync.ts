// KS_SERVER_GMAIL_INBOX - Gmail inbox reading, at the level of the Microsoft 365 (Outlook) sync. BUILT BUT OFF.
//
// Off until KS_GOOGLE_GMAIL_READ_ENABLED=true (written by KS-Ops after Google's CASA assessment): gmail.readonly is
// never requested, no sync runs, and Connections says "Gmail inbox reading is pending Google's security review".
//
// When on, for each person who connected Google AND granted gmail.readonly (they reconnect once):
//   - First sync ("history sync"): the last KS_GMAIL_HISTORY_DAYS days (default 30, at most 500 messages), then the
//     person's Gmail history id is stored.
//   - Incremental sync: Gmail's history API from that id (messages added to INBOX / SENT). Polled every 2 minutes; with
//     Gmail push set up (KS_GOOGLE_PUBSUB_TOPIC) a push wakes the sync at once. When Google no longer has history that
//     old (about a week) it falls back to a 7-day sync, so nothing is lost.
//   - Mail FROM a CRM contact -> the contact's timeline (communications_messages, inbound email, the same row the
//     Outlook reply poller writes, linked to the contact's latest application), so sequences stop on a reply, the
//     "message received" automation fires, and the person gets a "New email" notification (like the Graph inbox
//     subscription).
//   - Mail the person sent from Gmail itself (phone, gmail.com) TO a CRM contact -> crm_email_log, like Outlook's Sent
//     Items subscription. Portal sends carry X-Boreal-Logged and were logged when sent.
//   - Attachments on mail from a CRM contact are filed to that contact's documents (contact_documents, like Outlook's
//     inbound attachment worker / "file to CRM"), with the same attempt ledger and 25 MB cap.
//   - "Read: <subject>" receipts stamp opened_at on the original email (like the Outlook read-receipt worker).
//   - Threads: every logged message keeps its Gmail thread id (gmail_messages, crm_email_log.gmail_thread_id).
// Only messages that match a CRM contact are stored; the rest of the mailbox is never copied. The never-log list
// applies throughout.
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { isNeverLogged, neverLogMatcher } from "../../neverLog/neverLog.js";
import { logWarnSwallowed } from "../../lib/logWarnSwallowed.js";
import { getStorage } from "../../lib/storage/index.js";
import { SENT_LOGGED_HEADER } from "../o365/sentItemsLog.js";
import { gmailReadEnabled, googleConfigProblem, hasScope, SCOPE_GMAIL_READONLY } from "../../services/workspace/googleConfig.js";
import { getGoogleForUser, type GoogleClient } from "../../services/workspace/googleAuth.js";
import {
  addresses, bodyHtml, directionOf, fileAttachments, getAttachment, getMessage, getProfile,
  GmailApiError, header, listHistory, listMessageIds, type GmailMessage,
} from "./gmailApi.js";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const FIRST_SYNC_CAP = 500;
const RESYNC_DAYS = 7;
const READ_PREFIX = /^read:\s*/i;

export function historyDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(String(env.KS_GMAIL_HISTORY_DAYS ?? "").trim());
  return Number.isFinite(n) && n >= 1 && n <= 365 ? Math.floor(n) : 30;
}

type Contact = { id: string; silo: string; email: string | null; secondary_email: string | null };

async function contactsFor(pool: Pool, silo: string | null, emails: string[]): Promise<Contact[]> {
  if (!emails.length) return [];
  const r = await pool.query<Contact>(
    `SELECT id::text AS id, silo, lower(email) AS email, lower(secondary_email) AS secondary_email FROM contacts
      WHERE ($1::text IS NULL OR silo = $1) AND (lower(email) = ANY($2::text[]) OR lower(secondary_email) = ANY($2::text[]))
      ORDER BY created_at`,
    [silo, emails],
  );
  return r.rows;
}

/** The contact's most recently updated application (the deal the email is about), or null. */
export async function applicationFor(pool: Pool, contactId: string): Promise<string | null> {
  const r = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM applications WHERE contact_id = $1 ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [contactId],
  );
  return r.rows[0]?.id ?? null;
}

async function alreadyLogged(pool: Pool, userId: string, gmailId: string): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM gmail_messages WHERE user_id = $1 AND gmail_id = $2`, [userId, gmailId]);
  return r.rows.length > 0;
}

async function recordMessage(pool: Pool, userId: string, m: GmailMessage, direction: "inbound" | "outbound", contact: Contact | null, applicationId: string | null): Promise<boolean> {
  const r = await pool.query(
    `INSERT INTO gmail_messages
       (user_id, gmail_id, thread_id, rfc_message_id, in_reply_to, direction, from_address, to_addresses, cc_addresses,
        subject, snippet, internal_date, has_attachments, contact_id, application_id, silo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (user_id, gmail_id) DO NOTHING`,
    [
      userId, m.id, m.threadId ?? null, header(m, "Message-ID") || null, header(m, "In-Reply-To") || null, direction,
      addresses(header(m, "From"))[0] ?? null, addresses(header(m, "To")), addresses(header(m, "Cc")),
      header(m, "Subject").slice(0, 998), String(m.snippet ?? "").slice(0, 2000),
      m.internalDate ? new Date(Number(m.internalDate)) : null, fileAttachments(m).length > 0,
      contact?.id ?? null, applicationId, contact?.silo || "BF",
    ],
  );
  return Boolean(r.rowCount);
}

// ---------------------------------------------------------------- attachments (file to CRM)

export type FileResult = { filed: number; duplicates: number; skipped: number; contactId: string | null; reason?: "no_attachments" | "no_contact" | "never_log" };

async function ledgerSkip(pool: Pool, silo: string, messageId: string): Promise<boolean> {
  try {
    const r = await pool.query<{ attempts: number; last_outcome: string | null }>(
      `SELECT attempts, last_outcome FROM inbound_attachment_attempts WHERE silo = $1 AND message_id = $2`, [silo, messageId],
    );
    const row = r.rows[0];
    if (!row) return false;
    return row.last_outcome === "filed" || row.last_outcome === "terminal" || Number(row.attempts ?? 0) >= 3;
  } catch (err) {
    logWarnSwallowed(err, "gmail:attachment-ledger-read");
    return false;
  }
}

async function ledgerRecord(pool: Pool, silo: string, messageId: string, outcome: string): Promise<void> {
  await pool.query(
    `INSERT INTO inbound_attachment_attempts (silo, message_id, attempts, last_outcome, last_attempt_at) VALUES ($1, $2, 1, $3, now())
     ON CONFLICT (silo, message_id) DO UPDATE SET attempts = inbound_attachment_attempts.attempts + 1, last_outcome = EXCLUDED.last_outcome, last_attempt_at = now()`,
    [silo, messageId, outcome],
  ).catch((err: unknown) => logWarnSwallowed(err, "gmail:attachment-ledger-write"));
}

/**
 * Files a Gmail message's attachments to a contact's documents. Inline images and files over 25 MB are skipped; the
 * insert de-duplicates on (silo, source_message_id, filename), so running it again is safe. `only` files one
 * attachment (its position among the message's attachments).
 */
export async function fileGmailAttachments(pool: Pool, g: GoogleClient, m: GmailMessage, contactId: string, silo: string, only?: number): Promise<FileResult> {
  const atts = fileAttachments(m);
  if (!atts.length || !m.id) return { filed: 0, duplicates: 0, skipped: 0, contactId, reason: "no_attachments" };
  const storage = getStorage();
  let filed = 0, duplicates = 0, skipped = 0;
  for (const [i, a] of atts.entries()) {
    if (only !== undefined && i !== only) continue;
    if (a.size > MAX_ATTACHMENT_BYTES) { skipped++; continue; }
    const got = await getAttachment(g, m.id, a.attachmentId);
    const buffer = Buffer.from(String(got.data ?? ""), "base64url");
    if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES) { skipped++; continue; }
    const put = await storage.put({ buffer, filename: a.filename, contentType: a.mimeType, pathPrefix: `contact-docs/${silo.toLowerCase()}/${contactId}` });
    const ins = await pool.query(
      `INSERT INTO contact_documents (contact_id, silo, filename, content_type, size_bytes, blob_name, blob_url, source, source_message_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'email',$8)
       ON CONFLICT (silo, source_message_id, filename) WHERE source_message_id IS NOT NULL DO NOTHING`,
      [contactId, silo, a.filename, a.mimeType, buffer.length, put.blobName, put.url ?? null, `gmail:${m.id}`],
    );
    if ((ins.rowCount ?? 0) > 0) filed++; else duplicates++;
  }
  return { filed, duplicates, skipped, contactId };
}

// ---------------------------------------------------------------- one message

export type MessageOutcome = "inbound" | "outbound" | "receipt" | "skipped";

async function logInbound(pool: Pool, g: GoogleClient, userId: string, own: string, m: GmailMessage, stats: SyncStats): Promise<MessageOutcome> {
  const fromHeader = header(m, "From");
  const sender = addresses(fromHeader)[0] ?? "";
  if (!sender || sender === own) return "skipped";
  if (await isNeverLogged(pool as any, sender)) return "skipped";
  const subject = header(m, "Subject");

  // A read receipt for an email this person sent: stamp the original as opened (tracking parity with Outlook).
  if (READ_PREFIX.test(subject)) {
    const original = subject.replace(READ_PREFIX, "").trim();
    const when = m.internalDate ? new Date(Number(m.internalDate)) : new Date();
    const r = await pool.query(
      `UPDATE crm_email_log SET opened_at = $3
        WHERE owner_id = $1 AND opened_at IS NULL AND lower(subject) = lower($2)
          AND EXISTS (SELECT 1 FROM unnest(to_addresses) t WHERE lower(t) = $4)`,
      [userId, original, when, sender],
    );
    if (r.rowCount) { stats.receipts++; return "receipt"; }
  }

  const [contact] = await contactsFor(pool, null, [sender]);
  if (!contact) return "skipped";
  const applicationId = await applicationFor(pool, contact.id);
  if (!(await recordMessage(pool, userId, m, "inbound", contact, applicationId))) return "skipped";
  const received = m.internalDate ? new Date(Number(m.internalDate)) : new Date();
  const msgId = header(m, "Message-ID") || `gmail:${m.id}`;
  const ins = await pool.query(
    `INSERT INTO communications_messages (id, type, direction, contact_id, application_id, body, created_at, silo, from_number, twilio_sid, channel, read_at)
     VALUES (gen_random_uuid(), 'email', 'inbound', $1, $2, $3, $4, $5, $6, $7, 'gmail', now())
     ON CONFLICT (twilio_sid) WHERE twilio_sid IS NOT NULL DO NOTHING`,
    [contact.id, applicationId, [subject, String(m.snippet ?? "")].filter(Boolean).join(" - ").slice(0, 2000), received, contact.silo || "BF", sender, msgId],
  );
  if (ins.rowCount) {
    stats.inbound++;
    void import("../automation/automationEngine.js")
      .then((mod) => mod.emitAutomationEvent("message.inbound", { silo: contact.silo || "BF", contactId: contact.id, data: { channel: "email" } }))
      .catch((err: any) => console.warn("[automation] emit failed", err?.message ?? String(err)));
  }
  // Attachments from a CRM contact go to their documents (Outlook's inbound attachment worker does the same).
  if (fileAttachments(m).length && m.id) {
    const ledgerId = `gmail:${m.id}`;
    if (!(await ledgerSkip(pool, contact.silo || "BF", ledgerId))) {
      try {
        const r = await fileGmailAttachments(pool, g, m, contact.id, contact.silo || "BF");
        stats.attachments += r.filed;
        await pool.query(`UPDATE gmail_messages SET attachments_filed = $3 WHERE user_id = $1 AND gmail_id = $2`, [userId, m.id, r.filed + r.duplicates]);
        await ledgerRecord(pool, contact.silo || "BF", ledgerId, r.filed > 0 || r.duplicates > 0 ? "filed" : "terminal");
      } catch (err) {
        console.warn("[gmail-sync] attachment filing failed", { userId, messageId: m.id, message: (err as Error)?.message });
        await ledgerRecord(pool, contact.silo || "BF", ledgerId, "retryable");
      }
    }
  }
  return "inbound";
}

async function logOutbound(pool: Pool, userId: string, own: string, m: GmailMessage, stats: SyncStats): Promise<MessageOutcome> {
  if (!m.id || header(m, SENT_LOGGED_HEADER)) return "skipped"; // portal sends were logged when they were sent
  const to = addresses(header(m, "To"));
  const cc = addresses(header(m, "Cc"));
  const never = await neverLogMatcher(pool as any);
  const recipients = Array.from(new Set([...to, ...cc])).filter((a) => a !== own && !never(a));
  if (!recipients.length) return "skipped";
  const owner = await pool.query<{ silo: string | null }>(`SELECT silo FROM users WHERE id = $1 LIMIT 1`, [userId]);
  const silo = owner.rows[0]?.silo || "BF";
  const matched = await contactsFor(pool, silo, recipients);
  if (!matched.length) return "skipped";
  const first = matched[0]!;
  if (!(await recordMessage(pool, userId, m, "outbound", first, await applicationFor(pool, first.id)))) return "skipped";
  for (const contact of matched) {
    const r = await pool.query(
      `INSERT INTO crm_email_log
         (from_address,to_addresses,cc_addresses,bcc_addresses,subject,body_html,owner_id,contact_id,company_id,silo,gmail_message_id,gmail_thread_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10,$11)
       ON CONFLICT (gmail_message_id, contact_id) WHERE gmail_message_id IS NOT NULL DO NOTHING`,
      [own, to, cc, [], header(m, "Subject"), bodyHtml(m.payload), userId, contact.id, silo, m.id, m.threadId ?? null],
    );
    stats.outbound += r.rowCount ?? 0;
  }
  return "outbound";
}

export type SyncStats = { mode: "first" | "incremental" | "resync" | "none"; seen: number; inbound: number; outbound: number; receipts: number; attachments: number };

/** One message: decides direction, de-duplicates, and logs it. Exported for tests. */
export async function processMessage(pool: Pool, g: GoogleClient, userId: string, m: GmailMessage, stats: SyncStats): Promise<MessageOutcome> {
  if (!m.id) return "skipped";
  const direction = directionOf(m);
  if (!direction) return "skipped";
  if (await alreadyLogged(pool, userId, m.id)) return "skipped";
  const own = g.email.toLowerCase();
  return direction === "inbound" ? logInbound(pool, g, userId, own, m, stats) : logOutbound(pool, userId, own, m, stats);
}

// ---------------------------------------------------------------- one person

const running = new Set<string>();

/**
 * Syncs one person's Gmail. First run: history sync by date; later: Gmail history from the stored id. Returns what
 * happened (mode "none" when the person has not granted gmail.readonly, or a sync for them is already running).
 */
export async function syncGmailAccount(pool: Pool, userId: string, env: NodeJS.ProcessEnv = process.env): Promise<SyncStats> {
  const stats: SyncStats = { mode: "none", seen: 0, inbound: 0, outbound: 0, receipts: 0, attachments: 0 };
  if (running.has(userId)) return stats;
  running.add(userId);
  try {
    const g = await getGoogleForUser(pool, userId);
    if (!g || !hasScope(g.scopes, SCOPE_GMAIL_READONLY)) return stats;
    const acc = await pool.query<{ gmail_history_id: string | null }>(
      `SELECT gmail_history_id FROM google_workspace_accounts WHERE user_id = $1::uuid`, [userId],
    );
    let historyId = acc.rows[0]?.gmail_history_id ?? null;
    let ids: string[];
    if (historyId) {
      try {
        const h = await listHistory(g, historyId);
        ids = h.ids;
        historyId = h.historyId;
        stats.mode = "incremental";
      } catch (err) {
        if (!(err instanceof GmailApiError && err.status === 404)) throw err;
        // Google has no history that old any more: catch up from a date instead.
        historyId = String((await getProfile(g)).historyId ?? "") || null;
        ids = await listMessageIds(g, `newer_than:${RESYNC_DAYS}d -in:chats`, FIRST_SYNC_CAP);
        stats.mode = "resync";
      }
    } else {
      historyId = String((await getProfile(g)).historyId ?? "") || null;
      ids = await listMessageIds(g, `newer_than:${historyDays(env)}d -in:chats -in:spam -in:trash`, FIRST_SYNC_CAP);
      stats.mode = "first";
    }
    // Oldest first, so the timeline and notifications follow the order mail arrived.
    for (const id of [...ids].reverse()) {
      stats.seen++;
      try {
        if (await alreadyLogged(pool, userId, id)) continue;
        await processMessage(pool, g, userId, await getMessage(g, id), stats);
      } catch (err) {
        if (err instanceof GmailApiError && err.status === 404) continue; // deleted since it was listed
        console.warn("[gmail-sync] message failed", { userId, id, message: (err as Error)?.message });
      }
    }
    await pool.query(
      `UPDATE google_workspace_accounts
          SET gmail_history_id = COALESCE($2, gmail_history_id), gmail_last_synced_at = now(), gmail_last_error = NULL,
              gmail_initial_sync_at = COALESCE(gmail_initial_sync_at, now())
        WHERE user_id = $1::uuid`,
      [userId, historyId],
    );
    if (stats.inbound && stats.mode !== "first") {
      const { createNotification } = await import("../notifications/notifications.repo.js");
      await createNotification({
        notificationId: randomUUID(), userId, applicationId: null, type: "email_received", title: "New email",
        body: stats.inbound === 1 ? "You have a new message from a client." : `You have ${stats.inbound} new messages from clients.`,
        metadata: { source: "gmail_sync" },
      }).catch((err: unknown) => console.warn("[gmail-sync] notification failed", { message: (err as Error)?.message }));
    }
    return stats;
  } catch (err) {
    await pool.query(`UPDATE google_workspace_accounts SET gmail_last_error = $2 WHERE user_id = $1::uuid`, [userId, String((err as Error)?.message ?? err).slice(0, 500)])
      .catch((e: unknown) => logWarnSwallowed(e, "gmail:last-error"));
    throw err;
  } finally {
    running.delete(userId);
  }
}

/** One pass over every Google user who granted gmail.readonly. A no-op (no database, no Google) while the switch is off. */
export async function syncAllGmail(pool: Pool, env: NodeJS.ProcessEnv = process.env): Promise<{ ran: boolean; users: number }> {
  if (!gmailReadEnabled(env) || googleConfigProblem(env)) return { ran: false, users: 0 };
  const accounts = await pool.query<{ user_id: string }>(
    `SELECT user_id::text AS user_id FROM google_workspace_accounts WHERE status = 'connected' AND position($1 in scopes) > 0`,
    [SCOPE_GMAIL_READONLY],
  );
  for (const a of accounts.rows) {
    try { await syncGmailAccount(pool, a.user_id, env); }
    catch (err) { console.warn("[gmail-sync] user sync failed", { userId: a.user_id, message: (err as Error)?.message }); }
  }
  return { ran: true, users: accounts.rows.length };
}

