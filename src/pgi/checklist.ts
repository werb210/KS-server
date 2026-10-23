// KS_SERVER_v11_PGI - what the insurer needs, mapped onto this brokerage's documents and application. Pure.
//
// PGI (Personal Guarantee Insurance) always needs: the lender's signed term sheet / commitment (loan_agreement),
// a profit & loss statement (last 12 months, monthly), a balance sheet, A/R aging and A/P aging. A business under
// three years old also needs founder CVs and a financial forecast. Government ID goes to the partner for KYC only
// and is never sent on to the carrier. Canadian applications also need the PGI API v2 fields below.

export const PGI_SLOTS = ["loan_agreement", "profit_loss", "balance_sheet", "ar_aging", "ap_aging", "founder_cv", "financial_forecast"] as const;
export type PgiSlot = (typeof PGI_SLOTS)[number];
export type PgiUploadSlot = PgiSlot | "kyc_id";

export const PGI_SLOT_LABELS: Record<PgiUploadSlot, string> = {
  loan_agreement: "Signed term sheet / lender commitment",
  profit_loss: "Profit & loss statement (last 12 months, monthly)",
  balance_sheet: "Balance sheet",
  ar_aging: "Accounts receivable aging",
  ap_aging: "Accounts payable aging",
  founder_cv: "Founder CV(s)",
  financial_forecast: "Financial forecast",
  kyc_id: "Government ID (identity check only)",
};

export const STARTUP_ONLY: readonly PgiSlot[] = ["founder_cv", "financial_forecast"];
export const ELIGIBLE_LOAN_TYPES = ["Commercial Mortgage", "Other Secured Loan"] as const;

/** The document category a staff member picks when uploading for a slot from the PGI panel. */
export const SLOT_UPLOAD_CATEGORY: Record<PgiUploadSlot, string> = {
  loan_agreement: "signed_term_sheet",
  profit_loss: "PnL - Interim financials",
  balance_sheet: "Balance Sheet - Interim financials",
  ar_aging: "accounts_receivable_aging",
  ap_aging: "accounts_payable_aging",
  founder_cv: "founder_cv",
  financial_forecast: "financial_forecast",
  kyc_id: "government_id",
};

const SLOT_BY_CATEGORY: Record<string, PgiUploadSlot> = {
  signed_term_sheet: "loan_agreement", term_sheet: "loan_agreement", loan_agreement: "loan_agreement",
  commitment_letter: "loan_agreement", lender_commitment: "loan_agreement", signed_commitment: "loan_agreement",
  lender_term_sheet: "loan_agreement",
  pnl_interim: "profit_loss", pnl_interim_financials: "profit_loss", p_l_interim_financials: "profit_loss",
  profit_loss: "profit_loss", profit_and_loss: "profit_loss", income_statement: "profit_loss",
  balance_sheet: "balance_sheet", balance_sheet_interim: "balance_sheet", balance_sheet_interim_financials: "balance_sheet",
  ar: "ar_aging", a_r: "ar_aging", ar_aging: "ar_aging", accounts_receivable: "ar_aging", accounts_receivable_aging: "ar_aging",
  ap: "ap_aging", a_p: "ap_aging", ap_aging: "ap_aging", accounts_payable: "ap_aging", accounts_payable_aging: "ap_aging",
  founder_cv: "founder_cv", founder_resume: "founder_cv", resume: "founder_cv", cv: "founder_cv",
  financial_forecast: "financial_forecast", forecast: "financial_forecast", projections: "financial_forecast",
  financial_projections: "financial_forecast", business_plan_projections: "financial_forecast",
  government_id: "kyc_id", "2_pieces_of_government_issued_id": "kyc_id", owner_photo_id: "kyc_id", photo_id: "kyc_id",
  id_document: "kyc_id", drivers_license: "kyc_id", drivers_licence: "kyc_id", passport: "kyc_id",
};

