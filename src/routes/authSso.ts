// KS_SERVER_SSO_API_KEYS - staff single sign-on (Pro). Mounted under /api/auth/sso (open while a service is suspended,
// like the rest of sign-in).
//   GET  /api/auth/sso/config               (public)  which buttons the sign-in page shows
//   GET  /api/auth/sso/:provider/start      (public)  sets the state cookie and redirects to Microsoft / Google
//   GET  /api/auth/sso/:provider/callback   (public, rate limited)  checks everything, then redirects to the portal
//                                                     with a one-time 60-second code in the URL fragment
//   POST /api/auth/sso/exchange { code }    (public, rate limited)  the code -> the same staff session token the
//                                                     text-code and passkey sign-ins issue
// The state is a random single-use value: its sha256, the PKCE verifier and the nonce are stored for 10 minutes and
// the value is also set in an HttpOnly, Secure, SameSite=Lax cookie; the callback needs both (same pattern as the
// Microsoft 365 / Google Workspace connect). Users are matched by verified email to an existing active staff user;
// nobody is ever created. Every sign-in and every refusal is written to the audit log.
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { timingSafeEqual } from "node:crypto";
import { pool } from "../db.js";
import { signAccessToken } from "../auth/jwt.js";
import { fetchCapabilitiesForRole } from "../auth/capabilities.js";
import { isStaffRole, normalizeRole, ROLES } from "../auth/roles.js";
import { findAuthUserById } from "../modules/auth/auth.repo.js";
import { recordAuditEvent } from "../modules/audit/audit.service.js";
import { clientIpFromRequest, rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { recordTrialUsage, getPlanState, type Q } from "../plans/state.js";
import { checkFeature } from "../plans/catalogue.js";
import {
  HANDOFF_TTL_MS, STATE_TTL_MS, SsoError, buildAuthorizeUrl, exchangeCodeForIdToken, isSsoProvider, providerConfig,
  randomToken, sha256Hex, ssoReturnUrl, verifyIdToken, type KeyResolver, type SsoProvider,
} from "../sso/oidc.js";
import { loadSsoAvailability } from "../sso/settings.js";

const router = Router();
const db = () => pool as unknown as Q;

const STATE_COOKIE = "ks_sso_state";
const COOKIE_PATH = "/api/auth/sso";
const stateCookieOptions = { httpOnly: true, secure: true, sameSite: "lax" as const, path: COOKIE_PATH };

// Test hook: the id_token signing-key lookup (defaults to the providers' published JWKS).
let keyResolver: KeyResolver | undefined;
export function setSsoKeyResolverForTests(r: KeyResolver | undefined): void {
  keyResolver = r;
}

// Per address: a whole office signing in at 9am shares one address, so this is generous; the codes themselves are
// 256-bit random values and single-use, so the limit is about load and noise, not guessing.
function ssoLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.KS_SSO_CALLBACK_RATE_LIMIT ?? "") || 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKeyFromRequest,
    message: { ok: false, error: "rate_limited", message: "Too many sign-in attempts. Try again in a few minutes." },
  });
}
export const ssoCallbackLimiter = ssoLimiter();
const ssoExchangeLimiter = ssoLimiter();

function cookieValue(req: any, name: string): string {
  const parsed = req.cookies && typeof req.cookies[name] === "string" ? req.cookies[name] : null;
  if (parsed !== null) return parsed;
  const header = typeof req.headers?.cookie === "string" ? req.headers.cookie : "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ""; }
  }
  return "";
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

function back(params: Record<string, string>, fragment = false): string {
  const base = ssoReturnUrl();
  const q = new URLSearchParams(params).toString();
  if (fragment) return `${base}#${q}`;
  return base + (base.includes("?") ? "&" : "?") + q;
}

async function audit(req: any, success: boolean, provider: string, details: Record<string, unknown>, userId: string | null = null) {
  try {
    await recordAuditEvent({
      action: success ? "sso_sign_in" : "sso_sign_in_refused",
      actorUserId: userId,
      targetUserId: userId,
      targetType: "user",
      targetId: userId,
      ip: clientIpFromRequest(req) || null,
      userAgent: String(req.headers?.["user-agent"] ?? "").slice(0, 300) || null,
      success,
      metadata: { provider, ...details },
    });
  } catch (err) {
    console.error("[sso] audit write failed", { provider, success, message: (err as Error)?.message });
  }
}

