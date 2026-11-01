// KS_HUBSPOT_GAPS_1_PAYMENTS - /api/payments: payment links and bank debit for broker fees (Growth and Pro).
//   GET  /settings                         Admin: Stripe connection status (and why payments are off on this server)
//   POST /connect                          Admin: { url } of Stripe's connect screen
//   GET  /stripe/callback                  public: Stripe sends the Admin back here; then on to Settings > Payments
//   POST /disconnect                       Admin (audited)
//   GET  /fee-suggestion?application_id=   staff: the signed fee agreement's fee, to fill the amount in
//   GET  /links?application_id=|contact_id=   staff who may see the record
//   POST /links                            staff: { application_id?, contact_id?, amount, description, methods, expires_days, send: { email, sms } }
//   POST /links/:id/send                   staff: { email, sms } (texts only with consent)
//   POST /links/:id/cancel                 staff (audited)
//   GET  /report?days=90                   staff: collected, processing, outstanding, by month (record visibility applies)
//   GET  /pay/:token                       public: the client's link -> Stripe Checkout on the brokerage's account
//   GET  /pay/:token/done                  public: the page Stripe returns the client to
//   POST /stripe/webhook                   public: Stripe Connect events (signature checked)
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { randomBytes, createHash } from "node:crypto";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { requireFeature } from "../plans/requireFeature.js";
import { checkFeature } from "../plans/catalogue.js";
import { getPlanState } from "../plans/state.js";
import { pool } from "../db.js";
import { serverUrl } from "../licensee/urls.js";
import { brandName } from "../licensee/brand.js";
import { actorId, auditFor } from "../settingsPack/common.js";
import { canSeeRecord, ownerFilterSql, scopeForRequest } from "../visibility/scope.js";
import { defaultReminderDeps } from "../booking/bookingPages.js";
import {
  connectAuthorizeUrl, deauthorizeAccount, exchangeConnectCode, stripeConfig, stripeConfigProblem, verifyStripeSignature,
} from "../payments/stripe.js";
import {
  METHODS, METHOD_LABEL, createLink, firstDelivery, handleStripeEvent, linkById, linkByToken, linkView, loadStripeConnection,
  markDisconnected, money, openCheckout, paymentsReport, paymentsSettingsUrl, recordInQuickBooks, refreshAccountDetails,
  resolveContact, resultPage, saveConnection, sendLink, suggestedFee, timeline, validateCreate, type Q, type SendDeps,
} from "../payments/paymentLinks.js";

const router = Router();
const db = (): Q => pool as unknown as Q;
const FEATURE = "payment_links";
const admin = [auth, requireAuthorization({ roles: [ROLES.ADMIN] }), requireFeature(FEATURE)];
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }), requireFeature(FEATURE)];
const publicLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKeyFromRequest });
const STATE_TTL_MINUTES = 10;
const callbackUrl = () => `${serverUrl().replace(/\/+$/, "")}/api/payments/stripe/callback`;
const hashState = (s: string) => createHash("sha256").update(s).digest("hex");

let sendDeps: SendDeps = defaultReminderDeps();
/** Test seam. */
export function setPaymentSendDepsForTests(d: SendDeps | null): void { sendDeps = d ?? defaultReminderDeps(); }

// ------------------------------------------------------------------ Admin: connect Stripe
router.get("/settings", ...admin, safeHandler(async (_req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  const c = await loadStripeConnection(db());
  res.json({
    ok: true,
    problem: stripeConfigProblem(),
    connection: c ? { ...c, account_id: c.account_id } : { status: "disconnected" },
    methods: METHODS.map((m) => ({ value: m, label: METHOD_LABEL[m] })),
  });
}));

router.post("/connect", ...admin, safeHandler(async (req: any, res: any) => {
  const cfg = stripeConfig();
  if (!cfg) return res.status(503).json({ ok: false, error: "not_configured", message: stripeConfigProblem() });
  const state = randomBytes(24).toString("base64url");
  await db().query(`DELETE FROM stripe_oauth_states WHERE created_at < now() - make_interval(mins => $1::int)`, [STATE_TTL_MINUTES]);
  await db().query(`INSERT INTO stripe_oauth_states (state_hash, user_id) VALUES ($1, $2::uuid)`, [hashState(state), actorId(req)]);
  const email = String(req.user?.email ?? "") || null;
  res.json({ ok: true, url: connectAuthorizeUrl(cfg, state, callbackUrl(), { email, businessName: brandName() }) });
}));

