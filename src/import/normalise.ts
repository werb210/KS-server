// KS_SERVER_v16_DATA_IMPORT - turning one mapped source row into the values Keystone stores, with the problems found
// in it. Pure: no database. Used by the preview (row errors), the dry run and the run.
import { FIELDS, type RecordType } from "./fields.js";

export type RowIssue = { field: string; message: string };
export type Normalised = { values: Record<string, unknown>; errors: RowIssue[]; warnings: RowIssue[] };

/** Keystone's pipeline stages (src/modules/applications/pipelineState.ts). */
export const KEYSTONE_STAGES = ["Received", "In Review", "Documents Required", "Additional Steps Required", "Off to Lender", "Offer", "Accepted", "Rejected", "Hold"] as const;

const STAGE_WORDS: Array<[RegExp, string]> = [
  [/\b(closed ?won|won|funded|accepted|approved and funded|paid|complete[d]?)\b/, "Accepted"],
  [/\b(closed ?lost|lost|declined|rejected|dead|cancel+ed|withdrawn|not interested|disqualified|unqualified)\b/, "Rejected"],
  [/\b(on hold|hold|paused|parked|nurture)\b/, "Hold"],
  [/\b(offer|term ?sheet|proposal|quote|negotiat\w*|approved|approval|contract sent|commitment)\b/, "Offer"],
  [/\b(off to lender|submitted|sent to lender|with lender|lender review|submission)\b/, "Off to Lender"],
  [/\b(documents? (required|needed|requested|pending)|docs? (required|needed|pending)|missing documents?|awaiting documents?)\b/, "Documents Required"],
  [/\b(additional steps?|conditions|stipulations?|stips)\b/, "Additional Steps Required"],
  [/\b(in review|review|underwriting|qualif\w*|analysis|processing|due diligence|decision maker bought in|presentation scheduled|needs analysis|value proposition|id\. decision makers|perception analysis)\b/, "In Review"],
  [/\b(new|received|lead|open|appointment scheduled|prospecting|contacted|incoming|inquiry|enquiry|application)\b/, "Received"],
];

/** Keystone stage for a source stage name: the licensee's own stage map first, then common CRM stage names. */
export function mapStage(raw: string, custom: Record<string, string> = {}): { stage: string; matched: boolean } {
  const s = String(raw ?? "").trim();
  if (!s) return { stage: "Received", matched: true };
  for (const [from, to] of Object.entries(custom)) {
    if (from.trim().toLowerCase() === s.toLowerCase() && (KEYSTONE_STAGES as readonly string[]).includes(to)) return { stage: to, matched: true };
  }
  const exact = KEYSTONE_STAGES.find((k) => k.toLowerCase() === s.toLowerCase());
  if (exact) return { stage: exact, matched: true };
  const lower = s.toLowerCase().replace(/[_-]+/g, " ");
  for (const [re, stage] of STAGE_WORDS) if (re.test(lower)) return { stage, matched: true };
  return { stage: "Received", matched: false };
}

export const LENDER_PRODUCT_CATEGORIES = ["LOC", "TERM", "FACTORING", "PO", "EQUIPMENT", "MCA", "MEDIA", "ABL", "SBA", "STARTUP"] as const;
const CATEGORY_WORDS: Array<[RegExp, string]> = [
  [/^(loc|line of credit|credit line|revolving|working capital line|business line)/, "LOC"],
  [/^(term|term loan|loan|installment)/, "TERM"],
  [/^(factoring|invoice factoring|receivables|ar financing|invoice financing)/, "FACTORING"],
  [/^(po|purchase order)/, "PO"],
  [/^(equipment|equipment financing|equipment loan|lease|leasing)/, "EQUIPMENT"],
  [/^(mca|merchant cash advance|cash advance|revenue based)/, "MCA"],
  [/^(media|media financing)/, "MEDIA"],
  [/^(abl|asset based|asset-based)/, "ABL"],
  [/^(sba|sba loan|sba 7\(a\)|7a|504)/, "SBA"],
  [/^(startup|start up|start-up)/, "STARTUP"],
];
export function mapCategory(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const up = s.toUpperCase();
  if ((LENDER_PRODUCT_CATEGORIES as readonly string[]).includes(up)) return up;
  const lower = s.toLowerCase();
  for (const [re, c] of CATEGORY_WORDS) if (re.test(lower)) return c;
  return null;
}

