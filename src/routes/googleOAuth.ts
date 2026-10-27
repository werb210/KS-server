// KS_SERVER_v12_GOOGLE_WORKSPACE - /api/google: connect, status and disconnect for a staff member's Google account.
//   GET  /api/google/status            (auth)   configured? connected? which scopes? read switch on?
//   GET  /api/google/oauth/start       (auth)   returns { url } of Google's consent screen; sets the nonce cookie
//   GET  /api/google/oauth/callback    (public) Google redirects here with ?code&state
//   POST /api/google/oauth/disconnect  (auth)   revokes the grant at Google and forgets the tokens
// The state is a random single-use nonce bound to the user (hashed in google_oauth_states with the PKCE verifier)
// and held in an HttpOnly/Secure/SameSite=Lax cookie, exactly like the Microsoft connect (routes/o365OAuth.ts).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { gmailReadEnabled, googleConfigProblem, googleOAuthConfig } from "../services/workspace/googleConfig.js";
import {
  STATE_TTL_MS, buildAuthUrl, disconnectGoogle, exchangeCode, fetchGoogleIdentity, googleStatusForUser,
  newCodeVerifier, nonceHash, saveGoogleAccount,
} from "../services/workspace/googleAuth.js";
import { unwrapState, wrapState } from "../licensee/oauthBroker.js"; // KS_SERVER_M365_ONE_CLICK

const router = Router();
const STATE_COOKIE = "google_oauth_nonce";
const COOKIE_PATH = "/api/google/oauth";
const stateCookieOptions = { httpOnly: true, secure: true, sameSite: "lax" as const, path: COOKIE_PATH };

function uidOf(req: any): string {
  return String(req.user?.id ?? req.user?.userId ?? req.user?.sub ?? "");
}

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

function sameNonce(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

function back(returnUrl: string, outcome: "connected" | "error", reason?: string): string {
  const q = `google=${outcome}${reason ? `&reason=${encodeURIComponent(reason)}` : ""}`;
  return returnUrl + (returnUrl.includes("?") ? "&" : "?") + q;
}

router.get("/status", requireAuth, safeHandler(async (req: any, res: any) => {
  const userId = uidOf(req);
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  res.setHeader("Cache-Control", "no-store");
  res.json(await googleStatusForUser(pool, userId, googleConfigProblem(), gmailReadEnabled()));
}));

router.get("/oauth/start", requireAuth, safeHandler(async (req: any, res: any) => {
  const userId = uidOf(req);
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const cfg = googleOAuthConfig();
  if (!cfg) return res.status(503).json({ error: "google_oauth_not_configured", reason: googleConfigProblem() });
  const nonce = randomBytes(32).toString("base64url");
  const verifier = newCodeVerifier();
  await pool.query(
    `INSERT INTO google_oauth_states (nonce_hash, user_id, code_verifier, expires_at) VALUES ($1, $2, $3, $4)`,
    [nonceHash(nonce), userId, verifier, new Date(Date.now() + STATE_TTL_MS)],
  );
  await pool.query(`DELETE FROM google_oauth_states WHERE expires_at < now() - interval '1 day'`)
    .catch((err: unknown) => logWarnSwallowed(err, "google_oauth_states.prune"));
  res.cookie(STATE_COOKIE, nonce, { ...stateCookieOptions, maxAge: STATE_TTL_MS });
  const hint = typeof req.query.login_hint === "string" ? req.query.login_hint : null;
  res.json({ url: buildAuthUrl(cfg, wrapState("google", nonce, STATE_TTL_MS), verifier, { loginHint: hint }) });
}));

router.get("/oauth/callback", safeHandler(async (req: any, res: any) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  // KS_SERVER_M365_ONE_CLICK - a state that came through Keystone's redirect broker is unwrapped (HMAC checked).
  const state = unwrapState("google", typeof req.query.state === "string" ? req.query.state : "") ?? "";
  const cookieNonce = cookieValue(req, STATE_COOKIE);
  res.clearCookie(STATE_COOKIE, stateCookieOptions);
  const cfg = googleOAuthConfig();
  if (!cfg) return res.status(503).send("Google Workspace is not set up on this server.");
  if (typeof req.query.error === "string" && req.query.error) return res.redirect(back(cfg.returnUrl, "error", String(req.query.error).slice(0, 60)));
  if (!code || !state) return res.redirect(back(cfg.returnUrl, "error", "missing_code"));
  if (!cookieNonce || !sameNonce(cookieNonce, state)) {
    console.warn("google_oauth_state_cookie_mismatch", { hasCookie: Boolean(cookieNonce) });
    return res.redirect(back(cfg.returnUrl, "error", "state"));
  }
  const consumed = await pool.query(
    `UPDATE google_oauth_states SET consumed_at = now()
      WHERE nonce_hash = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING user_id::text AS user_id, code_verifier`,
    [nonceHash(state)],
  );
  const row = consumed.rows[0] as { user_id?: string; code_verifier?: string } | undefined;
  if (!row?.user_id || !row.code_verifier) {
    console.warn("google_oauth_state_invalid", { reason: "unknown_used_or_expired" });
    return res.redirect(back(cfg.returnUrl, "error", "state"));
  }
  let tokens;
  try {
    tokens = await exchangeCode(cfg, code, row.code_verifier);
  } catch (err) {
    console.error("google_oauth_exchange_failed", { message: (err as Error)?.message });
    return res.redirect(back(cfg.returnUrl, "error", "exchange"));
  }
  const identity = await fetchGoogleIdentity(tokens.accessToken);
  await saveGoogleAccount(pool, row.user_id, tokens, identity);
  return res.redirect(back(cfg.returnUrl, "connected"));
}));

router.post("/oauth/disconnect", requireAuth, safeHandler(async (req: any, res: any) => {
  const userId = uidOf(req);
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const r = await disconnectGoogle(pool, userId);
  res.json({ ok: true, connected: false, revoked: r.revoked });
}));

export default router;
