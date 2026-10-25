// KS_SERVER_v16_DATA_IMPORT - an uploaded file as a sequence of import items. Three shapes:
//   table     a CSV or XLSX of one record type; the admin's column mapping turns each row into Keystone fields
//   documents a zip of files plus a CSV/XLSX saying which deal or contact (and category) each file belongs to
//   keystone  a Keystone export zip (GET /api/export): tables/<table>.jsonl in dependency order, ids kept as the
//             source system's ids so the links between records survive, and the stored files under documents/
import JSZip from "jszip";
import path from "node:path";
import { csvHeaders, iterateCsvRows, iterateJsonl, iterateRecordsAsRows, readXlsx, type Row } from "./parse.js";
import { applyMapping } from "./normalise.js";
import type { RecordType } from "./fields.js";

export type FileKind = "csv" | "xlsx" | "zip";
export type SourceItem = {
  type: RecordType;
  /** 1-based row in its file (the header is row 0), or the line in a Keystone table. */
  rowNumber: number;
  raw: Record<string, unknown>;
  input: Record<string, string>;
  /** Documents only: reads the file this row points at, null when the zip does not have it. */
  readFile?: () => Promise<{ buffer: Buffer; name: string } | null>;
};

export type OpenedSource = {
  kind: "table" | "documents" | "keystone";
  columns: string[];
  /** Record types this source yields, in order (one for a table). */
  types: RecordType[];
  /** Counts per type (rows in the file). */
  counts: Partial<Record<RecordType, number>>;
  sample: (n: number) => Row[];
  items: (mapping: Record<string, string>) => Generator<SourceItem>;
};

export class SourceError extends Error {}

export function fileKindOf(name: string, mime?: string): FileKind | null {
  const ext = path.extname(String(name ?? "")).toLowerCase();
  if (ext === ".csv" || ext === ".txt" || ext === ".tsv") return "csv";
  if (ext === ".xlsx") return "xlsx";
  if (ext === ".zip") return "zip";
  if (mime === "text/csv") return "csv";
  if (mime === "application/zip" || mime === "application/x-zip-compressed") return "zip";
  return null;
}

function decodeText(buf: Buffer): string {
  // UTF-8 (with or without BOM); a file that is not valid UTF-8 is read as Windows-1252, which is what Excel
  // writes for "CSV" on many machines.
  const utf8 = buf.toString("utf8");
  if (!utf8.includes("�")) return utf8;
  return new TextDecoder("windows-1252").decode(buf);
}

/** Generic rows (CSV/XLSX) as an iterator factory plus the header. */
async function tableRows(kind: "csv" | "xlsx", buf: Buffer): Promise<{ columns: string[]; rows: () => Generator<Row> }> {
  if (kind === "csv") {
    const text = decodeText(buf);
    return { columns: csvHeaders(text), rows: () => iterateCsvRows(text) };
  }
  const sheet = await readXlsx(buf);
  const first = sheet.records().next();
  const { normaliseHeaders } = await import("./parse.js");
  const columns = first.done ? [] : normaliseHeaders(first.value);
  return { columns, rows: () => iterateRecordsAsRows(sheet.records()) };
}

function countOf(gen: Generator<unknown>): number {
  let n = 0;
  for (const _ of gen) { void _; n++; }
  return n;
}

function firstN<T>(gen: Generator<T>, n: number): T[] {
  const out: T[] = [];
  for (const x of gen) { if (out.length >= n) break; out.push(x); }
  return out;
}

