// KS_SERVER_M365_ONE_CLICK - the brokerage-wide Microsoft 365 connection: Microsoft's admin consent flow, the tenant
// it saves, the health check that notices a revoked consent, and disconnect.
//
// Start (Admin in Keystone): GET /api/o365-oauth/admin-consent/start returns Microsoft's admin consent address
//   https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id&scope=https://graph.microsoft.com/.default
// with a single-use state (sha256 kept in o365_oauth_states, purpose 'admin_consent', 10 minutes, and the same value in
// an HttpOnly cookie). A Keystone Admin who is not a Microsoft 365 admin can instead copy a link
// (POST /api/o365-oauth/admin-consent/link) for their Microsoft 365 admin to open in any browser: its state is a
// single-use row (purpose 'admin_consent_link', 7 days) and needs no cookie.
// Microsoft returns ?admin_consent=True&tenant=<guid>&state, or ?error=access_denied&error_description=AADSTS... .
import { createHash, randomBytes } from "node:crypto";
import { clearLicenseeCache, getLicenseeConnections } from "../../licensee/settings.js";
import { APPLICATION_PERMISSIONS, DELEGATED_LABELS, DELEGATED_SCOPES, isTenantGuid, m365App, m365AppOnly, m365TenantInfo, tokenEndpoint, tokenRoles } from "./m365App.js";
import { parseMicrosoftError } from "./o365Health.js";
import { logWarnSwallowed } from "../../lib/logWarnSwallowed.js";

export type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const CONSENT_STATE_TTL_MS = 10 * 60 * 1000;
export const CONSENT_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ADMIN_CONSENT_URL = "https://login.microsoftonline.com/organizations/v2.0/adminconsent";
export const GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default";

export function hashState(v: string): string {
  return createHash("sha256").update(v, "utf8").digest("hex");
}

export function newState(): string {
  return randomBytes(32).toString("base64url");
}

export function adminConsentUrl(clientId: string, redirectUri: string, state: string): string {
  const p = new URLSearchParams({ client_id: clientId, scope: GRAPH_DEFAULT_SCOPE, redirect_uri: redirectUri, state });
  return `${ADMIN_CONSENT_URL}?${p.toString()}`;
}

export type ConsentErrorKind = "declined" | "needs_admin" | "error";

/** What Microsoft's error means for the person who clicked. */
export function consentErrorKind(error: string, description: string): ConsentErrorKind {
  const d = String(description ?? "");
  // AADSTS90094/90095/900941: an administrator must grant this; a non-admin reached the consent screen.
  if (/AADSTS(90094|90095|900941|90099|900981)\b/.test(d) || /admin(istrator)? (consent|approval|permission)/i.test(d)) return "needs_admin";
  // AADSTS65004: the admin pressed Cancel / declined.
  if (/AADSTS65004\b/.test(d) || error === "access_denied" || error === "consent_required") return "declined";
  return "error";
}

export type ConsentRecord = {
  tenant_id: string;
  consented_at: string;
  consented_by_id: string | null;
  consented_by: string | null;
  via: "button" | "link";
};

export async function readConsent(db: Db): Promise<ConsentRecord | null> {
  const r = await db.query(`SELECT m365_consent FROM licensee_settings WHERE id = 1`);
  const v = r.rows[0]?.m365_consent;
  return v && typeof v === "object" && isTenantGuid(v.tenant_id) ? (v as ConsentRecord) : null;
}

/** Saves the tenant Microsoft returned (the setting every Microsoft call now reads) and who connected it. */
export async function saveConsent(db: Db, record: ConsentRecord): Promise<void> {
  await db.query(
    `INSERT INTO licensee_settings (id, updated_by, office365_tenant_id, m365_consent) VALUES (1, $1, $2, $3::jsonb)
     ON CONFLICT (id) DO UPDATE SET office365_tenant_id = $2, m365_consent = $3::jsonb, updated_by = $1, updated_at = now()`,
    [record.consented_by_id ?? "m365-consent", record.tenant_id.toLowerCase(), JSON.stringify(record)],
  );
  clearLicenseeCache();
  await getLicenseeConnections(db); // every Microsoft call reads the new tenant from now on
  resetM365HealthCache();
}

/** Disconnect for the whole brokerage: forget the tenant and every staff member's Microsoft sign-in. */
export async function disconnectM365(db: Db, by: string): Promise<{ users: number }> {
  await db.query(
    `INSERT INTO licensee_settings (id, updated_by, office365_tenant_id, m365_consent) VALUES (1, $1, '', NULL)
     ON CONFLICT (id) DO UPDATE SET office365_tenant_id = '', m365_consent = NULL, updated_by = $1, updated_at = now()`,
    [by],
  );
  const u = await db.query(
    `UPDATE users SET o365_access_token = NULL, o365_refresh_token = NULL, o365_access_token_expires_at = NULL,
            o365_token_expires_at = NULL, o365_user_email = NULL, o365_account_id = NULL
      WHERE o365_access_token IS NOT NULL OR o365_refresh_token IS NOT NULL`,
  );
  clearLicenseeCache();
  await getLicenseeConnections(db);
  resetM365HealthCache();
  return { users: Number(u.rowCount ?? 0) };
}

