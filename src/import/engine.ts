// KS_SERVER_v14_DATA_IMPORT - writing imported rows, the dry run, the background run and undo.
//
// Every row goes through normalise() (pure) and then the writer for its record type inside a SAVEPOINT, so a bad row
// is recorded as an error and the rest carry on. Matching an existing record (all within the batch's silo, like the
// CRM import): the source system's id from an earlier import first, then
//   contacts        email, then phone (last 10 digits)
//   companies       name
//   lenders         name (lender names are unique across the copy)
//   lender products lender + product name
//   deals, notes    the source system's id only (a note also skips an exact duplicate)
//   documents       same deal + same file content, or same contact + file name + size
// A matched record is updated with the non-empty imported values (owner only filled when empty, tags merged).
//
// Dry run: one transaction over the whole file that is rolled back - counts are exact, including duplicates
// within the file - and existing records are not updated or locked; nothing is uploaded.
// Run: chunks of CHUNK rows, each its own transaction committed together with the progress counters, so an
// interrupted run resumes where it stopped. Everything created or changed is listed in import_batch_items (changed
// fields with their before and after values), which is what undo walks backwards.
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { Pool } from "pg";
import { normalise, phoneKey, splitList, type RowIssue } from "./normalise.js";
import { openSource, type FileKind, type OpenedSource, type SourceItem } from "./source.js";
import { isRecordType, type RecordType } from "./fields.js";
import { statusFromPipeline } from "../modules/applications/pipelineState.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";

export type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
type PoolLike = Db & { connect: () => Promise<Db & { release: (destroy?: boolean) => void }> };

export const CHUNK = 250;
export const DRY_RUN_PROGRESS_EVERY = 250;
export const MAX_STORED_ERRORS = 10_000;
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const STALE_JOB_MINUTES = 3;

export type FileStore = {
  get: (key: string) => Promise<Buffer | null>;
  put: (p: { buffer: Buffer; filename: string; contentType: string; pathPrefix?: string }) => Promise<{ blobName: string; url: string; sizeBytes: number; hash?: string }>;
  delete: (key: string) => Promise<void>;
};
export type JobDeps = {
  files: FileStore;
  audit?: (e: { actorUserId: string | null; action: string; batchId: string; metadata: Record<string, unknown> }) => Promise<void>;
};

export type Batch = {
  id: string; silo: string; source: string; record_type: string; file_name: string | null; file_key: string | null;
  file_kind: string | null; status: string; mapping: Record<string, string>; options: Record<string, any>;
  processed_rows: number; created_count: number; updated_count: number; skipped_count: number; error_count: number;
  created_by: string | null; created_by_email: string | null; total_rows: number;
};

type Counts = { created: number; updated: number; skipped: number; errors: number; warnings: number };
const zero = (): Counts => ({ created: 0, updated: 0, skipped: 0, errors: 0, warnings: 0 });

export type RowError = { level: "error" | "warning"; record_type: string; row_number: number; field: string; message: string; raw: unknown };
export type RowOutcome = { action: "created" | "updated" | "skipped" | "error"; issues: RowIssue[]; errors: RowIssue[] };

class RowFailure extends Error {
  constructor(public field: string, message: string) { super(message); }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown) => UUID_RE.test(String(v ?? ""));
const TABLE_OF: Record<RecordType, string> = {
  contacts: "contacts", companies: "companies", lenders: "lenders", lender_products: "lender_products",
  applications: "applications", notes: "crm_notes", documents: "documents",
};
const SILO_TABLES = new Set(["contacts", "companies", "applications", "crm_notes", "contact_documents"]);
const UNDO_TABLES = new Set(["contacts", "companies", "lenders", "lender_products", "applications", "crm_notes", "documents", "contact_documents"]);

/** Comparable text for a stored or imported value. */
export function comparable(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString();
  if (Array.isArray(v) || typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  if (/^-?\d+(\.\d+)?$/.test(s)) return String(Number(s));
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) { const d = new Date(s); if (!Number.isNaN(d.getTime())) return d.toISOString(); }
  return s;
}

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".heic": "image/heic", ".tif": "image/tiff", ".tiff": "image/tiff", ".csv": "text/csv", ".txt": "text/plain",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const contentTypeOf = (name: string) => CONTENT_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";

/** Writes rows of one batch. One instance per transaction scope (dry run) or per job (run). */
export class Importer {
  private columns = new Map<string, Map<string, string>>();
  private users: Map<string, string> | null = null;
  private docLabels: { labels: Set<string>; byKey: Map<string, string> } | null = null;
  private pendingBlob: string | null = null;
  readonly counts = zero();
  readonly byType: Record<string, Counts> = {};
  readonly blobsToDelete: string[] = [];

  constructor(private db: Db, private batch: Batch, private files: FileStore | null, private dry: boolean) {}

  setDb(db: Db) { this.db = db; }