router.get("/stripe/callback", publicLimiter, safeHandler(async (req: any, res: any) => {
  const cfg = stripeConfig();
  const state = String(req.query?.state ?? "");
  const claimed = state ? (await db().query(
    `DELETE FROM stripe_oauth_states WHERE state_hash = $1 AND created_at > now() - make_interval(mins => $2::int) RETURNING user_id::text AS user_id`,
    [hashState(state), STATE_TTL_MINUTES])).rows[0] : null;
  if (!cfg || !claimed) return res.redirect(303, paymentsSettingsUrl("expired"));
  if (req.query?.error) {
    console.warn("[payments] Stripe connect declined", { error: String(req.query.error), description: String(req.query.error_description ?? "").slice(0, 200) });
    return res.redirect(303, paymentsSettingsUrl("declined"));
  }
  try {
    const { accountId, livemode } = await exchangeConnectCode(cfg, String(req.query?.code ?? ""));
    await saveConnection(db(), accountId, livemode, claimed.user_id ?? null);
    try { await refreshAccountDetails(db(), cfg, accountId); } catch (err) {
      console.warn("[payments] could not read the connected account's details", { message: err instanceof Error ? err.message : String(err) });
    }
    await auditFor({ user: { userId: claimed.user_id }, headers: req.headers, ip: req.ip }, "payments.stripe_connected", { account_id: accountId, livemode }, { type: "stripe_connection", id: "1" });
    return res.redirect(303, paymentsSettingsUrl("connected"));
  } catch (err) {
    console.error("[payments] Stripe connect failed", { message: err instanceof Error ? err.message : String(err) });
    return res.redirect(303, paymentsSettingsUrl("error"));
  }
}));

router.post("/disconnect", ...admin, safeHandler(async (req: any, res: any) => {
  const c = await loadStripeConnection(db());
  const cfg = stripeConfig();
  let revoked = false;
  if (cfg && c?.account_id && c.status === "connected") {
    try { await deauthorizeAccount(cfg, c.account_id); revoked = true; } catch (err) {
      console.warn("[payments] Stripe deauthorize failed; disconnecting here anyway", { message: err instanceof Error ? err.message : String(err) });
    }
  }
  await markDisconnected(db(), null);
  await auditFor(req, "payments.stripe_disconnected", { account_id: c?.account_id ?? null, revoked }, { type: "stripe_connection", id: "1" });
  res.json({ ok: true, revoked });
}));

// ------------------------------------------------------------------ staff: links
async function mayUse(req: any, res: any, applicationId: string | null, contactId: string | null): Promise<boolean> {
  const scope = await scopeForRequest(req, db());
  const okApp = !applicationId || await canSeeRecord(db(), scope, "application", applicationId);
  const okContact = !contactId || await canSeeRecord(db(), scope, "contact", contactId);
  if (okApp && okContact) return true;
  res.status(404).json({ ok: false, error: "not_found", message: "Record not found" });
  return false;
}

router.get("/fee-suggestion", ...staff, safeHandler(async (req: any, res: any) => {
  const applicationId = String(req.query?.application_id ?? "").trim();
  if (!applicationId) return res.json({ ok: true, fee: null });
  if (!(await mayUse(req, res, applicationId, null))) return;
  res.json({ ok: true, fee: await suggestedFee(db(), applicationId) });
}));

router.get("/links", ...staff, safeHandler(async (req: any, res: any) => {
  const applicationId = String(req.query?.application_id ?? "").trim() || null;
  const contactId = String(req.query?.contact_id ?? "").trim() || null;
  if (!applicationId && !contactId) return res.status(400).json({ ok: false, error: "record_required", message: "Ask for an application or a contact." });
  if (contactId && !/^[0-9a-f-]{36}$/i.test(contactId)) return res.status(404).json({ ok: false, error: "not_found" });
  if (!(await mayUse(req, res, applicationId, contactId))) return;
  const r = await db().query(
    `SELECT * FROM payment_links WHERE ($1::text IS NULL OR application_id = $1) AND ($2::uuid IS NULL OR contact_id = $2::uuid)
      ORDER BY created_at DESC LIMIT 100`, [applicationId, contactId]);
  const c = await loadStripeConnection(db());
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, connected: c?.status === "connected", problem: stripeConfigProblem(), links: r.rows.map(linkView) });
}));

