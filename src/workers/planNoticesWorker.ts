// KS_SERVER_v6_PLANS - checks every 30 minutes for a due trial or storage notice (see src/plans/notices.ts).
import type { Pool } from "pg";
import { runPlanNotices } from "../plans/notices.js";
import type { Q } from "../plans/state.js";
import { claimedTick } from "./claim.js";

export function startPlanNoticesWorker(pool: Pool): { stop: () => void } {
  let running = false;
  const tickUnclaimed = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runPlanNotices(pool as unknown as Q);
      if (r.sent.length) console.log("[plan-notices] sent", r.sent.join(", "));
    } catch (err) {
      console.error("[plan-notices] failed:", (err as { message?: string })?.message ?? err);
    } finally { running = false; }
  };
  const tick = claimedTick("plan_notices", tickUnclaimed);
  const timer = setInterval(() => { void tick(); }, 30 * 60 * 1000);
  const kickoff = setTimeout(() => { void tick(); }, 120 * 1000);
  return { stop: () => { clearInterval(timer); clearTimeout(kickoff); } };
}
