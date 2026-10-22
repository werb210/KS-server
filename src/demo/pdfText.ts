// KS_SERVER_v10_DEMO - reads the text layer of a PDF as lines (items on the same baseline joined left to right) and
// turns bank-statement lines into the rows the statement-math check (fraud check 2) walks. The live system gets these
// rows from OCR; the demo statements carry a text layer, so the demo reads it straight from the uploaded file.
import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from "pdf-lib";
import type { StatementRow } from "../fraud/checks/statementMath.js";

const MAX_PAGES = 20;
const MAX_CONTENT = 1024 * 1024;

type Item = { x: number; y: number; text: string };

function decodeLiteral(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_m, c: string) => {
    if (/^[0-7]+$/.test(c)) return String.fromCharCode(parseInt(c, 8));
    return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" } as Record<string, string>)[c] ?? c;
  });
}

function decodeHex(h: string): string {
  const clean = h.replace(/\s+/g, "");
  let out = "";
  for (let i = 0; i + 1 < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

/** Text-showing operators in one content stream, each with the position set by the last Tm / Td before it. */
export function itemsFromContent(content: string): Item[] {
  const items: Item[] = [];
  let x = 0, y = 0;
  const re = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm|(-?[\d.]+)\s+(-?[\d.]+)\s+Td|<([0-9a-fA-F\s]*)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj|\bBT\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (m[1] !== undefined) { x = Number(m[5]); y = Number(m[6]); }
    else if (m[7] !== undefined) { x += Number(m[7]); y += Number(m[8]); }
    else if (m[9] !== undefined) items.push({ x, y, text: decodeHex(m[9]) });
    else if (m[10] !== undefined) items.push({ x, y, text: decodeLiteral(m[10]) });
    else { x = 0; y = 0; } // BT resets the text matrix
  }
  return items;
}

/** Lines of text, top to bottom, page by page. Items on one baseline are joined with two spaces. */
export async function pdfTextLines(buffer: Buffer): Promise<string[]> {
  if (!buffer.subarray(0, 5).toString("latin1").startsWith("%PDF-")) return [];
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  } catch {
    return [];
  }
  const lines: string[] = [];
  for (const page of doc.getPages().slice(0, MAX_PAGES)) {
    const contents = page.node.get(PDFName.of("Contents"));
    const streams: PDFRawStream[] = [];
    const add = (o: unknown) => { const v = o instanceof PDFRef ? doc.context.lookup(o) : o; if (v instanceof PDFRawStream) streams.push(v); };
    if (contents instanceof PDFArray) contents.asArray().forEach(add); else add(contents);
    let text = "";
    for (const s of streams) {
      try { text += Buffer.from(decodePDFRawStream(s).decode()).toString("latin1") + "\n"; } catch { /* undecodable stream: skip */ }
      if (text.length > MAX_CONTENT) break;
    }
    const byLine = new Map<number, Item[]>();
    for (const it of itemsFromContent(text.slice(0, MAX_CONTENT))) {
      const key = Math.round(it.y);
      if (!byLine.has(key)) byLine.set(key, []);
      byLine.get(key)!.push(it);
    }
    for (const key of [...byLine.keys()].sort((a, b) => b - a)) {
      lines.push(byLine.get(key)!.sort((a, b) => a.x - b.x).map((i) => i.text.trim()).filter(Boolean).join("  "));
    }
  }
  return lines;
}

const AMOUNT = "-?[\\d,]+\\.\\d{2}";
const TX_LINE = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})\\s{2,}(.+?)\\s{2,}(${AMOUNT})\\s{2,}(${AMOUNT})$`);
const BAL_LINE = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})\\s{2,}((?:Opening|Closing) balance)\\s{2,}(${AMOUNT})$`, "i");
const num = (s: string) => Number(s.replace(/,/g, ""));

/** Statement rows (opening, transactions, closing) from the statement's text lines. */
export function statementRowsFromLines(lines: string[]): StatementRow[] {
  const rows: StatementRow[] = [];
  for (const line of lines) {
    const b = BAL_LINE.exec(line);
    if (b) { rows.push({ date: b[1]!, description: b[2]!, amount: null, balance: num(b[3]!) }); continue; }
    const t = TX_LINE.exec(line);
    if (t) rows.push({ date: t[1]!, description: t[2]!, amount: num(t[3]!), balance: num(t[4]!) });
  }
  return rows;
}
