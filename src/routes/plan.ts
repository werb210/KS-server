// KS_SERVER_v6_PLANS - the copy's plan and its one free trial.
//   GET  /api/plan                   any signed-in staff: plan, trial, features, allowances, storage, trial usage
//   POST /api/plan/trial             Admin: start the free 14-day trial (409 { reason } when not available)
//   POST /api/plan/upgrade-request   Admin: { plan, extra_storage_blocks? } - emails Keystone sales
//   PUT  /api/plan                   operations only (X-KS-Ops-Key = KS_OPS_KEY): { plan?, extra_storage_blocks?, status?, addons? }
//                                    addons = { bank_connect?: boolean } (KS_SERVER_BANK_CONNECT_ADDON; not a plan feature)
//                                    beta_features = [...] this copy's whole beta list (KS_SERVER_BETA_v1, see beta/flags.ts)
//                                    branding = { primary_color, accent_color, background_color, font_family, logo_url }
//                                      chosen at sign-up (KS_SERVER_v15_BRAND_SYNC; the admin's own edits win, see
//                                      licensee/settings.ts applyOpsBranding)
//   GET  /api/plan/usage-report?period=YYYY-MM   operations only: the UsageReport (KS_SERVER_v8_USAGE)
// Licensee admins cannot change their own plan; that is set by operations.
import { createHash, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { brandName } from "../licensee/brand.js";
import { applyOpsBranding, parseOpsBranding } from "../licensee/settings.js";
import { featureDef, isPlan, isServiceStatus, trialStatus } from "../plans/catalogue.js";
import { bodies, salesEmail, sendPlanMail } from "../plans/email.js";
import { planOverview, storageFor } from "../plans/overview.js";
import { getPlanState, setPlan, startTrial, trialUsage, type Q } from "../plans/state.js";
import { buildUsageReport, isPeriod, licenseeTimeZone, periodOf } from "../plans/usage.js"; // KS_SERVER_v8_USAGE
import { postToOps, opsConfig } from "../plans/opsLink.js"; // KS_SERVER_v8_OPS_LINK
import { parseAddonPatch } from "../plans/addons.js"; // KS_SERVER_BANK_CONNECT_ADDON
import { parseBetaPatch, setBetaFeatures } from "../beta/flags.js"; // KS_SERVER_BETA_v1

const router = Router();
const db = () => pool as unknown as Q;
const userIdOf = (req: any) => String(req.user?.userId ?? req.user?.id ?? req.user?.sub ?? "");
const MAX_BLOCKS = 1000;

/** Constant-time comparison of the X-KS-Ops-Key header with KS_OPS_KEY (both hashed, so lengths match). */
export function opsKeyMatches(given: unknown, expected: string | undefined = process.env.KS_OPS_KEY): boolean {
  const want = String(expected ?? "");
  if (!want) return false;
  const a = createHash("sha256").update(String(given ?? "")).digest();
  const b = createHash("sha256").update(want).digest();
  return timingSafeEqual(a, b);
}

function blocksOf(raw: unknown): { ok: true; value: number | undefined } | { ok: false } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: undefined };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_BLOCKS) return { ok: false };
  return { ok: true, value: n };
}

const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF, ROLES.OPS, ROLES.MARKETING] })];
const adminOnly = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];

router.get("/", ...staff, safeHandler(async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await planOverview(db()));
}));

router.post("/trial", ...adminOnly, safeHandler(async (req, res) => {
  const r = await startTrial(db(), userIdOf(req));
  if (!r.ok) return res.status(409).json({ ok: false, error: "trial_not_available", reason: r.reason });
  return res.json(await planOverview(db()));
}));

