// KS_SERVER_v13_QUICKBOOKS - /api/quickbooks: the licensee's QuickBooks Online connection and fee invoices.
//   GET  /api/quickbooks/status                          (Admin)  configured? connected? company, tax code
//   POST /api/quickbooks/connect                         (Admin)  returns { url } of Intuit's consent screen
//   GET  /api/quickbooks/oauth/callback                  (public) Intuit redirects here with ?code&state&realmId
//   POST /api/quickbooks/disconnect                      (Admin)  revokes at Intuit and forgets the tokens
//   GET  /api/quickbooks/tax-codes                       (Admin)  the company's active tax codes (for the setting)
//   PUT  /api/quickbooks/settings                        (Admin)  { taxCodeId | null } tax code on fee invoice lines
//   GET  /api/quickbooks/applications/:id/invoice        (Staff)  the application's fee invoice
//   POST /api/quickbooks/applications/:id/invoice/retry  (Staff)  queue the invoice work again and run it now
// The state is a random single-use nonce (hashed in quickbooks_oauth_states, 10 minutes) bound to the admin who
// started the connect, also held in an HttpOnly cookie scoped to the callback (checked when the browser sends it).
import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { qboConfig, qboConfigProblem, qboEnvironment } from "../services/quickbooks/qboConfig.js";
import {
  STATE_TTL_MS, buildAuthUrl, disconnectQbo, exchangeCode, fetchCompanyName, getQboClient, newNonce, nonceHash, qboStatus, saveConnection,
} from "../services/quickbooks/qboAuth.js";
import { enqueueQuickBooksSync, invoiceForApplication, processInvoiceJob } from "../services/quickbooks/feeInvoice.js";

const router = Router();
const STATE_COOKIE = "qbo_oauth_nonce";
const COOKIE_PATH = "/api/quickbooks/oauth";
const stateCookieOptions = { httpOnly: true, secure: true, sameSite: "lax" as const, path: COOKIE_PATH };
const adminOnly = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] })];

function uidOf(req: any): string {
  return String(req.user?.userId ?? req.user?.id ?? req.user?.sub ?? "");
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
  const q = `quickbooks=${outcome}${reason ? `&reason=${encodeURIComponent(reason)}` : ""}`;
  return returnUrl + (returnUrl.includes("?") ? "&" : "?") + q;
}

router.get("/status", ...adminOnly, safeHandler(async (_req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await qboStatus(pool, qboConfigProblem(), qboEnvironment()));
}));

