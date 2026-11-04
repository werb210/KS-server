// KS_LENDER_SYNC_CONTRACTS - lender-reported balances on Active Contracts.
//
// When a connected lender reports a funded deal's balance, payments made, next payment or status (src/lenderConnectors,
// RemoteUpdate.servicing), it is added to the contract's balance history as source 'lender_portal' with the lender's
// name, through the existing recordLenderReportedBalance hook (money.ts). Balances are append-only, so a balance staff
// typed by hand is never overwritten; the contract page shows both when they differ (repo.ts contractView).
// After funding the deal is polled daily while its contract is open, and polling stops when the contract is paid out
// or closed (in Keystone, or by the lender's own status).
import type { Q } from "./repo.js";
import { HISTORY_STATUSES, isoDay, num, toDate } from "./model.js";
import { recordLenderReportedBalance } from "./money.js";
import { writeContractEvent } from "./timeline.js";
import { isClosedServicingStatus, type RemoteServicing } from "../lenderConnectors/types.js";

/** How often a funded deal with an open contract is read back from the lender. */
export const FUNDED_POLL_MINUTES = 24 * 60;
/** How long a funded deal keeps being read while its contract has not been created yet (the hourly engine makes it). */
export const NO_CONTRACT_GRACE_DAYS = 14;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The Active Contract for a lender submission: same application, and the same lender when the contract names one. */
export async function contractForSubmission(db: Q, applicationId: string, lenderId: string): Promise<{ id: string; status: string } | null> {
  const r = await db.query(
    `SELECT id::text AS id, status FROM active_contracts
      WHERE application_id = $1 AND (lender_id IS NULL OR lender_id::text = $2)
      ORDER BY created_at DESC LIMIT 1`, [applicationId, lenderId]);
  return r.rows[0] ? { id: String(r.rows[0].id), status: String(r.rows[0].status ?? "") } : null;
}

export type ServicingOutcome = { contractId: string | null; recorded: boolean; lenderClosed: boolean };

/** The lender's as-of date, or today when it is missing or later than tomorrow. */
function asOfDay(v: string | null, now: Date): string {
  const d = toDate(v);
  if (!d || d.getTime() > now.getTime() + 86_400_000) return isoDay(now)!;
  return isoDay(d)!;
}

/** Records what the lender reports on the matching contract. A report identical to the last one adds nothing. */
export async function applyLenderServicing(db: Q, args: {
  applicationId: string; lenderId: string; lenderName: string; submissionId: string; servicing: RemoteServicing; now?: Date;
}): Promise<ServicingOutcome> {
  const s = args.servicing;
  const now = args.now ?? new Date();
  const lenderClosed = isClosedServicingStatus(s.status);
  const contract = await contractForSubmission(db, args.applicationId, args.lenderId);
  if (!contract) return { contractId: null, recorded: false, lenderClosed };

  const last = (await db.query(
    `SELECT balance, as_of, payments_made, next_payment_date, next_payment_amount, lender_status FROM active_contract_balances
      WHERE contract_id = $1::uuid AND source = 'lender_portal' ORDER BY as_of DESC, created_at DESC LIMIT 1`, [contract.id])).rows[0] ?? null;
  const wasClosed = Boolean(last && isClosedServicingStatus(last.lender_status));

  let recorded = false;
  if (s.balance !== null && s.balance >= 0) {
    const asOf = asOfDay(s.asOf, now);
    const same = last
      && num(last.balance) === round2(s.balance)
      && isoDay(toDate(last.as_of)) === asOf
      && (num(last.payments_made) ?? null) === (s.paymentsMade ?? null)
      && isoDay(toDate(last.next_payment_date)) === (isoDay(toDate(s.nextPaymentDate)) ?? null)
      && (num(last.next_payment_amount) ?? null) === (s.nextPaymentAmount === null ? null : round2(s.nextPaymentAmount))
      && (last.lender_status ?? null) === (s.status ?? null);
    if (!same) {
      await recordLenderReportedBalance(db, contract.id, round2(s.balance), asOf, "lender_portal", {
        payments_made: s.paymentsMade, lender_name: args.lenderName, lender_status: s.status,
        next_payment_date: isoDay(toDate(s.nextPaymentDate)), next_payment_amount: s.nextPaymentAmount, submission_id: args.submissionId,
      });
      recorded = true;
    }
  }
  if (lenderClosed && !wasClosed) {
    await writeContractEvent(db, contract.id, {
      title: `${args.lenderName} reports this contract as "${s.status}"`,
      detail: "Keystone has stopped checking the balance with the lender. Change the contract's status once you have confirmed it.",
    });
  }
  return { contractId: contract.id, recorded, lenderClosed };
}

/**
 * Whether a funded deal keeps being read back from the lender (daily): yes while its contract is open; no once the
 * contract is paid out, matured, refinanced or closed, or the lender says it is. Before the contract exists, yes for
 * NO_CONTRACT_GRACE_DAYS after the lender first reported funding (fundedSeenAt null = just now).
 */
export async function keepPollingFunded(db: Q, args: { applicationId: string; lenderId: string; lenderClosed: boolean; fundedSeenAt: unknown; now?: Date }): Promise<boolean> {
  if (args.lenderClosed) return false;
  const contract = await contractForSubmission(db, args.applicationId, args.lenderId);
  if (contract) return !HISTORY_STATUSES.has(contract.status);
  const seen = toDate(args.fundedSeenAt);
  if (!seen) return true;
  return (args.now ?? new Date()).getTime() - seen.getTime() < NO_CONTRACT_GRACE_DAYS * 86_400_000;
}
