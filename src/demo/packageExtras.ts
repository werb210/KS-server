// KS_SERVER_v13_DEMO_SHOW_EVERYTHING - the extra pages the DEMO lender package carries so the prospect sees everything the
// walkthrough showed them, not only what a real licensee's default package holds:
//
//   fraud-prescreen.pdf             the real pre-screen page (prescreenText + renderPrescreenPdf from src/fraud), with
//                                   the score and reasons the walkthrough showed (72 / 100 when a document failed)
//   client-intake-call-note.pdf     the AI call note and the transcript of the borrower's call
//   bank-summary.pdf                month-by-month deposits, withdrawals and balances from the sample statements
//   financials-summary.pdf          the two years of financial statements, ratios and debt service coverage
//
// The demo is a demo: it shows the system off, it does not process deals, so none of the real package's limits apply
// here (the real package adds the pre-screen only when staff turn it on and has no call note or summaries). Nothing in
// this file is used outside src/demo. Every page is dark text on white at 10 pt or larger, with the SAMPLE footer.
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { FRAUD_CHECKS } from "../fraud/catalogue.js";
import { renderPrescreenPdf } from "../fraud/prescreen.js";
import { band, prescreenText, type FraudScore } from "../fraud/score.js";
import {
  CALL_SCRIPT, CALL_SUMMARY, DEMO_BANK, DEMO_DURATION_SECONDS, DOCTORED, SAMPLE_STATEMENTS, monthlyPayment, type FinancialYear,
} from "./fixture.js";
import { ASSUMED_RATE_PCT } from "./creditSummary.js";
import type { ApplicationRow, DocumentRow } from "./repo.js";
import { brokerageTimeZone } from "../lib/brokerageTime.js"; // KS_SETTINGS_PACK_v1_TIME_ZONE - the brokerage's zone (Settings > Company)

export const DEMO_FOOTER = "SAMPLE - fictional business and lenders, made in the Keystone demo. Not a real application.";

/** The score the walkthrough shows for the sample file when a document failed the checks (portal demo shim). */
export const DEMO_FRAUD_SCORE = 72;

export type DemoDocState = Pick<DocumentRow, "sample_key" | "category" | "label" | "status" | "fraud_status" | "tamper" | "statement_math">;
export type ExtraPdf = { filename: string; content: Buffer };

const INK = rgb(0.07, 0.09, 0.15);
const MUTED = rgb(0.3, 0.33, 0.4);
const RULE = rgb(0.8, 0.82, 0.86);
const FOOT = rgb(0.45, 0.1, 0.1);

const ascii = (s: unknown) => String(s ?? "")
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
  .replace(/[^\x20-\x7E\xA0-\xFF]/g, "");

