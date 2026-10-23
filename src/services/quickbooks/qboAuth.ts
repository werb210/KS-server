// KS_SERVER_v13_QUICKBOOKS - Intuit OAuth 2.0 for the licensee's QuickBooks company, and an API client that
// refreshes its own access token.
//
// - Tokens are AES-256-GCM encrypted with QBO_TOKEN_ENCRYPTION_KEY (services/workspace/tokenCrypto.ts).
// - Intuit rotates refresh tokens: every refresh answer's refresh_token replaces the stored one.
// - invalid_grant on refresh -> status reauth_required (tokens forgotten); an admin reconnects in Settings.
// - Disconnect revokes the refresh token at Intuit, then forgets the connection.
import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { decryptToken, encryptToken } from "../workspace/tokenCrypto.js";
import { QBO_AUTH_URL, QBO_MINOR_VERSION, QBO_REVOKE_URL, QBO_SCOPE, QBO_TOKEN_URL, qboConfig, type QboConfig } from "./qboConfig.js";

export const STATE_TTL_MS = 10 * 60 * 1000;
const KEY = "QBO_TOKEN_ENCRYPTION_KEY" as const;
const seal = (plain: string) => encryptToken(plain, process.env, KEY);
const open = (sealed: string | null | undefined) => decryptToken(sealed, process.env, KEY);

export class QboApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null = null, readonly detail: string | null = null) {
    super(message);
    this.name = "QboApiError";
  }
}

export function nonceHash(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

export function newNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function buildAuthUrl(cfg: QboConfig, state: string): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    scope: QBO_SCOPE,
    redirect_uri: cfg.redirectUri,
    state,
  });
  return `${QBO_AUTH_URL}?${q.toString()}`;
}

export type QboTokens = { accessToken: string; refreshToken: string; expiresIn: number; refreshExpiresIn: number | null };

function basicAuth(cfg: QboConfig): string {
  return "Basic " + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`, "utf8").toString("base64");
}

async function tokenRequest(cfg: QboConfig, body: Record<string, string>): Promise<QboTokens> {
  const res = await fetch(QBO_TOKEN_URL, {
    method: "POST",
    headers: { Authorization: basicAuth(cfg), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  if (!res.ok || !json.access_token) {
    throw new QboApiError(`intuit_token_${res.status}`, res.status, typeof json.error === "string" ? json.error : null, text.slice(0, 300));
  }
  return {
    accessToken: String(json.access_token),
    refreshToken: String(json.refresh_token ?? body.refresh_token ?? ""),
    expiresIn: Number(json.expires_in) || 3600,
    refreshExpiresIn: Number(json.x_refresh_token_expires_in) || null,
  };
}

export function exchangeCode(cfg: QboConfig, code: string): Promise<QboTokens> {
  return tokenRequest(cfg, { grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri });
}

const expiry = (seconds: number | null): Date | null => (seconds ? new Date(Date.now() + seconds * 1000) : null);

export async function saveConnection(pool: Pool, realmId: string, tokens: QboTokens, userId: string, environment: string, companyName: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO quickbooks_connection (id, realm_id, company_name, environment, access_token_enc, refresh_token_enc,
            access_token_expires_at, refresh_token_expires_at, status, last_error, connected_by, connected_at, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, 'connected', NULL, $8, now(), now())
     ON CONFLICT (id) DO UPDATE SET
       realm_id = EXCLUDED.realm_id, company_name = EXCLUDED.company_name, environment = EXCLUDED.environment,
       access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc,
       access_token_expires_at = EXCLUDED.access_token_expires_at, refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
       status = 'connected', last_error = NULL, connected_by = EXCLUDED.connected_by,
       item_id = CASE WHEN quickbooks_connection.realm_id = EXCLUDED.realm_id THEN quickbooks_connection.item_id ELSE NULL END,
       tax_code_id = CASE WHEN quickbooks_connection.realm_id = EXCLUDED.realm_id THEN quickbooks_connection.tax_code_id ELSE NULL END,
       tax_code_name = CASE WHEN quickbooks_connection.realm_id = EXCLUDED.realm_id THEN quickbooks_connection.tax_code_name ELSE NULL END,
       connected_at = now(), updated_at = now()`,
    [realmId, companyName, environment, seal(tokens.accessToken), seal(tokens.refreshToken),
      expiry(tokens.expiresIn), expiry(tokens.refreshExpiresIn), userId],
  );
}

