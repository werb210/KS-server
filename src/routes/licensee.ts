// KS_SERVER_v1_LICENSEE - GET /api/licensee (public: branding and addresses for the apps)
// and PUT /api/licensee (the licensee's admin edits the company details and branding).
// KS_SERVER_v8_CONNECTIONS - GET /api/licensee/admin (Admin): everything, including the licensee's own connection
// settings (twilio_main_number, google_ads_customer_id, office365_tenant_id), which the public GET never shows.
// PUT accepts those fields too and answers with the admin view.
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { adminLicensee, publicLicensee, updateLicenseeSettings } from "../licensee/settings.js";

const router = Router();

router.get("/", safeHandler(async (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json({ ok: true, licensee: await publicLicensee(pool) });
}));

const adminOnly = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];

router.get("/admin", ...adminOnly, safeHandler(async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, licensee: await adminLicensee(pool) });
}));

router.put("/", ...adminOnly, safeHandler(async (req: any, res) => {
  const userId = String(req.user?.userId ?? req.user?.id ?? req.user?.sub ?? "");
  const r = await updateLicenseeSettings(pool, req.body ?? {}, userId);
  if (!r.ok) return res.status(400).json({ ok: false, error: "invalid_settings", errors: r.errors });
  return res.json({ ok: true, licensee: await adminLicensee(pool) });
}));

export default router;
