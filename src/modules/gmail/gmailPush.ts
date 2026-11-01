// KS_SERVER_GMAIL_INBOX - optional Gmail push (Pub/Sub). Without it the 2-minute poll does the same job.
//
// Setup (Keystone, once per licensee server, only after inbox reading is on): a Pub/Sub topic in Keystone's Google
// Cloud project with gmail-api-push@system.gserviceaccount.com allowed to publish, and a push subscription to
//   https://<licensee server>/api/gmail-push?token=<KS_GOOGLE_PUBSUB_PUSH_TOKEN>
// Then set KS_GOOGLE_PUBSUB_TOPIC=projects/<project>/topics/<topic> and KS_GOOGLE_PUBSUB_PUSH_TOKEN on the server.
// The worker keeps each person's watch alive (Gmail drops a watch after 7 days; it is renewed daily).
import { timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { getGoogleForUser } from "../../services/workspace/googleAuth.js";
import { hasScope, SCOPE_GMAIL_READONLY } from "../../services/workspace/googleConfig.js";
import { logWarnSwallowed } from "../../lib/logWarnSwallowed.js";
import { watchMailbox } from "./gmailApi.js";

export function pushTopic(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = String(env.KS_GOOGLE_PUBSUB_TOPIC ?? "").trim();
  return /^projects\/[^/]+\/topics\/[^/]+$/.test(t) ? t : null;
}

export function pushTokenMatches(given: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const want = String(env.KS_GOOGLE_PUBSUB_PUSH_TOKEN ?? "").trim();
  if (!want || typeof given !== "string" || !given) return false;
  const a = Buffer.from(given, "utf8"), b = Buffer.from(want, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The mailbox a Pub/Sub push names ({ message: { data: base64 JSON { emailAddress, historyId } } }), or null. */
export function parsePush(body: any): { emailAddress: string; historyId: string | null } | null {
  try {
    const data = String(body?.message?.data ?? "");
    if (!data) return null;
    const j = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
    const email = String(j?.emailAddress ?? "").trim().toLowerCase();
    return email ? { emailAddress: email, historyId: j?.historyId != null ? String(j.historyId) : null } : null;
  } catch {
    return null;
  }
}

/** Starts or renews the watch for everyone whose watch ends within a day. A no-op without a topic. */
export async function renewWatches(pool: Pool, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const topic = pushTopic(env);
  if (!topic) return 0;
  const due = await pool.query<{ user_id: string }>(
    `SELECT user_id::text AS user_id FROM google_workspace_accounts
      WHERE status = 'connected' AND position($1 in scopes) > 0
        AND (gmail_watch_expires_at IS NULL OR gmail_watch_expires_at < now() + interval '1 day')`,
    [SCOPE_GMAIL_READONLY],
  );
  let renewed = 0;
  for (const { user_id } of due.rows) {
    try {
      const g = await getGoogleForUser(pool, user_id);
      if (!g || !hasScope(g.scopes, SCOPE_GMAIL_READONLY)) continue;
      const w = await watchMailbox(g, topic);
      const exp = w.expiration ? new Date(Number(w.expiration)) : null;
      await pool.query(`UPDATE google_workspace_accounts SET gmail_watch_expires_at = $2 WHERE user_id = $1::uuid`, [user_id, exp]);
      renewed++;
    } catch (err) {
      logWarnSwallowed(err, "gmail:watch-renew");
    }
  }
  return renewed;
}