export type ConnectionRow = {
  realm_id: string | null; company_name: string | null; environment: string | null; status: string;
  access_token_enc: string | null; refresh_token_enc: string | null; access_token_expires_at: string | Date | null;
  last_error: string | null; tax_code_id: string | null; tax_code_name: string | null; item_id: string | null;
  connected_at: string | Date | null;
};

export async function loadConnection(pool: Pool): Promise<ConnectionRow | null> {
  const r = await pool.query<ConnectionRow>(
    `SELECT realm_id, company_name, environment, status, access_token_enc, refresh_token_enc, access_token_expires_at,
            last_error, tax_code_id, tax_code_name, item_id, connected_at
       FROM quickbooks_connection WHERE id = 1`,
  );
  return r.rows[0] ?? null;
}

export type QboStatus = {
  configured: boolean; reason: string | null; environment: string; connected: boolean; status: string | null;
  companyName: string | null; realmId: string | null; connectedAt: string | null; lastError: string | null;
  taxCodeId: string | null; taxCodeName: string | null;
};

export async function qboStatus(pool: Pool, problem: string | null, environment: string): Promise<QboStatus> {
  const base: QboStatus = { configured: !problem, reason: problem, environment, connected: false, status: null, companyName: null, realmId: null, connectedAt: null, lastError: null, taxCodeId: null, taxCodeName: null };
  if (problem) return base;
  const c = await loadConnection(pool);
  if (!c) return base;
  return {
    ...base,
    connected: c.status === "connected" && Boolean(c.refresh_token_enc),
    status: c.status,
    companyName: c.company_name,
    realmId: c.realm_id,
    connectedAt: c.connected_at ? new Date(c.connected_at).toISOString() : null,
    lastError: c.last_error,
    taxCodeId: c.tax_code_id,
    taxCodeName: c.tax_code_name,
  };
}

/** Revoke at Intuit (best effort, logged) and forget the connection. */
export async function disconnectQbo(pool: Pool, cfg: QboConfig | null): Promise<{ revoked: boolean }> {
  const c = await loadConnection(pool);
  let revoked = false;
  const token = open(c?.refresh_token_enc) ?? open(c?.access_token_enc);
  if (cfg && token) {
    try {
      const res = await fetch(QBO_REVOKE_URL, {
        method: "POST",
        headers: { Authorization: basicAuth(cfg), "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ token }),
      });
      revoked = res.ok;
      if (!res.ok) console.warn("[quickbooks] revoke refused", { status: res.status });
    } catch (err) {
      console.warn("[quickbooks] revoke failed", { message: err instanceof Error ? err.message : String(err) });
    }
  }
  await pool.query(`DELETE FROM quickbooks_connection WHERE id = 1`);
  return { revoked };
}

export type QboClient = {
  realmId: string;
  request<T = any>(method: "GET" | "POST", path: string, opts?: { body?: unknown; requestId?: string; query?: Record<string, string> }): Promise<T>;
  query<T = any>(statement: string): Promise<T[]>;
};

let refreshing: Promise<string> | null = null;

async function accessToken(pool: Pool, cfg: QboConfig, c: ConnectionRow, force = false): Promise<string> {
  const current = open(c.access_token_enc);
  const exp = c.access_token_expires_at ? new Date(c.access_token_expires_at).getTime() : 0;
  if (!force && current && exp - Date.now() > 60_000) return current;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const refresh = open(c.refresh_token_enc);
    if (!refresh) throw new QboApiError("quickbooks_not_connected", 401, "no_refresh_token");
    try {
      const t = await tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: refresh });
      await pool.query(
        `UPDATE quickbooks_connection
            SET access_token_enc = $1, refresh_token_enc = $2, access_token_expires_at = $3,
                refresh_token_expires_at = COALESCE($4, refresh_token_expires_at), last_error = NULL, updated_at = now()
          WHERE id = 1`,
        [seal(t.accessToken), seal(t.refreshToken || refresh), expiry(t.expiresIn), expiry(t.refreshExpiresIn)],
      );
      return t.accessToken;
    } catch (err) {
      if (err instanceof QboApiError && err.code === "invalid_grant") {
        await pool.query(
          `UPDATE quickbooks_connection SET status = 'reauth_required', access_token_enc = NULL, refresh_token_enc = NULL,
                  last_error = 'QuickBooks needs to be connected again.', updated_at = now() WHERE id = 1`,
        );
        console.warn("[quickbooks] refresh token rejected; reconnect needed");
      }
      throw err;
    }
  })();
  try { return await refreshing; } finally { refreshing = null; }
}

