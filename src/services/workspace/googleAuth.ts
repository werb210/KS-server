// KS_SERVER_v12_GOOGLE_WORKSPACE - Google OAuth 2.0 (server-side authorization-code flow, offline access, PKCE)
// and the per-user Google client every Google feature goes through.
//
// Flow (routes/googleOAuth.ts): /start stores sha256(nonce) + the user + the PKCE verifier for 10 minutes and sets
// the nonce in an HttpOnly cookie; the callback needs that cookie to equal `state`, consumes the row once, and
// redeems the code with the verifier. Tokens are stored encrypted (tokenCrypto.ts). The access token is refreshed
// a minute before it expires, and once more on a 401. When Google answers invalid_grant (the user revoked access,
// the password changed, or the refresh token expired) the account is marked "reauth_required" and the portal asks
// the user to connect again.
import { createHash, randomBytes } from "node:crypto";
import {
  GOOGLE_AUTH_URL, GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL,
  googleOAuthConfig, parseScopes, requestedScopes, type GoogleOAuthConfig,
} from "./googleConfig.js";
import { decryptToken, encryptToken } from "./tokenCrypto.js";
import { markWorkspaceSync } from "../../modules/o365/m365Consent.js";

export type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const STATE_TTL_MS = 10 * 60 * 1000;
const EXPIRY_SKEW_MS = 60_000;

export function nonceHash(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

/** RFC 7636: 43-128 characters from the unreserved set. 32 random bytes -> 43 base64url characters. */
export function newCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function buildAuthUrl(cfg: GoogleOAuthConfig, state: string, verifier: string, opts: { loginHint?: string | null; env?: NodeJS.ProcessEnv } = {}): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: requestedScopes(opts.env).join(" "),
    access_type: "offline",
    // consent every time so Google always returns a refresh token (it omits it on a repeat grant otherwise).
    prompt: "consent select_account",
    state,
    code_challenge: codeChallenge(verifier),
    code_challenge_method: "S256",
  });
  if (opts.loginHint) params.set("login_hint", opts.loginHint);
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export type TokenSet = { accessToken: string; refreshToken: string | null; expiresAt: Date; scopes: string[] };

export class GoogleTokenError extends Error {
  constructor(public status: number, public code: string | null, message: string) { super(message); this.name = "GoogleTokenError"; }
  get invalidGrant(): boolean { return this.code === "invalid_grant"; }
}

async function tokenRequest(body: URLSearchParams): Promise<TokenSet> {
  const r = await fetch(GOOGLE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const text = await r.text().catch((err: unknown) => { console.warn("google_token_body_unreadable", { message: (err as Error)?.message }); return ""; });
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  if (!r.ok || !json.access_token) {
    const code = typeof json.error === "string" ? json.error : null;
    throw new GoogleTokenError(r.status, code, `google_token_${code ?? r.status}`);
  }
  return {
    accessToken: String(json.access_token),
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
    expiresAt: new Date(Date.now() + Number(json.expires_in ?? 3600) * 1000),
    scopes: parseScopes(json.scope),
  };
}

export function exchangeCode(cfg: GoogleOAuthConfig, code: string, verifier: string): Promise<TokenSet> {
  return tokenRequest(new URLSearchParams({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: "authorization_code",
    code_verifier: verifier,
  }));
}

export function refreshGoogleToken(cfg: GoogleOAuthConfig, refreshToken: string): Promise<TokenSet> {
  return tokenRequest(new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }));
}

