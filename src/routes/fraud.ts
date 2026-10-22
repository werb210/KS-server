// KS_SERVER_v9_FRAUD - the fraud-protection API for the staff portal.
//   GET  /api/fraud/applications/:id              Admin, Staff: every check (locked ones marked), per-document badges, score
//   POST /api/fraud/applications/:id/run          Admin, Staff: run the checks again now (202)
//   GET  /api/fraud/applications/:id/network      pro (fraud_12): the network graph (masked labels)
//   GET  /api/fraud/applications/:id/prescreen    pro (fraud_16): the pre-screen summary text
//   PUT  /api/fraud/applications/:id/prescreen    pro (fraud_16): { include_in_package: boolean }
//   PUT  /api/fraud/applications/:id/bank-link    pro (fraud_3): { login_id } from Flinks Connect; DELETE removes it
//   GET  /api/fraud/settings                      Admin: watchlist opt-in, pre-screen default, which services are set up
//   PUT  /api/fraud/settings                      Admin: { watchlist_opt_in?, include_prescreen_in_package? }
//   GET  /api/fraud/staff-alerts                  Admin, pro (fraud_14): recent inside-job events
// Locked checks answer 402 feature_not_in_plan on the gated routes; the overview GET never 402s (it marks them).
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { requireFeature } from "../plans/requireFeature.js";
import { checkFeature, featureDef } from "../plans/catalogue.js";
import { getPlanState, type Q } from "../plans/state.js";
import { FRAUD_CHECKS } from "../fraud/catalogue.js";
import { allowedChecks, enqueueFraudRun, getFraudSettings, listResults, queueStatus, saveFraudSettings } from "../fraud/store.js";
import { computeScore, prescreenText } from "../fraud/score.js";
import { buildNetwork, loadProfile } from "../fraud/engine.js";
import { fraudProviders, providerStatus } from "../fraud/providers/index.js";
import { watchlistReady } from "../fraud/watchlist.js";
import { postToOps } from "../plans/opsLink.js";
import { brandName } from "../licensee/brand.js";

const router = Router();
const db = () => pool as unknown as Q;
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] })];
const admin = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const userIdOf = (req: any) => String(req.user?.userId ?? req.user?.id ?? req.user?.sub ?? "");

async function appExists(id: string): Promise<{ id: string; name: string | null; include: boolean | null } | null> {
  const r = await db().query(`SELECT id::text AS id, COALESCE(business_legal_name, name) AS name, fraud_prescreen_in_package AS include FROM applications WHERE id::text = $1 LIMIT 1`, [id]);
  return r.rows[0] ?? null;
}

/** The 402 body requireFeature sends, for gates decided inside a handler. */
async function refusal(key: string): Promise<Record<string, unknown> | null> {
  const now = new Date();
  const c = checkFeature(await getPlanState(db(), now.getTime()), key, now);
  return c.allowed ? null : { ok: false, error: "feature_not_in_plan", feature: key, required_plan: c.required_plan, trial_available: c.trial_available };
}

router.get("/applications/:id", ...staff, safeHandler(async (req: any, res) => {
  res.setHeader("Cache-Control", "no-store");
  const app = await appExists(String(req.params.id));
  if (!app) return res.status(404).json({ ok: false, error: "not_found" });
  const allowed = await allowedChecks(db());
  const rows = await listResults(db(), app.id);
  const docs = await db().query(
    `SELECT id::text AS id, COALESCE(display_name, filename, title) AS filename, COALESCE(category, document_type) AS category
       FROM documents WHERE application_id::text = $1 ORDER BY created_at ASC`,
    [app.id],
  );
  const checks = FRAUD_CHECKS.map((c) => {
    const locked = !allowed.has(c.key);
    const mine = rows.filter((r) => r.check_key === c.key && r.subject === "");
    const r = mine[0];
    return {
      key: c.key, label: c.label, description: c.description, scope: c.scope, plan: featureDef(c.key)?.plan ?? "pro", locked,
      ...(locked ? { status: "locked" } : r ? { status: r.status, reasons: r.reasons, checked_at: r.checked_at, provider: r.provider } : { status: c.scope === "document" ? "per_document" : "pending" }),
    };
  });
  const documents = docs.rows.map((d: any) => {
    const tamper = allowed.has("fraud_1") ? rows.find((r) => r.check_key === "fraud_1" && r.subject === d.id) : undefined;
    const math = allowed.has("fraud_2") ? rows.find((r) => r.check_key === "fraud_2" && r.subject === d.id) : undefined;
    return {
      document_id: d.id, filename: d.filename, category: d.category,
      tamper: tamper ? { status: tamper.status, reasons: tamper.reasons, checked_at: tamper.checked_at } : null,
      statement_math: math ? { status: math.status, reasons: math.reasons, checked_at: math.checked_at } : null,
    };
  });
  const score = allowed.has("fraud_16") ? computeScore(rows, allowed) : null;
  return res.json({
    ok: true, application_id: app.id, checks, documents, score,
    include_prescreen_in_package: app.include ?? (await getFraudSettings(db())).include_prescreen_in_package,
    queue: await queueStatus(db(), app.id),
  });
}));

router.post("/applications/:id/run", ...staff, safeHandler(async (req: any, res) => {
  const app = await appExists(String(req.params.id));
  if (!app) return res.status(404).json({ ok: false, error: "not_found" });
  await enqueueFraudRun(db(), app.id, "staff_request");
  return res.status(202).json({ ok: true, queued: true });
}));

