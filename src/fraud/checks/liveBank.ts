// KS_SERVER_v9_FRAUD - check 3: the uploaded statements against the bank's own data for the same period.
// Transactions are paired by amount (to the cent) within 3 days. What is left over tells the story:
//  - on the statement but not at the bank  -> added to the statement
//  - at the bank but not on the statement  -> removed from the statement
//  - same day and description, different amount -> altered
import type { LiveTx } from "../providers/bankData.js";
import { notApplicable, result, type CheckResult, type Reason } from "../types.js";

export type StatementTx = { date: string; description: string | null; amount: number; balance: number | null };

const day = (iso: string) => Math.floor(new Date(`${iso.slice(0, 10)}T00:00:00Z`).getTime() / 86_400_000);
const money = (n: number) => `$${Math.abs(n).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function words(s: string | null): Set<string> {
  return new Set(String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !/^\d+$/.test(w)));
}

function similar(a: string | null, b: string | null): boolean {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return false;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / Math.min(A.size, B.size) >= 0.5;
}

type Pairing = { matched: number; extra: StatementTx[]; missing: LiveTx[] };

function pair(stmt: StatementTx[], live: LiveTx[]): Pairing {
  const used = new Set<number>();
  const extra: StatementTx[] = [];
  let matched = 0;
  for (const s of stmt) {
    let best = -1, bestGap = 99;
    live.forEach((l, i) => {
      if (used.has(i) || Math.abs(l.amount - s.amount) > 0.005) return;
      const gap = Math.abs(day(l.date) - day(s.date));
      if (gap <= 3 && gap < bestGap) { best = i; bestGap = gap; }
    });
    if (best >= 0) { used.add(best); matched++; } else extra.push(s);
  }
  return { matched, extra, missing: live.filter((_, i) => !used.has(i)) };
}

export function compareStatementToLive(statement: StatementTx[], live: LiveTx[]): CheckResult {
  const stmt = statement.filter((s) => s.date && Number.isFinite(s.amount));
  if (!stmt.length) return notApplicable("No statement transactions have been read yet, so there is nothing to compare.");
  const from = Math.min(...stmt.map((s) => day(s.date))), to = Math.max(...stmt.map((s) => day(s.date)));
  const inPeriod = live.filter((l) => day(l.date) >= from && day(l.date) <= to);
  if (!inPeriod.length) return notApplicable("The connected bank data does not cover the statement period.");

  // Use the bank account that best matches the statement (the client may have several accounts connected).
  const accounts = [...new Set(inPeriod.map((l) => l.account))];
  let best: { account: string; p: Pairing } | null = null;
  for (const a of accounts) {
    const p = pair(stmt, inPeriod.filter((l) => l.account === a));
    if (!best || p.matched > best.p.matched) best = { account: a, p };
  }
  const { p } = best!;
  if (p.matched === 0) {
    return result([{ code: "no_overlap", severity: "amber", text: "None of the statement's transactions appear in the connected bank account. The statement may be for a different account - or not genuine." }], { statement_count: stmt.length, live_count: inPeriod.length, matched: 0 });
  }

  // Altered: an unmatched statement line with a same-day, same-description bank line of a different amount.
  const altered: Array<{ date: string; shown: number; bank: number }> = [];
  const missing = [...p.missing];
  const extra: StatementTx[] = [];
  for (const s of p.extra) {
    const idx = missing.findIndex((m) => Math.abs(day(m.date) - day(s.date)) <= 1 && similar(m.description, s.description) && Math.sign(m.amount) === Math.sign(s.amount));
    if (idx >= 0) { altered.push({ date: s.date, shown: s.amount, bank: missing[idx]!.amount }); missing.splice(idx, 1); }
    else extra.push(s);
  }

  const reasons: Reason[] = [];
  if (altered.length) {
    const a = altered[0]!;
    reasons.push({ code: "altered", severity: "red", text: `${altered.length} transaction(s) on the statement have a different amount at the bank - e.g. ${a.date}: statement ${money(a.shown)}, bank ${money(a.bank)}.` });
  }
  if (extra.length) {
    const sum = extra.reduce((s, x) => s + Math.abs(x.amount), 0);
    const deposits = extra.filter((x) => x.amount > 0).length;
    reasons.push({ code: "added", severity: sum >= 500 || extra.length >= 3 ? "red" : "amber", text: `${extra.length} transaction(s) totalling ${money(sum)} are on the statement but not at the bank${deposits ? ` (${deposits} of them deposits)` : ""}.` });
  }
  if (missing.length) {
    const sum = missing.reduce((s, x) => s + Math.abs(x.amount), 0);
    const debits = missing.filter((x) => x.amount < 0).length;
    reasons.push({ code: "removed", severity: sum >= 500 || missing.length >= 3 ? "red" : "amber", text: `${missing.length} bank transaction(s) totalling ${money(sum)} are missing from the statement${debits ? ` (${debits} of them withdrawals)` : ""}.` });
  }
  // Balance check on days both sides print an end-of-day balance.
  const stmtBal = new Map<number, number>(), liveBal = new Map<number, number>();
  for (const s of stmt) if (s.balance != null) stmtBal.set(day(s.date), s.balance);
  for (const l of inPeriod) if (l.account === best!.account && l.balance != null) liveBal.set(day(l.date), l.balance);
  let balanceMismatches = 0;
  for (const [d, b] of stmtBal) { const lb = liveBal.get(d); if (lb != null && Math.abs(lb - b) > 1) balanceMismatches++; }
  if (balanceMismatches) reasons.push({ code: "balance_mismatch", severity: balanceMismatches >= 2 ? "red" : "amber", text: `The end-of-day balance differs from the bank's on ${balanceMismatches} day(s).` });
  if (!reasons.length) reasons.push({ code: "matches_bank", severity: "info", text: `All ${p.matched} statement transactions match the bank's own records.` });
  return result(reasons, { statement_count: stmt.length, live_count: inPeriod.length, matched: p.matched, added: extra.length, removed: missing.length, altered: altered.length, balance_mismatches: balanceMismatches });
}
