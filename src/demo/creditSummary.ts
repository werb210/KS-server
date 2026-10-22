// KS_SERVER_v10_DEMO - the credit summary for the sample file, built from what the prospect did: the financials, the
// bank statements they accepted (deposits read from the files), what the fraud checks found and the borrower's call.
import { monthlyPayment, SAMPLE_DOCS, type FinancialYear } from "./fixture.js";
import type { ApplicationRow, DocumentRow } from "./repo.js";

export type CreditSummary = {
  built_at: string;
  headline: string;
  borrower: { legal_name: string; industry: string; years_in_business: number; location: string; owner: string };
  request: { amount: number; product: string; purpose: string; term_months: number };
  financial_snapshot: {
    year: number; revenue: number; revenue_growth_pct: number; ebitda: number; ebitda_margin_pct: number; net_income: number;
    current_ratio: number; debt_to_equity: number; assumed_rate_pct: number; proposed_payment_monthly: number;
    annual_debt_service_total: number; dscr: number;
  };
  banking: { statements_used: string[]; avg_monthly_deposits: number | null; revenue_check: string };
  documents: { accepted: number; rejected: number; pending: number; missing: string[]; flagged: Array<{ label: string; status: string; decision: string; reasons: string[] }> };
  strengths: string[];
  risks: string[];
  conditions: string[];
  recommendation: string;
};

export const ASSUMED_RATE_PCT = 9.0;
const money = (n: number) => `$${Math.round(n).toLocaleString("en-CA")}`;
const r2 = (n: number) => Math.round(n * 100) / 100;

export function dscrFor(app: Pick<ApplicationRow, "financials" | "request">): number {
  const cur = (app.financials?.years ?? [])[0] as FinancialYear | undefined;
  if (!cur) return 0;
  const pay = monthlyPayment(Number(app.request.amount), ASSUMED_RATE_PCT, Number(app.request.term_months)) * 12;
  return r2(cur.ebitda / (cur.existing_debt_service + pay));
}

export function buildCreditSummary(app: ApplicationRow, docs: DocumentRow[], now = new Date()): CreditSummary {
  const [cur, prev] = (app.financials?.years ?? []) as FinancialYear[];
  if (!cur || !prev) throw new Error("demo: financials missing");
  const req = app.request;
  const payMonthly = monthlyPayment(Number(req.amount), ASSUMED_RATE_PCT, Number(req.term_months));
  const debtService = cur.existing_debt_service + payMonthly * 12;
  const dscr = r2(cur.ebitda / debtService);
  const growth = r2(((cur.revenue - prev.revenue) / prev.revenue) * 100);

  const statements = docs.filter((d) => d.category === "bank_statement" && d.status === "accepted");
  const deposits = statements.map((d) => Number(d.statement_math?.totals?.deposits ?? NaN)).filter((n) => Number.isFinite(n));
  const avgDeposits = deposits.length ? r2(deposits.reduce((a, b) => a + b, 0) / deposits.length) : null;
  const revenueCheck = avgDeposits == null
    ? "No accepted bank statements yet, so deposits could not be compared with reported revenue."
    : `Average monthly deposits of ${money(avgDeposits)} over ${deposits.length} accepted statement(s) annualise to ${money(avgDeposits * 12)}, ` +
      `${Math.round(((avgDeposits * 12) / cur.revenue) * 100)}% of the ${money(cur.revenue)} revenue reported for FY${cur.year}.`;

  const flagged = docs
    .filter((d) => d.fraud_status === "red" || d.fraud_status === "amber")
    .map((d) => ({
      label: d.label,
      status: String(d.fraud_status),
      decision: d.status,
      reasons: [...(d.tamper?.reasons ?? []), ...(d.statement_math?.reasons ?? [])]
        .filter((x: { severity?: string }) => x.severity === "red" || x.severity === "amber")
        .map((x: { text: string }) => x.text),
    }));
  const uploaded = new Set(docs.map((d) => d.sample_key));
  const missing = SAMPLE_DOCS.filter((s) => !uploaded.has(s.key)).map((s) => s.label);

  const strengths = [
    `${app.business.years_in_business} years in business with revenue up ${growth}% to ${money(cur.revenue)}.`,
    `EBITDA of ${money(cur.ebitda)} (${r2((cur.ebitda / cur.revenue) * 100)}% margin) covers all debt service ${dscr.toFixed(2)} times, including the new loan.`,
    `Current ratio of ${r2(cur.current_assets / cur.current_liabilities).toFixed(2)}; owner has ${money(req.down_payment ?? 0)} down on the equipment.`,
  ];
  const risks: string[] = [];
  const conditions: string[] = [];
  for (const f of flagged) {
    if (f.status === "red") {
      risks.push(`${f.label}: the fraud check found a concern (${f.reasons[0] ?? "see the document"}).${f.decision === "accepted" ? " It was accepted anyway - lenders will see it." : f.decision === "rejected" ? " It was rejected." : ""}`);
      conditions.push(`Replace the ${f.label.toLowerCase()} with an original downloaded from the bank before funding.`);
    }
  }
  if (app.call?.summary) conditions.push(String(app.call.summary.follow_up ?? "").replace(/^Task:\s*/i, "") || "Follow up with the borrower.");
  if (missing.length) risks.push(`Documents not received yet: ${missing.join(", ")}.`);
  if (dscr < 1.25) risks.push(`Debt service coverage of ${dscr.toFixed(2)} is below the usual 1.25 minimum.`);
  conditions.push("Equipment invoice and proof of the down payment.");

  const redAccepted = flagged.some((f) => f.status === "red" && f.decision === "accepted");
  const recommendation = redAccepted
    ? "Hold: a document with a fraud concern was accepted. Replace it with the bank's original before sending to lenders."
    : flagged.some((f) => f.status === "red")
      ? "Proceed to equipment lenders, subject to the original September statement replacing the flagged copy."
      : "Proceed to equipment lenders.";

  return {
    built_at: now.toISOString(),
    headline: `${app.business.legal_name}: ${money(Number(req.amount))} ${String(req.product).toLowerCase()} over ${req.term_months} months - DSCR ${dscr.toFixed(2)}.`,
    borrower: {
      legal_name: app.business.legal_name, industry: app.business.industry, years_in_business: app.business.years_in_business,
      location: `${app.business.city}, ${app.business.province}`, owner: `${app.contact.name}, ${app.contact.title} (${app.contact.ownership_pct}%)`,
    },
    request: { amount: Number(req.amount), product: req.product, purpose: req.purpose, term_months: Number(req.term_months) },
    financial_snapshot: {
      year: cur.year, revenue: cur.revenue, revenue_growth_pct: growth, ebitda: cur.ebitda,
      ebitda_margin_pct: r2((cur.ebitda / cur.revenue) * 100), net_income: cur.net_income,
      current_ratio: r2(cur.current_assets / cur.current_liabilities), debt_to_equity: r2(cur.total_liabilities / cur.equity),
      assumed_rate_pct: ASSUMED_RATE_PCT, proposed_payment_monthly: r2(payMonthly), annual_debt_service_total: r2(debtService), dscr,
    },
    banking: { statements_used: statements.map((d) => d.label), avg_monthly_deposits: avgDeposits, revenue_check: revenueCheck },
    documents: {
      accepted: docs.filter((d) => d.status === "accepted").length,
      rejected: docs.filter((d) => d.status === "rejected").length,
      pending: docs.filter((d) => d.status === "pending").length,
      missing, flagged,
    },
    strengths, risks, conditions, recommendation,
  };
}
