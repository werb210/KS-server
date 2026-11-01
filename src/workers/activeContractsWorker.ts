// KS_SERVER_ACTIVE_CONTRACTS - the renewal engine and statement intake, hourly, one instance at a time (claimedTick).
// Each tick: funded applications become contracts, renewal rules are applied (src/activeContracts/engine.ts), and lender
// statements filed from email are read into "pending review" (src/activeContracts/statements.ts). ACTIVE_CONTRACTS_ENGINE=off
// stops it.
import type { Pool } from "pg";
import { claimedTick } from "./claim.js";
import { defaultEngineDeps, runEngineTick } from "../activeContracts/engine.js";
import { defaultStatementDeps, scanInboundStatements } from "../activeContracts/statements.js";
import type { Q } from "../activeContracts/repo.js";
import { checkFeature } from "../plans/catalogue.js";
import { getPlanState } from "../plans/state.js";

/** KS_SERVER_ACTIVE_CONTRACTS - the plan includes Active Contracts (Growth and Pro, or a running trial). A read failure means off. */
export async function activeContractsEnabled(db: Q): Promise<boolean> {
  try {
    return checkFeature(await getPlanState(db as any), "active_contracts").allowed;
  } catch (err) {
    console.warn("[active-contracts] plan check failed", (err as Error)?.message);
    return false;
  }
}

const TICK_MS = 60 * 60_000;

export function startActiveContractsWorker(pool: Pool): { stop: () => void } {
  let stopped = false;
  let running = false;
  const db = pool as unknown as Q;
  const tickUnclaimed = async () => {
    if (stopped || running || String(process.env.ACTIVE_CONTRACTS_ENGINE ?? "").toLowerCase() === "off") return;
    running = true;
    try {
      if (!(await activeContractsEnabled(db))) return; // not in this copy's plan: nothing runs, nothing is created
      const out = await runEngineTick(db, await defaultEngineDeps());
      const statements = await scanInboundStatements(db, await defaultStatementDeps());
      if (out.created || out.status_changes || out.failed || statements) console.info({ event: "active_contracts_tick", ...out, statements });
    } catch (err) {
      console.error("[active-contracts] tick failed:", (err as Error)?.message ?? err);
    } finally {
      running = false;
    }
  };
  const tick = claimedTick("active_contracts", tickUnclaimed);
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  setTimeout(() => { void tick(); }, 90_000);
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
