// KS_SERVER_MARKETING_ADDON - the website kit: what a brokerage puts on its own website.
//
//   Lead forms        every plan has one; unlimited with the Marketing add-on. A submission becomes a CRM contact (a
//                     lead, tagged with the form), gets an owner from lead rotation when the Admin turned it on, records
//                     express CASL consent when the person ticked the box, and notifies staff.
//   AI chat widget    Marketing add-on: a chat bubble that talks to the brokerage's own AI assistant.
//   Tracking script   Marketing add-on: page views go into visitor tracking, ONLY after the visitor agreed to analytics
//                     cookies (the kit's own banner, or the site's banner calling WebsiteKit.consent(true)).
//
// The Admin copies one snippet: a script tag with the kit's public key, plus a placeholder per form. The kit only
// answers pages on the website addresses the Admin listed. Settings live in brokerage_settings ('website_kit').
import { randomBytes } from "node:crypto";
import { readSetting, writeSetting, type Q } from "../settingsPack/common.js";

export const KIT_SETTING = "website_kit";

export type KitSettings = {
  key: string;
  allowed_origins: string[];
  chat_enabled: boolean;
  tracking_enabled: boolean;
  consent_banner: boolean;
};

const KEY_RE = /^[a-f0-9]{24}$/;

export function newKitKey(): string {
  return randomBytes(12).toString("hex");
}

/** "https://www.example.com/page" -> "https://www.example.com"; null when it is not an http(s) origin. Plain http is
 *  only accepted for localhost (testing). */
export function normalizeOrigin(raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`); } catch { return null; }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return null;
  if (!u.hostname.includes(".") && u.hostname !== "localhost") return null;
  return `${u.protocol}//${u.host}`.toLowerCase();
}

export function normalizeKitSettings(raw: unknown): KitSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const origins = Array.isArray(r.allowed_origins) ? r.allowed_origins.map(normalizeOrigin).filter((x: string | null): x is string => Boolean(x)) : [];
  return {
    key: typeof r.key === "string" && KEY_RE.test(r.key) ? r.key : "",
    allowed_origins: [...new Set<string>(origins)].slice(0, 20),
    chat_enabled: r.chat_enabled === true,
    tracking_enabled: r.tracking_enabled === true,
    consent_banner: r.consent_banner !== false,
  };
}

/** The settings, with a key made (and saved) the first time. */
export async function kitSettings(db: Q): Promise<KitSettings> {
  const s = await readSetting(db, KIT_SETTING, normalizeKitSettings);
  if (s.key) return s;
  const next = { ...s, key: newKitKey() };
  await writeSetting(db, KIT_SETTING, next, null);
  return next;
}

export async function saveKitSettings(db: Q, s: KitSettings, actor: string | null): Promise<void> {
  await writeSetting(db, KIT_SETTING, s, actor);
}

/** Is a browser Origin one of the website addresses the Admin listed? (A missing Origin never is.) */
export function originAllowed(s: Pick<KitSettings, "allowed_origins">, origin: unknown): boolean {
  const o = normalizeOrigin(origin);
  return Boolean(o) && s.allowed_origins.includes(o!);
}

// ------------------------------------------------------------------------------------------------------- forms

export const FORM_FIELD_KEYS = ["full_name", "email", "phone", "company", "amount", "message"] as const;
export type FormFieldKey = (typeof FORM_FIELD_KEYS)[number];
export const FORM_FIELD_LABELS: Record<FormFieldKey, string> = {
  full_name: "Full name", email: "Email", phone: "Phone", company: "Business name", amount: "Amount needed", message: "Message",
};

export type FormField = { key: FormFieldKey; label: string; required: boolean };
export type KitForm = {
  id: string; name: string; fields: FormField[]; button_label: string; thank_you: string; tag: string | null;
  active: boolean; submissions: number; created_at: string;
};

export const DEFAULT_FIELDS: FormField[] = [
  { key: "full_name", label: "Full name", required: true },
  { key: "email", label: "Email", required: true },
  { key: "phone", label: "Phone", required: false },
  { key: "company", label: "Business name", required: false },
  { key: "message", label: "How can we help?", required: false },
];

const clip = (v: unknown, n: number): string => String(v ?? "").trim().slice(0, n);

export function normalizeFields(raw: unknown): FormField[] {
  if (!Array.isArray(raw) || !raw.length) return DEFAULT_FIELDS.map((f) => ({ ...f }));
  const out: FormField[] = [];
  for (const f of raw) {
    const key = String((f as any)?.key ?? "") as FormFieldKey;
    if (!(FORM_FIELD_KEYS as readonly string[]).includes(key) || out.some((x) => x.key === key)) continue;
    out.push({ key, label: clip((f as any)?.label, 80) || FORM_FIELD_LABELS[key], required: (f as any)?.required === true });
  }
  // A lead must be reachable: email or phone is always on the form, and one of them required.
  if (!out.some((f) => f.key === "email") && !out.some((f) => f.key === "phone")) out.push({ key: "email", label: "Email", required: true });
  if (!out.some((f) => (f.key === "email" || f.key === "phone") && f.required)) {
    const contact = out.find((f) => f.key === "email") ?? out.find((f) => f.key === "phone")!;
    contact.required = true;
  }
  return out;
}

export type FormInput = { name: string; fields: FormField[]; button_label: string; thank_you: string; tag: string | null; active: boolean };