const money = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "-" : `${n < 0 ? "-" : ""}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
const cents = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const r2 = (n: number) => Math.round(n * 100) / 100;

type Block =
  | { kind: "h"; text: string }
  | { kind: "p"; text: string; muted?: boolean }
  | { kind: "kv"; rows: Array<[string, string]> }
  | { kind: "bullets"; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][]; widths: number[]; align?: Array<"l" | "r"> }
  | { kind: "gap" };

/** A plain, readable report: title, subtitle, then headings, paragraphs, key/value rows, bullets and tables. */
export async function renderReport(title: string, subtitle: string, blocks: Block[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(ascii(title));
  doc.setProducer("Keystone demo");
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const L = 50, R = 562, W = R - L, BOTTOM = 60;
  let page: PDFPage = doc.addPage([612, 792]);
  let y = 742;
  const newPage = () => { page = doc.addPage([612, 792]); y = 742; };
  const need = (h: number) => { if (y - h < BOTTOM) newPage(); };
  const wrap = (text: string, size: number, f: PDFFont, width: number): string[] => {
    const out: string[] = [];
    let cur = "";
    for (const w of ascii(text).split(/\s+/).filter(Boolean)) {
      const next = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(next, size) > width && cur) { out.push(cur); cur = w; } else cur = next;
    }
    out.push(cur);
    return out;
  };
  const line = (text: string, x: number, size: number, f: PDFFont, color = INK) => page.drawText(ascii(text), { x, y, size, font: f, color });

  for (const part of wrap(title, 17, bold, W)) { line(part, L, 17, bold); y -= 22; }
  for (const part of wrap(subtitle, 10.5, reg, W)) { line(part, L, 10.5, reg, MUTED); y -= 15; }
  y -= 4;
  page.drawLine({ start: { x: L, y }, end: { x: R, y }, thickness: 1, color: RULE });
  y -= 18;

  for (const b of blocks) {
    if (b.kind === "gap") { y -= 8; continue; }
    if (b.kind === "h") { need(40); y -= 4; line(b.text, L, 12.5, bold); y -= 18; continue; }
    if (b.kind === "p") {
      for (const part of wrap(b.text, 10.5, reg, W)) { need(15); line(part, L, 10.5, reg, b.muted ? MUTED : INK); y -= 15; }
      y -= 4; continue;
    }
    if (b.kind === "kv") {
      for (const [k, v] of b.rows) {
        const parts = wrap(v, 10.5, reg, W - 160);
        need(15 * parts.length);
        line(k, L, 10.5, reg, MUTED);
        parts.forEach((p, i) => { line(p, L + 160, 10.5, i === 0 ? bold : reg); y -= 15; });
      }
      y -= 4; continue;
    }
    if (b.kind === "bullets") {
      for (const item of b.items) {
        const parts = wrap(item, 10.5, reg, W - 16);
        need(15 * parts.length);
        line("-", L + 2, 10.5, reg);
        for (const p of parts) { line(p, L + 16, 10.5, reg); y -= 15; }
      }
      y -= 4; continue;
    }
    // table
    const xs: number[] = [];
    b.widths.reduce((x, w) => (xs.push(x), x + w), L);
    const cell = (text: string, i: number, f: PDFFont) => {
      const s = ascii(text);
      const right = (b.align?.[i] ?? "l") === "r";
      const x = right ? xs[i]! + b.widths[i]! - 6 - f.widthOfTextAtSize(s, 10) : xs[i]! + (i > 0 ? 6 : 0);
      page.drawText(s, { x, y, size: 10, font: f, color: INK });
    };
    const head = () => {
      b.head.forEach((h, i) => cell(h, i, bold));
      y -= 5;
      page.drawLine({ start: { x: L, y }, end: { x: R, y }, thickness: 0.75, color: RULE });
      y -= 12;
    };
    need(40);
    head();
    for (const row of b.rows) {
      if (y - 14 < BOTTOM) { newPage(); head(); }
      row.forEach((c, i) => cell(c, i, reg));
      y -= 15;
    }
    y -= 6;
  }

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText(DEMO_FOOTER, { x: L, y: 28, size: 8, font: reg, color: FOOT });
    if (pages.length > 1) p.drawText(`Page ${i + 1} of ${pages.length}`, { x: R - 60, y: 28, size: 8, font: reg, color: MUTED });
  });
  return Buffer.from(await doc.save());
}

async function withFooter(pdf: Buffer): Promise<Buffer> {
  const doc = await PDFDocument.load(pdf);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of doc.getPages()) p.drawText(DEMO_FOOTER, { x: 50, y: 28, size: 8, font: reg, color: FOOT });
  return Buffer.from(await doc.save());
}

// ---------------------------------------------------------------- fraud pre-screen

const checkLabel = (key: string) => FRAUD_CHECKS.find((c) => c.key === key)?.label ?? key;

/** The demo's fraud score: the walkthrough's 72 when a document failed, with the reasons the real checks gave. */
export function demoFraudScore(docs: DemoDocState[], callAnswered: boolean): FraudScore {
  const reasons: FraudScore["reasons"] = [];
  const worstOf = (key: "tamper" | "statement_math") => {
    let w: "green" | "amber" | "red" | null = null;
    for (const d of docs) {
      const st = d[key]?.status;
      if (st === "red") w = "red"; else if (st === "amber" && w !== "red") w = "amber"; else if (st === "green" && !w) w = "green";
    }
    return w;
  };
  for (const d of docs) {
    for (const [key, check] of [["tamper", "fraud_1"], ["statement_math", "fraud_2"]] as const) {
      for (const r of (d[key]?.reasons ?? []) as Array<{ severity?: string; text?: string }>) {
        if (r.severity === "red" || r.severity === "amber") {
          reasons.push({ check, label: checkLabel(check), severity: r.severity, text: `${d.label}: ${String(r.text ?? "")}` });
        }
      }
    }
  }
  reasons.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "red" ? -1 : 1));
  const covered: FraudScore["covered"] = [];
  const notCovered: FraudScore["not_covered"] = [];
  for (const def of FRAUD_CHECKS) {
    if (def.key === "fraud_16" || def.key === "fraud_3") continue; // fraud_3 needs a live bank connection
    if (def.key === "fraud_1") { covered.push({ check: def.key, label: def.label, status: worstOf("tamper") ?? "green" }); continue; }
    if (def.key === "fraud_2") { covered.push({ check: def.key, label: def.label, status: worstOf("statement_math") ?? "green" }); continue; }
    if (def.key === "fraud_15" && !callAnswered) { notCovered.push({ check: def.key, label: def.label, status: "not_applicable", why: "no recorded call" }); continue; }
    covered.push({ check: def.key, label: def.label, status: "green" });
  }
  const anyRed = docs.some((d) => d.fraud_status === "red");
  const anyAmber = docs.some((d) => d.fraud_status === "amber");
  const score = anyRed ? DEMO_FRAUD_SCORE : anyAmber ? 24 : 6;
  return { score, band: band(score), reasons, covered, not_covered: notCovered };
}

export async function fraudPrescreenPdf(input: { docs: DemoDocState[]; callAnswered: boolean; company: string; applicationName: string; at: Date }): Promise<ExtraPdf> {
  const lines = prescreenText(demoFraudScore(input.docs, input.callAnswered), { company: input.company, applicationName: input.applicationName, at: input.at });
  return { filename: "fraud-prescreen.pdf", content: await withFooter(await renderPrescreenPdf(lines.map(ascii))) };
}

// ---------------------------------------------------------------- client intake call note

export async function callNotePdf(input: { app: Pick<ApplicationRow, "contact" | "business" | "call">; brokerName: string; company: string; at: Date }): Promise<ExtraPdf> {
  const c = input.app.contact ?? {};
  const call = input.app.call ?? {};
  const when = new Date(call.completed_at ?? call.answered_at ?? input.at);
  const date = when.toLocaleString("en-CA", { timeZone: brokerageTimeZone(), year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  const secs = Number(call.duration_seconds ?? DEMO_DURATION_SECONDS);
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  const summary = call.summary ?? CALL_SUMMARY;
  const script = (Array.isArray(call.transcript) && call.transcript.length ? call.transcript : CALL_SCRIPT) as typeof CALL_SCRIPT;
  const who = (s: string) => (s === "broker" ? input.brokerName : String(c.name ?? "Borrower"));
  const content = await renderReport(
    "Client intake call note",
    `${input.app.business?.legal_name ?? ""} - prepared by ${input.company}`,
    [
      { kind: "kv", rows: [
        ["Caller", `${c.name ?? "Borrower"}${c.title ? `, ${c.title}` : ""}`],
        ["Phone", String(c.phone ?? "-")],
        ["Taken by", input.brokerName],
        ["When", date],
        ["Duration", mmss(secs)],
        ["Sentiment", String(summary.sentiment ?? "-")],
      ] },
      { kind: "h", text: "Summary" },
      { kind: "p", text: String(summary.headline ?? "") },
      { kind: "h", text: "Key points" },
      { kind: "bullets", items: (summary.points ?? []).map(String) },
      { kind: "h", text: "Follow-up" },
      { kind: "p", text: String(summary.follow_up ?? "") },
      { kind: "h", text: "Transcript" },
      ...script.map((l): Block => ({ kind: "p", text: `[${mmss(l.at)}] ${who(l.speaker)}: ${l.text}` })),
      { kind: "gap" },
      { kind: "p", muted: true, text: "Summary and transcript written by the AI call assistant from the call recording." },
    ],
  );
  return { filename: "client-intake-call-note.pdf", content };
}

// ---------------------------------------------------------------- bank summary

export function bankMonths() {
  return SAMPLE_STATEMENTS.map((s) => {
    // As printed on the statements on file (the doctored September copy shows the edited deposit).
    const printed = s.tx.map((t) => (s.month === DOCTORED.month && t.date === DOCTORED.date ? DOCTORED.shown : t.amount));
    const deposits = r2(printed.filter((a) => a > 0).reduce((a, b) => a + b, 0));
    const withdrawals = r2(-printed.filter((a) => a < 0).reduce((a, b) => a + b, 0));
    const closing = r2(s.opening + s.tx.reduce((a, t) => a + t.amount, 0));
    let low = s.opening, run = s.opening;
    for (const t of s.tx) { run += t.amount; low = Math.min(low, run); }
    return { month: s.month, label: s.label, opening: s.opening, deposits, withdrawals, closing, lowest: r2(low), count: s.tx.length };
  });
}

export async function bankSummaryPdf(input: { docs: DemoDocState[]; businessName: string; company: string }): Promise<ExtraPdf> {
  const months = bankMonths();
  const docFor = (label: string) => input.docs.find((d) => d.category === "bank_statement" && d.label.endsWith(label));
  const status = (label: string) => {
    const d = docFor(label);
    if (!d) return "not received";
    const fraud = d.fraud_status === "red" ? "failed fraud check" : d.fraud_status === "amber" ? "worth a look" : "passed";
    return `${d.status}, ${fraud}`;
  };
  const totalDep = months.reduce((a, m) => a + m.deposits, 0);
  const totalWd = months.reduce((a, m) => a + m.withdrawals, 0);
  const payees = new Map<string, number>();
  const payers = new Map<string, number>();
  for (const s of SAMPLE_STATEMENTS) for (const t of s.tx) {
    const name = t.description.replace(/^Customer payment - /, "");
    const map = t.amount < 0 ? payees : payers;
    map.set(name, (map.get(name) ?? 0) + Math.abs(t.amount));
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, v]) => [n, money(v)]);
  const red = input.docs.filter((d) => d.category === "bank_statement" && d.fraud_status === "red");
  const content = await renderReport(
    "Bank summary",
    `${input.businessName} - ${DEMO_BANK}, business chequing - ${months[0]!.label} to ${months[months.length - 1]!.label} - prepared by ${input.company}`,
    [
      { kind: "kv", rows: [
        ["Statements analysed", `${months.length} months (${months.reduce((a, m) => a + m.count, 0)} transactions)`],
        ["Average monthly deposits", money(totalDep / months.length)],
        ["Average monthly withdrawals", money(totalWd / months.length)],
        ["Lowest balance", money(Math.min(...months.map((m) => m.lowest)))],
        ["NSF / overdraft days", "0"],
        ["Existing debt payments", "Equipment loan, $5,400 a month (disclosed)"],
      ] },
      { kind: "h", text: "Month by month" },
      {
        kind: "table", head: ["Month", "Opening", "Deposits", "Withdrawals", "Closing", "Statement"], widths: [86, 72, 72, 78, 72, 132],
        align: ["l", "r", "r", "r", "r", "l"],
        rows: months.map((m) => [m.label, money(m.opening), money(m.deposits), money(m.withdrawals), money(m.closing), status(m.label)]),
      },
      { kind: "h", text: "Largest customers (deposits)" },
      { kind: "table", head: ["Customer", "Total"], widths: [300, 100], align: ["l", "r"], rows: top(payers) },
      { kind: "h", text: "Largest payments out" },
      { kind: "table", head: ["Payee", "Total"], widths: [300, 100], align: ["l", "r"], rows: top(payees) },
      ...(red.length ? [
        { kind: "h", text: "Flagged" } as Block,
        { kind: "bullets", items: [
          `${months.find((m) => m.month === DOCTORED.month)?.label} statement: the ${DOCTORED.date} deposit is printed as ${cents(DOCTORED.shown)} but the running balance only moves by ${cents(DOCTORED.real)}. The figures above are as printed; the original statement has been requested from the bank.`,
        ] } as Block,
      ] : []),
    ],
  );
  return { filename: "bank-summary.pdf", content };
}

// ---------------------------------------------------------------- financials summary

export async function financialsSummaryPdf(input: { app: Pick<ApplicationRow, "financials" | "request" | "business">; company: string }): Promise<ExtraPdf> {
  const years = (input.app.financials?.years ?? []) as FinancialYear[];
  const req = input.app.request ?? {};
  const pay = monthlyPayment(Number(req.amount ?? 0), ASSUMED_RATE_PCT, Number(req.term_months ?? 60));
  const row = (label: string, f: (y: FinancialYear) => string) => [label, ...years.map(f)];
  const m = (k: keyof FinancialYear) => (y: FinancialYear) => money(y[k]);
  const x2 = (n: number) => `${n.toFixed(2)}x`;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const widths = [190, ...years.map(() => 110)];
  const align = ["l" as const, ...years.map(() => "r" as const)];
  const head = ["", ...years.map((y) => `FY${y.year}`)];
  const cur = years[0];
  const content = await renderReport(
    "Financials summary",
    `${input.app.business?.legal_name ?? ""} - ${input.app.financials?.basis ?? "Financial statements"}, ${input.app.financials?.prepared_by ?? ""} - prepared by ${input.company}`,
    [
      { kind: "h", text: "Income statement" },
      { kind: "table", head, widths, align, rows: [
        row("Revenue", m("revenue")), row("Cost of sales", m("cogs")), row("Gross profit", m("gross_profit")),
        row("Gross margin", (y) => pct(y.gross_profit / y.revenue)), row("Operating expenses", m("operating_expenses")),
        row("EBITDA", m("ebitda")), row("EBITDA margin", (y) => pct(y.ebitda / y.revenue)), row("Depreciation", m("depreciation")),
        row("Interest", m("interest")), row("Net income", m("net_income")),
      ] },
      { kind: "h", text: "Balance sheet" },
      { kind: "table", head, widths, align, rows: [
        row("Total assets", m("total_assets")), row("Current assets", m("current_assets")), row("Current liabilities", m("current_liabilities")),
        row("Total liabilities", m("total_liabilities")), row("Equity", m("equity")),
        row("Current ratio", (y) => x2(y.current_assets / y.current_liabilities)), row("Debt to equity", (y) => x2(y.total_liabilities / y.equity)),
      ] },
      { kind: "h", text: "Debt service with the new loan" },
      { kind: "table", head, widths, align, rows: [
        row("Existing debt service", m("existing_debt_service")),
        row("New loan payments (12 months)", () => money(pay * 12)),
        row("Total debt service", (y) => money(y.existing_debt_service + pay * 12)),
        row("Debt service coverage", (y) => x2(y.ebitda / (y.existing_debt_service + pay * 12))),
      ] },
      { kind: "p", muted: true, text: `New loan: ${money(Number(req.amount ?? 0))} over ${req.term_months ?? 60} months at an assumed ${ASSUMED_RATE_PCT}% - about ${money(pay)} a month.${cur ? ` Revenue grew ${pct((cur.revenue - (years[1]?.revenue ?? cur.revenue)) / (years[1]?.revenue ?? cur.revenue))} year over year.` : ""}` },
    ],
  );
  return { filename: "financials-summary.pdf", content };
}
