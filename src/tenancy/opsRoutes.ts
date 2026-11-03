// KS_SHARED_HOSTING_v1 - KS-Ops' calls to the shared server, authorised by the header X-KS-Ops-Service-Key, which
// must equal KS_OPS_SERVICE_KEY (a shared App Service setting; never a brokerage's value).
//   POST /api/ops/tenants/reload         clear the registry cache (after KS-Ops writes ks_tenants)
//   POST /api/ops/tenants/:code/migrate  run the migrations on that brokerage's database now
import { timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { migrateTenantNow } from "./migrations.js";
import { sharedEnv } from "./mode.js";
import { clearRegistryCache, findTenantByCode } from "./registry.js";

export const OPS_SERVICE_KEY_HEADER = "x-ks-ops-service-key";

export function opsServiceKeyMatches(sent: unknown): boolean {
  const expected = String(sharedEnv().KS_OPS_SERVICE_KEY ?? "");
  const got = String(Array.isArray(sent) ? sent[0] : sent ?? "");
  if (!expected || !got) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(got, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireServiceKey(req: Request, res: Response, next: NextFunction) {
  if (!String(sharedEnv().KS_OPS_SERVICE_KEY ?? "")) return res.status(503).json({ error: "ops_service_key_not_configured" });
  if (!opsServiceKeyMatches(req.headers[OPS_SERVICE_KEY_HEADER])) return res.status(401).json({ error: "invalid_ops_service_key" });
  return next();
}

export type TenantOpsHooks = { afterMigrate?: (code: string) => void | Promise<void>; afterReload?: () => void | Promise<void> };

export function tenantOpsRouter(hooks: TenantOpsHooks = {}): Router {
  const router = Router();
  router.use(requireServiceKey);
  router.post("/reload", async (_req, res) => {
    clearRegistryCache();
    try { await hooks.afterReload?.(); } catch (err) {
      console.error(JSON.stringify({ event: "ks_tenants_reload_hook_failed", message: (err as Error)?.message ?? String(err) }));
    }
    res.json({ ok: true });
  });
  router.post("/:code/migrate", async (req, res) => {
    const code = String(req.params.code ?? "").trim().toLowerCase();
    clearRegistryCache(); // the row KS-Ops just wrote
    let tenant;
    try {
      tenant = await findTenantByCode(code);
    } catch (err) {
      console.error(JSON.stringify({ event: "ks_tenant_migrate_registry_failed", tenant: code, message: (err as Error)?.message ?? String(err) }));
      return res.status(503).json({ error: "registry_unavailable" });
    }
    if (!tenant) return res.status(404).json({ error: "unknown_brokerage" });
    if (tenant.status === "cancelled") return res.status(410).json({ error: "brokerage_closed" });
    const started = Date.now();
    try {
      await migrateTenantNow(tenant);
    } catch (err) {
      return res.status(500).json({ ok: false, error: "migration_failed", message: (err as Error)?.message ?? String(err) });
    }
    try { await hooks.afterMigrate?.(code); } catch (err) {
      console.error(JSON.stringify({ event: "ks_tenant_after_migrate_failed", tenant: code, message: (err as Error)?.message ?? String(err) }));
    }
    return res.json({ ok: true, code, ms: Date.now() - started });
  });
  return router;
}