// ---- health -----------------------------------------------------------------------------------------------------

export type M365Health =
  | { state: "ok"; roles: string[]; missing: string[]; checkedAt: string }
  | { state: "revoked" | "app_key" | "not_checked" | "unreachable"; code: string | null; message: string; checkedAt: string };

let healthCache: { at: number; tenant: string; value: M365Health } | null = null;
const HEALTH_TTL_MS = 10 * 60 * 1000;

export function resetM365HealthCache(): void {
  healthCache = null;
}

/** Revoked / removed / never consented in that tenant: the brokerage must reconnect. */
const REVOKED = /^AADSTS(7000229|700016|65001|500011|50020|700027|90002)$/;
/** Keystone's (or the server's own) app key is wrong or expired: not the brokerage's to fix. */
const APP_KEY = /^AADSTS(7000215|7000222|7000218|7000112)$/;

/**
 * Asks Microsoft for an app-only token in the brokerage's tenant. Works only while the admin consent stands, and the
 * token's roles say which application permissions are still granted. Cached 10 minutes.
 */
export async function checkM365Health(opts: { refresh?: boolean; fetcher?: typeof fetch; now?: number } = {}): Promise<M365Health> {
  const now = opts.now ?? Date.now();
  const creds = m365AppOnly();
  const checkedAt = new Date(now).toISOString();
  if (!creds) return { state: "not_checked", code: null, message: "Microsoft 365 is not connected.", checkedAt };
  if (!opts.refresh && healthCache && healthCache.tenant === creds.tenant && now - healthCache.at < HEALTH_TTL_MS) return healthCache.value;
  const fetcher = opts.fetcher ?? fetch;
  let value: M365Health;
  try {
    const r = await fetcher(tokenEndpoint(creds.tenant), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: "client_credentials", scope: GRAPH_DEFAULT_SCOPE }),
    });
    const text = await r.text().catch((err: unknown) => logWarnSwallowed(err, "m365_health.body", ""));
    if (r.ok) {
      let token = "";
      try { token = String(JSON.parse(text).access_token ?? ""); } catch { token = ""; }
      const roles = tokenRoles(token);
      const missing = APPLICATION_PERMISSIONS.map((p) => p.name).filter((p) => !roles.includes(p));
      value = roles.length === 0
        ? { state: "revoked", code: "no_roles", message: "Microsoft 365 no longer grants Keystone any permissions in your organisation.", checkedAt }
        : { state: "ok", roles, missing, checkedAt };
    } else {
      const { code, message } = parseMicrosoftError(text);
      const c = String(code ?? "");
      if (REVOKED.test(c) || c === "unauthorized_client" || (c === "invalid_client" && /tenant/i.test(String(message)))) {
        value = { state: "revoked", code: c || null, message: "Keystone was removed from your Microsoft 365, or its permission was taken back.", checkedAt };
      } else if (APP_KEY.test(c) || c === "invalid_client") {
        value = { state: "app_key", code: c || null, message: "The Microsoft app key on this server is wrong or has expired. Keystone support needs to renew it; nothing is needed from you.", checkedAt };
      } else {
        value = { state: "unreachable", code: c || null, message: `Microsoft did not answer as expected${c ? ` (${c})` : ""}. Try again in a few minutes.`, checkedAt };
      }
    }
  } catch (err) {
    value = { state: "unreachable", code: null, message: `Could not reach Microsoft: ${(err as Error)?.message ?? String(err)}`.slice(0, 200), checkedAt };
  }
  healthCache = { at: now, tenant: creds.tenant, value };
  return value;
}

// ---- last successful sync -------------------------------------------------------------------------------------------

const lastMark: Record<string, number> = {};
const MARK_EVERY_MS = 60_000;

/** Notes that a Microsoft or Google call just worked (at most once a minute per provider). Never throws. */
export function markWorkspaceSync(db: Db, provider: "m365" | "google", now = Date.now()): void {
  if (process.env.NODE_ENV === "test" && !process.env.KS_TEST_SYNC_MARKS) return;
  if (now - (lastMark[provider] ?? 0) < MARK_EVERY_MS) return;
  lastMark[provider] = now;
  const col = provider === "m365" ? "m365_last_sync_at" : "google_last_sync_at";
  void db.query(
    `INSERT INTO licensee_settings (id, ${col}) VALUES (1, now()) ON CONFLICT (id) DO UPDATE SET ${col} = now()`,
  ).catch((err: unknown) => logWarnSwallowed(err, `licensee_settings.${col}`));
}

