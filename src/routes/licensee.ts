// KS_SERVER_v1_LICENSEE - GET /api/licensee (public: branding and addresses for the apps)
// and PUT /api/licensee (the licensee's admin edits the company details and branding).
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { publicLicensee, updateLicenseeSettings } from "../licensee/settings.js";

const router = Router();

router.get("/", safeHandler(async (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json({ ok: true, licensee: await publicLicensee(pool) });
}));

router.put("/", auth, requireAuthorization({ roles: [ROLES.ADMIN] }), safeHandler(async (req: any, res) => {
  const userId = String(req.user?.userId ?? req.user?.id ?? req.user?.sub ?? "");
  const r = await updateLicenseeSettings(pool, req.body ?? {}, userId);
  if (!r.ok) return res.status(400).json({ ok: false, error: "invalid_settings", errors: r.errors });
  return res.json({ ok: true, licensee: await publicLicensee(pool) });
}));

export default router;
