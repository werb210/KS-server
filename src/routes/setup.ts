// KS_SETUP_WIZARD - the portal's set-up wizard (src/setup/setupWizard.ts). Every signed-in staff role.
//   GET /api/setup                     -> { ok, role, steps: [{ key, title, why, link, help_slug, status, auto,
//                                           can_mark_done, optional, external_url }], done, total, complete, dismissed }
//   PUT /api/setup/steps/:key { status: "done" | "skipped" | "todo" }  -> the wizard again
//   PUT /api/setup/dismiss                                              -> the wizard again (no longer opens by itself)
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { actorId } from "../settingsPack/common.js";
import type { Q } from "../plans/state.js";
import { buildWizard, dismissWizard, setStepStatus } from "../setup/setupWizard.js";

const router = Router();
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF, ROLES.OPS, ROLES.MARKETING] })];
const db = (): Q => pool as unknown as Q;

const KEY_RE = /^[a-z_]{1,40}$/;

async function answer(req: any, res: any, userId: string) {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, ...(await buildWizard(db(), userId, req.user?.role)) });
}

router.get("/", ...staff, safeHandler(async (req: any, res: any) => {
  const userId = actorId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthenticated" });
  return answer(req, res, userId);
}));

router.put("/steps/:key", ...staff, safeHandler(async (req: any, res: any) => {
  const userId = actorId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthenticated" });
  const key = String(req.params.key ?? "");
  if (!KEY_RE.test(key)) return res.status(404).json({ ok: false, error: "not_found", message: "That step is not in your set-up list." });
  const r = await setStepStatus(db(), userId, req.user?.role, key, req.body?.status);
  if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error, message: r.message });
  return answer(req, res, userId);
}));

router.put("/dismiss", ...staff, safeHandler(async (req: any, res: any) => {
  const userId = actorId(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthenticated" });
  await dismissWizard(db(), userId);
  return answer(req, res, userId);
}));

export default router;
