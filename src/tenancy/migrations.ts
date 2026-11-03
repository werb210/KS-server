// KS_SHARED_HOSTING_v1 - each brokerage database runs the existing migration runner (src/startup/runMigrations.ts):
// at startup for every brokerage that is not cancelled, one at a time; when KS-Ops calls
// POST /api/ops/tenants/:code/migrate; and the first time this instance meets a brokerage it has not migrated yet
// (a brokerage added after this instance started, e.g. on a second instance). The runner itself takes the
// migration advisory lock, so two instances never migrate the same database at once.
import type { Pool } from "pg";
import { runWithTenant } from "./context.js";
import { contextFor } from "./pools.js";
import type { Tenant } from "./types.js";

type Migrator = (pool: Pool, tenant: Tenant) => Promise<void>;

const defaultMigrator: Migrator = async (pool) => {
  const { prepareDatabase } = await import("../db/init.js");
  await prepareDatabase(pool, { beforeMigrations: true });
  const { runMigrations } = await import("../startup/runMigrations.js");
  await runMigrations(pool);
  await prepareDatabase(pool, { beforeMigrations: false });
};
let migrator: Migrator = defaultMigrator;

export function setTenantMigratorForTests(fn: Migrator | null): void {
  migrator = fn ?? defaultMigrator;
  migrated.clear();
  failedAt.clear();
}

/** Brokerages this instance has migrated (code -> database URL it was migrated at). */
const migrated = new Map<string, string>();
const inFlight = new Map<string, Promise<void>>();
const failedAt = new Map<string, number>();
const RETRY_AFTER_FAILURE_MS = 60_000;

/** Run the migrations for one brokerage now (KS-Ops' migrate call, and startup). Throws on failure. */
export function migrateTenantNow(tenant: Tenant): Promise<void> {
  const running = inFlight.get(tenant.code);
  if (running) return running;
  const run = (async () => {
    const started = Date.now();
    console.log(JSON.stringify({ event: "ks_tenant_migrate_start", tenant: tenant.code }));
    try {
      const ctx = contextFor(tenant);
      await runWithTenant(ctx, () => migrator(ctx.pool, tenant));
      migrated.set(tenant.code, tenant.databaseUrl);
      failedAt.delete(tenant.code);
      console.log(JSON.stringify({ event: "ks_tenant_migrate_done", tenant: tenant.code, ms: Date.now() - started }));
    } catch (err) {
      failedAt.set(tenant.code, Date.now());
      const e = err as { message?: unknown; code?: unknown };
      console.error(JSON.stringify({ event: "ks_tenant_migrate_failed", tenant: tenant.code, message: String(e?.message ?? err), code: e?.code ?? null }));
      throw err;
    } finally {
      inFlight.delete(tenant.code);
    }
  })();
  inFlight.set(tenant.code, run);
  return run;
}

export function isTenantMigrated(tenant: Tenant): boolean {
  return migrated.get(tenant.code) === tenant.databaseUrl;
}

/**
 * Make sure this instance has migrated the brokerage before serving it. After a failure it waits a minute before
 * trying again (the request meanwhile gets 503), so a broken database cannot be hammered by every request.
 */
export async function ensureTenantMigrated(tenant: Tenant): Promise<void> {
  if (isTenantMigrated(tenant)) return;
  const failed = failedAt.get(tenant.code);
  if (failed && Date.now() - failed < RETRY_AFTER_FAILURE_MS && !inFlight.has(tenant.code)) {
    throw Object.assign(new Error("brokerage_migration_failed"), { code: "brokerage_migration_failed" });
  }
  await migrateTenantNow(tenant);
}
