// KS_SERVER_v20_WEBHOOKS - sends due webhook deliveries every 10 seconds (one instance per tick) and prunes the log
// to 30 days once an hour.
import type { Pool } from "pg";
import { claimedTick } from "./claim.js";
import type { Q } from "../plans/state.js";

export function startOutboundWebhookWorker(pool: Pool, intervalMs = 10_000): { stop: () => void } {
  let stopped = false;
  let running = false;
  let lastPrune = 0;
  const tickUnclaimed = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const { httpsTransport, pruneOld, runDueDeliveries } = await import("../outboundWebhooks/deliver.js");
      const db = pool as unknown as Q;
      const transport = httpsTransport();
      let n = 0;
      let rounds = 0;
      do { n = await runDueDeliveries(db, { transport }); rounds += 1; } while (n === 25 && rounds < 8 && !stopped);
      if (Date.now() - lastPrune > 60 * 60_000) {
        lastPrune = Date.now();
        const removed = await pruneOld(db);
        if (removed) console.info("[webhooks] pruned old deliveries", { removed });
      }
    } catch (err: any) {
      // Before the migration has run the tables are missing: quiet until they exist.
      if (err?.code !== "42P01") console.error("[webhooks] worker tick failed", { message: err?.message ?? String(err) });
    } finally {
      running = false;
    }
  };
  const tick = claimedTick("outbound-webhooks", tickUnclaimed);
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
