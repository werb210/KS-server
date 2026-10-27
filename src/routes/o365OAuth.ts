// BF_SERVER_BLOCK_v_O365_OAUTH_v1 - durable O365 connect via server-side
// authorization-code flow. The portal's MSAL.js (SPA) can only hand the server
// a 1-hour access token and NO refresh token, so the server could never refresh
// and the user had to reconnect ~hourly. Here the server redeems an auth CODE
// with its client secret + offline_access, capturing a long-lived REFRESH token
// that graphClient.ts can renew indefinitely.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { portalUrl, serverUrl } from "../licensee/urls.js"; // KS_SERVER_v1_LICENSEE
import { requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { DELEGATED_SCOPE_STRING, isTenantGuid, m365App, m365Delegated, m365TenantInfo } from "../modules/o365/m365App.js"; // KS_SERVER_M365_ONE_CLICK
import {
  CONSENT_LINK_TTL_MS, CONSENT_STATE_TTL_MS, adminConsentUrl, consentErrorKind, disconnectM365, hashState, m365Status, newState, saveConsent,
} from "../modules/o365/m365Consent.js";
import { redirectUriFor, unwrapState, wrapState } from "../licensee/oauthBroker.js";
import { recordAuditEvent } from "../modules/audit/audit.service.js";
import { markWorkspaceSync } from "../modules/o365/m365Consent.js";

const router = Router();
const AUTH_BASE = "https://login.microsoftonline.com";
// KS_SERVER_M365_ONE_CLICK - one list for connect and refresh (modules/o365/m365App.ts). People.Read was dropped:
// nothing calls /people. Mail.ReadWrite.Shared replaces Mail.Read.Shared: the inbox moves and marks shared mail.
const SCOPE = DELEGATED_SCOPE_STRING; // BF_SERVER_BLOCK_v_O365_SCOPES_WAVE2_v1

function redirectUri(): string {
  if (process.env.O365_OAUTH_REDIRECT_URI) return process.env.O365_OAUTH_REDIRECT_URI.trim();
  return redirectUriFor("microsoft", serverUrl() + "/api/o365-oauth/callback");
}
function consentRedirectUri(): string {
  if (process.env.O365_CONSENT_REDIRECT_URI) return process.env.O365_CONSENT_REDIRECT_URI.trim();
  return redirectUriFor("microsoft", serverUrl() + "/api/o365-oauth/admin-consent/callback");
}
function consentReturnUrl(suffix: string): string {
  const base = (process.env.O365_CONSENT_RETURN_URL || portalUrl() + "/settings/connections").trim();
  return base + (base.includes("?") ? "&" : "?") + suffix;
}
function returnUrl(suffix: string): string {
  const base = (process.env.O365_OAUTH_RETURN_URL || portalUrl() + "/communications").trim();
  return base + (base.includes("?") ? "&" : "?") + suffix;
}

// BF_SERVER_v789_O365_OAUTH_STATE - the state used to be a JWT naming the user,
// so anyone holding a valid state (or a code+state pair) could bind THEIR Microsoft
// account to that staff user (login CSRF). Now /start issues a random single-use
// nonce, stores sha256(nonce) with the user id and a 10-minute expiry, and sets the
// nonce in an HttpOnly, Secure, SameSite=Lax cookie. The state carries only the
// nonce. The callback requires the cookie to equal the state, consumes the row
// atomically (unused + unexpired), and saves tokens on the user who started it.
// Lax is enough: the callback is a top-level GET navigation from Microsoft.
const STATE_COOKIE = "o365_oauth_nonce";
const STATE_TTL_MS = 10 * 60 * 1000;
const COOKIE_PATH = "/api/o365-oauth";

function nonceHash(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

function cookieValue(req: any, name: string): string {
  const parsed = req.cookies && typeof req.cookies[name] === "string" ? req.cookies[name] : null;
  if (parsed !== null) return parsed;
  const header = typeof req.headers?.cookie === "string" ? req.headers.cookie : "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ""; }
  }
  return "";
}

function sameNonce(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

const stateCookieOptions = { httpOnly: true, secure: true, sameSite: "lax" as const, path: COOKIE_PATH };

// GET /api/o365-oauth/start - authed via header (fetched by the portal with
// credentials so the nonce cookie is stored); returns the Microsoft authorize URL.
// The portal then sets window.location to it.
router.get("/start", requireAuth, safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId ?? req.user?.sub;
  // KS_SERVER_M365_ONE_CLICK - Keystone's app (or this server's own) and the tenant an Admin connected.
  const ms = m365Delegated();
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  if (!m365App()) {
    return res.status(503).json({ error: "o365_oauth_not_configured", message: "Microsoft 365 is not available on this server yet. Contact Keystone support." });
  }
  if (!ms) {
    return res.status(409).json({ error: "m365_not_connected", message: "Your company has not connected Microsoft 365 yet. An administrator connects it once in Settings > Connections." });
  }
  const tenant = ms.tenant;
  const client = ms.clientId;
  const nonce = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO o365_oauth_states (nonce_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
    [nonceHash(nonce), String(userId), new Date(Date.now() + STATE_TTL_MS)],
  );
  // Housekeeping only; a failure here must not block the connect.
  await pool.query(`DELETE FROM o365_oauth_states WHERE expires_at < now() - interval '1 day'`)
    .catch((err: unknown) => logWarnSwallowed(err, "o365_oauth_states.prune"));
  res.cookie(STATE_COOKIE, nonce, { ...stateCookieOptions, maxAge: STATE_TTL_MS });
  const state = wrapState("o365", nonce, STATE_TTL_MS); // KS_SERVER_M365_ONE_CLICK - unchanged without the broker
  const params = new URLSearchParams({
    client_id: client,
    response_type: "code",
    redirect_uri: redirectUri(),
    response_mode: "query",
    scope: SCOPE,
    state,
    prompt: "select_account",
  });
  res.json({ url: `${AUTH_BASE}/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize?${params.toString()}` });
}));

