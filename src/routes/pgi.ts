// KS_SERVER_v11_PGI - Personal Guarantee Insurance referrals to the insurance partner. On every plan.
//   PUT  /api/pgi/link                              operations only (X-KS-Ops-Key = KS_OPS_KEY):
//                                                   { bi_server_url, referral_source_id, api_key, callback_secret }
//   GET  /api/pgi/link                              Admin: { configured, referral_source_id, partner_host, updated_at }
//   POST /api/pgi/bi-events                         the partner (HMAC-signed callback): messages, document requests,
//                                                   reminders, status updates
//   GET  /api/pgi/referrals                         Admin, Staff: every referral with status, missing count, unread, fee
//   GET  /api/pgi/referrals/:applicationId          Admin, Staff: checklist mapped onto the file, fields, thread
//   POST /api/pgi/referrals/:applicationId          Admin, Staff: turn PGI on for an application (refer it now)
//   PATCH /api/pgi/referrals/:applicationId         Admin, Staff: fill in fields the insurer needs (sent again)
//   POST /api/pgi/referrals/:applicationId/sync     Admin, Staff: send new documents and refresh from the partner
//   POST /api/pgi/referrals/:applicationId/messages Admin, Staff: { body } reply to the partner
//   POST /api/pgi/referrals/:applicationId/read     Admin, Staff: mark the partner's messages read
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import type { Q } from "../plans/state.js";
import { opsKeyMatches } from "./plan.js";
import { getPartnerLink, savePartnerLink, validateLink, verifyCallback } from "../pgi/link.js";
import { cleanInputPatch } from "../pgi/checklist.js";
import {
  getReferral, handlePartnerEvent, referralView, sendMessageToPartner, startReferral, syncReferral, updateReferralInput,
} from "../pgi/service.js";

const router = Router();
const db = () => pool as unknown as Q;
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] })];
const admin = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const userIdOf = (req: any) => String(req.user?.userId ?? req.user?.id ?? req.user?.sub ?? "") || null;

router.put("/link", safeHandler(async (req: any, res) => {
  if (!String(process.env.KS_OPS_KEY ?? "")) return res.status(403).json({ ok: false, error: "ops_link_disabled" });
  if (!opsKeyMatches(req.headers["x-ks-ops-key"])) return res.status(401).json({ ok: false, error: "invalid_ops_key" });
  const v = validateLink(req.body ?? {});
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
  await savePartnerLink(db(), v.value, String(req.headers["x-ks-ops-user"] ?? "ops").slice(0, 120));
  return res.json({ ok: true, configured: true, referral_source_id: v.value.referralSourceId });
}));

router.get("/link", ...admin, safeHandler(async (_req, res) => {
  const r = await db().query(`SELECT bi_server_url, referral_source_id, updated_at FROM pgi_partner_link WHERE id = 1`);
  const row = r.rows[0];
  res.setHeader("Cache-Control", "no-store");
  return res.json({
    configured: Boolean(row),
    referral_source_id: row?.referral_source_id ?? null,
    partner_host: row ? new URL(String(row.bi_server_url)).hostname : null,
    updated_at: row?.updated_at ?? null,
  });
}));

router.post("/bi-events", safeHandler(async (req: any, res) => {
  const link = await getPartnerLink(db());
  if (!link) return res.status(503).json({ ok: false, error: "insurance_partner_not_linked" });
  const raw: Buffer | string = req.rawBody ?? JSON.stringify(req.body ?? {});
  const check = verifyCallback({
    secret: link.callbackSecret, referralSourceId: link.referralSourceId, sourceHeader: req.headers["x-bi-referral-source"],
    tsHeader: req.headers["x-bi-timestamp"], sigHeader: req.headers["x-bi-signature"], raw,
  });
  if (!check.ok) {
    console.warn("[pgi] partner callback refused", check.reason);
    return res.status(check.reason === "stale" ? 409 : 401).json({ ok: false, error: check.reason });
  }
  const r = await handlePartnerEvent(db(), req.body ?? {});
  if (!r.ok) return res.status(r.error === "unknown_referral" ? 404 : 400).json({ ok: false, error: r.error });
  return res.status(202).json({ ok: true, stored: r.stored });
}));

