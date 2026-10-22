// KS_SERVER_v10_DEMO - the sample documents the borrower uploads from their phone. Made here with pdf-lib, the same
// bytes every time (fixed dates, no random ids), so every server instance serves identical files and an upload can be
// checked against them. Every page says SAMPLE. The September statement is doctored on purpose: a deposit was
// "edited" in an online PDF editor after the bank issued it, so the real fraud checks (tamper scan + statement math)
// flag it.
import { createHash } from "node:crypto";
import { degrees, PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import {
  DEMO_BANK, DOCTORED, SAMPLE_BUSINESS, SAMPLE_CONTACT, SAMPLE_DOCS, SAMPLE_FINANCIALS, SAMPLE_STATEMENTS,
  type SampleStatement,
} from "./fixture.js";

export type SampleFile = { key: string; filename: string; mime: string; bytes: Buffer; sha256: string };

const ISSUED = new Date(Date.UTC(2026, 9, 2, 14, 5, 0)); // when the "bank" issued the statements
const ink = rgb(0.07, 0.09, 0.15);
const grey = rgb(0.35, 0.38, 0.45);

export const money = (n: number) =>
  `${n < 0 ? "-" : ""}${Math.abs(n).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function watermark(page: PDFPage, font: PDFFont, text = "SAMPLE") {
  page.drawText(text, { x: 150, y: 260, size: 96, font, color: rgb(0.86, 0.88, 0.92), rotate: degrees(35) });
}

async function newDoc(opts: { title: string; producer: string; creator: string; created: Date; modified: Date }) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(opts.title);
  doc.setProducer(opts.producer);
  doc.setCreator(opts.creator);
  doc.setCreationDate(opts.created);
  doc.setModificationDate(opts.modified);
  return doc;
}

async function save(doc: PDFDocument): Promise<Buffer> {
  return Buffer.from(await doc.save({ useObjectStreams: false, updateFieldAppearances: false }));
}

/** Column positions on a statement line: date, description, amount, balance. */
const COL = { date: 50, desc: 130, amount: 400, balance: 490 };

function statementPage(doc: PDFDocument, fonts: { reg: PDFFont; bold: PDFFont }, s: SampleStatement, printed: SampleStatement["tx"]) {
  const page = doc.addPage([612, 792]);
  watermark(page, fonts.bold);
  page.drawText(`${DEMO_BANK} (SAMPLE - fictional bank)`, { x: 50, y: 740, size: 14, font: fonts.bold, color: ink });
  page.drawText("Business chequing statement", { x: 50, y: 722, size: 11, font: fonts.reg, color: grey });
  page.drawText(`${SAMPLE_BUSINESS.legal_name} (sample business)`, { x: 50, y: 700, size: 11, font: fonts.reg, color: ink });
  page.drawText(`Account 00012-345-678901 (sample)   Period: ${s.label}`, { x: 50, y: 684, size: 10, font: fonts.reg, color: grey });
  page.drawText("Date", { x: COL.date, y: 650, size: 10, font: fonts.bold, color: ink });
  page.drawText("Description", { x: COL.desc, y: 650, size: 10, font: fonts.bold, color: ink });
  page.drawText("Amount", { x: COL.amount, y: 650, size: 10, font: fonts.bold, color: ink });
  page.drawText("Balance", { x: COL.balance, y: 650, size: 10, font: fonts.bold, color: ink });
  let y = 630;
  const row = (date: string, desc: string, amount: string | null, balance: string) => {
    if (date) page.drawText(date, { x: COL.date, y, size: 10, font: fonts.reg, color: ink });
    page.drawText(desc, { x: COL.desc, y, size: 10, font: fonts.reg, color: ink });
    if (amount) page.drawText(amount, { x: COL.amount, y, size: 10, font: fonts.reg, color: ink });
    page.drawText(balance, { x: COL.balance, y, size: 10, font: fonts.reg, color: ink });
    y -= 18;
  };
  row(`${s.month}-01`, "Opening balance", null, money(s.opening));
  // Balances are the bank's real running balances; the printed amount may differ (the doctored copy).
  let bal = s.opening;
  s.tx.forEach((t, i) => {
    bal = Math.round((bal + t.amount) * 100) / 100;
    row(t.date, t.description, money(printed[i]!.amount), money(bal));
  });
  row(s.tx[s.tx.length - 1]!.date, "Closing balance", null, money(bal));
  page.drawText("This is a SAMPLE statement made for a software demo. It is not a real bank record.", { x: 50, y: 60, size: 9, font: fonts.reg, color: grey });
}

async function statementPdf(s: SampleStatement, doctored: boolean): Promise<Buffer> {
  const created = ISSUED;
  const modified = doctored ? new Date(ISSUED.getTime() + 47 * 60_000) : ISSUED;
  const doc = await newDoc({
    title: `Statement ${s.label}`,
    // The real statements come from the credit union's statement service; the doctored one was re-saved in an online
    // PDF editor (iLovePDF), 47 minutes after it was issued.
    producer: doctored ? "iLovePDF" : `${DEMO_BANK} eStatement service`,
    creator: doctored ? "iLovePDF" : `${DEMO_BANK} eStatement service`,
    created, modified,
  });
  const fonts = { reg: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  const printed = s.tx.map((t) => (doctored && t.date === DOCTORED.date && t.amount === DOCTORED.real ? { ...t, amount: DOCTORED.shown } : t));
  statementPage(doc, fonts, s, printed);
  let bytes = await save(doc);
  if (doctored) {
    // A second save appended to the file, as an editor does when it saves changes on top of the original.
    bytes = Buffer.concat([bytes, Buffer.from("\n% incremental update: edited\n%%EOF\n", "latin1")]);
  }
  return bytes;
}

async function financialsPdf(): Promise<Buffer> {
  const doc = await newDoc({ title: "Financial statements FY2025", producer: "Sample accounting suite", creator: "Sample accounting suite", created: ISSUED, modified: ISSUED });
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]);
  watermark(page, bold);
  page.drawText(`${SAMPLE_BUSINESS.legal_name} (sample business)`, { x: 50, y: 740, size: 14, font: bold, color: ink });
  page.drawText(`Financial statements - ${SAMPLE_FINANCIALS.basis} - ${SAMPLE_FINANCIALS.prepared_by}`, { x: 50, y: 722, size: 10, font: reg, color: grey });
  const [cur, prev] = SAMPLE_FINANCIALS.years as [typeof SAMPLE_FINANCIALS.years[0], typeof SAMPLE_FINANCIALS.years[0]];
  let y = 690;
  const line = (label: string, a: number | string, b: number | string, strong = false) => {
    const f = strong ? bold : reg;
    page.drawText(label, { x: 50, y, size: 10, font: f, color: ink });
    page.drawText(typeof a === "number" ? money(a) : a, { x: 360, y, size: 10, font: f, color: ink });
    page.drawText(typeof b === "number" ? money(b) : b, { x: 470, y, size: 10, font: f, color: ink });
    y -= 17;
  };
  line("Income statement", `FY${cur.year}`, `FY${prev.year}`, true);
  line("Revenue", cur.revenue, prev.revenue);
  line("Cost of goods sold", -cur.cogs, -prev.cogs);
  line("Gross profit", cur.gross_profit, prev.gross_profit, true);
  line("Operating expenses", -cur.operating_expenses, -prev.operating_expenses);
  line("EBITDA", cur.ebitda, prev.ebitda, true);
  line("Depreciation", -cur.depreciation, -prev.depreciation);
  line("Interest", -cur.interest, -prev.interest);
  line("Net income before tax", cur.net_income, prev.net_income, true);
  y -= 12;
  line("Balance sheet", `FY${cur.year}`, `FY${prev.year}`, true);
  line("Current assets", cur.current_assets, prev.current_assets);
  line("Total assets", cur.total_assets, prev.total_assets);
  line("Current liabilities", cur.current_liabilities, prev.current_liabilities);
  line("Total liabilities", cur.total_liabilities, prev.total_liabilities);
  line("Shareholder equity", cur.equity, prev.equity, true);
  page.drawText("SAMPLE financial statements made for a software demo. Not a real company.", { x: 50, y: 60, size: 9, font: reg, color: grey });
  return save(doc);
}

async function voidChequePdf(): Promise<Buffer> {
  const doc = await newDoc({ title: "Void cheque", producer: `${DEMO_BANK} cheque service`, creator: `${DEMO_BANK} cheque service`, created: ISSUED, modified: ISSUED });
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 300]);
  page.drawRectangle({ x: 20, y: 20, width: 572, height: 260, borderColor: grey, borderWidth: 1.5, color: rgb(0.95, 0.97, 1) });
  page.drawText(`${SAMPLE_BUSINESS.legal_name}`, { x: 40, y: 245, size: 12, font: bold, color: ink });
  page.drawText(SAMPLE_BUSINESS.address, { x: 40, y: 229, size: 9, font: reg, color: grey });
  page.drawText("PAY TO THE ORDER OF ______________________________   $ ________", { x: 40, y: 170, size: 11, font: reg, color: ink });
  page.drawText(`${DEMO_BANK} (fictional)`, { x: 40, y: 120, size: 10, font: reg, color: grey });
  page.drawText("VOID", { x: 200, y: 95, size: 80, font: bold, color: rgb(0.75, 0.1, 0.1) });
  page.drawText("SAMPLE - NOT A REAL CHEQUE", { x: 360, y: 40, size: 10, font: bold, color: rgb(0.75, 0.1, 0.1) });
  page.drawText("c00123c 12345d678 901234567c", { x: 40, y: 40, size: 11, font: reg, color: ink });
  return save(doc);
}

async function idPlaceholderPdf(): Promise<Buffer> {
  const doc = await newDoc({ title: "ID placeholder", producer: "Keystone demo", creator: "Keystone demo", created: ISSUED, modified: ISSUED });
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([420, 270]);
  page.drawRectangle({ x: 10, y: 10, width: 400, height: 250, borderColor: grey, borderWidth: 1.5, color: rgb(0.97, 0.97, 0.97) });
  page.drawRectangle({ x: 30, y: 70, width: 110, height: 140, color: rgb(0.85, 0.87, 0.9) });
  page.drawText("NO PHOTO", { x: 52, y: 135, size: 12, font: bold, color: grey });
  page.drawText("SAMPLE ID - NOT A REAL DOCUMENT", { x: 160, y: 225, size: 12, font: bold, color: rgb(0.75, 0.1, 0.1) });
  page.drawText(`Name: ${SAMPLE_CONTACT.name} (sample)`, { x: 160, y: 190, size: 11, font: reg, color: ink });
  page.drawText("Licence no.: SAMPLE-0000-0000", { x: 160, y: 170, size: 11, font: reg, color: ink });
  page.drawText("Placeholder for a demo only.", { x: 160, y: 150, size: 10, font: reg, color: grey });
  page.drawText("A real file would hold the owner's", { x: 160, y: 120, size: 10, font: reg, color: grey });
  page.drawText("government ID here.", { x: 160, y: 106, size: 10, font: reg, color: grey });
  return save(doc);
}

let cache: Promise<Map<string, SampleFile>> | null = null;

async function build(): Promise<Map<string, SampleFile>> {
  const out = new Map<string, SampleFile>();
  const add = (key: string, bytes: Buffer) => {
    const def = SAMPLE_DOCS.find((d) => d.key === key)!;
    out.set(key, { key, filename: def.filename, mime: "application/pdf", bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
  };
  for (const s of SAMPLE_STATEMENTS) {
    add(`bank_${s.month.replace("-", "_")}`, await statementPdf(s, s.month === DOCTORED.month));
  }
  add("financials_2025", await financialsPdf());
  add("void_cheque", await voidChequePdf());
  add("photo_id", await idPlaceholderPdf());
  return out;
}

/** All sample files, made once per process. */
export function sampleFiles(): Promise<Map<string, SampleFile>> {
  if (!cache) cache = build().catch((err) => { cache = null; throw err; });
  return cache;
}

export async function sampleFile(key: string): Promise<SampleFile | null> {
  return (await sampleFiles()).get(key) ?? null;
}

/** For tests: make the files again without the cache. */
export function buildSampleFilesUncached(): Promise<Map<string, SampleFile>> {
  return build();
}
