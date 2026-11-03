// KS_SHARED_HOSTING_v1 - one pg Pool per brokerage, created on first use: max 5 connections, idle connections
// closed after 30 s, the whole pool closed after 10 idle minutes. A pool only ever connects to its own brokerage's
// database (with that brokerage's own role); there is no fallback to another one.
import pg, { type Pool, type PoolConfig } from "pg";
import { currentTenant, NoBrokerageContextError } from "./context.js";
import type { Tenant, TenantContext } from "./types.js";

export const TENANT_POOL_MAX = 5;
export const TENANT_POOL_IDLE_MS = 30_000;
export const TENANT_POOL_CLOSE_AFTER_IDLE_MS = 10 * 60_000;

type Entry = { pool: Pool; url: string; lastUsed: number };
const pools = new Map<string, Entry>();
let sweeper: ReturnType<typeof setInterval> | null = null;

type PoolFactory = (config: PoolConfig, tenant: Tenant) => Pool;
let factory: PoolFactory = (config) => new pg.Pool(config);

/** Tests: build pools another way (null restores pg.Pool). */
export function setTenantPoolFactoryForTests(fn: PoolFactory | null): void {
  factory = fn ?? ((config) => new pg.Pool(config));
}

export function tenantPoolConfig(databaseUrl: string): PoolConfig {
  const isAzure = databaseUrl.includes("postgres.database.azure.com");
  return {
    connectionString: databaseUrl,
    ssl: isAzure ? { rejectUnauthorized: true } : false,
    max: TENANT_POOL_MAX,
    idleTimeoutMillis: TENANT_POOL_IDLE_MS,
    connectionTimeoutMillis: 5_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    statement_timeout: 10_000, // the same as the single-brokerage pool (BF_SERVER_POOL_STATEMENT_TIMEOUT_v186)
  };
}

function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => { void sweepIdlePools(); }, 60_000);
  sweeper.unref?.();
}

/** Close pools that have had nothing checked out and no use for 10 minutes. */
export async function sweepIdlePools(now = Date.now()): Promise<string[]> {
  const closed: string[] = [];
  for (const [code, e] of pools) {
    const busy = (e.pool.totalCount ?? 0) - (e.pool.idleCount ?? 0) > 0 || (e.pool.waitingCount ?? 0) > 0;
    if (busy || now - e.lastUsed < TENANT_POOL_CLOSE_AFTER_IDLE_MS) continue;
    pools.delete(code);
    closed.push(code);
    try { await e.pool.end(); } catch (err) {
      console.warn(JSON.stringify({ event: "ks_tenant_pool_close_failed", tenant: code, message: (err as Error)?.message ?? String(err) }));
    }
  }
  return closed;
}

export function getTenantPool(tenant: Tenant): Pool {
  const existing = pools.get(tenant.code);
  if (existing && existing.url === tenant.databaseUrl) {
    existing.lastUsed = Date.now();
    return existing.pool;
  }
  if (existing) {
    // The registry now names another database URL (password rotated): retire the old pool.
    pools.delete(tenant.code);
    existing.pool.end().catch((err: unknown) => {
      console.warn(JSON.stringify({ event: "ks_tenant_pool_close_failed", tenant: tenant.code, message: (err as Error)?.message ?? String(err) }));
    });
  }
  const pool = factory(tenantPoolConfig(tenant.databaseUrl), tenant);
  pool.on?.("error", (err: Error) => {
    console.warn(JSON.stringify({ event: "db_connection_error", tenant: tenant.code, message: err?.message }));
  });
  pools.set(tenant.code, { pool, url: tenant.databaseUrl, lastUsed: Date.now() });
  startSweeper();
  return pool;
}

export function tenantPoolCount(): number {
  return pools.size;
}

export async function closeAllTenantPools(): Promise<void> {
  const all = [...pools.entries()];
  pools.clear();
  if (sweeper) { clearInterval(sweeper); sweeper = null; }
  for (const [code, e] of all) {
    try { await e.pool.end(); } catch (err) {
      console.warn(JSON.stringify({ event: "ks_tenant_pool_close_failed", tenant: code, message: (err as Error)?.message ?? String(err) }));
    }
  }
}

/** The context a brokerage's requests and jobs run in. */
export function contextFor(tenant: Tenant): TenantContext {
  const env = { ...tenant.env, DATABASE_URL: tenant.databaseUrl };
  return {
    code: tenant.code,
    tenant,
    env,
    get pool(): Pool {
      return getTenantPool(tenant);
    },
  };
}

/** The current brokerage's pool; throws no_brokerage_context outside a brokerage. */
export function currentTenantPool(): Pool {
  const ctx = currentTenant();
  if (!ctx) throw new NoBrokerageContextError("database");
  return ctx.pool;
}

/**
 * The object exported as `pool` / `db` in multi-brokerage mode, so the ~400 modules that import `pool` need no change.
 *   - A method (query, connect, end, on, ...) is a function that finds the current brokerage's pool when it is CALLED,
 *     so a reference taken at import time (`pool.query.bind(pool)`) still goes to the right brokerage later.
 *   - Any other property (totalCount, options, ...) is read from the current brokerage's pool.
 *   - A property assigned on the proxy (src/visibility/scopedDb.ts wraps `pool.query`) is kept on the proxy and
 *     applies to every brokerage; it is never written into one brokerage's pool.
 * Outside a brokerage, calling a method or reading a property throws no_brokerage_context.
 */
export function createTenantPoolProxy(resolve: () => Pool = currentTenantPool): Pool {
  const overrides = new Map<PropertyKey, unknown>();
  const methods = new Map<PropertyKey, (...a: unknown[]) => unknown>();
  const isMethod = (prop: PropertyKey) => typeof (pg.Pool.prototype as unknown as Record<PropertyKey, unknown>)[prop] === "function";
  return new Proxy({} as Pool, {
    get(_t, prop) {
      if (overrides.has(prop)) return overrides.get(prop);
      if (prop === "then" || typeof prop === "symbol") return undefined; // not a thenable; no symbol protocol
      if (isMethod(prop)) {
        let fn = methods.get(prop);
        if (!fn) {
          fn = (...args: unknown[]) => {
            const target = resolve() as unknown as Record<PropertyKey, (...a: unknown[]) => unknown>;
            return target[prop]!.apply(target, args);
          };
          methods.set(prop, fn);
        }
        return fn;
      }
      const target = resolve();
      const v = Reflect.get(target as object, prop, target);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
    set(_t, prop, value) {
      overrides.set(prop, value);
      return true;
    },
    has(_t, prop) {
      return overrides.has(prop) || isMethod(prop) || Reflect.has(resolve() as object, prop);
    },
  });
}