router.get("/referrals", ...staff, safeHandler(async (_req, res) => {
  const r = await db().query(
    `SELECT p.application_id, p.status, p.partner_status, p.bi_application_code, p.missing_count, p.unread_count,
            p.referral_fee_amount, p.referral_fee_currency, p.referral_fee_status, p.last_error, p.created_at, p.updated_at,
            COALESCE(a.business_legal_name, a.name) AS application_name,
            NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), '') AS referring_user_name
       FROM pgi_referrals p
       LEFT JOIN applications a ON a.id::text = p.application_id
       LEFT JOIN users u ON u.id = p.referring_user_id
      ORDER BY p.updated_at DESC
      LIMIT 500`,
  );
  res.setHeader("Cache-Control", "no-store");
  return res.json({
    referrals: r.rows.map((x: any) => ({
      ...x,
      referral_fee_amount: x.referral_fee_amount != null ? Number(x.referral_fee_amount) : null,
    })),
  });
}));

router.get("/referrals/:applicationId", ...staff, safeHandler(async (req, res) => {
  const view = await referralView(db(), String(req.params.applicationId));
  res.setHeader("Cache-Control", "no-store");
  if (!view) return res.status(404).json({ ok: false, error: "no_referral" });
  return res.json(view);
}));

router.post("/referrals/:applicationId", ...staff, safeHandler(async (req: any, res) => {
  const id = String(req.params.applicationId);
  const existing = await getReferral(db(), id);
  if (!existing) {
    const created = await startReferral(db(), id, userIdOf(req));
    if (!created) return res.status(404).json({ ok: false, error: "application_not_found" });
  }
  return res.status(existing ? 200 : 201).json(await referralView(db(), id));
}));

router.patch("/referrals/:applicationId", ...staff, safeHandler(async (req, res) => {
  const id = String(req.params.applicationId);
  if (!(await getReferral(db(), id))) return res.status(404).json({ ok: false, error: "no_referral" });
  const patch = cleanInputPatch((req.body ?? {}) as Record<string, unknown>);
  if (!Object.keys(patch).length) return res.status(400).json({ ok: false, error: "nothing_to_change" });
  await updateReferralInput(db(), id, patch);
  return res.json(await referralView(db(), id));
}));

router.post("/referrals/:applicationId/sync", ...staff, safeHandler(async (req, res) => {
  const id = String(req.params.applicationId);
  if (!(await getReferral(db(), id))) return res.status(404).json({ ok: false, error: "no_referral" });
  const r = await syncReferral(db(), id);
  const view = await referralView(db(), id);
  return res.json({ ...view, sync: r });
}));

router.post("/referrals/:applicationId/messages", ...staff, safeHandler(async (req: any, res) => {
  const id = String(req.params.applicationId);
  const body = typeof req.body?.body === "string" ? req.body.body.trim().slice(0, 5000) : "";
  if (!body) return res.status(400).json({ ok: false, error: "body_required" });
  const uid = userIdOf(req);
  const u = uid
    ? (await db().query(`SELECT NULLIF(trim(concat_ws(' ', first_name, last_name)), '') AS name, email FROM users WHERE id::text = $1 LIMIT 1`, [uid])).rows[0]
    : null;
  const r = await sendMessageToPartner(db(), id, { id: uid, name: u?.name ?? u?.email ?? null }, body);
  if (r.error === "no_referral") return res.status(404).json({ ok: false, error: "no_referral" });
  return res.status(201).json({ ok: true, sent: r.ok, error: r.ok ? null : r.error, id: r.id });
}));

router.post("/referrals/:applicationId/read", ...staff, safeHandler(async (req, res) => {
  const ref = await getReferral(db(), String(req.params.applicationId));
  if (!ref) return res.status(404).json({ ok: false, error: "no_referral" });
  await db().query(`UPDATE pgi_referral_messages SET read_at = now() WHERE referral_id = $1 AND direction = 'from_partner' AND read_at IS NULL`, [ref.id]);
  await db().query(`UPDATE pgi_referrals SET unread_count = 0 WHERE id = $1`, [ref.id]);
  return res.json({ ok: true });
}));

export default router;
