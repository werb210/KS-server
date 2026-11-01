// KS_SERVER_v12_GOOGLE_WORKSPACE / KS_SERVER_GMAIL_INBOX - the Gmail inbox sync worker. BUILT BUT OFF.
//
// Reading mail needs gmail.readonly, a RESTRICTED Google scope that requires the yearly CASA security assessment.
// Until KS_GOOGLE_GMAIL_READ_ENABLED=true (or the older GOOGLE_GMAIL_READ_ENABLED):
//   - the scope is never requested (services/workspace/googleConfig.ts),
//   - index.ts never starts this worker, and syncGmailOnce() returns without touching the database or Google.
// When on, every Google user who granted gmail.readonly is synced every 2 minutes (history sync first, then Gmail's
// history API), and Gmail push watches are renewed when KS_GOOGLE_PUBSUB_TOPIC is set. What a sync does is in
// modules/gmail/gmailSync.ts.
import type { Pool } from "pg";
import { claimedTick } from "./claim.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { syncAllGmail } from "../modules/gmail/gmailSync.js";
import { renewWatches } from "../modules/gmail/gmailPush.js";

const TICK_MS = 120_000;
const WATCH_EVERY_MS = 6 * 3600 * 1000;

/** One pass over every Google user who granted gmail.readonly. A no-op while the read switch is off. */
export function syncGmailOnce(pool: Pool, env: NodeJS.ProcessEnv = process.env): Promise<{ ran: boolean; users: number }> {
  return syncAllGmail(pool, env);
}

export function startGmailSyncWorker(pool: Pool): { stop: () => void } {
  let running = false;
  let lastWatch = 0;
  const tickUnclaimed = async () => {
    if (running) return;
    running = true;
    try {
      const r = await syncGmailOnce(pool);
      if (r.ran && Date.now() - lastWatch > WATCH_EVERY_MS) {
        lastWatch = Date.now();
        await renewWatches(pool);
      }
    } catch (err) {
      logWarnSwallowed(err, "workers/gmailSyncWorker.ts:tick");
    } finally {
      running = false;
    }
  };
  const tick = claimedTick("gmail_sync", tickUnclaimed);
  const timer = setInterval(() => void tick(), TICK_MS);
  void tick();
  return { stop: () => clearInterval(timer) };
}