// GET /api/o365-oauth/callback - PUBLIC. Microsoft redirects the browser here
// with ?code&state. Exchange the code -> access + refresh + expiry, store, bounce
// back to the portal.
router.get("/callback", safeHandler(async (req: any, res: any) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  // KS_SERVER_M365_ONE_CLICK - a state that came through Keystone's redirect broker is unwrapped (HMAC checked) first.
  const stateRaw = unwrapState("o365", typeof req.query.state === "string" ? req.query.state : "") ?? "";
  // BF_SERVER_v789_O365_OAUTH_STATE - the nonce cookie is single-use: clear it now.
  const cookieNonce = cookieValue(req, STATE_COOKIE);
  res.clearCookie(STATE_COOKIE, stateCookieOptions);
  if (typeof req.query.error === "string" && req.query.error) return res.redirect(returnUrl("o365=error"));

  const ms = m365Delegated();
  const tenant = ms?.tenant;
  const client = ms?.clientId;
  const clientSecret = ms?.clientSecret;
  if (!code || !stateRaw || !tenant || !client || !clientSecret) return res.redirect(returnUrl("o365=error"));

  // The browser finishing the flow must be the one that started it.
  if (!cookieNonce || !sameNonce(cookieNonce, stateRaw)) {
    console.warn("o365_oauth_state_cookie_mismatch", { hasCookie: Boolean(cookieNonce) });
    return res.redirect(returnUrl("o365=error"));
  }
  // Consume atomically: only an unused, unexpired nonce yields its user.
  const consumed = await pool.query<{ user_id: string }>(
    `UPDATE o365_oauth_states
        SET consumed_at = now()
      WHERE nonce_hash = $1 AND purpose = 'user' AND consumed_at IS NULL AND expires_at > now()
      RETURNING user_id::text AS user_id`,
    [nonceHash(stateRaw)],
  );
  const uid = consumed.rows[0]?.user_id ?? "";
  if (!uid) {
    console.warn("o365_oauth_state_invalid", { reason: "unknown_used_or_expired" });
    return res.redirect(returnUrl("o365=error"));
  }

  const body = new URLSearchParams({
    client_id: client,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
    scope: SCOPE,
  });
  const tokRes = await fetch(`${AUTH_BASE}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokRes.ok) {
    const detail = await tokRes.text().catch((err: unknown) => { console.warn("o365_oauth_exchange_body_unreadable", { message: (err as Error)?.message }); return ""; });
    console.error("o365_oauth_exchange_failed", { status: tokRes.status, detail: detail.slice(0, 300) });
    return res.redirect(returnUrl("o365=error"));
  }
  const tok = (await tokRes.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  const accessToken = tok.access_token ?? "";
  const refreshToken = tok.refresh_token ?? null;
  const expiresAt = new Date(Date.now() + (tok.expires_in ?? 3600) * 1000);
  if (!accessToken) return res.redirect(returnUrl("o365=error"));

  let email = "";
  try {
    const me = await fetch("https://graph.microsoft.com/v1.0/me", { headers: { Authorization: `Bearer ${accessToken}` } });
    if (me.ok) { const p = (await me.json()) as { mail?: string; userPrincipalName?: string }; email = p.mail ?? p.userPrincipalName ?? ""; }
  } catch { /* non-fatal */ }

  await pool.query(
    `UPDATE users SET
        o365_access_token = $1,
        o365_refresh_token = COALESCE($2, o365_refresh_token),
        o365_access_token_expires_at = $3,
        o365_token_expires_at        = $3,
        o365_user_email = COALESCE(NULLIF($4, ''), o365_user_email)
      WHERE id = $5`,
    [accessToken, refreshToken, expiresAt, email, uid],
  );
  markWorkspaceSync(pool, "m365");
  return res.redirect(returnUrl("o365=connected"));
}));

// BF_SERVER_O365_DISCONNECT_v802 - POST /api/o365-oauth/disconnect. The portal's Disconnect button only
// cleared the screen; the stored Microsoft tokens stayed, so mail and calendar kept using the account.
router.post("/disconnect", requireAuth, safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId ?? req.user?.sub;
  if (!userId) return res.status(401).json({ error: "unauthorized" });
  await pool.query(
    "UPDATE users SET o365_access_token = NULL, o365_refresh_token = NULL, o365_access_token_expires_at = NULL, o365_token_expires_at = NULL, o365_user_email = NULL, o365_account_id = NULL WHERE id = $1",
    [String(userId)],
  );
  return res.json({ ok: true, connected: false });
}));

// ---- KS_SERVER_M365_ONE_CLICK - the brokerage-wide connection (Admins) ----------------------------------------------
//   GET  /api/o365-oauth/admin-consent/status     (Admin)  plain-English status, permissions, health (?refresh=1)
//   GET  /api/o365-oauth/admin-consent/start      (Admin)  { url } of Microsoft's admin consent page; sets the cookie
//   POST /api/o365-oauth/admin-consent/link       (Admin)  { url, expires_at }: a 7-day, single-use link for the
//                                                           brokerage's Microsoft 365 admin, opened in any browser
//   GET  /api/o365-oauth/admin-consent/callback   (public) Microsoft (or Keystone's redirect broker) returns here
//   POST /api/o365-oauth/admin-consent/disconnect (Admin)  forgets the tenant and every staff member's sign-in
const CONSENT_COOKIE = "o365_consent_nonce";
const adminOnly = [requireAuth, requireAuthorization({ roles: [ROLES.ADMIN] })];

async function actorLabel(userId: string): Promise<string | null> {
  const r = await pool.query<{ name: string | null; email: string | null }>(
    `SELECT NULLIF(trim(concat_ws(' ', first_name, last_name)), '') AS name, email FROM users WHERE id::text = $1 LIMIT 1`,
    [userId],
  ).catch((err: unknown) => logWarnSwallowed(err, "o365_consent.actor", { rows: [] as Array<{ name: string | null; email: string | null }> }));
  const u = r.rows[0];
  if (!u) return null;
  return u.name && u.email ? `${u.name} (${u.email})` : u.name || u.email || null;
}

async function auditConsent(req: any, action: string, success: boolean, metadata: Record<string, unknown>, userId: string | null) {
  try {
    await recordAuditEvent({
      action, actorUserId: userId, targetUserId: null, targetType: "m365_connection", targetId: "1",
      ip: null, userAgent: String(req.headers?.["user-agent"] ?? "").slice(0, 300) || null, success, metadata,
    });
  } catch (err) {
    console.error("[m365] audit write failed", { action, message: (err as Error)?.message });
  }
}

async function newConsentState(userId: string, purpose: "admin_consent" | "admin_consent_link", ttlMs: number): Promise<string> {
  const nonce = newState();
  await pool.query(
    `INSERT INTO o365_oauth_states (nonce_hash, user_id, expires_at, purpose) VALUES ($1, $2, $3, $4)`,
    [hashState(nonce), userId, new Date(Date.now() + ttlMs), purpose],
  );
  await pool.query(`DELETE FROM o365_oauth_states WHERE expires_at < now() - interval '1 day'`)
    .catch((err: unknown) => logWarnSwallowed(err, "o365_oauth_states.prune"));
  return nonce;
}

router.get("/admin-consent/status", ...adminOnly, safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, ...(await m365Status(pool, { refresh: req.query.refresh === "1" })) });
}));

router.get("/admin-consent/start", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const userId = String(req.user?.id ?? req.user?.userId ?? req.user?.sub ?? "");
  const app = m365App();
  if (!app) return res.status(503).json({ error: "o365_oauth_not_configured", message: "Microsoft 365 is not available on this server yet. Contact Keystone support." });
  const nonce = await newConsentState(userId, "admin_consent", CONSENT_STATE_TTL_MS);
  res.cookie(CONSENT_COOKIE, nonce, { ...stateCookieOptions, maxAge: CONSENT_STATE_TTL_MS });
  res.setHeader("Cache-Control", "no-store");
  res.json({ url: adminConsentUrl(app.clientId, consentRedirectUri(), wrapState("consent", nonce, CONSENT_STATE_TTL_MS)) });
}));

router.post("/admin-consent/link", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const userId = String(req.user?.id ?? req.user?.userId ?? req.user?.sub ?? "");
  const app = m365App();
  if (!app) return res.status(503).json({ error: "o365_oauth_not_configured", message: "Microsoft 365 is not available on this server yet. Contact Keystone support." });
  const nonce = await newConsentState(userId, "admin_consent_link", CONSENT_LINK_TTL_MS);
  await auditConsent(req, "m365_consent_link_created", true, {}, userId || null);
  res.setHeader("Cache-Control", "no-store");
  res.json({
    url: adminConsentUrl(app.clientId, consentRedirectUri(), wrapState("consent", nonce, CONSENT_LINK_TTL_MS)),
    expires_at: new Date(Date.now() + CONSENT_LINK_TTL_MS).toISOString(),
  });
}));

router.get("/admin-consent/callback", safeHandler(async (req: any, res: any) => {
  const cookieNonce = cookieValue(req, CONSENT_COOKIE);
  res.clearCookie(CONSENT_COOKIE, stateCookieOptions);
  res.setHeader("Cache-Control", "no-store");
  const state = unwrapState("consent", typeof req.query.state === "string" ? req.query.state : "") ?? "";
  const error = typeof req.query.error === "string" ? req.query.error : "";
  if (error && !state) {
    // Nothing is saved on an error, so the page can still say what happened even when Microsoft sent no state back.
    const kind = consentErrorKind(error, typeof req.query.error_description === "string" ? req.query.error_description : "");
    await auditConsent(req, "m365_consent_refused", false, { reason: kind, error: error.slice(0, 60) }, null);
    return res.redirect(consentReturnUrl(`m365=${kind}`));
  }
  if (!state) {
    await auditConsent(req, "m365_consent_refused", false, { reason: "state" }, null);
    return res.redirect(consentReturnUrl("m365=state"));
  }
  // The browser that pressed Connect (cookie), or a link an Admin made for their Microsoft 365 admin (no cookie).
  const withCookie = Boolean(cookieNonce) && sameNonce(cookieNonce, state);
  const consumed = await pool.query<{ user_id: string; purpose: string }>(
    `UPDATE o365_oauth_states SET consumed_at = now()
      WHERE nonce_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        AND ((purpose = 'admin_consent' AND $2::boolean) OR purpose = 'admin_consent_link')
      RETURNING user_id::text AS user_id, purpose`,
    [hashState(state), withCookie],
  );
  const row = consumed.rows[0];
  if (!row) {
    await auditConsent(req, "m365_consent_refused", false, { reason: "state" }, null);
    return res.redirect(consentReturnUrl("m365=state"));
  }
  if (error) {
    const kind = consentErrorKind(error, typeof req.query.error_description === "string" ? req.query.error_description : "");
    await auditConsent(req, "m365_consent_refused", false, { reason: kind, error: error.slice(0, 60) }, row.user_id);
    return res.redirect(consentReturnUrl(`m365=${kind}`));
  }
  const tenant = typeof req.query.tenant === "string" ? req.query.tenant.trim().toLowerCase() : "";
  const granted = String(req.query.admin_consent ?? "").toLowerCase() === "true";
  if (!granted || !isTenantGuid(tenant)) {
    await auditConsent(req, "m365_consent_refused", false, { reason: "no_tenant" }, row.user_id);
    return res.redirect(consentReturnUrl("m365=error"));
  }
  const before = m365TenantInfo();
  await saveConsent(pool, {
    tenant_id: tenant,
    consented_at: new Date().toISOString(),
    consented_by_id: row.user_id,
    consented_by: await actorLabel(row.user_id),
    via: row.purpose === "admin_consent_link" ? "link" : "button",
  });
  await auditConsent(req, "m365_connected", true, { tenant_id: tenant, previous_tenant_id: before.tenant || null, via: row.purpose }, row.user_id);
  return res.redirect(consentReturnUrl("m365=connected"));
}));

router.post("/admin-consent/disconnect", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const userId = String(req.user?.id ?? req.user?.userId ?? req.user?.sub ?? "");
  const before = m365TenantInfo();
  if (before.source === "server_settings") {
    return res.status(409).json({ error: "set_by_server", message: "This server's own settings choose the Microsoft 365 organisation, so it cannot be disconnected here. Contact Keystone support." });
  }
  const r = await disconnectM365(pool, userId || "admin");
  await auditConsent(req, "m365_disconnected", true, { tenant_id: before.tenant || null, users_signed_out: r.users }, userId || null);
  res.json({ ok: true, users_signed_out: r.users });
}));

export default router;