/** Finds a file in the zip by the path the mapping CSV gives: exact, case-insensitive, then by file name alone. */
export function zipLookup(zip: JSZip): (name: string) => JSZip.JSZipObject | null {
  const files = Object.values(zip.files).filter((f) => !f.dir);
  const byLower = new Map(files.map((f) => [f.name.toLowerCase(), f]));
  const byBase = new Map<string, JSZip.JSZipObject | null>();
  for (const f of files) {
    const b = path.posix.basename(f.name).toLowerCase();
    byBase.set(b, byBase.has(b) ? null : f); // ambiguous names are not matched by basename
  }
  const root = (() => {
    // Everything in one top folder (a zipped folder): paths in the CSV are relative to it.
    const tops = new Set(files.map((f) => f.name.split("/")[0]));
    return tops.size === 1 && files.every((f) => f.name.includes("/")) ? `${[...tops][0]}/` : "";
  })();
  return (name: string) => {
    const n = String(name ?? "").replace(/\\/g, "/").replace(/^\.?\//, "");
    if (!n) return null;
    return zip.file(n) ?? byLower.get(n.toLowerCase()) ?? byLower.get(`${root}${n}`.toLowerCase()) ?? byBase.get(path.posix.basename(n).toLowerCase()) ?? null;
  };
}

const KEYSTONE_ORDER: Array<{ table: string; type: RecordType }> = [
  { table: "companies", type: "companies" },
  { table: "contacts", type: "contacts" },
  { table: "lenders", type: "lenders" },
  { table: "lender_products", type: "lender_products" },
  { table: "applications", type: "applications" },
  { table: "crm_notes", type: "notes" },
  { table: "documents", type: "documents" },
  { table: "contact_documents", type: "documents" },
];

const s = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? JSON.stringify(x) : String(x))).join("; ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

/** A Keystone row (column -> value) as import fields. users maps a user id to the email, for owners. */
export function keystoneInput(table: string, r: Record<string, any>, users: Map<string, string>): Record<string, string> {
  const owner = (id: unknown) => users.get(String(id ?? "")) ?? "";
  switch (table) {
    case "companies":
      return {
        external_id: s(r.id), name: s(r.name), legal_name: s(r.legal_name), dba_name: s(r.dba_name), website: s(r.website), domain: s(r.domain),
        email: s(r.email), phone: s(r.phone), industry: s(r.industry), address_street: s(r.address_street), city: s(r.city ?? r.address_city),
        province: s(r.province ?? r.address_state), country: s(r.country ?? r.address_country), address_zip: s(r.address_zip),
        annual_revenue: s(r.annual_revenue), number_of_employees: s(r.number_of_employees ?? r.employee_count),
        types_of_financing: s(r.types_of_financing), tags: s(r.tags), owner_email: owner(r.owner_id), created_at: s(r.created_at),
      };
    case "contacts":
      return {
        external_id: s(r.id), first_name: s(r.first_name), last_name: s(r.last_name), name: s(r.name), email: s(r.email), phone: s(r.phone),
        secondary_email: s(r.secondary_email), secondary_phone: s(r.secondary_phone), company_external_id: s(r.company_id),
        company_name: s(r.company_name), job_title: s(r.job_title), lead_status: s(r.lead_status), lifecycle_stage: s(r.lifecycle_stage),
        tags: s(r.tags), address_street: s(r.address_street), address_city: s(r.address_city), address_state: s(r.address_state),
        address_zip: s(r.address_zip), address_country: s(r.address_country), owner_email: owner(r.owner_id), created_at: s(r.created_at),
      };
    case "lenders":
      return {
        external_id: s(r.id), name: s(r.name), country: s(r.country), website: s(r.website), phone: s(r.phone ?? r.main_phone), email: s(r.email),
        street: s(r.street ?? r.street_address), city: s(r.city), region: s(r.region), postal_code: s(r.postal_code),
        contact_name: s(r.contact_name ?? r.primary_contact_name), contact_email: s(r.contact_email ?? r.primary_contact_email),
        contact_phone: s(r.contact_phone ?? r.primary_contact_phone), submission_method: s(r.submission_method), submission_email: s(r.submission_email),
        description: s(r.description), internal_notes: s(r.internal_notes), active: r.active === false ? "no" : "yes",
      };
    case "lender_products":
      return {
        external_id: s(r.id), lender_external_id: s(r.lender_id), lender_name: s(r.lender_name), name: s(r.name), category: s(r.category ?? r.type),
        country: s(r.country), amount_min: s(r.amount_min ?? r.min_amount), amount_max: s(r.amount_max ?? r.max_amount),
        rate_min: s(r.rate_min_num ?? r.interest_min ?? r.min_rate), rate_max: s(r.rate_max_num ?? r.interest_max ?? r.max_rate),
        rate_type: s(r.rate_type), term_min: s(r.term_min), term_max: s(r.term_max), min_credit_score: s(r.min_credit_score),
        commission: s(r.commission), required_documents: Array.isArray(r.required_documents) ? JSON.stringify(r.required_documents) : s(r.required_documents),
        eligibility_notes: s(r.eligibility_notes), description: s(r.description), active: r.active === false ? "no" : "yes",
      };
    case "applications":
      return {
        external_id: s(r.id), name: s(r.name), stage: s(r.pipeline_state ?? r.current_stage), amount: s(r.requested_amount),
        product_category: s(r.product_category), lender_product_external_id: s(r.lender_product_id), lender_external_id: s(r.lender_id),
        contact_external_id: s(r.contact_id), company_external_id: s(r.company_id), company_name: s(r.business_legal_name),
        owner_email: owner(r.owner_user_id), funded_amount: s(r.funded_amount), funded_at: s(r.funded_at), submitted_at: s(r.submitted_at),
        created_at: s(r.created_at), updated_at: s(r.updated_at),
      };
    case "crm_notes":
      return {
        external_id: s(r.id), body: s(r.body), contact_external_id: s(r.contact_id), company_external_id: s(r.company_id),
        application_external_id: s(r.application_id), author_email: owner(r.owner_id), created_at: s(r.created_at),
      };
    case "documents":
      return {
        external_id: s(r.id), category: s(r.category ?? r.document_type), title: s(r.display_name ?? r.title ?? r.filename),
        application_external_id: s(r.application_id), file: "",
      };
    case "contact_documents":
      return { external_id: s(r.id), category: "other", title: s(r.filename), contact_external_id: s(r.contact_id), file: "" };
    default:
      return {};
  }
}

export async function openSource(kind: FileKind, buf: Buffer, opts: { recordType: RecordType | "keystone"; } ): Promise<OpenedSource> {
  if (opts.recordType === "keystone") {
    if (kind !== "zip") throw new SourceError("A Keystone export is a .zip file (Settings, Import data, Download this portal's data).");
    return openKeystone(buf);
  }
  const type = opts.recordType;
  if (type === "documents") {
    if (kind !== "zip") throw new SourceError("Documents are imported as one .zip: the files plus a CSV saying where each one goes.");
    return openDocumentsZip(buf);
  }
  if (kind === "zip") throw new SourceError("Upload a .csv or .xlsx file for this record type.");
  const t = await tableRows(kind, buf);
  if (!t.columns.length) throw new SourceError("The file is empty - the first row should hold the column names.");
  const total = countOf(t.rows());
  return {
    kind: "table",
    columns: t.columns,
    types: [type],
    counts: { [type]: total },
    sample: (n) => firstN(t.rows(), n),
    items: function* (mapping) {
      let i = 0;
      for (const row of t.rows()) {
        i++;
        yield { type, rowNumber: i, raw: row, input: applyMapping(row, mapping) };
      }
    },
  };
}

async function openDocumentsZip(buf: Buffer): Promise<OpenedSource> {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(buf); } catch { throw new SourceError("The .zip file could not be opened."); }
  const lists = Object.values(zip.files)
    .filter((f) => !f.dir && /\.(csv|xlsx)$/i.test(f.name) && !f.name.startsWith("__MACOSX/"))
    .sort((a, b) => a.name.split("/").length - b.name.split("/").length || a.name.localeCompare(b.name));
  if (!lists.length) throw new SourceError("Put a CSV in the zip that lists each file with its deal or contact and category (see the documents template).");
  const listFile = lists[0];
  const listBuf = await listFile.async("nodebuffer");
  const t = await tableRows(/\.xlsx$/i.test(listFile.name) ? "xlsx" : "csv", listBuf);
  if (!t.columns.length) throw new SourceError(`${listFile.name} is empty - the first row should hold the column names.`);
  const find = zipLookup(zip);
  const total = countOf(t.rows());
  return {
    kind: "documents",
    columns: t.columns,
    types: ["documents"],
    counts: { documents: total },
    sample: (n) => firstN(t.rows(), n),
    items: function* (mapping) {
      let i = 0;
      for (const row of t.rows()) {
        i++;
        const input = applyMapping(row, mapping);
        yield {
          type: "documents", rowNumber: i, raw: row, input,
          readFile: async () => {
            const f = find(input.file ?? "");
            if (!f || f.name === listFile.name) return null;
            return { buffer: await f.async("nodebuffer"), name: path.posix.basename(f.name) };
          },
        };
      }
    },
  };
}

