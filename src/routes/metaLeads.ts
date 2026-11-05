// KS_META_LEAD_ADS_v1 - Facebook and Instagram lead ads.
//   Admin (mounted at /api/integrations/meta):
//     GET    /status               settings present? connected Pages
//     GET    /start                { url } of Facebook's consent screen (sets the nonce cookie)
//     GET    /callback             (public) Facebook redirects here, directly or through Keystone's broker
//     PATCH  /pages/:pageId        { active?, tag? }
//     DELETE /pages/:pageId        forget the Page (no more leads)
//   Webhook (mounted at /api/webhooks/meta, public):
//     GET    /leadgen              Meta's subscription check (hub.verify_token)
//     POST   /leadgen              lead events (X-Hub-Signature-256 checked)
import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { postToOps } from "../plans/opsLink.js";
import { unwrapState, wrapState } from "../licensee/oauthBroker.js";
import {
  STATE_TTL_MS, authUrl, exchangeForPages, handleLead, leadEvents, metaConfig, missingSettings, newNonce, nonceHash,
  savePages, signatureValid, subscribePage,
} from "../metaLeads/meta.js";

export const metaIntegrationRoutes = Router();
export const metaWebhookRoutes = Router();
const admin = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const STATE_COOKIE = "meta_oauth_nonce";
const cookieOpts = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/api/integrations/meta" };

function back(url: string, outcome: "connected" | "error", reason?: string): string {
  return url + (url.includes("?") ? "&" : "?") + `meta=${outcome}${reason ? `&reason=${encodeURIComponent(reason)}` : ""}`;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

metaIntegrationRoutes.get("/status", ...admin, safeHandler(async (_req: any, res: any) => {
  const { rows } = await pool.query(
    `SELECT page_id, page_name, active, tag, leads, last_lead_at, connected_at FROM meta_lead_pages
      WHERE disconnected_at IS NULL ORDER BY page_name`);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, configured: Boolean(metaConfig()), missing: missingSettings(), pages: rows });
}));

metaIntegrationRoutes.get("/start", ...admin, safeHandler(async (req: any, res: any) => {
  const cfg = metaConfig();
  if (!cfg) return res.status(503).json({ error: "meta_not_configured", missing: missingSettings() });
  const nonce = newNonce();
  await pool.query(`INSERT INTO meta_oauth_states (nonce_hash, user_id, expires_at) VALUES ($1, $2::uuid, $3)`,
    [nonceHash(nonce), String(req.user?.userId ?? req.user?.id ?? ""), new Date(Date.now() + STATE_TTL_MS)]);
  await pool.query(`DELETE FROM meta_oauth_states WHERE expires_at < now() - interval '1 day'`)
    .catch((err: unknown) => logWarnSwallowed(err, "meta_oauth_states.prune"));
  res.cookie(STATE_COOKIE, nonce, { ...cookieOpts, maxAge: STATE_TTL_MS });
  res.json({ url: authUrl(cfg, wrapState("meta", nonce, STATE_TTL_MS)) });
}));