router.get("/applications/:id/network", ...staff, requireFeature("fraud_12"), safeHandler(async (req: any, res) => {
  res.setHeader("Cache-Control", "no-store");
  const p = await loadProfile(db(), String(req.params.id));
  if (!p) return res.status(404).json({ ok: false, error: "not_found" });
  return res.json({ ok: true, network: await buildNetwork(db(), p) });
}));

router.get("/applications/:id/prescreen", ...staff, requireFeature("fraud_16"), safeHandler(async (req: any, res) => {
  res.setHeader("Cache-Control", "no-store");
  const app = await appExists(String(req.params.id));
  if (!app) return res.status(404).json({ ok: false, error: "not_found" });
  const allowed = await allowedChecks(db());
  const s = computeScore(await listResults(db(), app.id), allowed);
  const include = app.include ?? (await getFraudSettings(db())).include_prescreen_in_package;
  return res.json({ ok: true, score: s, include_in_package: include, lines: prescreenText(s, { company: brandName(), applicationName: app.name, at: new Date() }) });
}));

router.put("/applications/:id/prescreen", ...staff, requireFeature("fraud_16"), safeHandler(async (req: any, res) => {
  if (typeof req.body?.include_in_package !== "boolean") return res.status(400).json({ ok: false, error: "include_in_package must be true or false" });
  const r = await db().query(`UPDATE applications SET fraud_prescreen_in_package = $2 WHERE id::text = $1 RETURNING id`, [String(req.params.id), req.body.include_in_package]);
  if (!r.rows.length) return res.status(404).json({ ok: false, error: "not_found" });
  return res.json({ ok: true, include_in_package: req.body.include_in_package });
}));

router.put("/applications/:id/bank-link", ...staff, requireFeature("fraud_3"), safeHandler(async (req: any, res) => {
  const loginId = String(req.body?.login_id ?? "").trim();
  if (!/^[A-Za-z0-9-]{8,80}$/.test(loginId)) return res.status(400).json({ ok: false, error: "login_id must be the Flinks LoginId" });
  const app = await appExists(String(req.params.id));
  if (!app) return res.status(404).json({ ok: false, error: "not_found" });
  await db().query(
    `INSERT INTO fraud_bank_links (application_id, provider, login_id, created_by) VALUES ($1, 'flinks', $2, $3)
     ON CONFLICT (application_id) DO UPDATE SET login_id = EXCLUDED.login_id, created_by = EXCLUDED.created_by, created_at = now()`,
    [app.id, loginId, userIdOf(req)],
  );
  await enqueueFraudRun(db(), app.id, "bank_link");
  return res.json({ ok: true });
}));

router.delete("/applications/:id/bank-link", ...staff, requireFeature("fraud_3"), safeHandler(async (req: any, res) => {
  await db().query(`DELETE FROM fraud_bank_links WHERE application_id = $1`, [String(req.params.id)]);
  return res.json({ ok: true });
}));

router.get("/settings", ...admin, safeHandler(async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const allowed = await allowedChecks(db());
  return res.json({
    ok: true,
    settings: await getFraudSettings(db()),
    watchlist: { available: allowed.has("fraud_13"), ready: watchlistReady().ok, why: watchlistReady().ok ? null : (watchlistReady() as { why: string }).why },
    services: providerStatus(fraudProviders()),
    allowed: [...allowed],
  });
}));

router.put("/settings", ...admin, safeHandler(async (req: any, res) => {
  const b = req.body ?? {};
  const patch: { watchlist_opt_in?: boolean; include_prescreen_in_package?: boolean } = {};
  if (b.watchlist_opt_in !== undefined) {
    if (typeof b.watchlist_opt_in !== "boolean") return res.status(400).json({ ok: false, error: "watchlist_opt_in must be true or false" });
    if (b.watchlist_opt_in) { const no = await refusal("fraud_13"); if (no) return res.status(402).json(no); }
    patch.watchlist_opt_in = b.watchlist_opt_in;
  }
  if (b.include_prescreen_in_package !== undefined) {
    if (typeof b.include_prescreen_in_package !== "boolean") return res.status(400).json({ ok: false, error: "include_prescreen_in_package must be true or false" });
    if (b.include_prescreen_in_package) { const no = await refusal("fraud_16"); if (no) return res.status(402).json(no); }
    patch.include_prescreen_in_package = b.include_prescreen_in_package;
  }
  const before = await getFraudSettings(db());
  const settings = await saveFraudSettings(db(), patch, userIdOf(req));
  let ops: { told: boolean; error: string | null } = { told: false, error: null };
  if (patch.watchlist_opt_in !== undefined && patch.watchlist_opt_in !== before.watchlist_opt_in) {
    // Opting out also asks Keystone operations to delete every hash this brokerage shared.
    const r = await postToOps("watchlist/opt-in", { opt_in: patch.watchlist_opt_in });
    ops = { told: r.ok, error: r.ok ? null : r.error };
    if (!r.ok) console.warn("[fraud] watchlist opt-in change not delivered to operations", { error: r.error });
    if (r.ok && !patch.watchlist_opt_in) await db().query(`UPDATE fraud_watchlist_shares SET withdrawn_at = now() WHERE withdrawn_at IS NULL`, []);
  }
  return res.json({ ok: true, settings, ops });
}));

router.get("/staff-alerts", ...admin, requireFeature("fraud_14"), safeHandler(async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const r = await db().query(
    `SELECT e.id, e.kind, e.severity, e.application_id, e.detail, e.created_at, e.alerted_at,
            COALESCE(NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email) AS staff_name
       FROM staff_risk_events e LEFT JOIN users u ON u.id::text = e.user_id
      WHERE e.severity IN ('amber', 'red') ORDER BY e.created_at DESC LIMIT 100`,
    [],
  );
  return res.json({ ok: true, alerts: r.rows });
}));

export default router;