/** Revokes the grant at Google (refresh token preferred: it revokes the whole grant). Never throws. */
export async function revokeGoogleToken(token: string): Promise<boolean> {
  try {
    const r = await fetch(GOOGLE_REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
    // 400 invalid_token: already revoked/expired - the grant is gone either way.
    return r.ok || r.status === 400;
  } catch (err) {
    console.warn("google_revoke_failed", { message: (err as Error)?.message });
    return false;
  }
}

export async function fetchGoogleIdentity(accessToken: string): Promise<{ email: string; sub: string }> {
  try {
    const r = await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) return { email: "", sub: "" };
    const j = (await r.json()) as { email?: string; sub?: string };
    return { email: String(j.email ?? ""), sub: String(j.sub ?? "") };
  } catch (err) {
    console.warn("google_userinfo_failed", { message: (err as Error)?.message });
    return { email: "", sub: "" };
  }
}

export async function saveGoogleAccount(db: Db, userId: string, tokens: TokenSet, identity: { email: string; sub: string }): Promise<void> {
  await db.query(
    `INSERT INTO google_workspace_accounts
       (user_id, google_email, google_sub, access_token_enc, refresh_token_enc, access_token_expires_at, scopes, status, last_error, connected_at, updated_at)
     VALUES ($1::uuid, NULLIF($2, ''), NULLIF($3, ''), $4, $5, $6, $7, 'connected', NULL, now(), now())
     ON CONFLICT (user_id) DO UPDATE SET
       google_email = COALESCE(EXCLUDED.google_email, google_workspace_accounts.google_email),
       google_sub = COALESCE(EXCLUDED.google_sub, google_workspace_accounts.google_sub),
       access_token_enc = EXCLUDED.access_token_enc,
       refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, google_workspace_accounts.refresh_token_enc),
       access_token_expires_at = EXCLUDED.access_token_expires_at,
       scopes = EXCLUDED.scopes,
       status = 'connected',
       last_error = NULL,
       updated_at = now()`,
    [userId, identity.email, identity.sub, encryptToken(tokens.accessToken), tokens.refreshToken ? encryptToken(tokens.refreshToken) : null, tokens.expiresAt, tokens.scopes.join(" ")],
  );
}

export async function markGoogleReauthRequired(db: Db, userId: string, reason: string): Promise<void> {
  await db.query(
    `UPDATE google_workspace_accounts
        SET status = 'reauth_required', access_token_enc = NULL, refresh_token_enc = NULL,
            access_token_expires_at = NULL, last_error = $2, updated_at = now()
      WHERE user_id = $1::uuid`,
    [userId, reason.slice(0, 300)],
  );
  console.warn(JSON.stringify({ event: "google_reauth_required", userId, reason: reason.slice(0, 120) }));
}

type AccountRow = {
  google_email: string | null; access_token_enc: string | null; refresh_token_enc: string | null;
  access_token_expires_at: Date | string | null; scopes: string | null; status: string | null;
};

async function readAccount(db: Db, userId: string): Promise<AccountRow | null> {
  const r = await db.query(
    `SELECT google_email, access_token_enc, refresh_token_enc, access_token_expires_at, scopes, status
       FROM google_workspace_accounts WHERE user_id = $1::uuid LIMIT 1`,
    [userId],
  );
  return (r.rows[0] as AccountRow | undefined) ?? null;
}

const refreshInFlight = new Map<string, Promise<string | null>>();

/** Refresh once per user at a time; persists the new access token. Null = cannot refresh (reauth marked). */
export async function refreshAndPersist(db: Db, userId: string): Promise<string | null> {
  const existing = refreshInFlight.get(userId);
  if (existing) return existing;
  const run = (async (): Promise<string | null> => {
    const cfg = googleOAuthConfig();
    if (!cfg) return null;
    const row = await readAccount(db, userId);
    const refresh = decryptToken(row?.refresh_token_enc ?? null);
    if (!refresh) {
      if (row && row.status === "connected") await markGoogleReauthRequired(db, userId, "no_refresh_token");
      return null;
    }
    try {
      const t = await refreshGoogleToken(cfg, refresh);
      await db.query(
        `UPDATE google_workspace_accounts
            SET access_token_enc = $2, access_token_expires_at = $3,
                refresh_token_enc = COALESCE($4, refresh_token_enc),
                scopes = CASE WHEN $5 = '' THEN scopes ELSE $5 END, status = 'connected', last_error = NULL, updated_at = now()
          WHERE user_id = $1::uuid`,
        [userId, encryptToken(t.accessToken), t.expiresAt, t.refreshToken ? encryptToken(t.refreshToken) : null, t.scopes.join(" ")],
      );
      return t.accessToken;
    } catch (err) {
      if (err instanceof GoogleTokenError && (err.invalidGrant || err.status === 401)) {
        await markGoogleReauthRequired(db, userId, err.code ?? "invalid_grant");
      } else {
        console.warn(JSON.stringify({ event: "google_refresh_failed", userId, message: (err as Error)?.message }));
      }
      return null;
    }
  })();
  refreshInFlight.set(userId, run);
  try { return await run; } finally { refreshInFlight.delete(userId); }
}

