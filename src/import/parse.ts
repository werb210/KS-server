// KS_SERVER_v14_DATA_IMPORT - reading the files a licensee brings: CSV (comma, semicolon or tab), XLSX (first sheet),
// and zips (a Keystone export, or documents plus a mapping CSV). Rows are produced one at a time by generators, so a
// job walks a file of tens of thousands of rows without building a second copy of it in memory.
import JSZip from "jszip";

export type Row = Record<string, string>;

/** Picks the delimiter that splits the header line into the most columns. */
export function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, 5000).split(/\r?\n/)[0] ?? "";
  let best = ",";
  let bestCount = 0;
  for (const d of [",", ";", "\t", "|"]) {
    let n = 0;
    let quoted = false;
    for (const ch of firstLine) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === d) n++;
    }
    if (n > bestCount) { best = d; bestCount = n; }
  }
  return best;
}

/** RFC 4180 records (arrays of cells), one at a time. Quoted cells may hold delimiters, quotes ("") and newlines. */
export function* iterateCsvRecords(input: string, delimiter?: string): Generator<string[]> {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const d = delimiter ?? detectDelimiter(text);
  const n = text.length;
  let i = 0;
  while (i < n) {
    const record: string[] = [];
    let cell = "";
    let quoted = false;
    let atCellStart = true;
    let ended = false;
    while (i < n) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        cell += ch; i++; continue;
      }
      if (ch === '"' && atCellStart) { quoted = true; atCellStart = false; i++; continue; }
      if (ch === d) { record.push(cell); cell = ""; atCellStart = true; i++; continue; }
      if (ch === "\r" || ch === "\n") {
        i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
        ended = true;
        break;
      }
      cell += ch; atCellStart = false; i++;
    }
    record.push(cell);
    void ended;
    // A blank line is not a record.
    if (record.length === 1 && record[0].trim() === "") continue;
    yield record;
  }
}

/** Makes header names unique and non-empty ("Email", "Email (2)", "Column 3"). */
export function normaliseHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, idx) => {
    let name = String(h ?? "").replace(/\s+/g, " ").trim() || `Column ${idx + 1}`;
    const key = name.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > 1) name = `${name} (${count})`;
    return name;
  });
}

export function recordToRow(headers: string[], record: string[]): Row {
  const row: Row = {};
  headers.forEach((h, idx) => { row[h] = String(record[idx] ?? "").trim(); });
  return row;
}

/** Header plus row objects from CSV text. */
export function* iterateCsvRows(text: string): Generator<Row> {
  let headers: string[] | null = null;
  for (const record of iterateCsvRecords(text)) {
    if (!headers) { headers = normaliseHeaders(record); continue; }
    if (record.every((c) => c.trim() === "")) continue;
    yield recordToRow(headers, record);
  }
}

export function csvHeaders(text: string): string[] {
  for (const record of iterateCsvRecords(text)) return normaliseHeaders(record);
  return [];
}

// ---------------------------------------------------------------------------------------------------------------
// XLSX: a zip of XML parts. Only what an export needs: the first worksheet, shared and inline strings, numbers,
// booleans and dates (cells with a date number format become YYYY-MM-DD).

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[e.toLowerCase()] ?? m;
  });
}

function textOf(fragment: string): string {
  // Rich text runs (<r><t>..</t></r>) and plain <t>; phonetic runs (<rPh>) are not part of the value.
  const clean = fragment.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) out += decodeXml(m[1] ?? "");
  return out;
}

function colIndex(ref: string): number {
  const letters = (ref.match(/^[A-Z]+/i)?.[0] ?? "A").toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function excelDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
}

export type XlsxSheet = { name: string; records: () => Generator<string[]> };