export type SsoStaffUser = { id: string; role: string | null; active: boolean | null; disabled: boolean | null; deleted_at: unknown; status: string | null };

/** Why this user may not sign in, or null when they may. */
export function staffRefusal(user: SsoStaffUser | undefined): string | null {
  if (!user) return "no_user";
  if (!isStaffRole(user.role)) return "not_staff";
  if (user.active === false || user.disabled === true || user.deleted_at || String(user.status ?? "ACTIVE").toUpperCase() === "INACTIVE") return "user_inactive";
  return null;
}

export function mintStaffSessionToken(user: any, ksid?: string | null): string {
  const role = normalizeRole(user.role ?? "") ?? ROLES.STAFF;
  const userSilos = Array.isArray(user.silos) ? (user.silos as string[]) : [];
  const userSilo = user.silo as string | undefined;
  return signAccessToken({
    sub: String(user.id),
    role,
    tokenVersion: user.tokenVersion ?? 0,
    capabilities: fetchCapabilitiesForRole(role),
    ...(user.phoneNumber ? { phone: user.phoneNumber } : {}),
    ...(userSilo ? { silo: userSilo } : {}),
    ...(userSilos.length ? { silos: userSilos } : {}),
    ...(ksid ? { ksid } : {}), // KS_SETTINGS_PACK_v1_SECURITY - the signed-in session (single sign-on is strong)
  } as any);
}

router.get("/config", safeHandler(async (_req: any, res: any) => {
  const a = await loadSsoAvailability(db());
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    microsoft: a.providers.microsoft.available,
    google: a.providers.google.available,
    require_sso: a.require_sso,
  });
}));

