// KS_SERVER_v10_DEMO - the lender submission package for the sample file: a cover page, the credit summary, the call
// note, the document index with each file's fraud-check result, then the accepted documents themselves. Every page is
// marked SAMPLE. This is the PDF KS-Ops emails to the prospect.
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import type { CreditSummary } from "./creditSummary.js";
import type { LenderMatch } from "./lenders.js";
import type { DocumentRow } from "./repo.js";

const ink = rgb(0.07, 0.09, 0.15);
const grey = rgb(0.32, 0.35, 0.42);
const red = rgb(0.6, 0.08, 0.08);
const W = 612, H = 792, M = 50;

/** Only characters the standard PDF fonts can draw (prospect-typed names may hold others). */
export function pdfSafe(s: unknown): string {
  return String(s ?? "")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of pdfSafe(text).split(/\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) { out.push(line); line = word; }
      else line = next;
    }
    out.push(line);
  }
  return out;
}

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(private doc: PDFDocument, private reg: PDFFont, private bold: PDFFont, private footer: string) { this.newPage(); }
  newPage() {
    this.page = this.doc.addPage([W, H]);
    this.page.drawText("SAMPLE - DEMO PACKAGE", { x: W - M - 150, y: H - 30, size: 9, font: this.bold, color: red });
    this.page.drawText(pdfSafe(this.footer), { x: M, y: 25, size: 8, font: this.reg, color: grey });
    this.y = H - 60;
  }
  ensure(h: number) { if (this.y - h < 50) this.newPage(); }
  heading(t: string) { this.ensure(30); this.y -= 8; this.page.drawText(pdfSafe(t), { x: M, y: this.y, size: 13, font: this.bold, color: ink }); this.y -= 18; }
  text(t: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; indent?: number } = {}) {
    const size = opts.size ?? 10, font = opts.bold ? this.bold : this.reg, x = M + (opts.indent ?? 0);
    for (const line of wrap(t, font, size, W - x - M)) {
      this.ensure(size + 4);
      this.page.drawText(line, { x, y: this.y, size, font, color: opts.color ?? ink });
      this.y -= size + 4;
    }
  }
  bullet(t: string) { this.text(`-  ${t}`, { indent: 8 }); }
  gap(n = 6) { this.y -= n; }
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-CA")}`;

export async function buildLenderPackage(input: {
  prospect: { name: string; company: string };
  summary: CreditSummary;
  lenders: LenderMatch[];
  documents: DocumentRow[];
  accepted: Array<{ label: string; content: Buffer; mime_type: string }>;
  call: { summary?: { headline: string; points: string[]; follow_up: string } } | null;
  submittedAt: Date;
}): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle("Lender submission package (SAMPLE)");
  doc.setProducer("Keystone demo");
  doc.setCreator("Keystone demo");
  doc.setCreationDate(input.submittedAt);
  doc.setModificationDate(input.submittedAt);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const s = input.summary;
  const w = new Writer(doc, reg, bold, `Sample package made in the Keystone demo by ${input.prospect.name}, ${input.prospect.company}. Fictional business and lenders.`);

  w.text("Lender submission package", { size: 22, bold: true });
  w.gap(4);
  w.text(s.headline, { size: 12 });
  w.gap(10);
  w.text(`Prepared by ${input.prospect.name} (${input.prospect.company}) on ${input.submittedAt.toISOString().slice(0, 10)}`, { color: grey });
  w.text("This is a SAMPLE package from a software demo. The business, people, bank and lenders are fictional.", { color: red, bold: true });
  w.gap(8);
  w.heading("Submitted to");
  for (const l of input.lenders) w.bullet(`${l.name} - ${l.product} (${l.rate}, ${l.term}) - match ${l.score}/100`);

  w.heading("Borrower");
  w.text(`${s.borrower.legal_name} - ${s.borrower.industry}`);
  w.text(`${s.borrower.years_in_business} years in business, ${s.borrower.location}. Owner: ${s.borrower.owner}`);
  w.heading("Request");
  w.text(`${money(s.request.amount)} ${s.request.product}, ${s.request.term_months} months. ${s.request.purpose}`);

  w.heading("Credit summary");
  const f = s.financial_snapshot;
  w.text(`FY${f.year}: revenue ${money(f.revenue)} (${f.revenue_growth_pct >= 0 ? "+" : ""}${f.revenue_growth_pct}%), EBITDA ${money(f.ebitda)} (${f.ebitda_margin_pct}%), net income ${money(f.net_income)}.`);
  w.text(`Current ratio ${f.current_ratio.toFixed(2)}, debt to equity ${f.debt_to_equity.toFixed(2)}. New payment about ${money(f.proposed_payment_monthly)}/month at an assumed ${f.assumed_rate_pct}%.`);
  w.text(`Debt service coverage (all debt incl. the new loan): ${f.dscr.toFixed(2)}x.`, { bold: true });
  w.text(s.banking.revenue_check);
  w.gap(4);
  w.text("Strengths", { bold: true });
  s.strengths.forEach((x) => w.bullet(x));
  if (s.risks.length) { w.text("Risks", { bold: true }); s.risks.forEach((x) => w.bullet(x)); }
  w.text("Conditions", { bold: true });
  s.conditions.forEach((x) => w.bullet(x));
  w.text(`Recommendation: ${s.recommendation}`, { bold: true });

  if (input.call?.summary) {
    w.heading("Call note (AI summary)");
    w.text(input.call.summary.headline);
    input.call.summary.points.forEach((p) => w.bullet(p));
    w.text(input.call.summary.follow_up, { color: grey });
  }

  w.heading("Documents and fraud checks");
  for (const d of input.documents) {
    const verdict = d.fraud_status === "red" ? "CONCERN" : d.fraud_status === "amber" ? "Worth a look" : d.fraud_status === "green" ? "No concerns" : "Not checked";
    w.text(`${d.label} - ${d.status.toUpperCase()} - fraud check: ${verdict}`, { bold: d.fraud_status === "red" });
    const reasons = [...(d.tamper?.reasons ?? []), ...(d.statement_math?.reasons ?? [])].filter((r: { severity?: string }) => r.severity !== "info");
    reasons.slice(0, 3).forEach((r: { text: string }) => w.text(r.text, { indent: 14, size: 9, color: grey }));
    if (d.reject_reason) w.text(`Rejected: ${d.reject_reason}`, { indent: 14, size: 9, color: grey });
  }
  if (!input.accepted.length) w.text("No documents were accepted, so none are attached.", { color: grey });

  for (const a of input.accepted) {
    if (a.mime_type !== "application/pdf") continue;
    try {
      const src = await PDFDocument.load(a.content, { ignoreEncryption: true, updateMetadata: false });
      const pages = await doc.copyPages(src, src.getPageIndices().slice(0, 10));
      pages.forEach((p) => {
        doc.addPage(p);
        p.drawText(pdfSafe(`Attachment: ${a.label} (SAMPLE)`), { x: M, y: 12, size: 8, font: reg, color: grey });
      });
    } catch (err) {
      console.warn("[demo] could not attach", a.label, err instanceof Error ? err.message : String(err));
    }
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