router.post("/connect", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const userId = uidOf(req);
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const cfg = qboConfig();
  if (!cfg) return res.status(503).json({ error: "quickbooks_not_configured", reason: qboConfigProblem() });
  const nonce = newNonce();
  await pool.query(
    `INSERT INTO quickbooks_oauth_states (nonce_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
    [nonceHash(nonce), userId, new Date(Date.now() + STATE_TTL_MS)],
  );
  await pool.query(`DELETE FROM quickbooks_oauth_states WHERE expires_at < now() - interval '1 day'`)
    .catch((err: unknown) => logWarnSwallowed(err, "quickbooks_oauth_states.prune"));
  res.cookie(STATE_COOKIE, nonce, { ...stateCookieOptions, maxAge: STATE_TTL_MS });
  res.json({ url: buildAuthUrl(cfg, nonce) });
}));

router.get("/oauth/callback", safeHandler(async (req: any, res: any) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const realmId = typeof req.query.realmId === "string" ? req.query.realmId.trim() : "";
  const cookieNonce = cookieValue(req, STATE_COOKIE);
  res.clearCookie(STATE_COOKIE, stateCookieOptions);
  const cfg = qboConfig();
  if (!cfg) return res.status(503).send("QuickBooks is not set up on this server.");
  if (typeof req.query.error === "string" && req.query.error) return res.redirect(back(cfg.returnUrl, "error", String(req.query.error).slice(0, 60)));
  if (!code || !state || !realmId) return res.redirect(back(cfg.returnUrl, "error", "missing_code"));
  // The portal and server are often on different sites, where browsers drop a cookie set by a fetch response. The
  // state alone is enough: it is unguessable, single-use, expires in 10 minutes and can only be made by an admin of
  // this licensee. When the cookie did arrive it must match.
  if (cookieNonce && !sameNonce(cookieNonce, state)) {
    console.warn("quickbooks_oauth_state_cookie_mismatch");
    return res.redirect(back(cfg.returnUrl, "error", "state"));
  }
  const consumed = await pool.query(
    `UPDATE quickbooks_oauth_states SET consumed_at = now()
      WHERE nonce_hash = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [nonceHash(state)],
  );
  const userId = (consumed.rows[0] as { user_id?: string } | undefined)?.user_id;
  if (!userId) {
    console.warn("quickbooks_oauth_state_invalid", { reason: "unknown_used_or_expired" });
    return res.redirect(back(cfg.returnUrl, "error", "state"));
  }
  let tokens;
  try {
    tokens = await exchangeCode(cfg, code);
  } catch (err) {
    console.error("quickbooks_oauth_exchange_failed", { message: (err as Error)?.message });
    return res.redirect(back(cfg.returnUrl, "error", "exchange"));
  }
  const companyName = await fetchCompanyName(cfg, realmId, tokens.accessToken);
  await saveConnection(pool, realmId, tokens, userId, cfg.environment, companyName);
  console.info({ event: "quickbooks_connected", realmId, environment: cfg.environment, userId });
  return res.redirect(back(cfg.returnUrl, "connected"));
}));

router.post("/disconnect", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const r = await disconnectQbo(pool, qboConfig());
  console.info({ event: "quickbooks_disconnected", userId: uidOf(req), revoked: r.revoked });
  res.json({ ok: true, connected: false, revoked: r.revoked });
}));

router.get("/tax-codes", ...adminOnly, safeHandler(async (_req: any, res: any) => {
  const q = await getQboClient(pool);
  if (!q) return res.status(409).json({ error: "quickbooks_not_connected" });
  const rows = await q.query<{ Id: string; Name: string; Description?: string }>(`select Id, Name, Description from TaxCode where Active = true maxresults 200`);
  res.json({ taxCodes: rows.map((t) => ({ id: String(t.Id), name: String(t.Name ?? ""), description: t.Description ?? null })) });
}));

router.put("/settings", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const raw = req.body?.taxCodeId;
  const taxCodeId = raw === null || raw === undefined || String(raw).trim() === "" ? null : String(raw).trim().slice(0, 40);
  const taxCodeName = taxCodeId && typeof req.body?.taxCodeName === "string" ? req.body.taxCodeName.trim().slice(0, 100) : null;
  const r = await pool.query(
    `UPDATE quickbooks_connection SET tax_code_id = $1, tax_code_name = $2, updated_at = now() WHERE id = 1`,
    [taxCodeId, taxCodeName],
  );
  if (!r.rowCount) return res.status(409).json({ error: "quickbooks_not_connected" });
  res.json(await qboStatus(pool, qboConfigProblem(), qboEnvironment()));
}));

router.get("/applications/:id/invoice", ...staff, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "").trim();
  if (!id) return res.status(400).json({ error: "application_id_required" });
  res.setHeader("Cache-Control", "no-store");
  res.json(await invoiceForApplication(pool, id));
}));

router.post("/applications/:id/invoice/retry", ...staff, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "").trim();
  if (!id) return res.status(400).json({ error: "application_id_required" });
  if (qboConfigProblem()) return res.status(503).json({ error: "quickbooks_not_configured", reason: qboConfigProblem() });
  const queued = await enqueueQuickBooksSync(pool, id, "manual_retry");
  if (!queued) return res.status(409).json({ error: "not_queued", message: "QuickBooks is not connected, or this invoice is already paid." });
  const result = await processInvoiceJob(pool, id);
  res.json({ ok: true, result, ...(await invoiceForApplication(pool, id)) });
}));

export default router;
