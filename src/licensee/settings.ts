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
  "mailing_address", // KS_SERVER_v5_MAILING_ADDRESS
  "workspace_provider", // KS_SERVER_v12_GOOGLE_WORKSPACE - m365 | google | both: which Connect buttons staff see
  "background_color", "font_family", // KS_SERVER_v14_BRAND_FONT - "" = the app's own default
] as const;
export type LicenseeField = (typeof LICENSEE_FIELDS)[number];

// KS_SERVER_v8_CONNECTIONS - the licensee's own accounts. Admin-only: never in the public GET /api/licensee.
// Where the server needs one it prefers this setting, then the App Service setting (see ./connections.ts).
// KS_SERVER_M365_ONE_CLICK - office365_tenant_id is now written by the Microsoft admin consent (Settings > Connections);
// office365_send_as is the shared mailbox lender packages and notices go out from.
export const CONNECTION_FIELDS = ["twilio_main_number", "google_ads_customer_id", "office365_tenant_id", "office365_send_as"] as const;
export type ConnectionField = (typeof CONNECTION_FIELDS)[number];
export type LicenseeConnections = Record<ConnectionField, string>;

const EMPTY_CONNECTIONS: LicenseeConnections = { twilio_main_number: "", google_ads_customer_id: "", office365_tenant_id: "", office365_send_as: "" };

/** Checks one connection field; returns the cleaned value or an error message. */
export function checkConnectionField(field: ConnectionField, raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const value = String(raw ?? "").trim();
  if (!value) return { ok: true, value };
  if (value.length > 200) return { ok: false, error: `${field} is too long (200 characters at most)` };
  if (field === "twilio_main_number") {
    const digits = value.replace(/[\s().-]/g, "");
    if (!/^\+[1-9]\d{7,14}$/.test(digits)) return { ok: false, error: "twilio_main_number must be a phone number like +15875550100" };
    return { ok: true, value: digits };
  }
  if (field === "google_ads_customer_id") {
    const digits = value.replace(/[\s-]/g, "");
    if (!/^\d{10}$/.test(digits)) return { ok: false, error: "google_ads_customer_id must be 10 digits like 123-456-7890" };
    return { ok: true, value: `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` };
  }
  if (field === "office365_send_as") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { ok: false, error: "office365_send_as must be an email address like submissions@yourcompany.com" };
    return { ok: true, value: value.toLowerCase() };
  }
  const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const domain = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
  if (!guid.test(value) && !domain.test(value)) return { ok: false, error: "office365_tenant_id must be a tenant id (GUID) or domain" };
  return { ok: true, value: value.toLowerCase() };
}

let lastConnections: LicenseeConnections | null = null;

/** The connection settings last loaded, or null before the first load. */
export function lastLoadedConnections(): LicenseeConnections | null {
  return lastConnections;
}

/** Test hook. */
export function setLastLoadedConnections(v: LicenseeConnections | null): void {
  lastConnections = v;
}

/** The saved connection settings (empty strings when unset). */
export async function getLicenseeConnections(db: Q): Promise<LicenseeConnections> {
  const r = await db.query(`SELECT ${CONNECTION_FIELDS.join(", ")} FROM licensee_settings WHERE id = 1`);
  const row = r.rows[0] ?? {};
  const value = { ...EMPTY_CONNECTIONS };
  for (const f of CONNECTION_FIELDS) value[f] = String(row[f] ?? "").trim();
  lastConnections = value;
  return value;
}
export type LicenseeSettings = Record<LicenseeField, string>;

const ENV_NAMES: Record<LicenseeField, string> = {
  company_name: "KS_COMPANY_NAME", legal_name: "KS_LEGAL_NAME", assistant_name: "KS_ASSISTANT_NAME",
  support_email: "KS_SUPPORT_EMAIL", support_phone: "KS_SUPPORT_PHONE", logo_url: "KS_LOGO_URL",
  primary_color: "KS_PRIMARY_COLOR", accent_color: "KS_ACCENT_COLOR", time_zone: "KS_TIME_ZONE", country: "KS_COUNTRY",
  mailing_address: "KS_MAILING_ADDRESS",
  workspace_provider: "KS_WORKSPACE_PROVIDER",
  background_color: "KS_BACKGROUND_COLOR", font_family: "KS_FONT_FAMILY",
};

/** KS_SERVER_v8_USAGE - the time zone a licensee gets when it sets none. */
export const DEFAULT_LICENSEE_TIME_ZONE = "America/Edmonton";

