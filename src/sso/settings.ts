// KS_SERVER_SSO_API_KEYS - the brokerage's SSO settings (sso_settings, one row) and what is actually offered.
//
// A provider is offered on the sign-in page only when all three hold: the plan (or a running trial) includes "sso",
// the server has that provider's app registration (env vars), and an Admin has switched it on. "Require SSO" only
// bites while at least one provider is offered - so a plan downgrade or a missing env var can never lock staff out.
// Admins can always still sign in with a text code or a passkey (break-glass).
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { checkFeature } from "../plans/catalogue.js";
import { getPlanState, type Q } from "../plans/state.js";
import { isHostedDomain, isTenantId, providerConfig, SSO_PROVIDERS, type SsoProvider } from "./oidc.js";

export type SsoSettings = {
  microsoft_enabled: boolean;
  google_enabled: boolean;
  microsoft_tenant_id: string;
  google_hosted_domain: string;
  require_sso: boolean;
};

export const DEFAULT_SSO_SETTINGS: SsoSettings = {
  microsoft_enabled: false, google_enabled: false, microsoft_tenant_id: "", google_hosted_domain: "", require_sso: false,
};

export function rowToSsoSettings(row: Record<string, unknown> | null | undefined): SsoSettings {
  if (!row) return { ...DEFAULT_SSO_SETTINGS };
  return {
    microsoft_enabled: row.microsoft_enabled === true,
    google_enabled: row.google_enabled === true,
    microsoft_tenant_id: String(row.microsoft_tenant_id ?? "").trim().toLowerCase(),
    google_hosted_domain: String(row.google_hosted_domain ?? "").trim().toLowerCase(),
    require_sso: row.require_sso === true,
  };
}

export async function readSsoSettings(db: Q): Promise<SsoSettings> {
  const r = await db.query(
    `SELECT microsoft_enabled, google_enabled, microsoft_tenant_id, google_hosted_domain, require_sso FROM sso_settings WHERE id = 1`,
  );
  return rowToSsoSettings(r.rows[0]);
}

export type SsoSettingsPatch = Partial<SsoSettings>;

/** Validates a PUT body. Unknown keys are ignored; wrong types and malformed tenant/domain values are refused. */
export function parseSsoPatch(raw: unknown): { ok: true; value: SsoSettingsPatch } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Send the settings as a JSON object." };
  const b = raw as Record<string, unknown>;
  const out: SsoSettingsPatch = {};
  for (const k of ["microsoft_enabled", "google_enabled", "require_sso"] as const) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== "boolean") return { ok: false, error: `${k} must be true or false.` };
    out[k] = b[k] as boolean;
  }
  if (b.microsoft_tenant_id !== undefined) {
    const v = String(b.microsoft_tenant_id ?? "").trim().toLowerCase();
    if (v && !isTenantId(v)) return { ok: false, error: "The Microsoft tenant ID must be a directory (tenant) ID like 3f2504e0-4f89-11d3-9a0c-0305e82c3301." };
    out.microsoft_tenant_id = v;
  }
  if (b.google_hosted_domain !== undefined) {
    const v = String(b.google_hosted_domain ?? "").trim().toLowerCase().replace(/^@/, "");
    if (v && !isHostedDomain(v)) return { ok: false, error: "The Google domain must look like yourcompany.com." };
    out.google_hosted_domain = v;
  }
  return { ok: true, value: out };
}

export async function saveSsoSettings(db: Q, next: SsoSettings, by: string): Promise<SsoSettings> {
  const r = await db.query(
    `INSERT INTO sso_settings (id, microsoft_enabled, google_enabled, microsoft_tenant_id, google_hosted_domain, require_sso, updated_at, updated_by)
     VALUES (1, $1, $2, $3, $4, $5, now(), $6)
     ON CONFLICT (id) DO UPDATE SET
       microsoft_enabled = EXCLUDED.microsoft_enabled, google_enabled = EXCLUDED.google_enabled,
       microsoft_tenant_id = EXCLUDED.microsoft_tenant_id, google_hosted_domain = EXCLUDED.google_hosted_domain,
       require_sso = EXCLUDED.require_sso, updated_at = now(), updated_by = EXCLUDED.updated_by
     RETURNING microsoft_enabled, google_enabled, microsoft_tenant_id, google_hosted_domain, require_sso`,
    [next.microsoft_enabled, next.google_enabled, next.microsoft_tenant_id, next.google_hosted_domain, next.require_sso, by || null],
  );
  return rowToSsoSettings(r.rows[0] ?? next);
}

export type SsoAvailability = {
  plan_allows: boolean;
  providers: Record<SsoProvider, { configured: boolean; enabled: boolean; available: boolean }>;
  /** Staff (not Admins) must use SSO right now. */
  require_sso: boolean;
  settings: SsoSettings;
};

/** Pure: what is offered given the plan check, the env and the stored settings. */
export function ssoAvailability(planAllows: boolean, settings: SsoSettings, e: NodeJS.ProcessEnv = process.env): SsoAvailability {
  const providers = {} as SsoAvailability["providers"];
  for (const p of SSO_PROVIDERS) {
    const configured = providerConfig(p, e) !== null;
    const enabled = p === "microsoft" ? settings.microsoft_enabled : settings.google_enabled;
    providers[p] = { configured, enabled, available: planAllows && configured && enabled };
  }
  const anyAvailable = SSO_PROVIDERS.some((p) => providers[p].available);
  return { plan_allows: planAllows, providers, require_sso: settings.require_sso && anyAvailable, settings };
}

/** Reads the plan and the settings. Any read failure is logged and treated as "SSO off" (never locks anyone out). */
export async function loadSsoAvailability(db: Q, e: NodeJS.ProcessEnv = process.env): Promise<SsoAvailability> {
  let planAllows = false;
  let settings = { ...DEFAULT_SSO_SETTINGS };
  try {
    planAllows = checkFeature(await getPlanState(db), "sso").allowed;
    settings = await readSsoSettings(db);
  } catch (err) {
    logWarnSwallowed(err, "sso/settings.ts:loadSsoAvailability");
    return ssoAvailability(false, { ...DEFAULT_SSO_SETTINGS }, e);
  }
  return ssoAvailability(planAllows, settings, e);
}

/** Must this staff member sign in with SSO? Admins never (break-glass); everyone else only while it is required. */
export async function ssoRequiredFor(db: Q, role: string | null | undefined): Promise<boolean> {
  if (String(role ?? "").toLowerCase() === "admin") return false;
  return (await loadSsoAvailability(db)).require_sso;
}

export const SSO_REQUIRED_MESSAGE = "Your company signs staff in with single sign-on. Use the Microsoft or Google button on the sign-in page.";
