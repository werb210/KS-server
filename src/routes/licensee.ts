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
import multer from "multer";
import { adminLicensee, publicLicensee, updateLicenseeSettings } from "../licensee/settings.js";
import { BRAND_ASSET_MAX_BYTES, storeBrandAsset } from "../licensee/brandAssets.js"; // KS_SERVER_BRAND_ASSETS_v1

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

// KS_SERVER_BRAND_ASSETS_v1 - POST /api/licensee/brand-asset (Admin, multipart: file + kind=logo|favicon). Saves the
// file and sets logo_url or favicon_url; answers with the admin view.
const brandUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: BRAND_ASSET_MAX_BYTES } });
router.post("/brand-asset", ...adminOnly, (req: any, res: any, next: any) => {
  brandUpload.single("file")(req, res, (err: any) => {
    if (err) return res.status(400).json({ ok: false, error: "invalid_file", message: err.code === "LIMIT_FILE_SIZE" ? "The file is larger than 2 MB." : "The upload could not be read." });
    next();
  });
}, safeHandler(async (req: any, res: any) => {
  const kind = String(req.body?.kind ?? req.query?.kind ?? "");
  const file = req.file as { buffer: Buffer; mimetype: string } | undefined;
  if (!file) return res.status(400).json({ ok: false, error: "invalid_file", message: "Choose an image to upload." });
  let url: string;
  try {
    url = await storeBrandAsset(kind as any, file.buffer, file.mimetype);
  } catch (e: any) {
    if (e?.code === "invalid_file") return res.status(400).json({ ok: false, error: "invalid_file", message: e.message });
    if (e?.code === "storage_not_configured") return res.status(503).json({ ok: false, error: "storage_not_configured", message: "File storage isn't set up for this brokerage yet." });
    throw e;
  }
  const userId = String(req.user?.userId ?? req.user?.id ?? req.user?.sub ?? "");
  const field = kind === "favicon" ? "favicon_url" : "logo_url";
  const r = await updateLicenseeSettings(pool, { [field]: url }, userId);
  if (!r.ok) return res.status(400).json({ ok: false, error: "invalid_settings", errors: r.errors });
  return res.json({ ok: true, url, field, licensee: await adminLicensee(pool) });
}));

export default router;
