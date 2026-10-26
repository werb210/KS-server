// KS_SERVER_PHONE_PROVISIONING - every 15 minutes: schedule the release of numbers that should go (a seat removed, the
// service cancelled, a plan that no longer includes the kind) with the grace period and the admin notice, then give
// back to Twilio the numbers whose grace period is over. Does nothing until Twilio is connected.
import type { Pool } from "pg";
import type { Q } from "../plans/state.js";
import { reconcileNumbers, releaseDue } from "../phone/numbers.js";
import { liveTwilioNumbersApi, twilioConfigured } from "../phone/twilioNumbers.js";
import { claimedTick } from "./claim.js";

export function startPhoneNumberWorker(pool: Pool, intervalMs = 15 * 60_000): { stop: () => void } {
  let running = false;
  const tickUnclaimed = async () => {
    if (running || !twilioConfigured()) return;
    running = true;
    const db = pool as unknown as Q;
    try {
      const scheduled = await reconcileNumbers(db);
      if (scheduled.length) console.log("[phone-numbers] release scheduled", scheduled.join(", "));
    } catch (err) {
      console.error("[phone-numbers] reconcile failed:", (err as { message?: string })?.message ?? err);
    }
    try {
      const r = await releaseDue(db, liveTwilioNumbersApi());
      if (r.released.length) console.log("[phone-numbers] released", r.released.join(", "));
      if (r.failed.length) console.error("[phone-numbers] release failed (retried next run)", r.failed.join(", "));
    } catch (err) {
      console.error("[phone-numbers] release run failed:", (err as { message?: string })?.message ?? err);
    } finally {
      running = false;
    }
  };
  const tick = claimedTick("phone_numbers", tickUnclaimed);
  const timer = setInterval(() => { void tick(); }, intervalMs);
  const kickoff = setTimeout(() => { void tick(); }, 180 * 1000);
  return { stop: () => { clearInterval(timer); clearTimeout(kickoff); } };
}
