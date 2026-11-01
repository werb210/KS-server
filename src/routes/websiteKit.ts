// KS_SERVER_MARKETING_ADDON - the website kit (src/marketing/websiteKit.ts).
//
// Staff (Admins and Marketing users), mounted at /api/website-kit:
//   GET    /                     settings, forms, the snippet to copy, and what the plan allows
//   PUT    /settings             { allowed_origins, chat_enabled, tracking_enabled, consent_banner } (audited)
//                                 the chat widget and tracking script are Marketing add-on tools
//   POST   /settings/new-key     replaces the public key (the old snippet stops working; audited)
//   POST   /forms                a lead form (1 on every plan, unlimited with the add-on; audited)
//   PUT    /forms/:id, DELETE /forms/:id (audited)
//
// Public, mounted at /api/kit (answers only pages on the website addresses the Admin listed):
//   GET  /:key/kit.js            the script
//   POST /:key/forms/:formId     a form submission -> a CRM lead (lead rotation, consent, staff notified)
//   POST /:key/chat              the AI chat widget -> the brokerage's assistant (add-on)
//   POST /:key/track             page views, only sent after the visitor agreed to analytics cookies (add-on)
//   POST /:key/consent           the visitor's cookie choice (recorded like the other consent banners)
// Bodies are JSON sent as text/plain so browsers send them without a preflight.
import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { clientIpFromRequest, rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { actorId, auditFor, UUID_RE, type Q } from "../settingsPack/common.js";
import { serverUrl } from "../licensee/urls.js";
import { assistantName, brandName, brandSettings } from "../licensee/brand.js";
import { getPlanState } from "../plans/state.js";
import { marketingAddonActive, marketingLimitsFor } from "../plans/marketing.js";
import { checkMarketingTool, personOf } from "../plans/marketingGate.js";
import {
  createForm, deleteForm, kitSettings, kitSnippet, listForms, liveForms, newKitKey, normalizeKitSettings, originAllowed,
  parseFormInput, parseSubmission, saveKitSettings, updateForm, type KitSettings,
} from "../marketing/websiteKit.js";
import { kitScript } from "../marketing/kitScript.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";

const db = (): Q => pool as unknown as Q;
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.MARKETING] })];

async function formLimit(now = new Date()): Promise<{ limit: number | null; extras: boolean }> {
  const state = await getPlanState(db(), now.getTime());
  return { limit: marketingLimitsFor(state, now).lead_forms, extras: marketingAddonActive(state, now) };
}

async function overview(req: any) {
  const [settings, forms, lim, tool] = await Promise.all([
    kitSettings(db()), listForms(db()), formLimit(), checkMarketingTool(db(), "website_kit", personOf(req)),
  ]);
  const live = new Set(liveForms(forms, lim.limit).map((f) => f.id));
  return {
    ok: true,
    settings,
    forms: forms.map((f) => ({ ...f, live: live.has(f.id) })),
    snippet: kitSnippet(serverUrl(), settings.key, forms),
    limits: { lead_forms: lim.limit, addon: lim.extras, can_use_extras: tool.allowed },
  };
}

// ------------------------------------------------------------------------------------------------------- staff

export const websiteKitAdminRoutes = Router();

websiteKitAdminRoutes.get("/", ...staff, safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json(await overview(req));
}));

websiteKitAdminRoutes.put("/settings", ...staff, safeHandler(async (req: any, res: any) => {
  const current = await kitSettings(db());
  const next: KitSettings = { ...normalizeKitSettings({ ...current, ...(req.body ?? {}) }), key: current.key };
  const raw = Array.isArray(req.body?.allowed_origins) ? req.body.allowed_origins.map((x: unknown) => String(x ?? "").trim()).filter(Boolean) : [];
  if (raw.length > next.allowed_origins.length) {
    return res.status(400).json({ ok: false, error: "invalid_origin", message: "Each website address must start with https:// (for example https://www.yourbrokerage.ca)." });
  }
  const turningOn = (next.chat_enabled && !current.chat_enabled) || (next.tracking_enabled && !current.tracking_enabled);
  if (turningOn) {
    const c = await checkMarketingTool(db(), "website_kit", personOf(req));
    if (!c.allowed) return res.status(c.status).json(c.body);
  }
  await saveKitSettings(db(), next, actorId(req));
  await auditFor(req, "website_kit_settings_saved", {
    allowed_origins: next.allowed_origins, chat_enabled: next.chat_enabled, tracking_enabled: next.tracking_enabled, consent_banner: next.consent_banner,
  });
  return res.json(await overview(req));
}));

