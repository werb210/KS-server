// BF_SERVER_v811_MOBILE_APPS_REPORT - GET /api/reports/mobile-apps?days=30 for the portal's Marketing > Mobile apps
// tab. Staff only (Admin, Staff, Ops, Marketing). The client apps are Boreal Financial's, so this is BF data.
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { clampDays, mobileAppsReport } from "../modules/reporting/mobileApps.js";
import { requireFeature } from "../plans/requireFeature.js"; // KS_SERVER_v7_NO_REPORTS_ON_STARTER

const STAFF_ROLES = new Set(["admin", "staff", "ops", "marketing"]);
const router = Router();

router.get("/mobile-apps", requireAuth, requireFeature("full_reports"), safeHandler(async (req: any, res: any) => {
  if (!STAFF_ROLES.has(String(req.user?.role ?? "").toLowerCase())) return res.status(403).json({ error: "forbidden" });
  res.json(await mobileAppsReport(clampDays(req.query?.days)));
}));

export default router;
