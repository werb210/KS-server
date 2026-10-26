// KS_SERVER_SSO_API_KEYS - staff single sign-on with Microsoft (Entra ID) and Google: OpenID Connect authorization
// code flow with PKCE (S256), state and nonce. The id_token is checked here, never trusted as sent:
//   * signature: RS256 against the provider's published JWKS (cached an hour, refetched once for an unknown kid)
//   * issuer: Google's, or https://login.microsoftonline.com/{tid}/v2.0 for the token's own tenant
//   * audience: this copy's client id; expiry / not-before (60 s clock skew); nonce: the one this sign-in stored
//   * email: Google needs email_verified === true. Microsoft email claims are not verified by default, so the
//     email is accepted only when the tenant is pinned (Admin setting or SSO_MICROSOFT_TENANT) and the token is from
//     it - that organisation owns its sign-in names - or when Microsoft marks the email domain as verified (xms_edov).
//   * tenant / domain: the Admin's Microsoft tenant restriction (tid) and Google hosted-domain restriction (hd).
// Reuses the app registrations the mail/calendar connections already use (MSAL_CLIENT_ID / MSAL_CLIENT_SECRET and
// GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET). When those are unset the provider is simply not offered.
import { createHash, createPublicKey, randomBytes, type KeyObject } from "node:crypto";
import jwt from "jsonwebtoken";
import { portalUrl, serverUrl } from "../licensee/urls.js";

export const SSO_PROVIDERS = ["microsoft", "google"] as const;
export type SsoProvider = (typeof SSO_PROVIDERS)[number];

export function isSsoProvider(v: unknown): v is SsoProvider {
  return typeof v === "string" && (SSO_PROVIDERS as readonly string[]).includes(v);
}

export const STATE_TTL_MS = 10 * 60 * 1000;
export const HANDOFF_TTL_MS = 60 * 1000;
const CLOCK_SKEW_S = 60;

export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const MS_LOGIN_BASE = "https://login.microsoftonline.com";
export const MS_JWKS_URL = `${MS_LOGIN_BASE}/common/discovery/v2.0/keys`;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

export function isTenantId(v: string): boolean {
  return GUID.test(v);
}
export function isHostedDomain(v: string): boolean {
  return DOMAIN.test(v) && v.length <= 200;
}

const env = (name: string, e: NodeJS.ProcessEnv): string => String(e[name] ?? "").trim();

export type ProviderConfig = {
  provider: SsoProvider;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Microsoft only: the tenant segment of the authority (a GUID, or "organizations"). */
  authorityTenant?: string;
  /** Microsoft only: a tenant pinned by the server's own settings (SSO_MICROSOFT_TENANT / MSAL_TENANT_ID GUID). */
  serverTenant?: string | null;
};

/** The server-side configuration for a provider, or null when its env vars are not set (provider not offered). */
export function providerConfig(provider: SsoProvider, e: NodeJS.ProcessEnv = process.env): ProviderConfig | null {
  if (provider === "google") {
    const clientId = env("GOOGLE_OAUTH_CLIENT_ID", e);
    const clientSecret = env("GOOGLE_OAUTH_CLIENT_SECRET", e);
    if (!clientId || !clientSecret) return null;
    return {
      provider, clientId, clientSecret,
      redirectUri: env("SSO_GOOGLE_REDIRECT_URI", e) || serverUrl() + "/api/auth/sso/google/callback",
    };
  }
  const clientId = env("MSAL_CLIENT_ID", e);
  const clientSecret = env("MSAL_CLIENT_SECRET", e);
  if (!clientId || !clientSecret) return null;
  const pinned = env("SSO_MICROSOFT_TENANT", e) || env("MSAL_TENANT_ID", e);
  const serverTenant = isTenantId(pinned) ? pinned.toLowerCase() : null;
  return {
    provider, clientId, clientSecret,
    redirectUri: env("SSO_MICROSOFT_REDIRECT_URI", e) || serverUrl() + "/api/auth/sso/microsoft/callback",
    authorityTenant: serverTenant ?? "organizations",
    serverTenant,
  };
}

/** Where the browser lands after a sign-in (the portal's sign-in page reads the hand-off code from the hash). */
export function ssoReturnUrl(e: NodeJS.ProcessEnv = process.env): string {
  return env("SSO_RETURN_URL", e) || portalUrl() + "/login";
}

export function sha256Hex(v: string): string {
  return createHash("sha256").update(v, "utf8").digest("hex");
}
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export type AuthorizeInput = { state: string; nonce: string; verifier: string; tenantRestriction?: string; hostedDomain?: string };

