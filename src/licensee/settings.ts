// KS_SERVER_v1_LICENSEE - this copy's company details and branding.
//
// Each Keystone copy belongs to one licensee. Its name, legal name, AI assistant name, support contacts, logo and
// colours come from the licensee_settings row (edited by the licensee's admin through PUT /api/licensee), falling back
// to the KS_* App Service settings, then to neutral defaults. Nothing here is Boreal's.
import { clientUrl, portalUrl, serverUrl, websiteUrl } from "./urls.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export const LICENSEE_FIELDS = [
  "company_name", "legal_name", "assistant_name", "support_email", "support_phone",
  "logo_url", "primary_color", "accent_color", "time_zone", "country",
] as const;
export type LicenseeField = (typeof LICENSEE_FIELDS)[number];
export type LicenseeSettings = Record<LicenseeField, string>;

const ENV_NAMES: Record<LicenseeField, string> = {
  company_name: "KS_COMPANY_NAME", legal_name: "KS_LEGAL_NAME", assistant_name: "KS_ASSISTANT_NAME",
  support_email: "KS_SUPPORT_EMAIL", support_phone: "KS_SUPPORT_PHONE", logo_url: "KS_LOGO_URL",
  primary_color: "KS_PRIMARY_COLOR", accent_color: "KS_ACCENT_COLOR", time_zone: "KS_TIME_ZONE", country: "KS_COUNTRY",
};

const NEUTRAL: LicenseeSettings = {
  company_name: "Keystone Demo Brokerage", legal_name: "", assistant_name: "Assistant", support_email: "",
  support_phone: "", logo_url: "", primary_color: "#0B1F3A", accent_color: "#2563EB",
  time_zone: "America/Edmonton", country: "CA",
};

export function envDefaults(env: NodeJS.ProcessEnv = process.env): LicenseeSettings {
  const out = { ...NEUTRAL };
  for (const f of LICENSEE_FIELDS) {
    const v = String(env[ENV_NAMES[f]] ?? "").trim();
    if (v) out[f] = v;
  }
  return out;
}

/** Checks one field; returns the cleaned value or an error message. */
export function checkField(field: LicenseeField, raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const value = String(raw ?? "").trim();
  if (value.length > 200) return { ok: false, error: `${field} is too long (200 characters at most)` };
  if (!value) return { ok: true, value };
  if ((field === "primary_color" || field === "accent_color") && !/^#[0-9a-f]{6}$/i.test(value)) {
    return { ok: false, error: `${field} must be a colour like #0B1F3A` };
  }
  if (field === "logo_url" && !/^https:\/\/[^\s]+$/i.test(value)) return { ok: false, error: "logo_url must start with https://" };
  if (field === "support_email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { ok: false, error: "support_email is not an email address" };
  if (field === "country" && !/^[A-Z]{2}$/.test(value.toUpperCase())) return { ok: false, error: "country must be a two-letter code like CA or US" };
  return { ok: true, value: field === "country" ? value.toUpperCase() : value };
}

let cache: { at: number; value: LicenseeSettings } | null = null;
const CACHE_MS = 60_000;

export function clearLicenseeCache(): void {
  cache = null;
}

/** Saved values over the KS_* settings over neutral defaults. An empty saved value falls back. */
export async function getLicenseeSettings(db: Q, now = Date.now()): Promise<LicenseeSettings> {
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  const base = envDefaults();
  const r = await db.query(`SELECT ${LICENSEE_FIELDS.join(", ")} FROM licensee_settings WHERE id = 1`);
  const row = r.rows[0] ?? {};
  const value = { ...base };
  for (const f of LICENSEE_FIELDS) {
    const v = String(row[f] ?? "").trim();
    if (v) value[f] = v;
  }
  cache = { at: now, value };
  return value;
}

/** Saves the fields given (others unchanged). Returns the errors, or the new settings. */
export async function updateLicenseeSettings(db: Q, patch: Record<string, unknown>, userId: string)
  : Promise<{ ok: true; settings: LicenseeSettings } | { ok: false; errors: string[] }> {
  const errors: string[] = [];
  const fields: LicenseeField[] = [];
  const values: string[] = [];
  for (const f of LICENSEE_FIELDS) {
    if (!(f in (patch ?? {}))) continue;
    const c = checkField(f, patch[f]);
    if (!c.ok) { errors.push(c.error); continue; }
    fields.push(f);
    values.push(c.value);
  }
  if (errors.length) return { ok: false, errors };
  if (fields.length) {
    const cols = fields.join(", ");
    const params = fields.map((_, i) => `$${i + 2}`).join(", ");
    const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
    await db.query(
      `INSERT INTO licensee_settings (id, updated_by, ${cols}) VALUES (1, $1, ${params})
       ON CONFLICT (id) DO UPDATE SET ${sets}, updated_by = $1, updated_at = now()`,
      [userId, ...values],
    );
  }
  clearLicenseeCache();
  return { ok: true, settings: await getLicenseeSettings(db) };
}

/** What the portal, client app and website may show: branding and addresses, never keys. */
export async function publicLicensee(db: Q) {
  const s = await getLicenseeSettings(db);
  return { ...s, urls: { server: serverUrl(), portal: portalUrl(), client: clientUrl(), website: websiteUrl() } };
}