router.get("/:provider/start", safeHandler(async (req: any, res: any) => {
  const provider = String(req.params.provider ?? "");
  if (!isSsoProvider(provider)) return res.status(404).json({ ok: false, error: "not_found" });
  const cfg = providerConfig(provider);
  const a = await loadSsoAvailability(db());
  if (!cfg || !a.providers[provider].available) return res.redirect(back({ sso_error: "sso_off" }));
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  await pool.query(
    `INSERT INTO sso_login_states (state_hash, provider, code_verifier, nonce, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [sha256Hex(state), provider, verifier, nonce, new Date(Date.now() + STATE_TTL_MS)],
  );
  await pool.query(`DELETE FROM sso_login_states WHERE expires_at < now() - interval '1 day'`)
    .catch((err: unknown) => logWarnSwallowed(err, "sso_login_states.prune"));
  res.cookie(STATE_COOKIE, state, { ...stateCookieOptions, maxAge: STATE_TTL_MS });
  res.setHeader("Cache-Control", "no-store");
  return res.redirect(buildAuthorizeUrl(cfg, {
    state, nonce, verifier,
    tenantRestriction: a.settings.microsoft_tenant_id || undefined,
    hostedDomain: a.settings.google_hosted_domain || undefined,
  }));
}));

router.get("/:provider/callback", ssoCallbackLimiter, safeHandler(async (req: any, res: any) => {
  const provider = String(req.params.provider ?? "");
  if (!isSsoProvider(provider)) return res.status(404).json({ ok: false, error: "not_found" });
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const cookieState = cookieValue(req, STATE_COOKIE);
  res.clearCookie(STATE_COOKIE, stateCookieOptions);
  res.setHeader("Cache-Control", "no-store");
  const refuse = async (reason: string, details: Record<string, unknown> = {}, userId: string | null = null) => {
    await audit(req, false, provider, { reason, ...details }, userId);
    return res.redirect(back({ sso_error: reason }));
  };

  if (typeof req.query.error === "string" && req.query.error) return refuse("provider_error", { provider_error: String(req.query.error).slice(0, 60) });
  const cfg = providerConfig(provider);
  const a = await loadSsoAvailability(db());
  if (!cfg || !a.providers[provider].available) return refuse("sso_off");
  if (!code || !state) return refuse("missing_code");
  if (!cookieState || !same(cookieState, state)) return refuse("state");
  const consumed = await pool.query(
    `UPDATE sso_login_states SET consumed_at = now()
      WHERE state_hash = $1 AND provider = $2 AND consumed_at IS NULL AND expires_at > now()
      RETURNING code_verifier, nonce`,
    [sha256Hex(state), provider],
  );
  const row = consumed.rows[0] as { code_verifier?: string; nonce?: string } | undefined;
  if (!row?.code_verifier || !row.nonce) return refuse("state");

  const tenantRestriction = a.settings.microsoft_tenant_id || undefined;
  let identity;
  try {
    const idToken = await exchangeCodeForIdToken(cfg, code, row.code_verifier, tenantRestriction);
    identity = await verifyIdToken(provider, idToken, {
      clientId: cfg.clientId,
      nonce: row.nonce,
      tenantRestriction,
      serverTenant: cfg.serverTenant ?? null,
      hostedDomain: a.settings.google_hosted_domain || undefined,
    }, keyResolver);
  } catch (err) {
    const reason = err instanceof SsoError ? err.reason : "bad_token";
    console.warn("[sso] sign-in refused", { provider, reason, message: (err as Error)?.message });
    return refuse(reason);
  }

  const users = await pool.query(
    `SELECT id::text AS id, role, active, disabled, deleted_at, status FROM users WHERE lower(email) = $1 LIMIT 2`,
    [identity.email],
  );
  const domain = identity.email.split("@")[1] ?? "";
  if (users.rows.length > 1) return refuse("ambiguous_email", { email: identity.email, email_domain: domain });
  const user = users.rows[0] as SsoStaffUser | undefined;
  const why = staffRefusal(user);
  if (why) return refuse(why, { email: identity.email, email_domain: domain }, user?.id ?? null);

  const handoff = randomToken();
  await pool.query(
    `INSERT INTO sso_login_handoffs (code_hash, user_id, provider, expires_at) VALUES ($1, $2, $3, $4)`,
    [sha256Hex(handoff), user!.id, provider, new Date(Date.now() + HANDOFF_TTL_MS)],
  );
  await pool.query(`DELETE FROM sso_login_handoffs WHERE expires_at < now() - interval '1 day'`)
    .catch((err: unknown) => logWarnSwallowed(err, "sso_login_handoffs.prune"));
  const plan = checkFeature(await getPlanState(db()), "sso");
  if (plan.allowed && plan.viaTrial) await recordTrialUsage(db(), "sso");
  await audit(req, true, provider, { email: identity.email, tenant_id: identity.tenantId, hosted_domain: identity.hostedDomain }, user!.id);
  return res.redirect(back({ sso_code: handoff }, true));
}));

router.post("/exchange", ssoExchangeLimiter, safeHandler(async (req: any, res: any) => {
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  res.setHeader("Cache-Control", "no-store");
  if (!code) return res.status(400).json({ ok: false, error: "code_required" });
  const consumed = await pool.query(
    `UPDATE sso_login_handoffs SET consumed_at = now()
      WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING user_id, provider`,
    [sha256Hex(code)],
  );
  const row = consumed.rows[0] as { user_id?: string; provider?: string } | undefined;
  if (!row?.user_id) return res.status(401).json({ ok: false, error: "sso_code_invalid", message: "That sign-in link has expired. Please sign in again." });
  // Re-checked here: the user could have been switched off in the seconds since the callback.
  const check = await pool.query(
    `SELECT id::text AS id, role, active, disabled, deleted_at, status FROM users WHERE id::text = $1 LIMIT 1`,
    [row.user_id],
  );
  const user: any = await findAuthUserById(row.user_id);
  const why = staffRefusal(check.rows[0] as SsoStaffUser | undefined) ?? (user ? null : "no_user");
  if (why) {
    await audit(req, false, String(row.provider ?? ""), { reason: why, stage: "exchange" }, row.user_id);
    return res.status(403).json({ ok: false, error: "user_inactive", message: "This account can't sign in. Ask an admin." });
  }
  // KS_SETTINGS_PACK_v1_SECURITY - a single sign-on session, listed under Security and strong for the two-step switch.
  const { openSession } = await import("../security/sessions.js");
  const fwd = String(req.headers?.["x-forwarded-for"] ?? "").split(",")[0]?.trim();
  const ksid = await openSession(db() as any, { userId: String(user.id), method: "sso", ip: fwd || req.ip || null, userAgent: String(req.headers?.["user-agent"] ?? "") });
  return res.status(200).json({ status: "ok", data: { token: mintStaffSessionToken(user, ksid) } });
}));

export type { SsoProvider };
export default router;