metaIntegrationRoutes.get("/callback", safeHandler(async (req: any, res: any) => {
  const cfg = metaConfig();
  if (!cfg) return res.status(503).send("Facebook lead ads are not set up on this server.");
  const state = unwrapState("meta", typeof req.query.state === "string" ? req.query.state : "") ?? "";
  const cookieNonce = String(req.cookies?.[STATE_COOKIE] ?? "");
  res.clearCookie(STATE_COOKIE, cookieOpts);
  if (typeof req.query.error === "string" && req.query.error) return res.redirect(back(cfg.returnUrl, "error", String(req.query.error).slice(0, 60)));
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code || !state || !cookieNonce || !same(cookieNonce, state)) return res.redirect(back(cfg.returnUrl, "error", "state"));
  const used = await pool.query(
    `UPDATE meta_oauth_states SET consumed_at = now() WHERE nonce_hash = $1 AND consumed_at IS NULL AND expires_at > now()
     RETURNING user_id::text AS user_id`, [nonceHash(state)]);
  const userId = used.rows[0]?.user_id as string | undefined;
  if (!userId) return res.redirect(back(cfg.returnUrl, "error", "state"));
  let pages;
  try {
    pages = await exchangeForPages(cfg, code);
  } catch (err) {
    console.error("meta_oauth_exchange_failed", { message: (err as Error)?.message });
    return res.redirect(back(cfg.returnUrl, "error", "exchange"));
  }
  if (!pages.length) return res.redirect(back(cfg.returnUrl, "error", "no_pages"));
  const subscribed: string[] = [];
  for (const p of pages) {
    try { await subscribePage(p.id, p.access_token); subscribed.push(p.id); } catch (err) {
      console.warn("meta_page_subscribe_failed", { pageId: p.id, message: (err as Error)?.message });
    }
  }
  await savePages(pool as any, pages.filter((p) => subscribed.includes(p.id)), userId);
  // Keystone: tell KS-Ops these Pages are ours, so it passes their lead webhooks here.
  const ops = await postToOps("meta-pages", { page_ids: subscribed });
  if (!ops.ok && ops.error !== "ops_not_configured") console.warn("meta_pages_ops_register_failed", { error: ops.error });
  return res.redirect(back(cfg.returnUrl, subscribed.length ? "connected" : "error", subscribed.length ? undefined : "subscribe"));
}));

metaIntegrationRoutes.patch("/pages/:pageId", ...admin, safeHandler(async (req: any, res: any) => {
  const b = req.body ?? {};
  const tag = typeof b.tag === "string" ? b.tag.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 40) || null : undefined;
  const { rows } = await pool.query(
    `UPDATE meta_lead_pages SET active = COALESCE($2, active), tag = CASE WHEN $3::boolean THEN $4 ELSE tag END
      WHERE page_id = $1 AND disconnected_at IS NULL RETURNING page_id, page_name, active, tag, leads, last_lead_at`,
    [String(req.params.pageId), typeof b.active === "boolean" ? b.active : null, tag !== undefined, tag ?? null]);
  if (!rows[0]) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true, page: rows[0] });
}));

metaIntegrationRoutes.delete("/pages/:pageId", ...admin, safeHandler(async (req: any, res: any) => {
  const { rows } = await pool.query(
    `UPDATE meta_lead_pages SET disconnected_at = now(), active = false, page_token_enc = '' WHERE page_id = $1 AND disconnected_at IS NULL RETURNING page_id`,
    [String(req.params.pageId)]);
  if (!rows[0]) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
}));

metaWebhookRoutes.get("/leadgen", (req: any, res: any) => {
  const want = String(process.env.META_WEBHOOK_VERIFY_TOKEN ?? "");
  const got = String(req.query["hub.verify_token"] ?? "");
  if (req.query["hub.mode"] === "subscribe" && want && same(want, got)) return res.status(200).type("text/plain").send(String(req.query["hub.challenge"] ?? ""));
  return res.sendStatus(403);
});

metaWebhookRoutes.post("/leadgen", safeHandler(async (req: any, res: any) => {
  const secret = String(process.env.META_APP_SECRET ?? "");
  if (!signatureValid(req.rawBody, req.headers?.["x-hub-signature-256"], secret)) {
    console.warn("meta_webhook_bad_signature");
    return res.sendStatus(401);
  }
  let failed = 0;
  for (const ev of leadEvents(req.body)) {
    try {
      const outcome = await handleLead(pool as any, ev);
      console.log(JSON.stringify({ event: "meta_lead", leadgenId: ev.leadgenId, pageId: ev.pageId, outcome }));
    } catch (err) {
      failed += 1;
      console.error("meta_lead_failed", { leadgenId: ev.leadgenId, pageId: ev.pageId, message: (err as Error)?.message });
    }
  }
  // A failure answers 500 so Meta sends it again; leads already handled are skipped on the retry.
  return res.sendStatus(failed ? 500 : 200);
}));
