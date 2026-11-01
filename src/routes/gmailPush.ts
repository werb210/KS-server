// KS_SERVER_GMAIL_INBOX - POST /api/gmail-push?token=... : Gmail push notifications from Google Pub/Sub (public; the
// shared token on the subscription URL authenticates it). A push only wakes the sync for that mailbox; the sync itself
// reads Gmail with the person's own token. Answers 204 for any authenticated push so Pub/Sub does not retry.
import { Router } from "express";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { gmailReadEnabled } from "../services/workspace/googleConfig.js";
import { parsePush, pushTokenMatches } from "../modules/gmail/gmailPush.js";
import { syncGmailAccount } from "../modules/gmail/gmailSync.js";

const router = Router();

router.post("/", safeHandler(async (req: any, res: any) => {
  if (!pushTokenMatches(req.query.token)) return res.status(403).json({ ok: false, error: "forbidden" });
  res.status(204).end();
  if (!gmailReadEnabled()) return;
  const push = parsePush(req.body);
  if (!push) return;
  const r = await pool.query(
    `SELECT user_id::text AS user_id FROM google_workspace_accounts WHERE lower(google_email) = $1 AND status = 'connected'`, [push.emailAddress],
  );
  for (const { user_id } of r.rows) {
    void syncGmailAccount(pool, user_id).catch((err: unknown) => console.warn("[gmail-push] sync failed", { message: (err as Error)?.message }));
  }
}));

export default router;