export function buildAuthorizeUrl(cfg: ProviderConfig, input: AuthorizeInput): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: input.state,
    nonce: input.nonce,
    code_challenge: codeChallenge(input.verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  if (cfg.provider === "google") {
    if (input.hostedDomain) params.set("hd", input.hostedDomain);
    return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
  }
  params.set("response_mode", "query");
  return `${MS_LOGIN_BASE}/${encodeURIComponent(authorityFor(cfg, input.tenantRestriction))}/oauth2/v2.0/authorize?${params.toString()}`;
}

/** Microsoft authority: the server's pinned tenant, else the Admin's tenant restriction, else "organizations". */
export function authorityFor(cfg: ProviderConfig, tenantRestriction?: string): string {
  if (cfg.serverTenant) return cfg.serverTenant;
  if (tenantRestriction && isTenantId(tenantRestriction)) return tenantRestriction.toLowerCase();
  return cfg.authorityTenant ?? "organizations";
}

export function tokenUrlFor(cfg: ProviderConfig, tenantRestriction?: string): string {
  return cfg.provider === "google"
    ? GOOGLE_TOKEN_URL
    : `${MS_LOGIN_BASE}/${encodeURIComponent(authorityFor(cfg, tenantRestriction))}/oauth2/v2.0/token`;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Redeems the authorization code (with the PKCE verifier and the client secret) for the id_token. */
export async function exchangeCodeForIdToken(
  cfg: ProviderConfig, code: string, verifier: string, tenantRestriction?: string, fetcher: Fetcher = fetch,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    code_verifier: verifier,
    redirect_uri: cfg.redirectUri,
    grant_type: "authorization_code",
  });
  if (cfg.provider === "microsoft") body.set("scope", "openid email profile");
  const r = await fetcher(tokenUrlFor(cfg, tenantRestriction), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await r.json().catch(() => ({}))) as { id_token?: unknown; error?: unknown };
  if (!r.ok || typeof json.id_token !== "string" || !json.id_token) {
    throw new SsoError("exchange_failed", `token endpoint answered ${r.status}${json.error ? ` (${String(json.error).slice(0, 60)})` : ""}`);
  }
  return json.id_token;
}

export type SsoRefusal =
  | "exchange_failed" | "bad_token" | "bad_signature" | "wrong_issuer" | "wrong_audience" | "expired" | "bad_nonce"
  | "email_not_verified" | "wrong_tenant" | "wrong_domain";

export class SsoError extends Error {
  constructor(public reason: SsoRefusal, message?: string) {
    super(message ?? reason);
    this.name = "SsoError";
  }
}

// ---- JWKS -------------------------------------------------------------------------------------------------------

type Jwk = { kid?: string; kty?: string; alg?: string; use?: string; n?: string; e?: string };
type KeySet = { at: number; keys: Map<string, KeyObject> };
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFRESH_MS = 60 * 1000;
const jwksCache = new Map<string, KeySet>();

export function clearJwksCache(): void {
  jwksCache.clear();
}

async function loadJwks(url: string, fetcher: Fetcher): Promise<KeySet> {
  const r = await fetcher(url);
  if (!r.ok) throw new SsoError("bad_signature", `JWKS ${url} answered ${r.status}`);
  const json = (await r.json()) as { keys?: Jwk[] };
  const keys = new Map<string, KeyObject>();
  for (const k of Array.isArray(json.keys) ? json.keys : []) {
    if (!k.kid || k.kty !== "RSA" || !k.n || !k.e) continue;
    try {
      keys.set(k.kid, createPublicKey({ key: { kty: "RSA", n: k.n, e: k.e }, format: "jwk" }));
    } catch (err) {
      console.warn("[sso] skipped an unreadable JWKS key", { kid: k.kid, message: (err as Error)?.message });
    }
  }
  const set = { at: Date.now(), keys };
  jwksCache.set(url, set);
  return set;
}

/** The signing key for this kid, from the cached set; an unknown kid refetches the set (at most once a minute). */
export async function jwksKey(url: string, kid: string, fetcher: Fetcher = fetch): Promise<KeyObject | null> {
  let set = jwksCache.get(url);
  if (!set || Date.now() - set.at > JWKS_TTL_MS) set = await loadJwks(url, fetcher);
  let key = set.keys.get(kid) ?? null;
  if (!key && Date.now() - set.at > JWKS_MIN_REFRESH_MS) key = (await loadJwks(url, fetcher)).keys.get(kid) ?? null;
  return key;
}

export type KeyResolver = (provider: SsoProvider, kid: string) => Promise<KeyObject | null>;

