// KS_SERVER_v22_KYC - ID and address verification (src/kyc/).
//   GET  /api/kyc/settings                            Admin: provider choice, wizard step, which providers are set up, webhook URL
//   PUT  /api/kyc/settings                            Admin: { provider?: auto|onfido|manual, wizard_step?, wizard_people? }
//   GET  /api/kyc/applications/:id                    staff: people on the file and their verifications
//   POST /api/kyc/applications/:id/requests           staff: { contact_id? } send a verification request (default: applicant)
//   POST /api/kyc/verifications/:vid/refresh          staff: ask the vendor again now
//   POST /api/kyc/verifications/:vid/decision         staff: { decision: approved|declined, note? } (vendor review / manual)
//   POST /api/kyc/verifications/:vid/cancel           staff
//   GET  /api/kyc/verifications/:vid/id-details       staff: what the vendor read from the ID, number masked; ?full=1 Admin only
//                                                     (every reveal is in the audit log)
//   POST /api/kyc/webhooks/:provider                  public, signature checked (Entrust IDV / Onfido: X-SHA2-Signature)
// Staff routes are growth and up (id_verification); the webhook is never gated, so results already paid for land.
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { requireFeature } from "../plans/requireFeature.js";
import { auditRequest, actorId } from "../lib/auditRequest.js";
import { serverUrl } from "../licensee/urls.js";
import {
  activeProvider, cancelVerification, getKycSettings, getVerification, handleWebhook, idDetails, listForApplication, parseSettingsPatch,
  peopleOnFile, refreshFromVendor, requestVerification, saveKycSettings, staffDecision, staffView, type Db,
} from "../kyc/service.js";
import { kycProviders } from "../kyc/providers/index.js";

const router = Router();
const db = () => pool as unknown as Db;
const gate = requireFeature("id_verification");
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }), gate];
const admin = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERRORS: Record<string, string> = {
  not_found: "That application or verification was not found.",
  person_not_on_file: "That person is not on this application.",
  no_applicant_on_file: "This application has no applicant contact to verify yet.",
  provider_not_configured: "ID verification is not set up yet. An Admin can set it up in Settings > ID verification, or choose manual review.",
  not_awaiting_review: "Only a verification waiting for review can be approved or declined.",
};
const fail = (res: any, status: number, error: string) => res.status(status).json({ ok: false, error, message: ERRORS[error] ?? error });

export function webhookUrl(provider = "onfido"): string {
  return `${serverUrl().replace(/\/+$/, "")}/api/kyc/webhooks/${provider}`;
}

// ------------------------------------------------------------------------------------------------ webhook (public)
router.post("/webhooks/:provider", safeHandler(async (req: any, res: any) => {
  const out = await handleWebhook(String(req.params.provider ?? ""), req.rawBody, req.headers ?? {}, req.body);
  if (out.status >= 400) console.warn("[kyc] webhook refused", { provider: req.params.provider, outcome: out.outcome });
  return res.status(out.status).json({ ok: out.status < 400, outcome: out.outcome });
}));

// ------------------------------------------------------------------------------------------------ settings (Admin)
router.get("/settings", ...admin, safeHandler(async (_req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  const settings = await getKycSettings();
  const providers = kycProviders();
  const active = await activeProvider({ providers });
  return res.json({
    ok: true, settings, active_provider: active.key,
    providers: Object.values(providers).map((p) => ({ key: p.key, label: p.label, configured: p.configured(), hosted: p.hosted, settings: p.settings })),
    webhook_url: webhookUrl("onfido"),
  });
}));

router.put("/settings", ...admin, safeHandler(async (req: any, res: any) => {
  const p = parseSettingsPatch(req.body);
  if (!p.ok) return res.status(400).json({ ok: false, error: p.error });
  const settings = await saveKycSettings(db(), p.patch, actorId(req));
  await auditRequest(req, "kyc_settings", "update", "kyc_settings", "1", { ...p.patch });
  return res.json({ ok: true, settings });
}));

// ------------------------------------------------------------------------------------------------ per application (staff)
router.get("/applications/:id", ...staff, safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  const id = String(req.params.id ?? "");
  if (!UUID.test(id)) return fail(res, 400, "invalid_id");
  const app = await db().query(`SELECT id::text AS id FROM applications WHERE id::text = $1 LIMIT 1`, [id]);
  if (!app.rows[0]) return fail(res, 404, "not_found");
  const provider = await activeProvider();
  const people = await peopleOnFile(db(), id);
  const verifications = (await listForApplication(db(), id)).map(staffView);
  return res.json({
    ok: true, application_id: id,
    provider: { key: provider.key, label: provider.label, configured: provider.configured(), hosted: provider.hosted },
    people: people.map((p) => ({ contact_id: p.contact_id, role: p.role, name: p.name, has_phone: Boolean(p.phone) })),
    verifications,
  });
}));

router.post("/applications/:id/requests", ...staff, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "");
  if (!UUID.test(id)) return fail(res, 400, "invalid_id");
  const contactId = req.body?.contact_id ? String(req.body.contact_id) : null;
  if (contactId && !UUID.test(contactId)) return fail(res, 400, "invalid_contact_id");
  const r = await requestVerification({ applicationId: id, contactId, via: "staff", requestedBy: actorId(req) });
  if (!r.ok) return fail(res, r.status, r.error);
  if (r.created) await auditRequest(req, "kyc", "request", "application", id, { verification_id: r.verification.id, provider: r.verification.provider });
  return res.status(r.created ? 201 : 200).json({ ok: true, created: r.created, verification: staffView(r.verification) });
}));

router.post("/verifications/:vid/refresh", ...staff, safeHandler(async (req: any, res: any) => {
  const v = await getVerification(db(), String(req.params.vid ?? ""));
  if (!v) return fail(res, 404, "not_found");
  await refreshFromVendor(v);
  return res.json({ ok: true, verification: staffView((await getVerification(db(), v.id))!) });
}));

router.post("/verifications/:vid/decision", ...staff, safeHandler(async (req: any, res: any) => {
  const decision = req.body?.decision;
  if (decision !== "approved" && decision !== "declined") return res.status(400).json({ ok: false, error: "decision must be approved or declined" });
  const r = await staffDecision(String(req.params.vid ?? ""), decision, String(req.body?.note ?? ""), actorId(req));
  if (!r.ok) return fail(res, r.status, r.error);
  await auditRequest(req, "kyc", decision === "approved" ? "approve" : "decline", "application", r.verification.application_id, { verification_id: r.verification.id });
  return res.json({ ok: true, verification: staffView(r.verification) });
}));

router.post("/verifications/:vid/cancel", ...staff, safeHandler(async (req: any, res: any) => {
  const ok = await cancelVerification(String(req.params.vid ?? ""), actorId(req));
  if (!ok) return fail(res, 409, "not_open");
  return res.json({ ok: true });
}));

router.get("/verifications/:vid/id-details", ...staff, safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  const full = req.query?.full === "1";
  if (full && req.user?.role !== ROLES.ADMIN) return res.status(403).json({ ok: false, error: "admin_only", message: "Only an Admin can see the full ID number." });
  const v = await getVerification(db(), String(req.params.vid ?? ""));
  if (!v) return fail(res, 404, "not_found");
  const details = await idDetails(v, full, db());
  await auditRequest(req, "kyc", full ? "reveal_id_number" : "view_id_details", "application", v.application_id, { verification_id: v.id });
  return res.json({ ok: true, details });
}));

export default router;
