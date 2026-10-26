// KS_SERVER_SSO_API_KEYS - Admins create, list and revoke API keys. Mounted at /api/api-keys behind the "api_access"
// plan feature (Pro, or a running trial).
//   GET    /api/api-keys         { ok, data: { keys: [...] } }  name, scope, prefix, created, last used, revoked
//   POST   /api/api-keys         { name, scope: "read" | "read_write" } -> { ok, data: { key, secret } }  (secret shown once)
//   DELETE /api/api-keys/:id     revoke (it stops working at once)
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { recordAuditEvent } from "../modules/audit/audit.service.js";
import { clientIpFromRequest } from "../middleware/clientIp.js";
import type { Q } from "../plans/state.js";
import {
  MAX_ACTIVE_KEYS, countActiveKeys, currentPepper, generateApiKey, insertApiKey, isApiKeyScope, listApiKeys, revokeApiKey,
} from "../apiKeys/keys.js";

const router = Router();
const adminOnly = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const db = () => pool as unknown as Q;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uid(req: any): string {
  return String(req.user?.userId ?? req.user?.id ?? req.user?.sub ?? "");
}

async function audit(req: any, action: string, keyId: string, metadata: Record<string, unknown>) {
  try {
    await recordAuditEvent({
      action, actorUserId: uid(req) || null, targetUserId: null, targetType: "api_key", targetId: keyId,
      ip: clientIpFromRequest(req) || null, userAgent: String(req.headers?.["user-agent"] ?? "").slice(0, 300) || null,
      success: true, metadata,
    });
  } catch (err) {
    console.error("[api-keys] audit write failed", { action, message: (err as Error)?.message });
  }
}

router.get("/", ...adminOnly, safeHandler(async (_req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, data: { keys: await listApiKeys(db()) } });
}));

router.post("/", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const name = String(req.body?.name ?? "").trim();
  const scope = req.body?.scope ?? "read";
  if (!name || name.length > 80) return res.status(400).json({ ok: false, error: "invalid_name", message: "Give the key a name (80 characters at most)." });
  if (!isApiKeyScope(scope)) return res.status(400).json({ ok: false, error: "invalid_scope", message: "Scope must be read or read_write." });
  const pepper = currentPepper();
  if (!pepper) return res.status(503).json({ ok: false, error: "api_keys_not_configured", message: "API keys are not set up on this server yet." });
  if ((await countActiveKeys(db())) >= MAX_ACTIVE_KEYS) {
    return res.status(409).json({ ok: false, error: "too_many_keys", message: `You can have ${MAX_ACTIVE_KEYS} active keys. Revoke one you no longer use first.` });
  }
  const k = generateApiKey(pepper);
  const key = await insertApiKey(db(), k, name, scope, uid(req) || null);
  await audit(req, "api_key_created", key.id, { name, scope, key_prefix: key.key_prefix });
  res.setHeader("Cache-Control", "no-store");
  res.status(201).json({ ok: true, data: { key, secret: k.key } });
}));

router.delete("/:id", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "");
  if (!UUID.test(id)) return res.status(400).json({ ok: false, error: "invalid_id" });
  const key = await revokeApiKey(db(), id, uid(req) || null);
  if (!key) return res.status(404).json({ ok: false, error: "not_found", message: "No active key with that id." });
  await audit(req, "api_key_revoked", key.id, { name: key.name, scope: key.scope, key_prefix: key.key_prefix });
  res.json({ ok: true, data: { key } });
}));

export default router;
