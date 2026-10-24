// KS_STAFF_DIRECTORY_v1 - every 15 minutes, sends the staff list to Keystone operations when it changed (and at least
// every six hours), so the Keystone apps can find this server from a staff member's email or mobile number. See
// src/staffDirectory/sync.ts. Without KS_OPS_URL / KS_LICENSEE_ID / KS_OPS_KEY it does not start, and says so once.
import type { Pool } from "pg";
import { opsConfig } from "../plans/opsLink.js";
import { syncStaffDirectory } from "../staffDirectory/sync.js";
import { claimedTick } from "./claim.js";

export function startStaffDirectoryWorker(pool: Pool, env: NodeJS.ProcessEnv = process.env): { stop: () => void; started: boolean } {
  if (!opsConfig(env)) {
    console.info("[staff-directory] not sending the staff list to operations: KS_OPS_URL, KS_LICENSEE_ID and KS_OPS_KEY are not all set");
    return { stop: () => undefined, started: false };
  }
  let running = false;
  const tickUnclaimed = async () => {
    if (running) return;
    running = true;
    try {
      const r = await syncStaffDirectory(pool as any, { env });
      if (r.pushed) console.log("[staff-directory] sent", r.count, "staff identifiers");
    } catch (err) {
      console.error("[staff-directory] failed:", (err as { message?: string })?.message ?? err);
    } finally { running = false; }
  };
  const tick = claimedTick("staff_directory", tickUnclaimed);
  const timer = setInterval(() => { void tick(); }, 15 * 60 * 1000);
  const kickoff = setTimeout(() => { void tick(); }, 120 * 1000);
  return { stop: () => { clearInterval(timer); clearTimeout(kickoff); }, started: true };
}
