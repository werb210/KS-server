// KS_SERVER_VENDOR_KEYS - /api/vendor-keys (Admin): the brokerage's own verification-service keys.
//   GET /api/vendor-keys   which are set (secrets show only their last 4 characters), sign-up links, the webhook address
//   PUT /api/vendor-keys   { values: { NAME: "value" | null } }  a string sets it, null or "" removes it
import { Router } from "express";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { serverUrl } from "../licensee/urls.js";
import { loadVendorKeys, saveVendorKeys, sealingKey, VendorKeyError, viewOf } from "../integrations/vendorKeys.js";

const router = Router();
const adminOnly = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];

export const VENDOR_SERVICES = [
  { id: "id", name: "ID checks (Entrust Identity Verification, formerly Onfido)", signup: "https://www.entrust.com/products/identity-verification", what: "Applicants photograph their ID and take a selfie; Entrust checks them. Without it, ID checks go to manual review." },
  { id: "ip", name: "IP location and VPN (ipinfo)", signup: "https://ipinfo.io/signup", what: "Adds VPN, proxy and Tor flags. Without it, the free check still gives the country and data-centre networks." },
  { id: "chatgpt_ads", name: "ChatGPT Ads (OpenAI Ads Manager)", signup: "https://ads.openai.com", what: "Shows your ChatGPT ad campaigns, spend, clicks and conversions on Marketing > Ads > ChatGPT, with pause and resume. Without it, the ChatGPT tab asks for the key." }, // KS_SERVER_CHATGPT_ADS_v1
  { id: "registry", name: "Corporations Canada (federal business registry)", signup: "https://api.ised-isde.canada.ca/", what: "Confirms a federally registered business exists and is active. Without it, the registry check is skipped." },
];

router.get("/", ...adminOnly, safeHandler(async (_req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  const values = await loadVendorKeys(pool);
  res.json({
    services: VENDOR_SERVICES,
    keys: viewOf(values),
    onfido_webhook_url: serverUrl() + "/api/kyc/webhooks/onfido",
    can_save: Boolean(sealingKey()),
  });
}));

router.put("/", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const values = req.body?.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) return res.status(400).json({ error: "values_required" });
  try {
    const saved = await saveVendorKeys(pool, values as Record<string, unknown>, String(req.user?.id ?? req.user?.userId ?? "") || null);
    console.info({ event: "vendor_keys_saved", keys: Object.keys(values) });
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, keys: viewOf(saved) });
  } catch (err) {
    if (err instanceof VendorKeyError) {
      return res.status(err.code === "no_encryption_key" ? 503 : 400).json({ error: err.code });
    }
    throw err;
  }
}));

export default router;