export const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
export const digitsOf = (s: string) => String(s ?? "").replace(/\D/g, "");
/** The last 10 digits: how phones are compared (a leading country code 1 or formatting does not matter). */
export const phoneKey = (s: string) => { const d = digitsOf(s); return d.length >= 7 ? d.slice(-10) : ""; };

/** "$1,200,000.00", "1 200 000", "(500)" -> number; null when blank; NaN when unreadable. */
export function parseNumber(raw: string): number | null {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$€£\s]|CAD|USD/gi, "");
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  s = s.replace(/%$/, "");
  const multi = /([kKmM])$/.exec(s);
  if (multi) s = s.slice(0, -1);
  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;
  const scaled = multi ? n * (multi[1].toLowerCase() === "k" ? 1_000 : 1_000_000) : n;
  return neg ? -scaled : scaled;
}

/** ISO, "YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY" (when the day is > 12), Excel-style text and epoch ms. */
export function parseDate(raw: string): Date | null | "invalid" {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^\d{12,13}$/.test(s)) { const d = new Date(Number(s)); return Number.isNaN(d.getTime()) ? "invalid" : d; }
  const slash = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(s);
  if (slash) {
    let a = Number(slash[1]); let b = Number(slash[2]); let y = Number(slash[3]);
    if (y < 100) y += 2000;
    let month = a; let day = b;
    if (a > 12 && b <= 12) { month = b; day = a; }
    let h = Number(slash[4] ?? 0);
    const min = Number(slash[5] ?? 0); const sec = Number(slash[6] ?? 0);
    if (slash[7]) { const pm = slash[7].toLowerCase() === "pm"; if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
    const d = new Date(Date.UTC(y, month - 1, day, h, min, sec));
    if (Number.isNaN(d.getTime()) || d.getUTCMonth() !== month - 1) return "invalid";
    void a; void b;
    return d;
  }
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(d.getTime())) return "invalid";
  if (d.getUTCFullYear() < 1900 || d.getUTCFullYear() > 2200) return "invalid";
  return d;
}

export function parseBool(raw: string): boolean | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (["y", "yes", "true", "1", "active", "on", "x"].includes(s)) return true;
  if (["n", "no", "false", "0", "inactive", "off", "disabled"].includes(s)) return false;
  return null;
}

export const splitList = (v: string) => String(v ?? "").split(/[;,|]/).map((s) => s.trim()).filter(Boolean);
/** Several ids in one cell (HubSpot "Associated Contact IDs": "123;456"): the first is the link. */
export const firstId = (v: string) => splitList(v)[0] ?? "";

function country(raw: string, fallback: "CA" | "BOTH"): string | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return fallback;
  if (["ca", "can", "canada"].includes(s)) return "CA";
  if (["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america", "america"].includes(s)) return "US";
  if (["both", "ca/us", "us/ca", "canada and us", "north america", "all"].includes(s)) return "BOTH";
  return null;
}