// ---- the status the Connections page and KS-Ops show ------------------------------------------------------------------

export type M365Status = {
  available: boolean;
  app: "keystone" | "own" | null;
  state: "not_available" | "not_connected" | "connected" | "partial" | "revoked" | "app_key" | "unreachable";
  headline: string;
  fix: string | null;
  tenant_id: string | null;
  tenant_source: "connected" | "server_settings" | "none";
  domain: string | null;
  connected_by: string | null;
  connected_at: string | null;
  via: "button" | "link" | null;
  permissions: { application: Array<{ name: string; why: string; granted: boolean | null }>; delegated: Array<{ name: string; label: string }> };
  staff_connected: number;
  send_as: string | null;
  last_sync_at: string | null;
  checked_at: string | null;
};

export async function m365Status(db: Db, opts: { refresh?: boolean; fetcher?: typeof fetch } = {}): Promise<M365Status> {
  const app = m365App();
  const { tenant, source } = m365TenantInfo();
  const [consent, row, staff] = await Promise.all([
    readConsent(db),
    db.query(`SELECT m365_last_sync_at, office365_send_as FROM licensee_settings WHERE id = 1`),
    db.query(
      `SELECT count(*)::int AS n, min(lower(split_part(o365_user_email, '@', 2))) AS domain
         FROM users WHERE o365_refresh_token IS NOT NULL OR o365_access_token IS NOT NULL`,
    ),
  ]);
  const lastSync = row.rows[0]?.m365_last_sync_at ? new Date(row.rows[0].m365_last_sync_at).toISOString() : null;
  const domain = String(staff.rows[0]?.domain ?? "").trim() || null;
  const sendAs = String(row.rows[0]?.office365_send_as ?? "").trim() || String(process.env.MS_GRAPH_SEND_AS ?? "").trim() || null;
  const base = {
    available: Boolean(app),
    app: app?.source ?? null,
    tenant_id: tenant || null,
    tenant_source: source,
    domain,
    connected_by: source === "connected" ? consent?.consented_by ?? null : null,
    connected_at: source === "connected" ? consent?.consented_at ?? null : null,
    via: source === "connected" ? consent?.via ?? null : null,
    staff_connected: Number(staff.rows[0]?.n ?? 0),
    send_as: sendAs,
    last_sync_at: lastSync,
  };
  const delegated = DELEGATED_SCOPES.map((name) => ({ name, label: DELEGATED_LABELS[name] ?? name }));
  const appPerms = (granted: string[] | null) => APPLICATION_PERMISSIONS.map((p) => ({ ...p, granted: granted ? granted.includes(p.name) : null }));
  if (!app) {
    return { ...base, state: "not_available", headline: "Microsoft 365 is not available on this server yet.", fix: "Keystone sets this up for you. Contact Keystone support if it stays like this.", permissions: { application: appPerms(null), delegated }, checked_at: null };
  }
  if (!tenant) {
    return { ...base, state: "not_connected", headline: "Microsoft 365 is not connected.", fix: "A Microsoft 365 administrator clicks Connect Microsoft 365 and approves Keystone once for the whole company.", permissions: { application: appPerms(null), delegated }, checked_at: null };
  }
  const h = await checkM365Health(opts);
  const who = base.domain ?? tenant;
  if (h.state === "ok") {
    const partial = h.missing.length > 0;
    return {
      ...base,
      state: partial ? "partial" : "connected",
      headline: `Connected to ${who}${base.connected_by ? ` by ${base.connected_by}` : ""}${base.connected_at ? ` on ${base.connected_at.slice(0, 10)}` : ""}.`,
      fix: partial ? `Some permissions are missing (${h.missing.join(", ")}). Click Reconnect and approve again.` : null,
      permissions: { application: appPerms(h.roles), delegated },
      checked_at: h.checkedAt,
    };
  }
  if (h.state === "revoked") {
    return { ...base, state: "revoked", headline: `Microsoft 365 stopped accepting Keystone in ${who}.`, fix: `${h.message} A Microsoft 365 administrator clicks Reconnect and approves again.`, permissions: { application: appPerms([]), delegated }, checked_at: h.checkedAt };
  }
  if (h.state === "app_key") {
    return { ...base, state: "app_key", headline: "Microsoft 365 is connected, but Keystone's app key on this server needs renewing.", fix: h.message, permissions: { application: appPerms(null), delegated }, checked_at: h.checkedAt };
  }
  return { ...base, state: "unreachable", headline: `Connected to ${who}, but Microsoft could not be checked just now.`, fix: h.state === "not_checked" ? null : h.message, permissions: { application: appPerms(null), delegated }, checked_at: h.checkedAt };
}