router.post("/links", ...staff, safeHandler(async (req: any, res: any) => {
  const v = validateCreate(req.body ?? {});
  if (!v.ok) return res.status(400).json({ ok: false, error: "validation_error", message: Object.values(v.errors)[0], errors: v.errors });
  if (!(await mayUse(req, res, v.value.applicationId, v.value.contactId))) return;
  if (stripeConfigProblem()) return res.status(503).json({ ok: false, error: "not_configured", message: stripeConfigProblem() });
  const c = await loadStripeConnection(db());
  if (c?.status !== "connected" || !c.account_id) {
    return res.status(409).json({ ok: false, error: "stripe_not_connected", message: "An Admin needs to connect your Stripe account in Settings > Payments first." });
  }
  if (v.value.methods.includes("acss_debit") && c.acss_debit_enabled === false) {
    return res.status(409).json({ ok: false, error: "acss_not_enabled", message: "Bank debit (pre-authorized debit) is not switched on in your Stripe account. Turn it on in Stripe (Settings > Payment methods), or send a card-only link." });
  }
  if (v.value.applicationId) {
    const exists = await db().query(`SELECT 1 FROM applications WHERE id::text = $1`, [v.value.applicationId]);
    if (!exists.rows.length) return res.status(404).json({ ok: false, error: "not_found", message: "Application not found" });
  }
  const contactId = await resolveContact(db(), v.value);
  const link = await createLink(db(), v.value, c.account_id, contactId, actorId(req));
  await auditFor(req, "payments.link_created", { link_id: link.id, amount_cents: link.amount_cents, application_id: link.application_id }, { type: "payment_link", id: link.id });
  const want = { email: req.body?.send?.email === true, sms: req.body?.send?.sms === true };
  const sent = await sendLink(db(), link, want, sendDeps, actorId(req));
  if (!sent.sent.length) await timeline(db(), link, "payment_link_sent", `Payment link created: ${money(link.amount_cents, link.currency)}`, `${link.description} - not sent yet (copy the link to share it)`, actorId(req));
  res.status(201).json({ ok: true, link: linkView((await linkById(db(), link.id))!), sent: sent.sent, refused: sent.refused });
}));

async function staffLink(req: any, res: any) {
  const link = await linkById(db(), String(req.params.id ?? ""));
  if (!link) { res.status(404).json({ ok: false, error: "not_found" }); return null; }
  if (!(await mayUse(req, res, link.application_id, link.contact_id))) return null;
  return link;
}

router.post("/links/:id/send", ...staff, safeHandler(async (req: any, res: any) => {
  const link = await staffLink(req, res);
  if (!link) return;
  if (!["open", "failed"].includes(link.status) || new Date(link.expires_at).getTime() <= Date.now()) {
    return res.status(409).json({ ok: false, error: "not_open", message: "Only an open link can be sent." });
  }
  const sent = await sendLink(db(), link, { email: req.body?.email === true, sms: req.body?.sms === true }, sendDeps, actorId(req));
  res.json({ ok: true, sent: sent.sent, refused: sent.refused, link: linkView((await linkById(db(), link.id))!) });
}));