export const defaultKeyResolver: KeyResolver = (provider, kid) =>
  jwksKey(provider === "google" ? GOOGLE_JWKS_URL : MS_JWKS_URL, kid);

// ---- id_token -----------------------------------------------------------------------------------------------------

export type VerifyOptions = {
  clientId: string;
  nonce: string;
  /** Microsoft: accept only this tenant (Admin setting). */
  tenantRestriction?: string;
  /** Microsoft: the tenant the server itself is pinned to. */
  serverTenant?: string | null;
  /** Google: accept only this Workspace domain (hd claim). */
  hostedDomain?: string;
  now?: Date;
};

export type SsoIdentity = { provider: SsoProvider; email: string; subject: string; tenantId: string | null; hostedDomain: string | null };

export async function verifyIdToken(
  provider: SsoProvider, idToken: string, opts: VerifyOptions, resolveKey: KeyResolver = defaultKeyResolver,
): Promise<SsoIdentity> {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || typeof decoded === "string" || typeof decoded.payload === "string") throw new SsoError("bad_token");
  const header = decoded.header as { alg?: string; kid?: string };
  if (header.alg !== "RS256" || !header.kid) throw new SsoError("bad_token", "id_token must be RS256 with a kid");
  const key = await resolveKey(provider, header.kid);
  if (!key) throw new SsoError("bad_signature", "signing key not published by the provider");

  let claims: Record<string, any>;
  try {
    claims = jwt.verify(idToken, key, {
      algorithms: ["RS256"],
      audience: opts.clientId,
      clockTolerance: CLOCK_SKEW_S,
      ...(opts.now ? { clockTimestamp: Math.floor(opts.now.getTime() / 1000) } : {}),
    }) as Record<string, any>;
  } catch (err) {
    const name = (err as Error)?.name;
    const message = (err as Error)?.message ?? "";
    if (name === "TokenExpiredError" || /not active/i.test(message)) throw new SsoError("expired", message);
    if (/audience/i.test(message)) throw new SsoError("wrong_audience", message);
    if (/signature/i.test(message)) throw new SsoError("bad_signature", message);
    throw new SsoError("bad_token", message);
  }
  if (typeof claims.exp !== "number") throw new SsoError("expired", "id_token has no expiry");
  if (typeof claims.nonce !== "string" || claims.nonce !== opts.nonce) throw new SsoError("bad_nonce");

  if (provider === "google") return googleIdentity(claims, opts);
  return microsoftIdentity(claims, opts);
}

function googleIdentity(claims: Record<string, any>, opts: VerifyOptions): SsoIdentity {
  if (!GOOGLE_ISSUERS.includes(String(claims.iss ?? ""))) throw new SsoError("wrong_issuer");
  const email = String(claims.email ?? "").trim().toLowerCase();
  if (!email || claims.email_verified !== true) throw new SsoError("email_not_verified");
  const hd = typeof claims.hd === "string" ? claims.hd.toLowerCase() : null;
  const wanted = String(opts.hostedDomain ?? "").trim().toLowerCase();
  if (wanted) {
    // hd is Google's own statement that the account belongs to that Workspace; the email domain must agree too.
    if (hd !== wanted || !email.endsWith(`@${wanted}`)) throw new SsoError("wrong_domain");
  }
  return { provider: "google", email, subject: String(claims.sub ?? ""), tenantId: null, hostedDomain: hd };
}

function microsoftIdentity(claims: Record<string, any>, opts: VerifyOptions): SsoIdentity {
  const tid = String(claims.tid ?? "").toLowerCase();
  if (!isTenantId(tid) || String(claims.iss ?? "") !== `${MS_LOGIN_BASE}/${tid}/v2.0`) throw new SsoError("wrong_issuer");
  const restriction = String(opts.tenantRestriction ?? "").trim().toLowerCase();
  const serverTenant = String(opts.serverTenant ?? "").trim().toLowerCase();
  if (restriction && tid !== restriction) throw new SsoError("wrong_tenant");
  if (serverTenant && tid !== serverTenant) throw new SsoError("wrong_tenant");
  const pinned = Boolean(restriction || serverTenant);
  const emailClaim = String(claims.email ?? "").trim().toLowerCase();
  const upn = String(claims.preferred_username ?? "").trim().toLowerCase();
  let email = "";
  if (pinned) email = emailClaim || (upn.includes("@") ? upn : "");
  else if (claims.xms_edov === true || claims.xms_edov === "true" || claims.xms_edov === 1) email = emailClaim;
  if (!email || !email.includes("@")) throw new SsoError("email_not_verified");
  return { provider: "microsoft", email, subject: String(claims.oid ?? claims.sub ?? ""), tenantId: tid, hostedDomain: null };
}
