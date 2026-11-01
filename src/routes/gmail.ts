// KS_SERVER_GMAIL_INBOX - /api/google/gmail: a Google user's own inbox in the portal, like the Outlook inbox
// (/api/crm/inbox). Every route answers 409 gmail_read_pending while inbox reading is switched off.
//   GET  /status                                   switch, whether this person granted read access, last sync, errors
//   GET  /threads?q=&label=INBOX&pageToken=        thread list (subject, from, date, snippet, unread), read live from Gmail
//   GET  /threads/:id                              the thread's messages (body, attachments) and the sender's CRM contact
//   GET  /messages/:id/attachments/:index          download one attachment (index = its position in the message)
//   POST /messages/:id/file-to-crm { attachment? } file the attachments (or one) to the sender's contact (created if new)
//   POST /sync                                     sync this person's Gmail to the CRM now
// The mailbox is the signed-in person's own; nothing here reads anyone else's.
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { GMAIL_READ_PENDING_MESSAGE, gmailReadEnabled, hasScope, SCOPE_GMAIL_READONLY } from "../services/workspace/googleConfig.js";
import { getGoogleForUser, type GoogleClient } from "../services/workspace/googleAuth.js";
import { createContact } from "../services/contacts.js";
import {
  addresses, displayName, fileAttachments, getAttachment, getMessage, getThread, gmailJson, GmailApiError, header, listThreads,
  toPortalMessage, type GmailMessage,
} from "../modules/gmail/gmailApi.js";
import { fileGmailAttachments, syncGmailAccount } from "../modules/gmail/gmailSync.js";
import { pushTopic } from "../modules/gmail/gmailPush.js";

const router = Router();
router.use(requireAuth);

const uidOf = (req: any) => String(req.user?.id ?? req.user?.userId ?? req.user?.sub ?? "");
const RECONNECT = "Reconnect Google in My Profile and allow Keystone to read your inbox.";

router.use((req: any, res: any, next: any) => {
  if (gmailReadEnabled()) return next();
  res.status(409).json({ ok: false, error: "gmail_read_pending", message: GMAIL_READ_PENDING_MESSAGE });
});

/** The person's Google client with read access, or the refusal has been sent. */
async function readerOr412(req: any, res: any): Promise<GoogleClient | null> {
  const g = await getGoogleForUser(pool, uidOf(req));
  if (!g) { res.status(412).json({ ok: false, error: "google_not_connected", message: "Connect Google in My Profile first." }); return null; }
  if (!hasScope(g.scopes, SCOPE_GMAIL_READONLY)) { res.status(412).json({ ok: false, error: "gmail_reconnect_required", message: RECONNECT }); return null; }
  return g;
}

function gmailFailure(res: any, err: unknown): void {
  if (err instanceof GmailApiError) {
    res.status(err.status === 404 ? 404 : 502).json({ ok: false, error: err.status === 404 ? "not_found" : "gmail_failed", message: err.status === 404 ? "That email is no longer in Gmail." : "Gmail did not answer. Try again in a moment." });
    return;
  }
  throw err;
}

router.get("/status", safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  const r = await pool.query(
    `SELECT scopes, status, gmail_last_synced_at, gmail_initial_sync_at, gmail_last_error, gmail_watch_expires_at
       FROM google_workspace_accounts WHERE user_id = $1::uuid`, [uidOf(req)],
  );
  const row = r.rows[0];
  const granted = Boolean(row && hasScope(row.scopes, SCOPE_GMAIL_READONLY));
  res.json({
    ok: true,
    enabled: true,
    connected: row?.status === "connected",
    granted,
    message: !row ? "Connect Google in My Profile to see your Gmail here." : granted ? null : RECONNECT,
    last_synced_at: row?.gmail_last_synced_at ?? null,
    first_sync_done: Boolean(row?.gmail_initial_sync_at),
    last_error: row?.gmail_last_error ?? null,
    push: Boolean(pushTopic()) && Boolean(row?.gmail_watch_expires_at && new Date(row.gmail_watch_expires_at).getTime() > Date.now()),
  });
}));

