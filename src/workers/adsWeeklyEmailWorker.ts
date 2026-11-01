// BF_SERVER_ADS_WEEKLY_EMAIL_v708 - checks every 30 minutes; sends once on Monday morning.
import type { Pool } from "pg";
import { maybeSendWeeklyAdsEmail } from "../services/adsWeeklyEmail.js";
import { claimedTick } from "./claim.js"; // BF_SERVER_v789_WORKER_CLAIM
import { getPlanState, type Q } from "../plans/state.js";
import { marketingAddonActive, toolViaPlan } from "../plans/marketing.js";

/** KS_SERVER_MARKETING_ADDON - Pro (or its trial), or the Marketing add-on (bought or during a trial). */
export async function mondayAdsEmailAllowed(db?: Q, now: Date = new Date()): Promise<boolean> {
  const d = db ?? ((await import("../db.js")).pool as unknown as Q);
  const state = await getPlanState(d, now.getTime());
  return toolViaPlan("google_ads_full", state, now) || marketingAddonActive(state, now);
}

export function startAdsWeeklyEmailWorker(_pool: Pool): { stop: () => void } {
  let running = false;
  const tickUnclaimed = async () => {
    if (running) return;
    running = true;
    try {
      // KS_SERVER_MARKETING_ADDON - the Monday ads email is one of the full Google Ads tools: Pro, or the Marketing
      // add-on. Starter and Growth without the add-on see Google Ads results in the portal only.
      if (await mondayAdsEmailAllowed()) {
        const r = await maybeSendWeeklyAdsEmail();
        if (r.sent) console.log("[ads-weekly] sent");
      }
      // BF_SERVER_WEEKLY_SUMMARY_v721 - the business summary goes out alongside it.
      const s = await (await import("../services/weeklySummaryEmail.js")).maybeSendWeeklySummary();
      if (s.sent) console.log("[weekly-summary] sent");
    } catch (err) {
      console.error("[ads-weekly] failed:", (err as { message?: string })?.message ?? err);
    } finally { running = false; }
  };
  const tick = claimedTick("ads_weekly_email", tickUnclaimed); // BF_SERVER_v789_WORKER_CLAIM - one instance per tick
  const timer = setInterval(() => { void tick(); }, 30 * 60 * 1000);
  const kickoff = setTimeout(() => { void tick(); }, 90 * 1000);
  return { stop: () => { clearInterval(timer); clearTimeout(kickoff); } };
}