export function slug(value: unknown): string {
  return String(value ?? "").replace(/[‐-―−]/g, "-").trim().toLowerCase()
    .replace(/&/g, "and").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** The PGI slot a document category (or label) fills, or null when PGI does not use it. */
export function pgiSlotFor(category: unknown): PgiUploadSlot | null {
  const s = slug(category);
  if (!s) return null;
  return SLOT_BY_CATEGORY[s] ?? SLOT_BY_CATEGORY[s.replace(/_and_/g, "_")] ?? null;
}

export function isStartup(formationDate: unknown, now: Date = new Date()): boolean {
  const t = String(formationDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(t)) return false;
  const d = new Date(t.slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return false;
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 3);
  return d.getTime() > cutoff.getTime();
}

export function requiredSlots(formationDate: unknown, now: Date = new Date()): PgiSlot[] {
  const startup = isStartup(formationDate, now);
  return PGI_SLOTS.filter((s) => startup || !STARTUP_ONLY.includes(s));
}

export type KsDocument = {
  id: string; category: string | null; document_type: string | null; status: string | null;
  created_at: string | Date; filename?: string | null;
};

/**
 * Documents to forward: accepted ones that fill a PGI slot, plus the signed term sheet this system produced (it is
 * the lender's signed commitment) unless rejected. The newest per slot; up to two government IDs.
 */
export function documentsToForward(docs: KsDocument[]): Array<{ doc: KsDocument; slot: PgiUploadSlot }> {
  const sorted = [...docs].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const out: Array<{ doc: KsDocument; slot: PgiUploadSlot }> = [];
  const taken = new Map<PgiUploadSlot, number>();
  for (const doc of sorted) {
    const slot = pgiSlotFor(doc.category) ?? pgiSlotFor(doc.document_type);
    if (!slot) continue;
    const status = String(doc.status ?? "").toLowerCase();
    const systemSigned = doc.document_type === "signed_term_sheet" && status !== "rejected";
    if (status !== "accepted" && !systemSigned) continue;
    const n = taken.get(slot) ?? 0;
    if (n >= (slot === "kyc_id" ? 2 : 1)) continue;
    taken.set(slot, n + 1);
    out.push({ doc, slot });
  }
  return out;
}

export type SlotState = "missing" | "awaiting_review" | "ready" | "sent" | "received" | "accepted" | "rejected";
export type PartnerDoc = { slot: string; status: string; rejection_reason?: string | null };
export type ChecklistRow = { slot: PgiSlot; label: string; state: SlotState; detail?: string | null };

/**
 * One row per required slot. Partner state (from the last sync) wins once the partner has the document; before
 * that: sent (forwarded, not yet confirmed), ready (accepted here, waiting to go), awaiting_review (uploaded, not
 * yet accepted by staff here), missing.
 */
export function buildChecklist(input: {
  formationDate: unknown;
  documents: KsDocument[];
  forwardedSlots: Set<string>;
  partnerDocs?: PartnerDoc[] | null;
  now?: Date;
}): { rows: ChecklistRow[]; missing: ChecklistRow[]; startup: boolean } {
  const now = input.now ?? new Date();
  const ready = new Set(documentsToForward(input.documents).map((f) => f.slot));
  const uploaded = new Set(input.documents.map((d) => pgiSlotFor(d.category) ?? pgiSlotFor(d.document_type)).filter(Boolean) as string[]);
  const partner = new Map((input.partnerDocs ?? []).map((d) => [d.slot, d]));
  const rows = requiredSlots(input.formationDate, now).map((slot): ChecklistRow => {
    const p = partner.get(slot);
    const label = PGI_SLOT_LABELS[slot];
    if (p && p.status === "accepted") return { slot, label, state: "accepted" };
    if (p && p.status === "received") return { slot, label, state: "received" };
    if (p && p.status === "rejected" && !ready.has(slot)) return { slot, label, state: "rejected", detail: p.rejection_reason ?? null };
    if (input.forwardedSlots.has(slot)) return { slot, label, state: "sent" };
    if (ready.has(slot)) return { slot, label, state: "ready" };
    if (uploaded.has(slot)) return { slot, label, state: "awaiting_review" };
    return { slot, label, state: "missing" };
  });
  return {
    rows,
    missing: rows.filter((r) => r.state === "missing" || r.state === "awaiting_review" || r.state === "rejected"),
    startup: isStartup(input.formationDate, now),
  };
}

/** What the broker can fill in for the insurer (the client answers ID and declarations on the partner's form). */
export type PgiInput = {
  business_legal_name?: string | null;
  operating_address?: string | null;
  province?: string | null;
  country?: string | null;
  naics_code?: string | null;
  formation_date?: string | null;
  business_number?: string | null;
  website?: string | null;
  entity_type?: string | null;
  guarantor_name?: string | null;
  guarantor_email?: string | null;
  guarantor_phone?: string | null;
  guarantor_dob?: string | null;
  residential_address?: string | null;
  loan_amount?: number | null;
  pgi_limit?: number | null;
  loan_type?: string | null;
  lender_name?: string | null;
  loan_purpose?: string | null;
  annual_revenue?: number | null;
};

export const PGI_FIELD_LABELS: Record<string, string> = {
  guarantor_name: "Director full name",
  guarantor_phone: "Director mobile phone",
  guarantor_dob: "Director date of birth",
  residential_address: "Director residential address",
  business_legal_name: "Business legal name",
  naics_code: "NAICS code (6 digits)",
  formation_date: "Business formation date",
  operating_address: "Business operating address",
  loan_type: "Loan type (Commercial Mortgage or Other Secured Loan)",
  loan_amount: "Loan amount (50,000 to 1,000,000)",
  pgi_limit: "PGI limit (up to 80% of the loan, at most 800,000)",
};

const filled = (v: unknown) => (typeof v === "string" ? v.trim().length > 0 : v !== null && v !== undefined);

export function missingFields(i: PgiInput): Array<{ key: string; label: string }> {
  const ca = String(i.country ?? "CA").toUpperCase() !== "US";
  const keys: string[] = [];
  if (!filled(i.guarantor_name)) keys.push("guarantor_name");
  if (!filled(i.guarantor_phone)) keys.push("guarantor_phone");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(i.guarantor_dob ?? ""))) keys.push("guarantor_dob");
  if (!filled(i.residential_address)) keys.push("residential_address");
  if (!filled(i.business_legal_name)) keys.push("business_legal_name");
  if (!/^\d{6}$/.test(String(i.naics_code ?? "").trim())) keys.push("naics_code");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(i.formation_date ?? ""))) keys.push("formation_date");
  if (!filled(i.operating_address)) keys.push("operating_address");
  if (ca && !(ELIGIBLE_LOAN_TYPES as readonly string[]).includes(String(i.loan_type ?? ""))) keys.push("loan_type");
  const loan = Number(i.loan_amount);
  if (!(Number.isFinite(loan) && loan >= 50_000 && loan <= 1_000_000)) keys.push("loan_amount");
  const limit = i.pgi_limit == null ? null : Number(i.pgi_limit);
  if (limit != null && !(Number.isFinite(limit) && limit > 0 && Number.isFinite(loan) && limit <= Math.floor(loan * 0.8))) keys.push("pgi_limit");
  return keys.map((key) => ({ key, label: PGI_FIELD_LABELS[key] ?? key }));
}