export function parseFormInput(raw: unknown): { ok: true; value: FormInput } | { ok: false; error: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const name = clip(r.name, 80);
  if (!name) return { ok: false, error: "Give the form a name." };
  const tag = clip(r.tag, 40).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return {
    ok: true,
    value: {
      name,
      fields: normalizeFields(r.fields),
      button_label: clip(r.button_label, 40) || "Send",
      thank_you: clip(r.thank_you, 300) || "Thank you. We will be in touch shortly.",
      tag: tag || null,
      active: r.active !== false,
    },
  };
}

const FORM_COLS = `id::text AS id, name, fields, button_label, thank_you, tag, active, submissions, created_at`;

const rowToForm = (r: any): KitForm => ({
  id: String(r.id), name: String(r.name), fields: normalizeFields(r.fields), button_label: String(r.button_label ?? "Send"),
  thank_you: String(r.thank_you ?? ""), tag: r.tag ?? null, active: r.active === true, submissions: Number(r.submissions) || 0,
  created_at: new Date(r.created_at).toISOString(),
});

export async function listForms(db: Q): Promise<KitForm[]> {
  const r = await db.query(`SELECT ${FORM_COLS} FROM website_kit_forms ORDER BY created_at ASC, id ASC`);
  return r.rows.map(rowToForm);
}

export async function createForm(db: Q, f: FormInput, actor: string | null): Promise<KitForm> {
  const r = await db.query(
    `INSERT INTO website_kit_forms (name, fields, button_label, thank_you, tag, active, created_by)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7::uuid) RETURNING ${FORM_COLS}`,
    [f.name, JSON.stringify(f.fields), f.button_label, f.thank_you, f.tag, f.active, actor],
  );
  return rowToForm(r.rows[0]);
}

export async function updateForm(db: Q, id: string, f: FormInput): Promise<KitForm | null> {
  const r = await db.query(
    `UPDATE website_kit_forms SET name = $2, fields = $3::jsonb, button_label = $4, thank_you = $5, tag = $6, active = $7, updated_at = now()
      WHERE id::text = $1 RETURNING ${FORM_COLS}`,
    [id, f.name, JSON.stringify(f.fields), f.button_label, f.thank_you, f.tag, f.active],
  );
  return r.rows[0] ? rowToForm(r.rows[0]) : null;
}

export async function deleteForm(db: Q, id: string): Promise<boolean> {
  const r = await db.query(`DELETE FROM website_kit_forms WHERE id::text = $1 RETURNING id`, [id]);
  return (r.rowCount ?? r.rows.length) > 0;
}

/**
 * The forms that take submissions now: active ones, and - when the plan allows only `limit` forms (no add-on) - the
 * oldest `limit` active ones. A form beyond the limit (left over after the add-on ended) is kept but paused.
 */
export function liveForms(forms: KitForm[], limit: number | null): KitForm[] {
  const active = forms.filter((f) => f.active);
  return limit === null ? active : active.slice(0, Math.max(0, limit));
}

// ------------------------------------------------------------------------------------------------ submissions

export type Submission = { values: Partial<Record<FormFieldKey, string>>; consent: boolean; consentText: string | null; sessionId: string | null; page: string | null };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Checks a submission against the form; returns the clean values or the first problem (in plain words). */
export function parseSubmission(form: KitForm, raw: unknown): { ok: true; value: Submission } | { ok: false; error: string; field?: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const v = (r.fields && typeof r.fields === "object" ? r.fields : {}) as Record<string, unknown>;
  const values: Partial<Record<FormFieldKey, string>> = {};
  for (const f of form.fields) {
    const max = f.key === "message" ? 2000 : 200;
    const val = clip(v[f.key], max);
    if (!val && f.required) return { ok: false, error: `Please fill in ${f.label.toLowerCase()}.`, field: f.key };
    if (val) values[f.key] = val;
  }
  if (values.email && !EMAIL_RE.test(values.email)) return { ok: false, error: "Please check the email address.", field: "email" };
  if (values.phone && values.phone.replace(/\D/g, "").length < 7) return { ok: false, error: "Please check the phone number.", field: "phone" };
  if (!values.email && !values.phone) return { ok: false, error: "Please give an email address or a phone number.", field: "email" };
  const sessionId = /^[A-Za-z0-9_.:-]{6,100}$/.test(String(r.sessionId ?? "")) ? String(r.sessionId) : null;
  return {
    ok: true,
    value: {
      values, consent: r.consent === true, consentText: r.consent === true ? clip(r.consentText, 500) || null : null,
      sessionId, page: clip(r.page, 500) || null,
    },
  };
}

export function splitName(full: string | undefined, email: string | undefined): { first: string; last: string } {
  const name = String(full ?? "").trim();
  if (name) {
    const [first, ...rest] = name.split(/\s+/);
    return { first: first!, last: rest.join(" ") };
  }
  return { first: String(email ?? "").split("@")[0] || "Website lead", last: "" };
}

// ------------------------------------------------------------------------------------------------------ snippet

/** What the Admin pastes into the website: the script once, and a placeholder where each form goes. */
export function kitSnippet(serverBase: string, key: string, forms: Array<Pick<KitForm, "id" | "name">>): { script: string; forms: Array<{ id: string; name: string; html: string }> } {
  const base = serverBase.replace(/\/+$/, "");
  return {
    script: `<script src="${base}/api/kit/${key}/kit.js" async></script>`,
    forms: forms.map((f) => ({ id: f.id, name: f.name, html: `<div data-ks-form="${f.id}"></div>` })),
  };
}