router.post("/links/:id/cancel", ...staff, safeHandler(async (req: any, res: any) => {
  const link = await staffLink(req, res);
  if (!link) return;
  if (!["open", "failed"].includes(link.status)) return res.status(409).json({ ok: false, error: "not_open", message: "A paid or processing payment cannot be cancelled here. Refunds are made in Stripe." });
  await db().query(`UPDATE payment_links SET status = 'cancelled', cancelled_at = now(), checkout_url = NULL, updated_at = now() WHERE id = $1::uuid`, [link.id]);
  const cfg = stripeConfig();
  if (cfg && link.checkout_session_id && link.checkout_url) {
    try {
      const { stripeRequest } = await import("../payments/stripe.js");
      await stripeRequest(cfg, "POST", `/checkout/sessions/${encodeURIComponent(link.checkout_session_id)}/expire`, {}, { account: link.stripe_account_id });
    } catch (err) {
      console.warn("[payments] could not expire the open Stripe checkout", { linkId: link.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  await auditFor(req, "payments.link_cancelled", { link_id: link.id }, { type: "payment_link", id: link.id });
  await timeline(db(), link, "payment_link_cancelled", `Payment link cancelled: ${money(link.amount_cents, link.currency)}`, link.description, actorId(req));
  res.json({ ok: true, link: linkView((await linkById(db(), link.id))!) });
}));

router.get("/report", ...staff, safeHandler(async (req: any, res: any) => {
  const days = Math.min(1825, Math.max(7, Number(req.query?.days ?? 90) || 90));
  const scope = await scopeForRequest(req, db());
  const params: unknown[] = [];
  const appCond = ownerFilterSql(scope, "application", "a", params);
  const contactCond = ownerFilterSql(scope, "contact", "c", params);
  // Report params start at $2 (the days are $1).
  const shift = (sql: string) => sql.replace(/\$(\d+)/g, (_m, n) => `$${Number(n) + 1}`);
  const sql = scope.mode === "all" ? "TRUE" : `((a.id IS NOT NULL AND ${shift(appCond)}) OR (a.id IS NULL AND ${shift(contactCond)}))`;
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, ...(await paymentsReport(db(), days, { sql, params })) });
}));

// ------------------------------------------------------------------ public: the client's link
function page(res: any, status: number, title: string, message: string) {
  res.status(status).setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.send(resultPage(title, message));
}

router.get("/pay/:token", publicLimiter, safeHandler(async (req: any, res: any) => {
  const link = await linkByToken(db(), String(req.params.token ?? ""));
  if (!link) return page(res, 404, "Link not found", `This payment link is not valid. Please check the link, or contact ${brandName()}.`);
  const cfg = stripeConfig();
  const plan = checkFeature(await getPlanState(db() as any), FEATURE);
  if (!cfg || !plan.allowed) return page(res, 503, "Payments unavailable", `Online payments are not available right now. Please contact ${brandName()}.`);
  let email: string | null = null;
  if (link.contact_id) email = (await db().query(`SELECT email FROM contacts WHERE id = $1::uuid`, [link.contact_id])).rows[0]?.email ?? null;
  try {
    const r = await openCheckout(db(), cfg, link, { customerEmail: email });
    if (r.kind === "redirect") return res.redirect(303, r.url);
    return page(res, r.status, r.title, r.message);
  } catch (err) {
    console.error("[payments] checkout could not be opened", { linkId: link.id, message: err instanceof Error ? err.message : String(err) });
    return page(res, 502, "Please try again", `The payment page could not be opened just now. Please try again in a minute, or contact ${brandName()}.`);
  }
}));

router.get("/pay/:token/done", publicLimiter, safeHandler(async (req: any, res: any) => {
  const link = await linkByToken(db(), String(req.params.token ?? ""));
  if (!link) return page(res, 404, "Link not found", `This payment link is not valid. Please contact ${brandName()}.`);
  const amount = money(link.amount_cents, link.currency);
  if (link.status === "paid") return page(res, 200, "Thank you", `Your payment of ${amount} for ${link.description} has been received.`);
  return page(res, 200, "Thank you", `Your payment of ${amount} for ${link.description} has been submitted. Card payments are confirmed in a moment; bank debits take about 3 to 5 business days. ${brandName()} will see the payment as soon as it clears.`);
}));

// ------------------------------------------------------------------ public: Stripe Connect events
router.post("/stripe/webhook", safeHandler(async (req: any, res: any) => {
  const cfg = stripeConfig();
  if (!cfg) return res.status(503).json({ ok: false, error: "not_configured" });
  const raw: Buffer | undefined = req.rawBody;
  if (!raw || !verifyStripeSignature(raw, String(req.headers["stripe-signature"] ?? ""), cfg.webhookSecret)) {
    console.warn("[payments] Stripe webhook with a bad signature refused");
    return res.status(400).json({ ok: false, error: "bad_signature" });
  }
  let event: any;
  try { event = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).json({ ok: false, error: "bad_json" }); }
  if (!(await firstDelivery(db(), event))) return res.json({ ok: true, duplicate: true });
  try {
    const r = await handleStripeEvent(db(), event, { recordInQuickBooks: async (id) => { await recordInQuickBooks(pool, id); } });
    return res.json({ ok: true, handled: r.handled });
  } catch (err) {
    // Let Stripe retry: forget the delivery so the retry is handled.
    await db().query(`DELETE FROM stripe_webhook_events WHERE event_id = $1`, [String(event?.id ?? "")]);
    console.error("[payments] Stripe event failed", { type: event?.type, id: event?.id, message: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ ok: false, error: "event_failed" });
  }
}));

export default router;