export type GoogleClient = {
  provider: "google";
  userId: string;
  email: string;
  scopes: string[];
  readonly accessToken: string;
  /** fetch against a Google API URL with the user's token; refreshes and retries once on 401. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
};

/** The user's Google client, or null when Google is not configured, not connected or needs reconnecting. */
export async function getGoogleForUser(db: Db, userId: string | null | undefined): Promise<GoogleClient | null> {
  if (!userId || !googleOAuthConfig()) return null;
  const row = await readAccount(db, String(userId));
  if (!row || row.status !== "connected") return null;
  let token = decryptToken(row.access_token_enc);
  const expiresAt = row.access_token_expires_at ? new Date(row.access_token_expires_at) : null;
  if (!token || !expiresAt || expiresAt.getTime() - Date.now() < EXPIRY_SKEW_MS) {
    token = await refreshAndPersist(db, String(userId));
    if (!token) return null;
  }
  let current = token;
  const uid = String(userId);
  const doFetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const call = (t: string) => fetch(url, { ...init, headers: { Authorization: `Bearer ${t}`, ...(init.headers as Record<string, string> | undefined) } });
    let resp = await call(current);
    if (resp.status === 401) {
      const fresh = await refreshAndPersist(db, uid);
      if (fresh) { current = fresh; resp = await call(current); }
    }
    if (resp.ok) markWorkspaceSync(db, "google"); // KS_SERVER_M365_ONE_CLICK - "last successful sync" on Connections
    return resp;
  };
  return {
    provider: "google",
    userId: uid,
    email: String(row.google_email ?? ""),
    scopes: parseScopes(row.scopes),
    get accessToken() { return current; },
    fetch: doFetch,
  };
}

export type GoogleStatus = {
  configured: boolean;
  configProblem: string | null;
  gmailReadEnabled: boolean;
  connected: boolean;
  status: "connected" | "reauth_required" | "not_connected";
  email: string | null;
  scopes: string[];
};

export async function googleStatusForUser(db: Db, userId: string, problem: string | null, readEnabled: boolean): Promise<GoogleStatus> {
  const base = { configured: !problem, configProblem: problem, gmailReadEnabled: readEnabled };
  const row = problem ? null : await readAccount(db, userId);
  if (!row) return { ...base, connected: false, status: "not_connected", email: null, scopes: [] };
  const status = row.status === "connected" ? "connected" : "reauth_required";
  return { ...base, connected: status === "connected", status, email: row.google_email ?? null, scopes: parseScopes(row.scopes) };
}

/** Disconnect: revoke at Google, then forget the tokens. */
export async function disconnectGoogle(db: Db, userId: string): Promise<{ revoked: boolean }> {
  const row = await readAccount(db, userId);
  const token = decryptToken(row?.refresh_token_enc ?? null) ?? decryptToken(row?.access_token_enc ?? null);
  const revoked = token ? await revokeGoogleToken(token) : true;
  await db.query(`DELETE FROM google_workspace_accounts WHERE user_id = $1::uuid`, [userId]);
  return { revoked };
}