  private async cols(table: string): Promise<Map<string, string>> {
    let c = this.columns.get(table);
    if (!c) {
      const r = await this.db.query(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table]);
      c = new Map(r.rows.map((x: any) => [String(x.column_name), String(x.data_type)]));
      this.columns.set(table, c);
    }
    return c;
  }

  private async userIdByEmail(email: unknown): Promise<string | null> {
    if (!email) return null;
    if (!this.users) {
      const r = await this.db.query(`SELECT id::text AS id, lower(email) AS email FROM users WHERE email IS NOT NULL AND deleted_at IS NULL`);
      this.users = new Map(r.rows.map((x: any) => [String(x.email), String(x.id)]));
    }
    return this.users.get(String(email).toLowerCase()) ?? null;
  }

  private get importer(): string | null { return isUuid(this.batch.created_by) ? this.batch.created_by : null; }

  private async findById(table: string, id: string): Promise<any | null> {
    if (!id) return null;
    if (["contacts", "companies", "lenders", "crm_notes", "contact_documents"].includes(table) && !isUuid(id)) return null;
    const silo = SILO_TABLES.has(table);
    const r = await this.db.query(
      `SELECT * FROM ${table} WHERE id::text = $1${silo ? " AND silo = $2" : ""} LIMIT 1`, silo ? [id, this.batch.silo] : [id]);
    return r.rows[0] ?? null;
  }

  /** The record an earlier import (or this one) made for a source id. Falls back to any source system when unique. */
  async byExternal(type: RecordType, externalId: unknown, table = TABLE_OF[type]): Promise<any | null> {
    const ext = String(externalId ?? "").trim();
    if (!ext) return null;
    const r = await this.db.query(
      `SELECT entity_table, entity_id, source_system FROM import_external_ids WHERE silo = $1 AND record_type = $2 AND external_id = $3`,
      [this.batch.silo, type, ext]);
    const same = r.rows.filter((x: any) => x.source_system === this.batch.source);
    const pick = same[0] ?? (r.rows.length === 1 ? r.rows[0] : null);
    if (pick) {
      const row = await this.findById(String(pick.entity_table), String(pick.entity_id));
      if (row) return { ...row, __table: String(pick.entity_table) };
    }
    // A Keystone export re-imported into the copy it came from: the id is the record's own id.
    if (this.batch.source === "keystone") {
      const row = await this.findById(table, ext);
      if (row) return { ...row, __table: table };
    }
    return null;
  }

  private async rememberExternal(type: RecordType, externalId: unknown, table: string, id: string) {
    const ext = String(externalId ?? "").trim();
    if (!ext) return;
    await this.db.query(
      `INSERT INTO import_external_ids (silo, source_system, record_type, external_id, entity_table, entity_id, batch_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (silo, source_system, record_type, external_id)
       DO UPDATE SET entity_table = EXCLUDED.entity_table, entity_id = EXCLUDED.entity_id, batch_id = EXCLUDED.batch_id`,
      [this.batch.silo, this.batch.source, type, ext, table, id, this.batch.id]);
  }

  private async recordItem(table: string, id: string, action: "created" | "updated", before: unknown, after: unknown, blob: string | null = null) {
    if (this.dry) return;
    await this.db.query(
      `INSERT INTO import_batch_items (batch_id, entity_table, entity_id, action, before, after, blob_name) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [this.batch.id, table, id, action, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), blob]);
  }

  private async param(table: string, col: string, v: unknown): Promise<unknown> {
    const type = (await this.cols(table)).get(col);
    if (type === "jsonb" || type === "json") return v === null || v === undefined ? null : JSON.stringify(v);
    return v;
  }

  private async insert(table: string, values: Record<string, unknown>): Promise<string> {
    const c = await this.cols(table);
    const names: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(values)) {
      if (!c.has(k) || v === undefined) continue;
      names.push(k);
      params.push(await this.param(table, k, v));
    }
    const r = await this.db.query(
      `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id::text AS id`, params);
    const id = String(r.rows[0]?.id ?? "");
    await this.recordItem(table, id, "created", null, null);
    return id;
  }

  /**
   * Changes the existing row to the desired values that are non-empty and different. fillOnly columns are only set
   * when empty; mergeArrays columns gain the new items. Returns whether anything changed. In a dry run nothing is
   * written (so existing records are never locked by a dry run).
   */
  private async update(table: string, existing: any, desired: Record<string, unknown>, opts: { fillOnly?: string[]; mergeArrays?: string[] } = {}): Promise<boolean> {
    const c = await this.cols(table);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [k, raw] of Object.entries(desired)) {
      if (!c.has(k) || raw === undefined || raw === null || raw === "") continue;
      let v = raw;
      const cur = existing[k];
      if (opts.fillOnly?.includes(k) && cur !== null && cur !== undefined && cur !== "") continue;
      if (opts.mergeArrays?.includes(k) && Array.isArray(v)) {
        const merged = [...new Set([...(Array.isArray(cur) ? cur : []), ...v])];
        if (merged.length === (Array.isArray(cur) ? cur.length : 0)) continue;
        v = merged;
      }
      if (Array.isArray(v) && v.length === 0) continue;
      if (comparable(cur) === comparable(v)) continue;
      before[k] = cur instanceof Date ? cur.toISOString() : cur ?? null;
      after[k] = v;
    }
    const keys = Object.keys(after);
    if (!keys.length) return false;
    if (this.dry) return true;
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const k of keys) { params.push(await this.param(table, k, after[k])); sets.push(`${k} = $${params.length}`); }
    if (c.has("updated_at") && !keys.includes("updated_at")) sets.push("updated_at = now()");
    params.push(String(existing.id));
    await this.db.query(`UPDATE ${table} SET ${sets.join(", ")} WHERE id::text = $${params.length}`, params);
    await this.recordItem(table, String(existing.id), "updated", before, after);
    return true;
  }

  // ---- record types ---------------------------------------------------------------------------------------------

  private async findCompany(v: Record<string, any>, extKey: string, nameKey: string): Promise<any | null> {
    if (v[extKey]) { const c = await this.byExternal("companies", v[extKey]); if (c) return c; }
    if (v[nameKey]) {
      const r = await this.db.query(`SELECT * FROM companies WHERE silo = $1 AND lower(name) = lower($2) ORDER BY created_at LIMIT 1`, [this.batch.silo, v[nameKey]]);
      if (r.rows[0]) return r.rows[0];
    }
    return null;
  }

  private async findContact(v: Record<string, any>, extKey: string, emailKey: string): Promise<any | null> {
    if (v[extKey]) { const c = await this.byExternal("contacts", v[extKey]); if (c) return c; }
    if (v[emailKey]) {
      const r = await this.db.query(
        `SELECT * FROM contacts WHERE silo = $1 AND lower(email) = lower($2) AND email IS NOT NULL AND email <> '' AND merged_into_id IS NULL ORDER BY created_at LIMIT 1`,
        [this.batch.silo, v[emailKey]]);
      if (r.rows[0]) return r.rows[0];
    }
    return null;
  }

  private async findLender(v: Record<string, any>): Promise<any | null> {
    if (v.lender_external_id) { const l = await this.byExternal("lenders", v.lender_external_id); if (l) return l; }
    if (v.lender_name) {
      const r = await this.db.query(`SELECT * FROM lenders WHERE lower(name) = lower($1) LIMIT 1`, [v.lender_name]);
      if (r.rows[0]) return r.rows[0];
    }
    return null;
  }

  private async owner(v: Record<string, any>, key: string, warnings: RowIssue[]): Promise<string | null> {
    if (!v[key]) return this.importer;
    const id = await this.userIdByEmail(v[key]);
    if (!id) warnings.push({ field: key, message: `no staff member signs in as ${v[key]}; owned by the person importing` });
    return id ?? this.importer;
  }

  private async contacts(v: Record<string, any>, w: RowIssue[]): Promise<"created" | "updated" | "skipped"> {
    let existing = v.external_id ? await this.byExternal("contacts", v.external_id) : null;
    if (!existing && v.email) existing = await this.findContact(v, "__none", "email");
    if (!existing && v.phone) {
      const key = phoneKey(String(v.phone));
      if (key) {
        const r = await this.db.query(
          `SELECT * FROM contacts WHERE silo = $1 AND phone IS NOT NULL AND phone <> ''
              AND right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = $2 AND merged_into_id IS NULL
            ORDER BY created_at LIMIT 1`, [this.batch.silo, key]);
        existing = r.rows[0] ?? null;
      }
    }
    let companyId: string | null = null;
    if (v.company_external_id || v.company_name) {
      const co = await this.findCompany(v, "company_external_id", "company_name");
      if (co) companyId = String(co.id);
      else if (v.company_external_id) w.push({ field: "company_external_id", message: `company ${v.company_external_id} was not found; import companies first to link it` });
    }
    const display = `${v.first_name ?? ""} ${v.last_name ?? ""}`.trim() || v.name || v.email || "";
    const desired: Record<string, unknown> = {
      first_name: v.first_name, last_name: v.last_name, name: display || undefined, email: v.email, phone: v.phone,
      secondary_email: v.secondary_email, secondary_phone: v.secondary_phone, company_name: v.company_name, company_id: companyId ?? undefined,
      job_title: v.job_title, lead_status: v.lead_status, lifecycle_stage: v.lifecycle_stage, tags: v.tags,
      address_street: v.address_street, address_city: v.address_city, address_state: v.address_state, address_zip: v.address_zip,
      address_country: v.address_country,
    };
    const ownerId = await this.owner(v, "owner_email", w);
    if (existing) {
      const changed = await this.update("contacts", existing, { ...desired, owner_id: ownerId }, { fillOnly: ["owner_id"], mergeArrays: ["tags"] });
      await this.rememberExternal("contacts", v.external_id, "contacts", String(existing.id));
      return changed ? "updated" : "skipped";
    }
    const id = await this.insert("contacts", {
      ...desired, first_name: v.first_name ?? "", last_name: v.last_name ?? "", name: display, lead_status: v.lead_status ?? "New",
      silo: this.batch.silo, owner_id: ownerId, created_at: v.created_at ?? undefined, tags: v.tags ?? undefined,
    });
    await this.rememberExternal("contacts", v.external_id, "contacts", id);
    return "created";
  }

  private async companies(v: Record<string, any>, w: RowIssue[]): Promise<"created" | "updated" | "skipped"> {
    let existing = v.external_id ? await this.byExternal("companies", v.external_id) : null;
    if (!existing) existing = await this.findCompany(v, "__none", "name");
    const desired: Record<string, unknown> = {
      legal_name: v.legal_name, dba_name: v.dba_name, website: v.website, domain: v.domain, email: v.email, phone: v.phone,
      industry: v.industry, address_street: v.address_street, city: v.city, province: v.province, country: v.country,
      address_zip: v.address_zip, annual_revenue: v.annual_revenue, number_of_employees: v.number_of_employees,
      types_of_financing: v.types_of_financing, tags: v.tags,
    };
    const ownerId = await this.owner(v, "owner_email", w);
    if (existing) {
      const changed = await this.update("companies", existing, { ...desired, owner_id: ownerId }, { fillOnly: ["owner_id"], mergeArrays: ["tags", "types_of_financing"] });
      await this.rememberExternal("companies", v.external_id, "companies", String(existing.id));
      return changed ? "updated" : "skipped";
    }
    const id = await this.insert("companies", {
      id: randomUUID(), name: v.name, ...desired, types_of_financing: v.types_of_financing ?? [], tags: v.tags ?? [],
      owner_id: ownerId, silo: this.batch.silo, created_at: v.created_at ?? undefined,
    });
    await this.rememberExternal("companies", v.external_id, "companies", id);
    return "created";
  }

  private async lenders(v: Record<string, any>): Promise<"created" | "updated" | "skipped"> {
    let existing = v.external_id ? await this.byExternal("lenders", v.external_id) : null;
    if (!existing) existing = await this.findLender({ lender_name: v.name });
    const desired: Record<string, unknown> = {
      country: v.country, website: v.website, phone: v.phone, email: v.email, street: v.street, city: v.city, region: v.region,
      postal_code: v.postal_code, contact_name: v.contact_name, contact_email: v.contact_email, contact_phone: v.contact_phone,
      submission_method: v.submission_method, submission_email: v.submission_email, description: v.description,
      internal_notes: v.internal_notes, active: v.active, status: v.active === false ? "INACTIVE" : v.active === true ? "ACTIVE" : undefined,
    };
    if (existing) {
      const changed = await this.update("lenders", existing, desired);
      await this.rememberExternal("lenders", v.external_id, "lenders", String(existing.id));
      return changed ? "updated" : "skipped";
    }
    const id = await this.insert("lenders", {
      id: randomUUID(), name: v.name, ...desired, country: v.country ?? "CA", active: v.active ?? true,
      status: v.active === false ? "INACTIVE" : "ACTIVE", silo: this.batch.silo,
    });
    await this.rememberExternal("lenders", v.external_id, "lenders", id);
    return "created";
  }

  private async requiredDocuments(list: unknown, w: RowIssue[]): Promise<unknown[] | undefined> {
    const raw = String(list ?? "").trim();
    if (!raw) return undefined;
    if (!this.docLabels) {
      const { PORTAL_FORM_DOC_LABELS } = await import("../routes/portalLenderProducts.js");
      const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      const labels = new Set<string>(PORTAL_FORM_DOC_LABELS);
      this.docLabels = { labels, byKey: new Map([...labels].map((l) => [key(l), l])) };
    }
    const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    let items: Array<Record<string, unknown>> = [];
    if (raw.startsWith("[")) {
      try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) items = parsed.map((x) => (x && typeof x === "object" ? x : { category: String(x) })); }
      catch { items = []; }
    }
    if (!items.length) items = splitList(raw).map((c) => ({ category: c }));
    const out: unknown[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      const label = String(it.category ?? it.document_type ?? "").trim();
      const resolved = this.docLabels.labels.has(label) ? label : this.docLabels.byKey.get(key(label));
      if (!resolved) { w.push({ field: "required_documents", message: `"${label}" is not one of the portal's document types; left out` }); continue; }
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      out.push({ category: resolved, required: it.required !== false, description: typeof it.description === "string" ? it.description : null, stage: it.stage === 2 ? 2 : 1 });
    }
    return out;
  }

  private async lender_products(v: Record<string, any>, w: RowIssue[]): Promise<"created" | "updated" | "skipped"> {
    let lender = await this.findLender(v);
    if (!lender) {
      if (!v.lender_name) throw new RowFailure("lender_external_id", `lender ${v.lender_external_id} was not found; import lenders first or add the lender's name`);
      const id = await this.insert("lenders", { id: randomUUID(), name: v.lender_name, country: v.country ?? "CA", active: true, status: "ACTIVE", silo: this.batch.silo });
      lender = { id, name: v.lender_name };
      w.push({ field: "lender_name", message: `lender "${v.lender_name}" did not exist and was added` });
    }
    let existing = v.external_id ? await this.byExternal("lender_products", v.external_id) : null;
    if (!existing) {
      const r = await this.db.query(`SELECT * FROM lender_products WHERE lender_id = $1 AND lower(name) = lower($2) LIMIT 1`, [String(lender.id), v.name]);
      existing = r.rows[0] ?? null;
    }
    const int32 = (n: unknown) => (typeof n === "number" && n <= 2147483647 ? n : undefined);
    const desired: Record<string, unknown> = {
      lender_id: String(lender.id), lender_name: String(lender.name ?? v.lender_name ?? ""), category: v.category, type: v.category,
      country: v.country, amount_min: v.amount_min, amount_max: v.amount_max, min_amount: int32(v.amount_min), max_amount: int32(v.amount_max),
      interest_min: v.rate_min !== undefined ? String(v.rate_min) : undefined, interest_max: v.rate_max !== undefined ? String(v.rate_max) : undefined,
      rate_min_num: v.rate_min, rate_max_num: v.rate_max, rate_type: v.rate_type, term_min: v.term_min, term_max: v.term_max,
      min_credit_score: v.min_credit_score, commission: v.commission, eligibility_notes: v.eligibility_notes, description: v.description,
      active: v.active, required_documents: await this.requiredDocuments(v.required_documents, w),
    };
    if (existing) {
      const changed = await this.update("lender_products", existing, desired);
      await this.rememberExternal("lender_products", v.external_id, "lender_products", String(existing.id));
      return changed ? "updated" : "skipped";
    }
    const id = await this.insert("lender_products", {
      id: randomUUID(), name: v.name, ...desired, country: v.country ?? "BOTH", active: v.active ?? true, status: "active",
      term_unit: "MONTHS", required_documents: desired.required_documents ?? [], silo: this.batch.silo,
    });
    await this.rememberExternal("lender_products", v.external_id, "lender_products", id);
    return "created";
  }

  private async applications(v: Record<string, any>, w: RowIssue[]): Promise<"created" | "updated" | "skipped"> {
    const existing = v.external_id ? await this.byExternal("applications", v.external_id) : null;
    const contact = v.contact_external_id || v.contact_email ? await this.findContact(v, "contact_external_id", "contact_email") : null;
    if ((v.contact_external_id || v.contact_email) && !contact) w.push({ field: "contact_email", message: `contact ${v.contact_external_id ?? v.contact_email} was not found; the deal has no contact` });
    const company = v.company_external_id || v.company_name ? await this.findCompany(v, "company_external_id", "company_name") : null;
    if (v.company_external_id && !company) w.push({ field: "company_external_id", message: `company ${v.company_external_id} was not found; the deal has no company` });
    const lender = v.lender_external_id || v.lender_name ? await this.findLender(v) : null;
    if ((v.lender_external_id || v.lender_name) && !lender) w.push({ field: "lender_name", message: `lender ${v.lender_external_id ?? v.lender_name} was not found` });
    let product: any = null;
    if (v.lender_product_external_id) product = await this.byExternal("lender_products", v.lender_product_external_id);
    if (!product && v.lender_product_name) {
      const r = await this.db.query(
        `SELECT * FROM lender_products WHERE lower(name) = lower($1)${lender ? " AND lender_id = $2" : ""} LIMIT 1`,
        lender ? [v.lender_product_name, String(lender.id)] : [v.lender_product_name]);
      product = r.rows[0] ?? null;
    }
    if ((v.lender_product_external_id || v.lender_product_name) && !product) w.push({ field: "lender_product_name", message: "lender product was not found" });
    const stage: string = v.stage ?? "Received";
    const desired: Record<string, unknown> = {
      name: v.name, pipeline_state: stage, current_stage: stage, status: statusFromPipeline(stage), requested_amount: v.amount,
      product_category: v.product_category, lender_id: lender ? String(lender.id) : product ? String(product.lender_id) : undefined,
      lender_product_id: product && isUuid(product.id) ? String(product.id) : undefined, contact_id: contact ? String(contact.id) : undefined,
      company_id: company ? String(company.id) : undefined, business_legal_name: company?.name ?? v.company_name,
      funded_amount: v.funded_amount, funded_at: v.funded_at, submitted_at: v.submitted_at,
    };
    const ownerId = await this.owner(v, "owner_email", w);
    if (existing) {
      const changed = await this.update("applications", existing, { ...desired, owner_user_id: ownerId }, { fillOnly: ["owner_user_id"] });
      await this.rememberExternal("applications", v.external_id, "applications", String(existing.id));
      return changed ? "updated" : "skipped";
    }
    const created = v.created_at ?? new Date().toISOString();
    const id = await this.insert("applications", {
      id: randomUUID(), ...desired, owner_user_id: ownerId, product_type: "standard", source: "import", silo: this.batch.silo,
      startup_flag: v.product_category === "STARTUP",
      submitted_at: v.submitted_at ?? (stage === "Received" ? undefined : created),
      parked_previous_stage: stage === "Hold" ? "Received" : undefined, parked_at: stage === "Hold" ? new Date().toISOString() : undefined,
      parked_reason: stage === "Hold" ? "On hold in the previous system" : undefined,
      metadata: { import: { batch_id: this.batch.id, source: this.batch.source, external_id: v.external_id ?? null, source_stage: v.source_stage ?? null } },
      created_at: created, updated_at: v.updated_at ?? created, last_updated: v.updated_at ?? created,
    });
    await this.rememberExternal("applications", v.external_id, "applications", id);
    return "created";
  }

  private async notes(v: Record<string, any>, w: RowIssue[]): Promise<"created" | "updated" | "skipped"> {
    const contact = v.contact_external_id || v.contact_email ? await this.findContact(v, "contact_external_id", "contact_email") : null;
    const company = v.company_external_id || v.company_name ? await this.findCompany(v, "company_external_id", "company_name") : null;
    const app = v.application_external_id ? await this.byExternal("applications", v.application_external_id) : null;
    if (!contact && !company && !app) throw new RowFailure("contact_external_id", "the contact, company or deal this note belongs to was not found; import those first");
    if ((v.contact_external_id || v.contact_email) && !contact) w.push({ field: "contact_email", message: "contact not found; note attached to the company or deal" });
    const label = { call: "Call", email: "Email", meeting: "Meeting", task: "Task", note: "" }[String(v.activity_type)] ?? "";
    const head = [label, v.subject].filter(Boolean).join(": ");
    const body = [head, v.body].filter(Boolean).join("\n\n");
    const authorId = await this.owner(v, "author_email", w);
    const links = { contact_id: contact ? String(contact.id) : null, company_id: company ? String(company.id) : (contact?.company_id ? String(contact.company_id) : null), application_id: app ? String(app.id) : null };
    const existing = v.external_id ? await this.byExternal("notes", v.external_id) : null;
    if (existing) {
      const changed = await this.update("crm_notes", existing, { body, ...links });
      return changed ? "updated" : "skipped";
    }
    const dup = await this.db.query(
      `SELECT id FROM crm_notes WHERE silo = $1 AND body = $2 AND contact_id IS NOT DISTINCT FROM $3::uuid AND company_id IS NOT DISTINCT FROM $4::uuid
          AND application_id IS NOT DISTINCT FROM $5::text AND ($6::timestamptz IS NULL OR created_at = $6::timestamptz) AND is_deleted = false LIMIT 1`,
      [this.batch.silo, body, links.contact_id, links.company_id, links.application_id, v.created_at ?? null]);
    if (dup.rows[0]) { await this.rememberExternal("notes", v.external_id, "crm_notes", String(dup.rows[0].id)); return "skipped"; }
    const id = await this.insert("crm_notes", { id: randomUUID(), body, ...links, owner_id: authorId, silo: this.batch.silo, created_at: v.created_at ?? undefined, updated_at: v.created_at ?? undefined });
    await this.rememberExternal("notes", v.external_id, "crm_notes", id);
    return "created";
  }

  private async documents(v: Record<string, any>, item: SourceItem, w: RowIssue[]): Promise<"created" | "updated" | "skipped"> {
    const app = v.application_external_id ? await this.byExternal("applications", v.application_external_id) : null;
    const contact = !app && (v.contact_external_id || v.contact_email) ? await this.findContact(v, "contact_external_id", "contact_email") : null;
    if (!app && !contact) throw new RowFailure(v.application_external_id ? "application_external_id" : "contact_email", "the deal or contact this document belongs to was not found; import those first");
    if (v.application_external_id && !app) w.push({ field: "application_external_id", message: "deal not found; attached to the contact" });
    const file = item.readFile ? await item.readFile() : null;
    if (!file) throw new RowFailure("file", `"${v.file}" is not in the zip`);
    if (file.buffer.length > MAX_DOCUMENT_BYTES) throw new RowFailure("file", `"${v.file}" is larger than 25 MB`);
    if (file.buffer.length === 0) throw new RowFailure("file", `"${v.file}" is empty`);
    const hash = createHash("sha256").update(file.buffer).digest("hex");
    const name = path.posix.basename(file.name) || "document";
    const ext = String(v.external_id ?? "").trim();
    if (app) {
      const dup = await this.db.query(`SELECT id FROM documents WHERE application_id = $1 AND hash = $2 LIMIT 1`, [String(app.id), hash]);
      if (dup.rows[0]) { await this.rememberExternal("documents", ext, "documents", String(dup.rows[0].id)); return "skipped"; }
    } else {
      const dup = await this.db.query(`SELECT id FROM contact_documents WHERE contact_id = $1 AND filename = $2 AND size_bytes = $3 LIMIT 1`, [String(contact.id), name, file.buffer.length]);
      if (dup.rows[0]) { await this.rememberExternal("documents", ext, "contact_documents", String(dup.rows[0].id)); return "skipped"; }
    }
    if (this.dry) return "created";
    if (!this.files) throw new RowFailure("file", "file storage is not available");
    const put = await this.files.put({ buffer: file.buffer, filename: name, contentType: contentTypeOf(name), pathPrefix: `imports/${this.batch.id}` });
    this.pendingBlob = put.blobName;
    let id: string;
    let table: string;
    if (app) {
      table = "documents";
      id = await this.insertDocument(String(app.id), v, name, put, hash);
    } else {
      table = "contact_documents";
      id = await this.insert("contact_documents", {
        id: randomUUID(), contact_id: String(contact.id), silo: this.batch.silo, filename: name, content_type: contentTypeOf(name),
        size_bytes: put.sizeBytes ?? file.buffer.length, blob_name: put.blobName, blob_url: put.url, source: "import",
      });
    }
    await this.db.query(`UPDATE import_batch_items SET blob_name = $1 WHERE batch_id = $2 AND entity_table = $3 AND entity_id = $4`, [put.blobName, this.batch.id, table, id]);
    this.pendingBlob = null;
    await this.rememberExternal("documents", ext, table, id);
    void w;
    return "created";
  }

  private async insertDocument(applicationId: string, v: Record<string, any>, name: string, put: { blobName: string; url: string; sizeBytes: number }, hash: string): Promise<string> {
    const now = new Date().toISOString();
    const id = await this.insert("documents", {
      id: randomUUID(), application_id: applicationId, owner_user_id: this.importer, title: v.title ?? name, display_name: v.title ?? undefined,
      filename: name, document_type: v.category ?? "other", category: v.category ?? "other", status: "uploaded", uploaded_by: "import",
      blob_name: put.blobName, storage_path: put.blobName, blob_url: put.url, size_bytes: put.sizeBytes, hash,
      // Already reviewed in the previous system: no OCR or tamper scan runs over a bulk import.
      ocr_status: "skipped", tamper_scanned_at: now, created_at: now, updated_at: now, uploaded_at: now,
    });
    const vc = await this.cols("document_versions");
    if (vc.has("document_id")) {
      await this.db.query(
        `INSERT INTO document_versions (id, document_id, version, blob_name, hash, metadata, content, created_at) VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6, now())`,
        [randomUUID(), id, put.blobName, hash, JSON.stringify({ source: "import", batch_id: this.batch.id }), put.url]);
    }
    return id;
  }

  /** One row: validate, then write inside a savepoint. */
  async processItem(item: SourceItem): Promise<RowOutcome> {
    const stageMap = (this.batch.options?.stage_map ?? {}) as Record<string, string>;
    const n = normalise(item.type, item.input, { stageMap });
    const counts = (this.byType[item.type] ??= zero());
    if (n.errors.length) {
      this.counts.errors++; counts.errors++;
      return { action: "error", issues: n.warnings, errors: n.errors };
    }
    const warnings = [...n.warnings];
    await this.db.query("SAVEPOINT import_row");
    try {
      let action: "created" | "updated" | "skipped";
      switch (item.type) {
        case "contacts": action = await this.contacts(n.values, warnings); break;
        case "companies": action = await this.companies(n.values, warnings); break;
        case "lenders": action = await this.lenders(n.values); break;
        case "lender_products": action = await this.lender_products(n.values, warnings); break;
        case "applications": action = await this.applications(n.values, warnings); break;
        case "notes": action = await this.notes(n.values, warnings); break;
        case "documents": action = await this.documents(n.values, item, warnings); break;
        default: throw new RowFailure("record_type", "unknown record type");
      }
      await this.db.query("RELEASE SAVEPOINT import_row");
      this.counts[action]++; counts[action]++;
      this.counts.warnings += warnings.length; counts.warnings += warnings.length;
      return { action, issues: warnings, errors: [] };
    } catch (err) {
      await this.db.query("ROLLBACK TO SAVEPOINT import_row");
      await this.db.query("RELEASE SAVEPOINT import_row");
      if (this.pendingBlob) { this.blobsToDelete.push(this.pendingBlob); this.pendingBlob = null; }
      this.counts.errors++; counts.errors++;
      if (err instanceof RowFailure) return { action: "error", issues: warnings, errors: [{ field: err.field, message: err.message }] };
      console.warn("[data-import] row failed", { batch: this.batch.id, type: item.type, row: item.rowNumber, message: (err as Error)?.message });
      return { action: "error", issues: warnings, errors: [{ field: "", message: `could not be saved: ${String((err as Error)?.message ?? err).slice(0, 300)}` }] };
    }
  }
}

