// KS_SERVER_v13_QUICKBOOKS - the QuickBooks fee-invoice outbox. Every minute: queue anything the sign/fund hooks
// missed, then run due rows (create invoice, update to the funded amount, record payment), with backoff on failure.
// Does nothing while QBO_* is unset or QuickBooks is not connected.
import type { Pool } from "pg";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { claimedTick } from "./claim.js";
import { runInvoiceWorkerOnce } from "../services/quickbooks/feeInvoice.js";

const TICK_MS = 60 * 1000;

export function startQuickBooksInvoiceWorker(pool: Pool): { stop: () => void } {
  let running = false;
  const tickUnclaimed = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runInvoiceWorkerOnce(pool);
      if (r.queued || r.ran) console.log("[quickbooks] invoice worker", r);
    } catch (err) {
      logWarnSwallowed(err, "workers/quickbooksInvoiceWorker.ts:tick");
    } finally {
      running = false;
    }
  };
  const tick = claimedTick("quickbooks_invoices", tickUnclaimed);
  const first = setTimeout(() => void tick(), 75 * 1000);
  const timer = setInterval(() => void tick(), TICK_MS);
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}
