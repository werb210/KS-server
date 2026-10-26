// KS_SETTINGS_PACK_v1_NPS - queues a survey for each newly funded deal and sends the ones now due. Every 15 minutes,
// one instance per tick; only while the plan includes nps_survey and the Admin has it switched on.
import type { Pool } from "pg";
import { claimedTick } from "./claim.js";
import { checkFeature } from "../plans/catalogue.js";
import { getPlanState } from "../plans/state.js";
import { npsSettings, queueFundedDeals, sendDueSurveys, type SendDeps } from "../surveys/nps.js";
import { defaultReminderDeps } from "../booking/bookingPages.js";

const TICK_MS = 15 * 60 * 1000;

export async function runNpsTick(pool: Pool, deps: SendDeps = defaultReminderDeps()): Promise<{ queued: number; sent: number; skipped: number; failed: number } | null> {
  const plan = checkFeature(await getPlanState(pool as any), "nps_survey");
  if (!plan.allowed) return null;
  const s = await npsSettings(pool as any);
  if (!s.enabled) return null;
  const queued = await queueFundedDeals(pool as any, s);
  return { queued, ...(await sendDueSurveys(pool as any, s, deps)) };
}

export function startNpsSurveyWorker(pool: Pool): { stop: () => void } {
  const tick = claimedTick("nps_surveys", async () => {
    try {
      const r = await runNpsTick(pool);
      if (r && (r.queued || r.sent || r.failed)) console.log(JSON.stringify({ event: "nps_surveys", ...r }));
    } catch (e) {
      console.error("[nps-worker] tick failed", e instanceof Error ? e.message : e);
    }
  });
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  void tick();
  return { stop: () => clearInterval(timer) };
}