export function issuesToErrors(item: SourceItem, outcome: RowOutcome): RowError[] {
  const raw = item.raw;
  return [
    ...outcome.errors.map((e) => ({ level: "error" as const, record_type: item.type, row_number: item.rowNumber, field: e.field, message: e.message, raw })),
    ...outcome.issues.map((e) => ({ level: "warning" as const, record_type: item.type, row_number: item.rowNumber, field: e.field, message: e.message, raw })),
  ];
}

async function saveErrors(db: Db, batchId: string, phase: string, errors: RowError[]) {
  for (let i = 0; i < errors.length; i += 500) {
    const part = errors.slice(i, i + 500);
    const params: unknown[] = [];
    const values = part.map((e) => {
      params.push(batchId, phase, e.level, e.record_type, e.row_number, e.field, e.message, JSON.stringify(e.raw ?? null));
      const b = params.length - 8;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}::jsonb)`;
    });
    await db.query(`INSERT INTO import_batch_errors (batch_id, phase, level, record_type, row_number, field, message, raw) VALUES ${values.join(", ")}`, params);
  }
}

export async function loadBatch(db: Db, id: string): Promise<Batch | null> {
  const r = await db.query(`SELECT * FROM import_batches WHERE id = $1`, [id]);
  const b = r.rows[0];
  if (!b) return null;
  return { ...b, mapping: b.mapping ?? {}, options: b.options ?? {} } as Batch;
}

export async function openBatchSource(batch: Batch, files: FileStore): Promise<OpenedSource> {
  if (!batch.file_key) throw new Error("the uploaded file is missing");
  const buf = await files.get(batch.file_key);
  if (!buf) throw new Error("the uploaded file could not be read from storage");
  const recordType = batch.source === "keystone" ? "keystone" : batch.record_type;
  if (recordType !== "keystone" && !isRecordType(recordType)) throw new Error(`unknown record type ${batch.record_type}`);
  return openSource(batch.file_kind as FileKind, buf, { recordType });
}

async function audit(deps: JobDeps, batch: Batch, action: string, metadata: Record<string, unknown>) {
  if (!deps.audit) return;
  try {
    await deps.audit({ actorUserId: isUuid(batch.created_by) ? batch.created_by : null, action, batchId: batch.id, metadata });
  } catch (err) {
    logWarnSwallowed(err, "import/engine.ts:audit");
  }
}

async function setFailed(db: Db, id: string, err: unknown) {
  const message = String((err as Error)?.message ?? err).slice(0, 1000);
  console.error("[data-import] job failed", { batch: id, message });
  await db.query(`UPDATE import_batches SET status = 'failed', last_error = $2, finished_at = now(), updated_at = now() WHERE id = $1`, [id, message]);
}

/** Dry run: every row in one transaction that is rolled back. Writes the summary and the row errors. */
export async function runDryRun(pool: PoolLike, batchId: string, deps: JobDeps): Promise<void> {
  const batch = await loadBatch(pool, batchId);
  if (!batch) return;
  let src: OpenedSource;
  try { src = await openBatchSource(batch, deps.files); } catch (err) { await setFailed(pool, batchId, err); return; }
  const client = await pool.connect();
  const importer = new Importer(client, batch, null, true);
  const errors: RowError[] = [];
  let processed = 0;
  let errorRows = 0;
  try {
    await client.query("BEGIN");
    for (const item of src.items(batch.mapping)) {
      const out = await importer.processItem(item);
      if (out.action === "error") errorRows++;
      for (const e of issuesToErrors(item, out)) if (errors.length < MAX_STORED_ERRORS) errors.push(e);
      processed++;
      if (processed % DRY_RUN_PROGRESS_EVERY === 0) {
        await pool.query(`UPDATE import_batches SET processed_rows = $2, heartbeat_at = now(), updated_at = now() WHERE id = $1`, [batchId, processed]);
      }
    }
  } catch (err) {
    await client.query("ROLLBACK").catch((e: unknown) => logWarnSwallowed(e, "import/engine.ts:dry_run_rollback"));
    client.release();
    await setFailed(pool, batchId, err);
    return;
  }
  await client.query("ROLLBACK");
  client.release();
  const summary = { ...importer.counts, error_rows: errorRows, rows: processed, by_type: importer.byType, finished_at: new Date().toISOString() };
  await pool.query(`DELETE FROM import_batch_errors WHERE batch_id = $1 AND phase = 'dry_run'`, [batchId]);
  await saveErrors(pool, batchId, "dry_run", errors);
  await pool.query(
    `UPDATE import_batches SET status = 'ready', dry_run = $2::jsonb, processed_rows = 0, heartbeat_at = NULL, updated_at = now() WHERE id = $1 AND status = 'dry_running'`,
    [batchId, JSON.stringify(summary)]);
}

/** The run: CHUNK rows per transaction, committed with the counters; resumes after processed_rows. */
export async function runImport(pool: PoolLike, batchId: string, deps: JobDeps): Promise<void> {
  const batch = await loadBatch(pool, batchId);
  if (!batch) return;
  let src: OpenedSource;
  try { src = await openBatchSource(batch, deps.files); } catch (err) { await setFailed(pool, batchId, err); return; }
  const startAt = batch.processed_rows ?? 0;
  const importer = new Importer(pool, batch, deps.files, false);
  const by = (batch as any).run_summary?.by_type ?? {};
  Object.assign(importer.byType, by);
  const iter = src.items(batch.mapping);
  let index = 0;
  for (let i = 0; i < startAt; i++) { if (iter.next().done) break; index++; }
  let done = false;
  try {
    while (!done) {
      const client = await pool.connect();
      importer.setDb(client);
      const errors: RowError[] = [];
      let c = { created: 0, updated: 0, skipped: 0, errors: 0 };
      let n = 0;
      try {
        await client.query("BEGIN");
        while (n < CHUNK) {
          const next = iter.next();
          if (next.done) { done = true; break; }
          const out = await importer.processItem(next.value);
          if (out.action === "error") c.errors++; else c[out.action]++;
          errors.push(...issuesToErrors(next.value, out));
          n++;
        }
        const stored = await client.query(`SELECT count(*)::int AS n FROM import_batch_errors WHERE batch_id = $1 AND phase = 'run'`, [batchId]);
        const room = Math.max(0, MAX_STORED_ERRORS - Number(stored.rows[0]?.n ?? 0));
        await saveErrors(client, batchId, "run", errors.slice(0, room));
        index += n;
        await client.query(
          `UPDATE import_batches SET processed_rows = $2, created_count = created_count + $3, updated_count = updated_count + $4,
                  skipped_count = skipped_count + $5, error_count = error_count + $6, run_summary = $7::jsonb, heartbeat_at = now(), updated_at = now()
            WHERE id = $1`,
          [batchId, index, c.created, c.updated, c.skipped, c.errors, JSON.stringify({ by_type: importer.byType })]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch((e: unknown) => logWarnSwallowed(e, "import/engine.ts:run_rollback"));
        throw err;
      } finally {
        client.release();
      }
      c = { created: 0, updated: 0, skipped: 0, errors: 0 };
      for (const blob of importer.blobsToDelete.splice(0)) await deps.files.delete(blob).catch((e: unknown) => logWarnSwallowed(e, "import/engine.ts:orphan_blob"));
    }
  } catch (err) {
    await setFailed(pool, batchId, err);
    await audit(deps, batch, "data_import.failed", { file: batch.file_name, record_type: batch.record_type, source: batch.source, processed: index });
    return;
  }
  await pool.query(`UPDATE import_batches SET status = 'completed', finished_at = now(), heartbeat_at = NULL, updated_at = now() WHERE id = $1`, [batchId]);
  const final = await loadBatch(pool, batchId);
  await audit(deps, batch, "data_import.completed", {
    file: batch.file_name, record_type: batch.record_type, source: batch.source, silo: batch.silo,
    created: final?.created_count, updated: final?.updated_count, skipped: final?.skipped_count, errors: final?.error_count,
  });
}

/** Undo: newest change first. Created rows are deleted (and their stored files); changed fields are put back while
 *  they still hold the imported value - a field someone has edited since is left as it is. */
export async function runUndo(pool: PoolLike, batchId: string, deps: JobDeps): Promise<void> {
  const batch = await loadBatch(pool, batchId);
  if (!batch) return;
  const prev = ((batch as any).undo_summary ?? {}) as Record<string, number>;
  const summary = { removed: prev.removed ?? 0, restored: prev.restored ?? 0, kept: prev.kept ?? 0, failed: prev.failed ?? 0 };
  const types = new Map<string, Map<string, string>>();
  const colTypes = async (db: Db, table: string) => {
    let t = types.get(table);
    if (!t) {
      const r = await db.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table]);
      t = new Map(r.rows.map((x: any) => [String(x.column_name), String(x.data_type)]));
      types.set(table, t);
    }
    return t;
  };
  try {
    for (;;) {
      const client = await pool.connect();
      const blobs: string[] = [];
      let n = 0;
      try {
        await client.query("BEGIN");
        const items = await client.query(
          `SELECT id, entity_table, entity_id, action, before, after, blob_name FROM import_batch_items
            WHERE batch_id = $1 AND undone_at IS NULL ORDER BY id DESC LIMIT 200`, [batchId]);
        n = items.rows.length;
        for (const it of items.rows) {
          const table = String(it.entity_table);
          if (!UNDO_TABLES.has(table)) { await client.query(`UPDATE import_batch_items SET undone_at = now() WHERE id = $1`, [it.id]); continue; }
          await client.query("SAVEPOINT undo_item");
          try {
            if (it.action === "created") {
              const del = await client.query(`DELETE FROM ${table} WHERE id::text = $1`, [String(it.entity_id)]);
              if (del.rowCount) summary.removed++;
              if (it.blob_name) blobs.push(String(it.blob_name));
            } else {
              const cur = (await client.query(`SELECT * FROM ${table} WHERE id::text = $1`, [String(it.entity_id)])).rows[0];
              if (cur) {
                const t = await colTypes(client, table);
                const before = (it.before ?? {}) as Record<string, unknown>;
                const after = (it.after ?? {}) as Record<string, unknown>;
                const sets: string[] = [];
                const params: unknown[] = [];
                for (const k of Object.keys(after)) {
                  if (!t.has(k)) continue;
                  if (comparable(cur[k]) !== comparable(after[k])) { summary.kept++; continue; }
                  const val = before[k];
                  params.push(t.get(k) === "jsonb" || t.get(k) === "json" ? (val === null || val === undefined ? null : JSON.stringify(val)) : val ?? null);
                  sets.push(`${k} = $${params.length}`);
                }
                if (sets.length) {
                  params.push(String(it.entity_id));
                  await client.query(`UPDATE ${table} SET ${sets.join(", ")} WHERE id::text = $${params.length}`, params);
                  summary.restored++;
                }
              }
            }
            await client.query("RELEASE SAVEPOINT undo_item");
          } catch (err) {
            await client.query("ROLLBACK TO SAVEPOINT undo_item");
            await client.query("RELEASE SAVEPOINT undo_item");
            summary.failed++;
            await client.query(
              `INSERT INTO import_batch_errors (batch_id, phase, level, record_type, field, message, raw) VALUES ($1, 'undo', 'error', $2, '', $3, $4::jsonb)`,
              [batchId, table, `could not undo: ${String((err as Error)?.message ?? err).slice(0, 300)}`, JSON.stringify({ id: it.entity_id })]);
          }
          await client.query(`UPDATE import_batch_items SET undone_at = now() WHERE id = $1`, [it.id]);
        }
        await client.query(`UPDATE import_batches SET undo_summary = $2::jsonb, heartbeat_at = now(), updated_at = now() WHERE id = $1`, [batchId, JSON.stringify(summary)]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch((e: unknown) => logWarnSwallowed(e, "import/engine.ts:undo_rollback"));
        throw err;
      } finally {
        client.release();
      }
      for (const b of blobs) await deps.files.delete(b).catch((e: unknown) => logWarnSwallowed(e, "import/engine.ts:undo_blob"));
      if (n === 0) break;
    }
    await pool.query(`DELETE FROM import_external_ids WHERE batch_id = $1`, [batchId]);
  } catch (err) {
    await setFailed(pool, batchId, err);
    return;
  }
  await pool.query(`UPDATE import_batches SET status = 'undone', finished_at = now(), heartbeat_at = NULL, updated_at = now() WHERE id = $1`, [batchId]);
  await audit(deps, batch, "data_import.undone", { file: batch.file_name, record_type: batch.record_type, ...summary });
}

/** Takes the next queued job (or one whose worker died) and marks it running. */
export async function claimNextJob(db: Db): Promise<{ id: string; status: string } | null> {
  const r = await db.query(
    `UPDATE import_batches b
        SET status = CASE b.status WHEN 'dry_run_queued' THEN 'dry_running' WHEN 'queued' THEN 'running' WHEN 'undo_queued' THEN 'undoing' ELSE b.status END,
            heartbeat_at = now(), started_at = COALESCE(b.started_at, now()), updated_at = now()
      WHERE b.id = (
        SELECT id FROM import_batches
         WHERE status IN ('dry_run_queued', 'queued', 'undo_queued')
            OR (status IN ('dry_running', 'running', 'undoing') AND (heartbeat_at IS NULL OR heartbeat_at < now() - interval '${STALE_JOB_MINUTES} minutes'))
         ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING b.id::text AS id, b.status`);
  return r.rows[0] ? { id: String(r.rows[0].id), status: String(r.rows[0].status) } : null;
}

/** Runs queued jobs one after another until none is left. Returns how many ran. */
export async function runQueuedJobs(pool: Pool | PoolLike, deps: JobDeps, max = 20): Promise<number> {
  const p = pool as unknown as PoolLike;
  let ran = 0;
  for (; ran < max; ran++) {
    const job = await claimNextJob(p);
    if (!job) break;
    if (job.status === "dry_running") {
      // A dry run that was interrupted starts again from the top (nothing of it was kept).
      await p.query(`UPDATE import_batches SET processed_rows = 0 WHERE id = $1`, [job.id]);
      await runDryRun(p, job.id, deps);
    } else if (job.status === "running") await runImport(p, job.id, deps);
    else if (job.status === "undoing") await runUndo(p, job.id, deps);
  }
  return ran;
}