/** Applies the mapping: { field: column } -> { field: cell text }. */
export function applyMapping(row: Record<string, string>, mapping: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, column] of Object.entries(mapping)) {
    if (!column) continue;
    const v = row[column];
    out[field] = v === undefined || v === null ? "" : String(v).trim();
  }
  return out;
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export function normalise(type: RecordType, input: Record<string, string>, opts: { stageMap?: Record<string, string> } = {}): Normalised {
  const errors: RowIssue[] = [];
  const warnings: RowIssue[] = [];
  const v: Record<string, unknown> = {};
  const text = (k: string, max = 500) => { const s = String(input[k] ?? "").trim(); if (s) v[k] = cut(s, max); return s; };
  const email = (k: string) => {
    const s = String(input[k] ?? "").trim();
    if (!s) return "";
    if (!EMAIL_RE.test(s)) { errors.push({ field: k, message: `"${cut(s, 80)}" is not an email address` }); return ""; }
    v[k] = s.toLowerCase();
    return s;
  };
  const phone = (k: string) => {
    const s = String(input[k] ?? "").trim();
    if (!s) return "";
    if (digitsOf(s).length < 7) { warnings.push({ field: k, message: `"${cut(s, 40)}" does not look like a phone number; kept as written` }); }
    v[k] = cut(s, 40);
    return s;
  };
  const num = (k: string, opt: { int?: boolean; min?: number } = {}) => {
    const n = parseNumber(String(input[k] ?? ""));
    if (n === null) return;
    if (Number.isNaN(n)) { errors.push({ field: k, message: `"${cut(String(input[k]), 40)}" is not a number` }); return; }
    if (opt.min !== undefined && n < opt.min) { errors.push({ field: k, message: `must be ${opt.min} or more` }); return; }
    v[k] = opt.int ? Math.round(n) : n;
  };
  const date = (k: string) => {
    const d = parseDate(String(input[k] ?? ""));
    if (d === null) return;
    if (d === "invalid") { errors.push({ field: k, message: `"${cut(String(input[k]), 40)}" is not a date` }); return; }
    v[k] = d.toISOString();
  };
  const list = (k: string) => { const l = splitList(String(input[k] ?? "")); if (l.length) v[k] = l.slice(0, 50).map((x) => cut(x, 100)); };
  const bool = (k: string) => {
    const s = String(input[k] ?? "").trim();
    if (!s) return;
    const b = parseBool(s);
    if (b === null) errors.push({ field: k, message: `"${cut(s, 20)}" is not yes or no` });
    else v[k] = b;
  };
  const ext = (k: string) => { const s = firstId(String(input[k] ?? "")); if (s) v[k] = cut(s, 200); };

  switch (type) {
    case "contacts": {
      ext("external_id"); ext("company_external_id");
      let first = text("first_name", 200); let last = text("last_name", 200);
      const full = text("name", 300);
      if ((!first || !last) && full) {
        const parts = full.split(/\s+/).filter(Boolean);
        if (!first && parts.length) { first = parts[0]; v.first_name = first; }
        if (!last && parts.length > 1) { last = parts.slice(1).join(" "); v.last_name = last; }
      }
      const e = email("email"); email("secondary_email");
      const p = phone("phone"); phone("secondary_phone");
      if (!e && !p && !first && !last && !full) errors.push({ field: "email", message: "needs a name, an email or a phone number" });
      text("company_name", 300); text("job_title", 200); text("lead_status", 100); text("lifecycle_stage", 100); list("tags");
      text("address_street"); text("address_city", 200); text("address_state", 100); text("address_zip", 20); text("address_country", 100);
      email("owner_email"); date("created_at");
      break;
    }
    case "companies": {
      ext("external_id");
      if (!text("name", 300)) errors.push({ field: "name", message: "company name is required" });
      text("legal_name", 300); text("dba_name", 300); text("website", 300); text("domain", 200); email("email"); phone("phone");
      text("industry", 200); text("address_street"); text("city", 200); text("province", 100); text("country", 100); text("address_zip", 20);
      num("annual_revenue", { min: 0 }); num("number_of_employees", { int: true, min: 0 });
      list("types_of_financing"); list("tags"); email("owner_email"); date("created_at");
      break;
    }
    case "lenders": {
      ext("external_id");
      if (!text("name", 300)) errors.push({ field: "name", message: "lender name is required" });
      const c = country(String(input.country ?? ""), "CA");
      if (!c) errors.push({ field: "country", message: `"${cut(String(input.country), 30)}" is not CA, US or BOTH` }); else v.country = c;
      text("website", 300); phone("phone"); email("email"); text("street"); text("city", 200); text("region", 100); text("postal_code", 20);
      text("contact_name", 200); email("contact_email"); phone("contact_phone"); email("submission_email");
      const sm = String(input.submission_method ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (sm) {
        const m = sm === "google_sheets" ? "google_sheet" : sm;
        if (["email", "api", "google_sheet"].includes(m)) v.submission_method = m;
        else errors.push({ field: "submission_method", message: `"${cut(sm, 30)}" is not email, api or google_sheet` });
      }
      text("description", 5000); text("internal_notes", 5000); bool("active");
      break;
    }
    case "lender_products": {
      ext("external_id"); ext("lender_external_id"); text("lender_name", 300);
      if (!v.lender_external_id && !v.lender_name) errors.push({ field: "lender_name", message: "needs the lender's name or id" });
      if (!text("name", 300)) errors.push({ field: "name", message: "product name is required" });
      const cat = mapCategory(String(input.category ?? ""));
      if (!cat) errors.push({ field: "category", message: input.category ? `"${cut(String(input.category), 40)}" is not a product category (LOC, TERM, FACTORING, PO, EQUIPMENT, MCA, MEDIA, ABL, SBA, STARTUP)` : "category is required" });
      else v.category = cat;
      const c = country(String(input.country ?? ""), "BOTH");
      if (!c) errors.push({ field: "country", message: `"${cut(String(input.country), 30)}" is not CA, US or BOTH` }); else v.country = c;
      num("amount_min", { min: 0, int: true }); num("amount_max", { min: 0, int: true });
      if (typeof v.amount_min === "number" && typeof v.amount_max === "number" && v.amount_min > v.amount_max) errors.push({ field: "amount_max", message: "maximum amount is below the minimum" });
      num("rate_min", { min: 0 }); num("rate_max", { min: 0 });
      const rt = String(input.rate_type ?? "").trim().toUpperCase();
      if (rt) { if (rt === "FIXED" || rt === "VARIABLE") v.rate_type = rt; else errors.push({ field: "rate_type", message: `"${cut(rt, 20)}" is not FIXED or VARIABLE` }); }
      num("term_min", { int: true, min: 0 }); num("term_max", { int: true, min: 0 });
      num("min_credit_score", { int: true, min: 0 }); num("commission", { min: 0 });
      list("required_documents"); text("eligibility_notes", 5000); text("description", 5000); bool("active");
      break;
    }
    case "applications": {
      ext("external_id");
      if (!text("name", 300)) errors.push({ field: "name", message: "deal name is required" });
      const rawStage = String(input.stage ?? "").trim();
      const st = mapStage(rawStage, opts.stageMap);
      v.stage = st.stage;
      if (rawStage) v.source_stage = cut(rawStage, 200);
      if (!st.matched) warnings.push({ field: "stage", message: `"${cut(rawStage, 60)}" is not a Keystone stage; it will be Received unless you map it` });
      num("amount", { min: 0 }); num("funded_amount", { min: 0 });
      const pc = String(input.product_category ?? "").trim();
      if (pc) v.product_category = mapCategory(pc) ?? cut(pc, 100);
      ext("lender_product_external_id"); text("lender_product_name", 300); ext("lender_external_id"); text("lender_name", 300);
      ext("contact_external_id"); email("contact_email"); ext("company_external_id"); text("company_name", 300); email("owner_email");
      date("funded_at"); date("submitted_at"); date("created_at"); date("updated_at");
      break;
    }
    case "notes": {
      ext("external_id");
      const body = String(input.body ?? "").trim();
      const subject = String(input.subject ?? "").trim();
      if (!body && !subject) errors.push({ field: "body", message: "note text is required" });
      const t = String(input.activity_type ?? "").trim().toLowerCase();
      const type = /call/.test(t) ? "call" : /mail/.test(t) ? "email" : /meet|appointment|lunch/.test(t) ? "meeting" : /task|todo|to-do|deadline/.test(t) ? "task" : "note";
      v.activity_type = type;
      if (subject) v.subject = cut(subject, 300);
      if (body) v.body = cut(body, 20000);
      ext("contact_external_id"); email("contact_email"); ext("company_external_id"); text("company_name", 300); ext("application_external_id");
      if (!v.contact_external_id && !v.contact_email && !v.company_external_id && !v.company_name && !v.application_external_id) {
        errors.push({ field: "contact_email", message: "needs a contact, company or deal to attach to" });
      }
      email("author_email"); date("created_at");
      break;
    }
    case "documents": {
      const f = String(input.file ?? "").trim().replace(/\\/g, "/").replace(/^\.?\//, "");
      if (!f) errors.push({ field: "file", message: "file name is required" }); else v.file = f;
      const cat = String(input.category ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
      v.category = cut(cat || "other", 100);
      text("title", 300);
      ext("application_external_id"); ext("contact_external_id"); email("contact_email");
      if (!v.application_external_id && !v.contact_external_id && !v.contact_email) errors.push({ field: "application_external_id", message: "needs a deal or contact to attach to" });
      break;
    }
  }
  return { values: v, errors, warnings };
}

/** For the preview: the fields this record type knows, in order. */
export const fieldKeys = (type: RecordType) => FIELDS[type].map((f) => f.key);