const NEUTRAL: LicenseeSettings = {
  company_name: "Keystone Demo Brokerage", legal_name: "", assistant_name: "Assistant", support_email: "",
  support_phone: "", logo_url: "", primary_color: "#0B1F3A", accent_color: "#2563EB",
  time_zone: DEFAULT_LICENSEE_TIME_ZONE, country: "CA", mailing_address: "",
  workspace_provider: "m365", // today's behaviour: Microsoft 365 only
  background_color: "", font_family: "", // KS_SERVER_v14_BRAND_FONT - unset: each app keeps its own background and font
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
  // KS_SERVER_v14_BRAND_FONT - a family name only (it goes into CSS and a Google Fonts address).
  if (field === "font_family") {
    const v = value.replace(/\s+/g, " ");
    if (!/^[A-Za-z0-9][A-Za-z0-9 -]{0,59}$/.test(v)) return { ok: false, error: "font_family can use letters, numbers, spaces and dashes (60 at most)" };
    return { ok: true, value: v };
  }
  if ((field === "primary_color" || field === "accent_color" || field === "background_color") && !/^#[0-9a-f]{6}$/i.test(value)) {
    return { ok: false, error: `${field} must be a colour like #0B1F3A` };
  }
  if (field === "logo_url" && !/^https:\/\/[^\s]+$/i.test(value)) return { ok: false, error: "logo_url must start with https://" };
  if (field === "support_email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { ok: false, error: "support_email is not an email address" };
  if (field === "country" && !/^[A-Z]{2}$/.test(value.toUpperCase())) return { ok: false, error: "country must be a two-letter code like CA or US" };
  // KS_SETTINGS_PACK_v1_TIME_ZONE - the brokerage's zone drives quiet hours, call hours, reports and usage periods,
  // so only a real IANA zone name is accepted (src/lib/brokerageTime.ts computes with it).
  if (field === "time_zone") {
    let valid = /^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value) && value.length <= 64;
    try { if (valid) new Intl.DateTimeFormat("en-CA", { timeZone: value }); } catch { valid = false; }
    if (!valid) return { ok: false, error: "time_zone must be an IANA time zone like America/Edmonton or America/Toronto" };
  }
  if (field === "workspace_provider") {
    const v = value.toLowerCase();
    if (v !== "m365" && v !== "google" && v !== "both") return { ok: false, error: "workspace_provider must be m365, google or both" };
    return { ok: true, value: v };
  }
  return { ok: true, value: field === "country" ? value.toUpperCase() : value };
}

let cache: { at: number; value: LicenseeSettings } | null = null;
const CACHE_MS = 60_000;
// KS_SERVER_v4_BRANDING - the last settings read from the database, kept after the cache expires so code that
// cannot await (message constants, templates) still has the licensee's name. See ./brand.ts.
let lastLoaded: LicenseeSettings | null = null;

/** The settings last loaded by getLicenseeSettings, or null before the first load. */
export function lastLoadedLicensee(): LicenseeSettings | null {
  return lastLoaded;
}

/** Test hook: forget the last loaded settings too. */
export function resetLastLoadedLicensee(): void {
  lastLoaded = null;
}

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
  lastLoaded = value;
  return value;
}

