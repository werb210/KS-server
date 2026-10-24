// KS_SERVER_v14_DATA_IMPORT - runs the import wizard's background jobs (dry run, run, undo), one at a time across
// every instance (claimedTick). Polls every 10 seconds; the routes also kick it the moment a job is queued. A job
// whose instance stopped mid-way is picked up again after a few minutes and resumes where its last chunk ended.
import type { Pool } from "pg";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { claimedTick } from "./claim.js";
import { runQueuedJobs } from "../import/engine.js";
import { importJobDeps } from "../import/deps.js";

const TICK_MS = 10 * 1000;
let kick: (() => void) | null = null;

/** Starts the next queued import job now instead of at the next poll (no-op until the worker is started). */
export function kickDataImportWorker(): void {
  if (kick) kick();
}

export function startDataImportWorker(pool: Pool): { stop: () => void } {
  let running = false;
  const tickUnclaimed = async () => {
    if (running) return;
    running = true;
    try {
      const ran = await runQueuedJobs(pool, importJobDeps());
      if (ran) console.log("[data-import] jobs run", { ran });
    } catch (err) {
      logWarnSwallowed(err, "workers/dataImportWorker.ts:tick");
    } finally {
      running = false;
    }
  };
  const tick = claimedTick("data_import", tickUnclaimed);
  kick = () => { void tick(); };
  const first = setTimeout(() => void tick(), 20 * 1000);
  const timer = setInterval(() => void tick(), TICK_MS);
  return { stop: () => { kick = null; clearTimeout(first); clearInterval(timer); } };
}
