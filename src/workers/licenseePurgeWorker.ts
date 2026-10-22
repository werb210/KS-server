// KS_SERVER_v8_PURGE - every 6 hours: the 7-day / 1-day warnings and, 180 days after cancellation, the deletion of a
// cancelled licensee's data (src/plans/purge.ts). Does nothing unless service_status is 'cancelled'.
import type { Pool } from "pg";
import { runLicenseePurge } from "../plans/purge.js";
import type { Q } from "../plans/state.js";
import { claimedTick } from "./claim.js";

export function startLicenseePurgeWorker(pool: Pool): { stop: () => void } {
  let running = false;
  const tickUnclaimed = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runLicenseePurge(pool as unknown as Q);
      if (r.action !== "none") console.log("[licensee-purge]", JSON.stringify(r));
    } catch (err) {
      console.error("[licensee-purge] failed:", (err as { message?: string })?.message ?? err);
    } finally { running = false; }
  };
  const tick = claimedTick("licensee_purge", tickUnclaimed);
  const timer = setInterval(() => { void tick(); }, 6 * 60 * 60 * 1000);
  const kickoff = setTimeout(() => { void tick(); }, 300 * 1000);
  return { stop: () => { clearInterval(timer); clearTimeout(kickoff); } };
}