export async function readXlsx(buf: Buffer): Promise<XlsxSheet> {
  const zip = await JSZip.loadAsync(buf);
  const wb = await zip.file("xl/workbook.xml")?.async("string");
  if (!wb) throw new Error("This does not look like an Excel .xlsx file.");
  const firstSheet = /<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/.exec(wb) ?? /<sheet\b[^>]*r:id="([^"]+)"[^>]*name="([^"]*)"/.exec(wb);
  const sheetName = firstSheet ? decodeXml(/name="([^"]*)"/.exec(firstSheet[0])?.[1] ?? "Sheet1") : "Sheet1";
  const rid = firstSheet ? /r:id="([^"]+)"/.exec(firstSheet[0])?.[1] : undefined;
  let sheetPath = "xl/worksheets/sheet1.xml";
  const rels = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (rels && rid) {
    const rel = new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*>`).exec(rels)?.[0];
    const target = rel ? /Target="([^"]+)"/.exec(rel)?.[1] : undefined;
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  }
  const sheetXml = await zip.file(sheetPath)?.async("string");
  if (!sheetXml) throw new Error("The workbook has no readable first sheet.");

  const shared: string[] = [];
  const sst = await zip.file("xl/sharedStrings.xml")?.async("string");
  if (sst) {
    const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sst))) shared.push(textOf(m[1]));
  }

  // Styles: which cell style indexes are dates.
  const dateStyles = new Set<number>();
  const styles = await zip.file("xl/styles.xml")?.async("string");
  if (styles) {
    const custom = new Map<number, string>();
    for (const m of styles.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) custom.set(Number(m[1]), decodeXml(m[2]));
    const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
    let idx = 0;
    for (const m of xfs.matchAll(/<xf\b([^>]*)\/?>/g)) {
      const id = Number(/numFmtId="(\d+)"/.exec(m[1])?.[1] ?? 0);
      const code = custom.get(id) ?? "";
      if (BUILTIN_DATE_FORMATS.has(id) || (/[dmy]/i.test(code.replace(/\[[^\]]*\]|"[^"]*"/g, "")) && !/[#0]/.test(code))) dateStyles.add(idx);
      idx++;
    }
  }

  function* records(): Generator<string[]> {
    const rowRe = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(sheetXml!))) {
      const body = rm[1] ?? "";
      const cells: string[] = [];
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm: RegExpExecArray | null;
      let next = 0;
      while ((cm = cellRe.exec(body))) {
        const attrs = cm[1];
        const inner = cm[2] ?? "";
        const ref = /\br="([A-Z]+\d+)"/i.exec(attrs)?.[1];
        const at = ref ? colIndex(ref) : next;
        next = at + 1;
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
        const style = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? -1);
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let value = "";
        if (type === "s") value = shared[Number(v)] ?? "";
        else if (type === "inlineStr") value = textOf(inner);
        else if (type === "str" || type === "e") value = decodeXml(v ?? "");
        else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
        else if (v !== undefined) {
          const num = Number(v);
          value = dateStyles.has(style) && Number.isFinite(num) ? excelDate(num) : decodeXml(v);
        }
        while (cells.length < at) cells.push("");
        cells[at] = value;
      }
      if (cells.length === 0 || cells.every((c) => c.trim() === "")) continue;
      yield cells;
    }
  }
  return { name: sheetName, records };
}

export function* iterateRecordsAsRows(records: Generator<string[]>): Generator<Row> {
  let headers: string[] | null = null;
  for (const record of records) {
    if (!headers) { headers = normaliseHeaders(record); continue; }
    yield recordToRow(headers, record);
  }
}

/** One JSON object per line (a Keystone export's tables/<table>.jsonl). Bad lines are skipped by the caller. */
export function* iterateJsonl(text: string): Generator<{ line: number; value: Record<string, unknown> | null }> {
  let line = 0;
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    const raw = text.slice(start, end).trim();
    start = end + 1;
    line++;
    if (!raw) continue;
    try {
      const v = JSON.parse(raw);
      yield { line, value: v && typeof v === "object" && !Array.isArray(v) ? v : null };
    } catch {
      yield { line, value: null };
    }
  }
}

/** A CSV cell that cannot start a spreadsheet formula when the error file is opened in Excel. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) lines.push(headers.map((h) => csvCell(r[h])).join(","));
  return lines.join("\r\n") + "\r\n";
}