router.get("/threads", safeHandler(async (req: any, res: any) => {
  const g = await readerOr412(req, res);
  if (!g) return;
  const label = /^[A-Z_]{1,40}$/.test(String(req.query.label ?? "")) ? String(req.query.label) : "INBOX";
  const q = typeof req.query.q === "string" ? req.query.q.slice(0, 300) : undefined;
  const pageToken = typeof req.query.pageToken === "string" ? req.query.pageToken : undefined;
  try {
    const list = await listThreads(g, { q, label, pageToken, max: 25 });
    const threads = [];
    for (const t of list.threads ?? []) {
      const meta = await gmailJson<{ messages?: GmailMessage[] }>(g, `/threads/${encodeURIComponent(t.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
      const msgs = meta.messages ?? [];
      const last = msgs[msgs.length - 1];
      threads.push({
        id: t.id,
        subject: header(msgs[0], "Subject") || "(no subject)",
        from: displayName(header(last, "From")) || addresses(header(last, "From"))[0] || "",
        date: last?.internalDate ? new Date(Number(last.internalDate)).toISOString() : null,
        snippet: t.snippet ?? last?.snippet ?? "",
        messages: msgs.length,
        unread: msgs.some((m) => (m.labelIds ?? []).includes("UNREAD")),
      });
    }
    res.json({ ok: true, threads, nextPageToken: list.nextPageToken ?? null });
  } catch (err) { gmailFailure(res, err); }
}));

router.get("/threads/:id", safeHandler(async (req: any, res: any) => {
  const g = await readerOr412(req, res);
  if (!g) return;
  try {
    const t = await getThread(g, String(req.params.id));
    const messages = (t.messages ?? []).map(toPortalMessage);
    const others = Array.from(new Set(messages.flatMap((m) => [m.fromAddress, ...m.to, ...m.cc]).filter((a) => a && a !== g.email.toLowerCase())));
    const contacts = others.length
      ? (await pool.query(`SELECT id::text AS id, name, lower(email) AS email FROM contacts WHERE silo = $1 AND lower(email) = ANY($2::text[])`, [resolveSiloFromRequest(req), others])).rows
      : [];
    const logged = (await pool.query(`SELECT gmail_id FROM gmail_messages WHERE user_id = $1 AND thread_id = $2`, [uidOf(req), String(req.params.id)])).rows.map((r: any) => r.gmail_id);
    res.json({ ok: true, id: t.id, messages: messages.map((m) => ({ ...m, logged: logged.includes(m.id) })), contacts });
  } catch (err) { gmailFailure(res, err); }
}));

router.get("/messages/:id/attachments/:index", safeHandler(async (req: any, res: any) => {
  const g = await readerOr412(req, res);
  if (!g) return;
  try {
    const m = await getMessage(g, String(req.params.id));
    const a = fileAttachments(m)[Number(req.params.index)];
    if (!a) return res.status(404).json({ ok: false, error: "not_found" });
    const got = await getAttachment(g, String(m.id), a.attachmentId);
    const buf = Buffer.from(String(got.data ?? ""), "base64url");
    res.setHeader("Content-Type", a.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${a.filename.replace(/["\\\r\n]/g, "_")}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(buf);
  } catch (err) { gmailFailure(res, err); }
}));

router.post("/messages/:id/file-to-crm", safeHandler(async (req: any, res: any) => {
  const g = await readerOr412(req, res);
  if (!g) return;
  try {
    const m = await getMessage(g, String(req.params.id));
    if (!fileAttachments(m).length) return res.json({ ok: true, filed: 0, duplicates: 0, contactId: null, reason: "no_attachments" });
    const fromHeader = header(m, "From");
    const sender = addresses(fromHeader)[0] ?? "";
    if (!sender) return res.json({ ok: true, filed: 0, contactId: null, reason: "no_contact" });
    const silo = resolveSiloFromRequest(req);
    // Like Outlook's "Save to CRM": the sender's contact in this silo, created when there is none yet.
    let contactId = (await pool.query(`SELECT id::text AS id FROM contacts WHERE silo = $1 AND lower(email) = $2 LIMIT 1`, [silo, sender])).rows[0]?.id ?? null;
    if (!contactId) {
      const name = displayName(fromHeader);
      const parts = name.split(/\s+/).filter(Boolean);
      const row = await createContact(pool as any, {
        first_name: parts[0] ?? sender.split("@")[0] ?? "Unknown", last_name: parts.slice(1).join(" "), email: sender, silo, owner_id: uidOf(req),
      } as any);
      contactId = row.id;
    }
    const only = req.body?.attachment !== undefined ? Number(req.body.attachment) : undefined;
    const r = await fileGmailAttachments(pool, g, m, contactId!, silo, Number.isInteger(only) ? only : undefined);
    res.json({ ok: true, ...r, reason: r.filed === 0 && r.duplicates > 0 ? "all_duplicates" : r.reason });
  } catch (err) { gmailFailure(res, err); }
}));

router.post("/sync", safeHandler(async (req: any, res: any) => {
  const g = await readerOr412(req, res);
  if (!g) return;
  try {
    const stats = await syncGmailAccount(pool, uidOf(req));
    res.json({ ok: true, ...stats });
  } catch (err) { gmailFailure(res, err); }
}));

export default router;