function qboErrorFrom(status: number, text: string): QboApiError {
  let code: string | null = null, detail: string | null = text.slice(0, 300);
  try {
    const j = JSON.parse(text);
    const e = j?.Fault?.Error?.[0];
    if (e) { code = e.code ? String(e.code) : null; detail = [e.Message, e.Detail].filter(Boolean).join(": ").slice(0, 300); }
  } catch { /* not JSON; keep the raw text */ }
  return new QboApiError(`quickbooks_api_${status}${code ? "_" + code : ""}`, status, code, detail);
}

/** The licensee's QuickBooks client, or null when not configured or not connected. */
export async function getQboClient(pool: Pool, cfg: QboConfig | null = qboConfig()): Promise<QboClient | null> {
  if (!cfg) return null;
  const c = await loadConnection(pool);
  if (!c || c.status !== "connected" || !c.realm_id || !c.refresh_token_enc) return null;
  const realmId = c.realm_id;
  const request = async <T>(method: "GET" | "POST", path: string, opts: { body?: unknown; requestId?: string; query?: Record<string, string> } = {}): Promise<T> => {
    const q = new URLSearchParams({ minorversion: QBO_MINOR_VERSION, ...(opts.query ?? {}) });
    if (opts.requestId) q.set("requestid", opts.requestId.slice(0, 50));
    const url = `${cfg.apiBase}/v3/company/${encodeURIComponent(realmId)}/${path}?${q.toString()}`;
    const send = async (token: string) => fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    let res = await send(await accessToken(pool, cfg, c));
    if (res.status === 401) res = await send(await accessToken(pool, cfg, (await loadConnection(pool)) ?? c, true));
    const text = await res.text();
    if (!res.ok) throw qboErrorFrom(res.status, text);
    return (text ? JSON.parse(text) : {}) as T;
  };
  return {
    realmId,
    request,
    async query<T>(statement: string): Promise<T[]> {
      const r = await request<any>("GET", "query", { query: { query: statement } });
      const resp = r?.QueryResponse ?? {};
      const key = Object.keys(resp).find((k) => Array.isArray(resp[k]));
      return key ? (resp[key] as T[]) : [];
    },
  };
}

/** The company's name, for the Settings card (best effort). */
export async function fetchCompanyName(cfg: QboConfig, realmId: string, accessTokenValue: string): Promise<string | null> {
  try {
    const res = await fetch(`${cfg.apiBase}/v3/company/${encodeURIComponent(realmId)}/companyinfo/${encodeURIComponent(realmId)}?minorversion=${QBO_MINOR_VERSION}`, {
      headers: { Authorization: `Bearer ${accessTokenValue}`, Accept: "application/json" },
    });
    if (!res.ok) { console.warn("[quickbooks] company info refused", { status: res.status }); return null; }
    const j: any = await res.json();
    return j?.CompanyInfo?.CompanyName ? String(j.CompanyInfo.CompanyName) : null;
  } catch (err) {
    console.warn("[quickbooks] company info failed", { message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
