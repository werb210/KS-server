// KS_SETTINGS_PACK_v1_PRIVACY - cookie consent and privacy requests. Every plan.
//   POST /api/privacy/consent { visitorId, surface, choice, categories }   public: record a banner choice
//   GET  /api/privacy/requests                                             Admin: the requests (open first, by due date)
//   POST /api/privacy/requests { contact_id, kind, details?, received_via?, requested_at? }   Admin: record one
//   GET  /api/privacy/requests/:id                                         Admin: one request (+ the deletion plan)
//   GET  /api/privacy/requests/:id/export                                  Admin: the contact's data as JSON (access)
//   POST /api/privacy/requests/:id/correct { changes }                    Admin: correct the contact (correction)
//   POST /api/privacy/requests/:id/delete                                  Admin: carry out a deletion (retention-aware)
//   POST /api/privacy/requests/:id/close { status: completed|refused, note }   Admin: close it
// Every step is audited.
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { clientIpFromRequest, rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { pool } from "../db.js";
import { actorId, auditFor, UUID_RE, type Q } from "../settingsPack/common.js";
import {
  REQUEST_KINDS, carryOutDeletion, closeRequest, contactLabel, correctContact, createRequest, exportContact, getRequest, listRequests,
  parseConsent, parseCorrection, planDeletion, recordConsent, type RequestKind,
} from "../privacy/privacy.js";

const router = Router();
const adminOnly = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const db = (): Q => pool as unknown as Q;
const consentLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKeyFromRequest });

router.post("/consent", consentLimiter, safeHandler(async (req: any, res: any) => {
  const parsed = parseConsent(req.body);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });
  let ip = "";
  try { ip = clientIpFromRequest(req); } catch { ip = ""; }
  await recordConsent(db(), parsed.value, { ip, userAgent: String(req.headers?.["user-agent"] ?? "") });
  return res.status(201).json({ ok: true });
}));

router.get("/requests", ...adminOnly, safeHandler(async (_req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, requests: await listRequests(db()) });
}));

router.post("/requests", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const contactId = String(req.body?.contact_id ?? "").trim();
  const kind = String(req.body?.kind ?? "") as RequestKind;
  const errors: Record<string, string> = {};
  if (!UUID_RE.test(contactId)) errors.contact_id = "Choose the contact the request is about.";
  if (!(REQUEST_KINDS as readonly string[]).includes(kind)) errors.kind = "Choose access, correction or deletion.";
  const requestedAt = req.body?.requested_at ? new Date(String(req.body.requested_at)) : null;
  if (requestedAt && (Number.isNaN(requestedAt.getTime()) || requestedAt.getTime() > Date.now() + 86_400_000)) errors.requested_at = "Use the date the request arrived.";
  if (Object.keys(errors).length) return res.status(400).json({ ok: false, error: "validation_error", errors });
  const label = await contactLabel(db(), contactId);
  if (!label) return res.status(404).json({ ok: false, error: "contact_not_found", errors: { contact_id: "No contact with that id." } });
  const request = await createRequest(db(), {
    contactId, label, kind, details: String(req.body?.details ?? "").trim().slice(0, 2000) || null,
    receivedVia: String(req.body?.received_via ?? "").trim().slice(0, 80) || null, requestedAt, actor: actorId(req),
  });
  await auditFor(req, "privacy_request.created", { kind, due_at: request.due_at }, { type: "contact", id: contactId });
  return res.status(201).json({ ok: true, request });
}));

async function openRequest(req: any, res: any, kind?: RequestKind) {
  const id = String(req.params.id ?? "");
  const r = UUID_RE.test(id) ? await getRequest(db(), id) : null;
  if (!r) { res.status(404).json({ ok: false, error: "not_found" }); return null; }
  if (kind && r.kind !== kind) { res.status(409).json({ ok: false, error: "wrong_kind", message: `This is a ${r.kind} request.` }); return null; }
  if (kind && r.status !== "open") { res.status(409).json({ ok: false, error: "closed", message: "This request is already closed." }); return null; }
  if (kind && !r.contact_id) { res.status(409).json({ ok: false, error: "no_contact", message: "The contact is no longer on file." }); return null; }
  return r;
}

router.get("/requests/:id", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const r = await openRequest(req, res);
  if (!r) return;
  const plan = r.kind === "deletion" && r.status === "open" && r.contact_id ? await planDeletion(db(), r.contact_id) : null;
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, request: r, deletion_plan: plan });
}));

router.get("/requests/:id/export", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const r = await openRequest(req, res);
  if (!r) return;
  if (!r.contact_id) return res.status(409).json({ ok: false, error: "no_contact", message: "The contact is no longer on file." });
  const data = await exportContact(db(), r.contact_id);
  await auditFor(req, "privacy_request.exported", { request_id: r.id, tables: Object.keys(data.records), skipped: Object.keys(data.skipped) }, { type: "contact", id: r.contact_id });
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Disposition", `attachment; filename="contact-${r.contact_id}-export.json"`);
  return res.json({ ok: true, request_id: r.id, ...data });
}));

router.post("/requests/:id/correct", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const r = await openRequest(req, res, "correction");
  if (!r) return;
  const parsed = parseCorrection(req.body?.changes);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: "validation_error", errors: parsed.errors });
  const changes = await correctContact(db(), r.contact_id!, parsed.value as Record<string, string>);
  await auditFor(req, "privacy_request.corrected", { request_id: r.id, changes }, { type: "contact", id: r.contact_id });
  return res.json({ ok: true, changes });
}));

router.post("/requests/:id/delete", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const r = await openRequest(req, res, "deletion");
  if (!r) return;
  const outcome = await carryOutDeletion(async () => (await pool.connect()) as any, db(), r.contact_id!);
  const closed = await closeRequest(db(), r.id, "completed", { ...outcome, note: outcome.deleted ? "Deleted." : "Kept under the 7-year record retention or a legal hold; opted out of marketing." }, actorId(req));
  await auditFor(req, outcome.deleted ? "privacy_request.deletion_completed" : "privacy_request.deletion_limited",
    { request_id: r.id, removed: outcome.removed, kept: outcome.kept, suppressed: outcome.suppressed }, { type: "contact", id: r.contact_id });
  return res.json({ ok: true, outcome, request: closed });
}));

router.post("/requests/:id/close", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const r = await openRequest(req, res);
  if (!r) return;
  const status = req.body?.status === "refused" ? "refused" : "completed";
  const note = String(req.body?.note ?? "").trim().slice(0, 2000);
  if (status === "refused" && note.length < 3) return res.status(400).json({ ok: false, error: "validation_error", errors: { note: "Say why the request was refused." } });
  const closed = await closeRequest(db(), r.id, status, { note }, actorId(req));
  if (!closed) return res.status(409).json({ ok: false, error: "closed", message: "This request is already closed." });
  await auditFor(req, `privacy_request.${status}`, { request_id: r.id, note }, { type: "contact", id: r.contact_id });
  return res.json({ ok: true, request: closed });
}));

export default router;