async function openKeystone(buf: Buffer): Promise<OpenedSource> {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(buf); } catch { throw new SourceError("The .zip file could not be opened."); }
  const tableFile = (t: string) => zip.file(`tables/${t}.jsonl`);
  if (!zip.file("manifest.json") && !tableFile("contacts") && !tableFile("applications")) {
    throw new SourceError("This zip is not a Keystone export: it has no manifest.json or tables/ folder.");
  }
  const users = new Map<string, string>();
  const usersFile = tableFile("users");
  if (usersFile) {
    for (const { value } of iterateJsonl(await usersFile.async("string"))) {
      if (value && value.id && value.email) users.set(String(value.id), String(value.email));
    }
  }
  // Stored files: documents/<table>/<id>-<name>, found by the id prefix.
  const stored = new Map<string, JSZip.JSZipObject>();
  for (const f of Object.values(zip.files)) {
    const m = /^documents\/([a-z_]+)\/([^/]+)$/.exec(f.name);
    if (!m || f.dir) continue;
    const id = /^([0-9a-fA-F-]{36}|[^-]+)-/.exec(m[2])?.[1];
    if (id) stored.set(`${m[1]}/${id}`, f);
  }
  const counts: Partial<Record<RecordType, number>> = {};
  const present: typeof KEYSTONE_ORDER = [];
  // The table rows (JSON lines) are decompressed here; the stored files only when their row is reached.
  const loaded = new Map<string, string>();
  for (const step of KEYSTONE_ORDER) {
    const f = tableFile(step.table);
    if (!f) continue;
    let n = 0;
    const text = await f.async("string");
    for (const { value } of iterateJsonl(text)) {
      if (!value) continue;
      if (step.table === "crm_notes" && value.is_deleted === true) continue;
      n++;
    }
    if (!n) continue;
    loaded.set(step.table, text);
    present.push(step);
    counts[step.type] = (counts[step.type] ?? 0) + n;
  }
  if (!present.length) throw new SourceError("The export has no contacts, companies, lenders, deals, notes or documents in it.");
  return {
    kind: "keystone",
    columns: [],
    types: [...new Set(present.map((p) => p.type))],
    counts,
    sample: (n) => {
      const out: Row[] = [];
      for (const step of present) {
        for (const { value } of iterateJsonl(loaded.get(step.table) ?? "")) {
          if (!value) continue;
          if (out.length >= n) return out;
          out.push({ table: step.table, ...Object.fromEntries(Object.entries(keystoneInput(step.table, value as any, users)).filter(([, v]) => v !== "")) });
        }
      }
      return out;
    },
    items: function* () {
      for (const step of present) {
        for (const { line, value } of iterateJsonl(loaded.get(step.table) ?? "")) {
          if (!value) continue;
          if (step.table === "crm_notes" && value.is_deleted === true) continue;
          const input = keystoneInput(step.table, value as any, users);
          const item: SourceItem = { type: step.type, rowNumber: line, raw: { table: step.table, id: value.id }, input };
          if (step.table === "documents" || step.table === "contact_documents") {
            const f = stored.get(`${step.table}/${String(value.id)}`);
            input.file = f ? f.name : `documents/${step.table}/${String(value.id)}`;
            const fname = String((value as any).filename ?? (value as any).file_name ?? "file");
            item.readFile = async () => (f ? { buffer: await f.async("nodebuffer"), name: fname } : null);
          }
          yield item;
        }
      }
    },
  };
}