websiteKitAdminRoutes.post("/settings/new-key", ...staff, safeHandler(async (req: any, res: any) => {
  const current = await kitSettings(db());
  await saveKitSettings(db(), { ...current, key: newKitKey() }, actorId(req));
  await auditFor(req, "website_kit_key_replaced", {});
  return res.json(await overview(req));
}));

websiteKitAdminRoutes.post("/forms", ...staff, safeHandler(async (req: any, res: any) => {
  const parsed = parseFormInput(req.body);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: "invalid_form", message: parsed.error });
  const [forms, lim] = await Promise.all([listForms(db()), formLimit()]);
  if (lim.limit !== null && forms.length >= lim.limit) {
    return res.status(402).json({
      ok: false, error: "marketing_addon_required", tool: "website_kit",
      message: `Your plan includes ${lim.limit} website lead form. The Marketing add-on gives you unlimited forms. You can edit the form you have.`,
    });
  }
  if (lim.limit === null && forms.length >= 1) {
    const c = await checkMarketingTool(db(), "website_kit", personOf(req));
    if (!c.allowed) return res.status(c.status).json(c.body);
  }
  const form = await createForm(db(), parsed.value, actorId(req));
  await auditFor(req, "website_kit_form_created", { name: form.name }, { type: "website_kit_form", id: form.id });
  return res.status(201).json({ ...(await overview(req)), form });
}));

websiteKitAdminRoutes.put("/forms/:id", ...staff, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!UUID_RE.test(id)) return res.status(404).json({ ok: false, error: "not_found" });
  const parsed = parseFormInput(req.body);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: "invalid_form", message: parsed.error });
  const form = await updateForm(db(), id, parsed.value);
  if (!form) return res.status(404).json({ ok: false, error: "not_found" });
  await auditFor(req, "website_kit_form_updated", { name: form.name, active: form.active }, { type: "website_kit_form", id });
  return res.json({ ...(await overview(req)), form });
}));

websiteKitAdminRoutes.delete("/forms/:id", ...staff, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!UUID_RE.test(id) || !(await deleteForm(db(), id))) return res.status(404).json({ ok: false, error: "not_found" });
  await auditFor(req, "website_kit_form_deleted", {}, { type: "website_kit_form", id });
  return res.json(await overview(req));
}));

// ------------------------------------------------------------------------------------------------------ public

export const websiteKitPublicRoutes = Router();
const publicLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKeyFromRequest });
const submitLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKeyFromRequest });
websiteKitPublicRoutes.use(express.text({ type: "*/*", limit: "32kb" }));

/** The JSON a kit request carries (sent as text/plain); {} when it is not JSON. */
export function kitBody(raw: unknown): Record<string, any> {
  if (raw && typeof raw === "object" && !Buffer.isBuffer(raw)) return raw as Record<string, any>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Finds the kit for :key and checks the page's website address. Sends the refusal and returns null. */
async function kitFor(req: any, res: any): Promise<KitSettings | null> {
  const s = await kitSettings(db());
  if (!s.key || String(req.params.key) !== s.key) { res.status(404).json({ ok: false, error: "not_found" }); return null; }
  const origin = req.headers?.origin;
  if (!originAllowed(s, origin)) {
    res.status(403).json({ ok: false, error: "website_not_allowed", message: "This website is not set up for this form. Ask the business to add its address in the website kit." });
    return null;
  }
  res.setHeader("Access-Control-Allow-Origin", String(origin));
  res.setHeader("Vary", "Origin");
  return s;
}

websiteKitPublicRoutes.get("/:key/kit.js", publicLimiter, safeHandler(async (req: any, res: any) => {
  const s = await kitSettings(db());
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (!s.key || String(req.params.key) !== s.key) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(404).send("/* This website kit is not available. */");
  }
  const lim = await formLimit();
  const forms = liveForms(await listForms(db()), lim.limit);
  const brand = brandSettings();
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.send(kitScript({
    base: serverUrl().replace(/\/+$/, ""), key: s.key, brand: brandName(), color: String(brand.primary_color ?? ""), assistant: assistantName(),
    chat: lim.extras && s.chat_enabled, tracking: lim.extras && s.tracking_enabled, banner: s.consent_banner,
    forms: forms.map((f) => ({ id: f.id, fields: f.fields, button_label: f.button_label, thank_you: f.thank_you })),
  }));
}));

