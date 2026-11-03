// KS_SHARED_HOSTING_v1 - one shared KS-server, a separate database per brokerage. See docs/SHARED_HOSTING.md.
export { isMultiBrokerage, sharedEnv } from "./mode.js";
export { encryptTenantValue, decryptTenantValue, decryptTenantEnv } from "./crypto.js";
export {
  currentTenant, currentTenantCode, requireTenant, runWithTenant, tenantKey, tenantLocal, NoBrokerageContextError,
  type TenantLocal,
} from "./context.js";
export {
  listTenants, findTenantByCode, findTenantByHost, clearRegistryCache, normaliseHost, jobsRunFor, migratesFor,
  REGISTRY_CACHE_MS,
} from "./registry.js";
export { getTenantPool, currentTenantPool, createTenantPoolProxy, contextFor, closeAllTenantPools } from "./pools.js";
export { installEnvOverlay, isPerBrokerageKey, PER_BROKERAGE_KEYS, PER_BROKERAGE_PREFIXES } from "./envOverlay.js";
export { tenantMiddleware, resolveTenant, answersWithoutBrokerage, TENANT_HEADER } from "./middleware.js";
export { forEachTenant, serialAcrossTenants } from "./jobs.js";
export { migrateTenantNow, ensureTenantMigrated } from "./migrations.js";
export { tenantOpsRouter, OPS_SERVICE_KEY_HEADER } from "./opsRoutes.js";
export type { Tenant, TenantContext, TenantStatus } from "./types.js";