/** Saves the fields given (others unchanged). Returns the errors, or the new settings. */
export async function updateLicenseeSettings(db: Q, patch: Record<string, unknown>, userId: string)
  : Promise<{ ok: true; settings: LicenseeSettings } | { ok: false; errors: string[] }> {
  const errors: string[] = [];
  const values: string[] = [];
  const fields: string[] = [];
  for (const f of LICENSEE_FIELDS) {
    if (!(f in (patch ?? {}))) continue;
    const c = checkField(f, patch[f]);
    if (!c.ok) { errors.push(c.error); continue; }
    fields.push(f);
    values.push(c.value);
  }
  for (const f of CONNECTION_FIELDS) { // KS_SERVER_v8_CONNECTIONS
    if (!(f in (patch ?? {}))) continue;
    const c = checkConnectionField(f, patch[f]);
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
  if (fields.some((f) => (CONNECTION_FIELDS as readonly string[]).includes(f))) await getLicenseeConnections(db);
  return { ok: true, settings: await getLicenseeSettings(db) };
}

/** What the portal, client app and website may show: branding and addresses, never keys. */
export async function publicLicensee(db: Q) {
  const s = await getLicenseeSettings(db);
  return { ...s, urls: { server: serverUrl(), portal: portalUrl(), client: clientUrl(), website: websiteUrl() } };
}

/** KS_SERVER_v8_CONNECTIONS - everything, for the licensee's admins: the public view plus the connection settings
 *  as saved, and the values in force (saved, else the App Service setting). */
export async function adminLicensee(db: Q, env: NodeJS.ProcessEnv = process.env) {
  const [pub, conn] = await Promise.all([publicLicensee(db), getLicenseeConnections(db)]);
  return {
    ...pub,
    ...conn,
    connections_in_force: {
      twilio_main_number: conn.twilio_main_number || String(env.TWILIO_MAIN_LINE_NUMBER ?? "").trim(),
      google_ads_customer_id: conn.google_ads_customer_id || String(env.GOOGLE_ADS_CUSTOMER_ID ?? "").trim(),
      office365_tenant_id: conn.office365_tenant_id || String(env.MSAL_TENANT_ID ?? "").trim() || String(env.MS_GRAPH_TENANT_ID ?? "").trim(),
      office365_send_as: conn.office365_send_as || String(env.MS_GRAPH_SEND_AS ?? "").trim(),
    },
  };
}

// ---- KS_SERVER_v15_BRAND_SYNC - branding pushed by Keystone operations (KS-Ops) ----------------------------------
// The colours, font and logo chosen at sign-up arrive with the plan push (PUT /api/plan { branding }). Rule: the
// licensee's admin wins. A field takes the pushed value while it is empty or still equal to what operations pushed
// last time; once the admin has set a different value on the Company page, later pushes leave it alone (and the pushed
// value is only recorded in ops_branding).
export const OPS_BRAND_FIELDS = ["primary_color", "accent_color", "background_color", "font_family", "logo_url"] as const;
export type OpsBrandField = (typeof OPS_BRAND_FIELDS)[number];

/** Checks a pushed branding object. Not an object = invalid; a field that is not a valid value (say an http logo
 *  address) is skipped with a warning, so branding can never hold up a plan or status push. */
export function parseOpsBranding(raw: unknown): { ok: true; value: Partial<Record<OpsBrandField, string>> | undefined } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const out: Partial<Record<OpsBrandField, string>> = {};
  for (const f of OPS_BRAND_FIELDS) {
    const v = (raw as Record<string, unknown>)[f];
    if (v === undefined) continue;
    const c = v === null || typeof v === "string" ? checkField(f, v ?? "") : null;
    if (!c || !c.ok) {
      console.warn(`[licensee] pushed branding ${f} ignored: ${c && !c.ok ? c.error : "not a string"}`);
      continue;
    }
    out[f] = c.value;
  }
  return { ok: true, value: out };
}

export async function applyOpsBranding(db: Q, branding: Partial<Record<OpsBrandField, string>>)
  : Promise<{ applied: OpsBrandField[]; kept: OpsBrandField[] }> {
  const r = await db.query(`SELECT ${OPS_BRAND_FIELDS.join(", ")}, ops_branding FROM licensee_settings WHERE id = 1`);
  const row = r.rows[0] ?? {};
  const last: Record<string, unknown> = row.ops_branding && typeof row.ops_branding === "object" ? row.ops_branding : {};
  const applied: OpsBrandField[] = [];
  const kept: OpsBrandField[] = [];
  for (const f of OPS_BRAND_FIELDS) {
    if (!(f in branding)) continue;
    const current = String(row[f] ?? "").trim();
    const lastPushed = String(last[f] ?? "").trim();
    const incoming = branding[f] ?? "";
    if (current === incoming) continue;
    if (current === "" || current.toLowerCase() === lastPushed.toLowerCase()) applied.push(f);
    else kept.push(f);
  }
  const nextLast = { ...last, ...branding };
  const cols = applied;
  const params = [JSON.stringify(nextLast), ...cols.map((f) => branding[f] ?? "")];
  await db.query(
    `INSERT INTO licensee_settings (id, updated_by, ops_branding${cols.map((c) => `, ${c}`).join("")})
     VALUES (1, 'ks-ops', $1::jsonb${cols.map((_, i) => `, $${i + 2}`).join("")})
     ON CONFLICT (id) DO UPDATE SET ops_branding = $1::jsonb${cols.map((c, i) => `, ${c} = $${i + 2}`).join("")}${cols.length ? ", updated_by = 'ks-ops', updated_at = now()" : ""}`,
    params,
  );
  clearLicenseeCache();
  if (applied.length) await getLicenseeSettings(db);
  return { applied, kept };
}