// ---------------------------------------------------------------- reading the client's application

function s(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}
function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/[, $]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
export function toE164(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.trim().startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}
function address(o: any): string | null {
  if (!o || typeof o !== "object") return null;
  const parts = [o.street, o.address, o.city, o.state, o.province, o.zip, o.postal, o.postalCode]
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0);
  return parts.length ? parts.join(", ") : null;
}
function isoDate(v: unknown): string | null {
  const t = s(v);
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
function country(v: unknown): "CA" | "US" | null {
  const t = String(v ?? "").trim().toLowerCase();
  if (t === "ca" || t === "canada") return "CA";
  if (t === "us" || t === "usa" || t === "united states" || t === "united states of america") return "US";
  return null;
}

/**
 * The PGI fields from the client's submitted application (the wizard payload, the normalized body and the sources
 * the submit route already resolved) plus the client's "PGI details" answers when the wizard collected them.
 */
export function pgiInputFromApplication(src: { legacyApp?: any; normalized?: any; businessSource?: any; applicantSource?: any; requestedAmount?: unknown }): PgiInput {
  const a = src.legacyApp && typeof src.legacyApp === "object" ? src.legacyApp : {};
  const n = src.normalized && typeof src.normalized === "object" ? src.normalized : {};
  const business = src.businessSource ?? a.business ?? a.company ?? a.business_info ?? n.company ?? {};
  const applicant = src.applicantSource ?? a.applicant ?? (Array.isArray(a.applicants) ? a.applicants[0] : null) ?? n.applicant ?? {};
  const kyc = a.kyc ?? a.kyc_answers ?? n.kyc ?? {};
  const d = a.pgi_details && typeof a.pgi_details === "object" ? a.pgi_details : {};
  const loan = num(d.loan_amount) ?? num(kyc.fundingAmount) ?? num(kyc.capitalAmount) ?? num(a.capital_amount) ?? num(src.requestedAmount);
  const naicsPicked = s(d.naics_code) ?? s(business.naicsCode) ?? s(business.naics_code) ?? s(kyc.naicsCode);
  const name = s(applicant.fullName) ?? ([s(applicant.firstName), s(applicant.lastName)].filter(Boolean).join(" ") || null);
  return {
    business_legal_name: s(business.legalName) ?? s(business.businessName) ?? s(business.companyName) ?? s(business.name),
    operating_address: s(d.operating_address) ?? address(business),
    province: (s(d.province) ?? s(business.province) ?? s(business.state))?.toUpperCase() ?? null,
    country: country(d.country) ?? country(kyc.businessLocation) ?? country(business.country) ?? "CA",
    naics_code: naicsPicked,
    formation_date: isoDate(d.formation_date) ?? isoDate(business.startDate) ?? isoDate(business.formationDate),
    business_number: s(business.businessNumber) ?? s(business.craBusinessNumber) ?? s(business.ein),
    website: s(business.website),
    entity_type: s(business.businessStructure) ?? s(business.entityType),
    guarantor_name: name,
    guarantor_email: s(applicant.email),
    guarantor_phone: toE164(s(applicant.phone) ?? s(applicant.mobile)) ?? s(applicant.phone),
    guarantor_dob: isoDate(d.guarantor_dob) ?? isoDate(applicant.dob) ?? isoDate(applicant.dateOfBirth) ?? isoDate(applicant.date_of_birth),
    residential_address: s(d.residential_address) ?? address(applicant),
    loan_amount: loan,
    pgi_limit: num(d.pgi_limit),
    loan_type: (ELIGIBLE_LOAN_TYPES as readonly string[]).includes(String(d.loan_type ?? "")) ? String(d.loan_type) : null,
    lender_name: s(a.selected_product?.lender_name) ?? s(a.selectedProduct?.lender_name),
    loan_purpose: s(kyc.purposeOfFunds) ?? s(kyc.lookingFor),
    annual_revenue: num(kyc.annualRevenue),
  };
}

/** Only the editable fields, cleaned (staff edit these on the PGI panel). */
export function cleanInputPatch(raw: Record<string, unknown>): PgiInput {
  const out: PgiInput = {};
  const text = ["business_legal_name", "operating_address", "province", "country", "naics_code", "business_number", "website",
    "entity_type", "guarantor_name", "guarantor_email", "residential_address", "lender_name", "loan_purpose"] as const;
  for (const k of text) if (raw[k] !== undefined) (out as any)[k] = s(raw[k])?.slice(0, 500) ?? null;
  if (raw.guarantor_phone !== undefined) out.guarantor_phone = toE164(s(raw.guarantor_phone)) ?? null;
  if (raw.formation_date !== undefined) out.formation_date = isoDate(raw.formation_date);
  if (raw.guarantor_dob !== undefined) out.guarantor_dob = isoDate(raw.guarantor_dob);
  for (const k of ["loan_amount", "pgi_limit", "annual_revenue"] as const) if (raw[k] !== undefined) out[k] = num(raw[k]);
  if (raw.loan_type !== undefined) out.loan_type = (ELIGIBLE_LOAN_TYPES as readonly string[]).includes(String(raw.loan_type)) ? String(raw.loan_type) : null;
  if (out.province) out.province = out.province.toUpperCase();
  return out;
}

/** The body for the partner's POST /api/v1/bi/ks/referrals. */
export function partnerReferralBody(applicationId: string, i: PgiInput, broker: { user_id: string | null; name: string | null; email: string | null }) {
  return {
    ks_application_id: applicationId,
    broker,
    business: {
      legal_name: i.business_legal_name ?? null, operating_address: i.operating_address ?? null, province: i.province ?? null,
      country: i.country ?? "CA", naics: i.naics_code ?? null, formation_date: i.formation_date ?? null,
      business_number: i.business_number ?? null, website: i.website ?? null, entity_type: i.entity_type ?? null,
    },
    guarantor: {
      name: i.guarantor_name ?? null, email: i.guarantor_email ?? null, phone: i.guarantor_phone ?? null,
      dob: i.guarantor_dob ?? null, residential_address: i.residential_address ?? null,
    },
    loan: {
      amount: i.loan_amount ?? null, pgi_limit: i.pgi_limit ?? null, loan_type: i.loan_type ?? null,
      lender_name: i.lender_name ?? null, purpose: i.loan_purpose ?? null,
    },
    annual_revenue: i.annual_revenue ?? null,
  };
}
