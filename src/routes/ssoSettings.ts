// KS_SERVER_SSO_API_KEYS - Admin settings for staff single sign-on. Mounted at /api/sso-settings behind the "sso" plan
// feature (402 feature_not_in_plan below Pro unless a trial is running).
//   GET /api/sso-settings   the saved settings, whether each provider is set up on this server, and the redirect
//                           address to register with Microsoft / Google
//   PUT /api/sso-settings   { microsoft_enabled?, google_enabled?, microsoft_tenant_id?, google_hosted_domain?, require_sso? }
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { recordAuditEvent } from "../modules/audit/audit.service.js";
import { clientIpFromRequest } from "../middleware/clientIp.js";
import type { Q } from "../plans/state.js";
import { providerConfig, SSO_PROVIDERS } from "../sso/oidc.js";
import { loadSsoAvailability, parseSsoPatch, readSsoSettings, saveSsoSettings, ssoAvailability } from "../sso/settings.js";
import { checkFeature } from "../plans/catalogue.js";
import { getPlanState } from "../plans/state.js";

const router = Router();
const adminOnly = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const db = () => pool as unknown as Q;

async function view() {
  const a = await loadSsoAvailability(db());
  const providers = Object.fromEntries(SSO_PROVIDERS.map((p) => {
    const cfg = providerConfig(p);
    return [p, { ...a.providers[p], redirect_uri: cfg?.redirectUri ?? null }];
  }));
  return { ok: true, settings: a.settings, providers, require_sso_active: a.require_sso };
}

router.get("/", ...adminOnly, safeHandler(async (_req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await view());
}));

router.put("/", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const userId = String(req.user?.userId ?? req.user?.id ?? req.user?.sub ?? "");
  const parsed = parseSsoPatch(req.body);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: "invalid_settings", message: parsed.error });
  const current = await readSsoSettings(db());
  const next = { ...current, ...parsed.value };
  // Requiring SSO with no working provider would do nothing (it only applies while a provider is offered), so say so
  // instead of saving a switch that looks on but isn't.
  if (next.require_sso && !current.require_sso) {
    const planAllows = checkFeature(await getPlanState(db()), "sso").allowed;
    if (!ssoAvailability(planAllows, next).require_sso) {
      return res.status(400).json({ ok: false, error: "no_provider", message: "Turn on Microsoft or Google sign-in (set up on this server) before requiring single sign-on." });
    }
  }
  const saved = await saveSsoSettings(db(), next, userId);
  try {
    await recordAuditEvent({
      action: "sso_settings_updated", actorUserId: userId || null, targetUserId: null, targetType: "sso_settings", targetId: "1",
      ip: clientIpFromRequest(req) || null, userAgent: String(req.headers?.["user-agent"] ?? "").slice(0, 300) || null,
      success: true, metadata: { before: current, after: saved },
    });
  } catch (err) {
    console.error("[sso] settings audit write failed", (err as Error)?.message);
  }
  res.json(await view());
}));

export default router;
