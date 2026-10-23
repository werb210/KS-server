// KS_SERVER_v11_PGI - every 10 minutes: send PGI referrals the insurance partner does not have yet, forward newly
// accepted documents, refresh status / checklist / messages, and resend replies that did not go out. Skipped while
// the service is stopped and when Keystone operations has not linked this copy to the partner.
import type { Pool } from "pg";
import type { Q } from "../plans/state.js";
import { serviceStoppedNow } from "../plans/serviceGate.js";
import { runPgiTick } from "../pgi/service.js";
import { claimedTick } from "./claim.js";

export function startPgiReferralWorker(pool: Pool): { stop: () => void } {
  let running = false;
  const tickUnclaimed = async () => {
    if (running) return;
    running = true;
    try {
      if (await serviceStoppedNow(pool as unknown as Q)) return;
      const r = await runPgiTick(pool as unknown as Q);
      if (r.synced || r.resent) console.log("[pgi] referrals synced", r);
    } catch (err) {
      console.error("[pgi] worker tick failed:", (err as { message?: string })?.message ?? err);
    } finally { running = false; }
  };
  const tick = claimedTick("pgi_referrals", tickUnclaimed);
  const timer = setInterval(() => { void tick(); }, 10 * 60 * 1000);
  const kickoff = setTimeout(() => { void tick(); }, 240 * 1000);
  return { stop: () => { clearInterval(timer); clearTimeout(kickoff); } };
}