websiteKitPublicRoutes.post("/:key/forms/:formId", submitLimiter, safeHandler(async (req: any, res: any) => {
  const s = await kitFor(req, res);
  if (!s) return;
  const body = kitBody(req.body);
  if (String(body.company_website ?? "").trim()) return res.json({ ok: true }); // the hidden field people never fill in
  const lim = await formLimit();
  const form = liveForms(await listForms(db()), lim.limit).find((f) => f.id === String(req.params.formId));
  if (!form) return res.status(404).json({ ok: false, error: "form_not_available", message: "This form is not taking submissions right now. Please call or email us instead." });
  const parsed = parseSubmission(form, body);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: "invalid_submission", field: parsed.field, message: parsed.error });
  const { submitKitLead } = await import("../marketing/kitLead.js");
  const lead = await submitKitLead(pool, form, parsed.value);
  return res.json({ ok: true, message: form.thank_you, contact: lead.created ? "created" : "updated" });
}));

websiteKitPublicRoutes.post("/:key/chat", publicLimiter, safeHandler(async (req: any, res: any) => {
  const s = await kitFor(req, res);
  if (!s) return;
  const lim = await formLimit();
  if (!lim.extras || !s.chat_enabled) return res.status(404).json({ ok: false, error: "chat_not_available", message: "Chat is not available right now." });
  const body = kitBody(req.body);
  const message = String(body.message ?? "").trim().slice(0, 2000);
  if (!message) return res.status(400).json({ ok: false, error: "message_required", message: "Type a question first." });
  const sessionId = /^[A-Za-z0-9_.:-]{6,100}$/.test(String(body.sessionId ?? "")) ? String(body.sessionId) : null;
  const { proxyMayaToAgent } = await import("./maya.js");
  await proxyMayaToAgent("/api/maya/message", "POST", { message, sessionId }, res, req);
}));

websiteKitPublicRoutes.post("/:key/track", publicLimiter, safeHandler(async (req: any, res: any) => {
  const s = await kitFor(req, res);
  if (!s) return;
  const lim = await formLimit();
  if (!lim.extras || !s.tracking_enabled) return res.json({ ok: true, skipped: "tracking_off" });
  try {
    const { recordJourney } = await import("./visitorTrack.js");
    const out = await recordJourney(kitBody(req.body), req.headers?.["user-agent"]);
    return res.json({ ok: true, ...out });
  } catch (err) {
    // Tracking must never surface an error to the visitor's browser.
    logWarnSwallowed(err, "routes/websiteKit.ts:track");
    return res.json({ ok: true, skipped: "error" });
  }
}));

websiteKitPublicRoutes.post("/:key/consent", publicLimiter, safeHandler(async (req: any, res: any) => {
  const s = await kitFor(req, res);
  if (!s) return;
  const { parseConsent, recordConsent } = await import("../privacy/privacy.js");
  const parsed = parseConsent({ ...kitBody(req.body), surface: "website_kit" });
  if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });
  await recordConsent(db(), parsed.value, { ip: safeIp(req), userAgent: String(req.headers?.["user-agent"] ?? "") });
  return res.status(201).json({ ok: true });
}));

function safeIp(req: any): string {
  try { return clientIpFromRequest(req) || ""; } catch (err) { return logWarnSwallowed(err, "routes/websiteKit.ts:ip", ""); }
}