router.post("/upgrade-request", ...adminOnly, safeHandler(async (req: any, res) => {
  const requested = String(req.body?.plan ?? "").trim().toLowerCase();
  if (!isPlan(requested)) return res.status(400).json({ ok: false, error: "invalid_plan" });
  const blocks = blocksOf(req.body?.extra_storage_blocks);
  if (!blocks.ok) return res.status(400).json({ ok: false, error: "invalid_extra_storage_blocks" });
  const now = new Date();
  const state = await getPlanState(db(), now.getTime());
  const [usage, storage] = await Promise.all([trialUsage(db()), storageFor(db(), state, now)]);
  const usageLines = Object.entries(usage).map(([k, n]) => `${featureDef(k)?.label ?? k}: ${n}`);
  const who = String(req.user?.email ?? userIdOf(req));
  const company = brandName();
  const gb = (n: number) => (n / 1024 ** 3).toFixed(1) + " GB";
  const mail = bodies([
    `${company} has asked for a plan change.`,
    [
      `Licensee: ${company}`,
      `Requested by: ${who}`,
      `Current plan: ${state.plan} (trial: ${trialStatus(state, now)})`,
      `Requested plan: ${requested}`,
      `Extra storage blocks requested: ${blocks.value ?? 0} (currently ${state.extra_storage_blocks})`,
      `Storage: ${gb(storage.used_bytes)} of ${gb(storage.allowance_bytes)} (${storage.percent}%), ${storage.seats} seat(s)`,
    ].join("\n"),
    usageLines.length ? "Trial features used:\n" + usageLines.join("\n") : "Trial features used: none recorded.",
  ]);
  const r = await sendPlanMail({
    to: [salesEmail()],
    subject: `Plan request: ${company} - ${state.plan} to ${requested}${blocks.value ? ` + ${blocks.value} x 50 GB` : ""}`,
    ...mail,
  });
  // KS_SERVER_v8_OPS_LINK - also copy the request to Keystone operations (best effort). When it reached operations the
  // request is not lost, so a failed sales email no longer fails the request.
  let relayed = false;
  if (opsConfig()) {
    const relay = await postToOps("requests", {
      kind: blocks.value ? "plan_and_storage" : "plan",
      current_plan: state.plan,
      requested_plan: requested,
      extra_storage_blocks: blocks.value ?? 0,
      requested_by: who,
      trial: trialStatus(state, now),
      trial_usage: usage,
      storage: { used_bytes: storage.used_bytes, allowance_bytes: storage.allowance_bytes, seats: storage.seats },
      requested_at: now.toISOString(),
    });
    if (!relay.ok) console.warn("[plan] upgrade request copy to operations failed", relay.error);
    relayed = relay.ok;
  }
  if (!r.ok && !relayed) {
    console.warn("[plan] upgrade request email failed", r.error);
    return res.status(502).json({ ok: false, error: "email_failed" });
  }
  if (!r.ok) console.warn("[plan] upgrade request email failed; operations has the copy", r.error);
  return res.json({ ok: true });
}));

/** The ops-key gate shared by PUT /api/plan and GET /api/plan/usage-report. Sends the error and returns false. */
function opsAuthorized(req: any, res: any): boolean {
  if (!String(process.env.KS_OPS_KEY ?? "")) { res.status(403).json({ ok: false, error: "plan_changes_disabled" }); return false; }
  if (!opsKeyMatches(req.headers["x-ks-ops-key"])) { res.status(401).json({ ok: false, error: "invalid_ops_key" }); return false; }
  return true;
}

// KS_SERVER_v8_USAGE - KS-Ops pulls a month's usage (default: the current month in the licensee's time zone).
router.get("/usage-report", safeHandler(async (req: any, res) => {
  if (!opsAuthorized(req, res)) return;
  const now = new Date();
  const raw = req.query?.period;
  const period = raw === undefined || raw === "" ? periodOf(now, licenseeTimeZone()) : String(raw);
  if (!isPeriod(period)) return res.status(400).json({ ok: false, error: "invalid_period" });
  res.setHeader("Cache-Control", "no-store");
  return res.json(await buildUsageReport(db(), period, now));
}));

router.put("/", safeHandler(async (req: any, res) => {
  if (!opsAuthorized(req, res)) return;
  const rawPlan = req.body?.plan;
  const plan = rawPlan === undefined ? undefined : String(rawPlan).trim().toLowerCase();
  if (plan !== undefined && !isPlan(plan)) return res.status(400).json({ ok: false, error: "invalid_plan" });
  const blocks = blocksOf(req.body?.extra_storage_blocks);
  if (!blocks.ok) return res.status(400).json({ ok: false, error: "invalid_extra_storage_blocks" });
  // KS_SERVER_v8_SERVICE_STATUS - { status: trial | active | past_due | suspended | cancelled }
  const rawStatus = req.body?.status;
  const status = rawStatus === undefined || rawStatus === null || rawStatus === "" ? undefined : String(rawStatus).trim().toLowerCase();
  if (status !== undefined && !isServiceStatus(status)) return res.status(400).json({ ok: false, error: "invalid_status" });
  // KS_SERVER_BANK_CONNECT_ADDON - { addons: { bank_connect: true|false } }; only operations can set it.
  const addons = parseAddonPatch(req.body?.addons);
  if (!addons.ok) return res.status(400).json({ ok: false, error: "invalid_addons" });
  const beta = parseBetaPatch(req.body?.beta_features);
  if (!beta.ok) return res.status(400).json({ ok: false, error: "invalid_beta_features" });
  const branding = parseOpsBranding(req.body?.branding); // KS_SERVER_v15_BRAND_SYNC
  if (!branding.ok) return res.status(400).json({ ok: false, error: "invalid_branding" });
  const planChange = plan !== undefined || blocks.value !== undefined || status !== undefined || addons.value !== undefined;
  if (!planChange && beta.value === undefined && branding.value === undefined) return res.status(400).json({ ok: false, error: "nothing_to_change" });
  const by = String(req.headers["x-ks-ops-user"] ?? "ops").slice(0, 120);
  if (planChange) await setPlan(db(), { plan: plan as any, extra_storage_blocks: blocks.value, status: status as any, addons: addons.value }, by);
  if (beta.value !== undefined) await setBetaFeatures(db(), beta.value);
  const brandResult = branding.value !== undefined ? await applyOpsBranding(db(), branding.value) : undefined;
  const overview = await planOverview(db());
  return res.json(brandResult ? { ...overview, branding: brandResult } : overview);
}));

export default router;
