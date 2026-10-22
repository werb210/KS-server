// KS_SERVER_v8_OPS_LINK - every hour, sends any due usage report to Keystone operations (see src/plans/usageReports.ts:
// one a day for the month so far, and the final one after a month ends). Without KS_OPS_URL / KS_LICENSEE_ID /
// KS_OPS_KEY it does not start, and says so once.
import type { Pool } from "pg";
import { opsConfig } from "../plans/opsLink.js";
import type { Q } from "../plans/state.js";
import { runUsageReports } from "../plans/usageReports.js";
import { claimedTick } from "./claim.js";

export function startUsageReportWorker(pool: Pool, env: NodeJS.ProcessEnv = process.env): { stop: () => void; started: boolean } {
  if (!opsConfig(env)) {
    console.info("[usage-reports] not sending usage to operations: KS_OPS_URL, KS_LICENSEE_ID and KS_OPS_KEY are not all set");
    return { stop: () => undefined, started: false };
  }
  let running = false;
  const tickUnclaimed = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runUsageReports(pool as unknown as Q, new Date(), { env });
      if (!r.skipped && r.posted.length) console.log("[usage-reports] posted", r.posted.join(", "));
    } catch (err) {
      console.error("[usage-reports] failed:", (err as { message?: string })?.message ?? err);
    } finally { running = false; }
  };
  const tick = claimedTick("usage_reports", tickUnclaimed);
  const timer = setInterval(() => { void tick(); }, 60 * 60 * 1000);
  const kickoff = setTimeout(() => { void tick(); }, 180 * 1000);
  return { stop: () => { clearInterval(timer); clearTimeout(kickoff); }, started: true };
}
