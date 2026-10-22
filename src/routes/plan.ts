// KS_SERVER_v6_PLANS - the copy's plan and its one free trial.
//   GET  /api/plan                   any signed-in staff: plan, trial, features, allowances, storage, trial usage
//   POST /api/plan/trial             Admin: start the free 14-day trial (409 { reason } when not available)
//   POST /api/plan/upgrade-request   Admin: { plan, extra_storage_blocks? } - emails Keystone sales
//   PUT  /api/plan                   operations only (X-KS-Ops-Key = KS_OPS_KEY): { plan?, extra_storage_blocks? }
// Licensee admins cannot change their own plan; that is set by operations.
import { createHash, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { brandName } from "../licensee/brand.js";
import { featureDef, isPlan, trialStatus } from "../plans/catalogue.js";
import { bodies, salesEmail, sendPlanMail } from "../plans/email.js";
import { planOverview, storageFor } from "../plans/overview.js";
import { getPlanState, setPlan, startTrial, trialUsage, type Q } from "../plans/state.js";

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
  if (!r.ok) {
    console.warn("[plan] upgrade request email failed", r.error);
    return res.status(502).json({ ok: false, error: "email_failed" });
  }
  return res.json({ ok: true });
}));

router.put("/", safeHandler(async (req: any, res) => {
  if (!String(process.env.KS_OPS_KEY ?? "")) return res.status(403).json({ ok: false, error: "plan_changes_disabled" });
  if (!opsKeyMatches(req.headers["x-ks-ops-key"])) return res.status(401).json({ ok: false, error: "invalid_ops_key" });
  const rawPlan = req.body?.plan;
  const plan = rawPlan === undefined ? undefined : String(rawPlan).trim().toLowerCase();
  if (plan !== undefined && !isPlan(plan)) return res.status(400).json({ ok: false, error: "invalid_plan" });
  const blocks = blocksOf(req.body?.extra_storage_blocks);
  if (!blocks.ok) return res.status(400).json({ ok: false, error: "invalid_extra_storage_blocks" });
  if (plan === undefined && blocks.value === undefined) return res.status(400).json({ ok: false, error: "nothing_to_change" });
  const by = String(req.headers["x-ks-ops-user"] ?? "ops").slice(0, 120);
  await setPlan(db(), { plan: plan as any, extra_storage_blocks: blocks.value }, by);
  return res.json(await planOverview(db()));
}));

export default router;
