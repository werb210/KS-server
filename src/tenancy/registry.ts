// KS_SHARED_HOSTING_v1 - the brokerage registry: table ks_tenants in the control database (KS_CONTROL_DATABASE_URL,
// read with the SELECT-only role ks_control_reader). KS-Ops owns and writes it. Cached for 60 seconds;
// POST /api/ops/tenants/reload clears the cache.
import pg from "pg";
import { decryptTenantEnv, decryptTenantValue } from "./crypto.js";
import { sharedEnv } from "./mode.js";
import type { Tenant } from "./types.js";

export const REGISTRY_CACHE_MS = 60_000;

export type RegistryRow = {
  code: string;
  licensee_id: string | null;
  status: string;
  api_hosts: string[] | null;
  portal_hosts: string[] | null;
  client_hosts: string[] | null;
  database_name: string;
  database_url_enc: string;
  env_enc: string | null;
  updated_at: Date | string | null;
};

export const SELECT_TENANTS_SQL =
  "SELECT code, licensee_id, status, api_hosts, portal_hosts, client_hosts, database_name, database_url_enc, env_enc, updated_at FROM ks_tenants";

type RowLoader = () => Promise<RegistryRow[]>;

let controlPool: pg.Pool | null = null;

function controlDb(): pg.Pool {
  if (!controlPool) {
    const connectionString = String(sharedEnv().KS_CONTROL_DATABASE_URL ?? "").trim();
    controlPool = new pg.Pool({
      connectionString,
      ssl: connectionString.includes("postgres.database.azure.com") ? { rejectUnauthorized: true } : false,
      max: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
    });
    controlPool.on("error", (err) => {
      console.warn(JSON.stringify({ event: "ks_control_pool_error", message: err?.message ?? String(err) }));
    });
  }
  return controlPool;
}

const defaultLoader: RowLoader = async () => (await controlDb().query<RegistryRow>(SELECT_TENANTS_SQL)).rows;
let loader: RowLoader = defaultLoader;

/** Tests: answer the registry from rows instead of the control database (null restores it). */
export function setRegistryLoaderForTests(fn: RowLoader | null): void {
  loader = fn ?? defaultLoader;
  clearRegistryCache();
}

/** A connection to the control database, for the readiness probe (null outside multi-brokerage mode). */
export async function pingControlDb(): Promise<void> {
  if (loader !== defaultLoader) return;
  await controlDb().query("SELECT 1");
}

export function normaliseHost(raw: unknown): string {
  let h = String(Array.isArray(raw) ? raw[0] : raw ?? "").trim().toLowerCase();
  h = h.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "");
  if (h.startsWith("[")) return h.replace(/\]:\d+$/, "]"); // IPv6 literal
  return h.replace(/:\d+$/, "").replace(/\.$/, "");
}

function rowToTenant(row: RegistryRow): Tenant {
  const databaseUrl = decryptTenantValue(row.database_url_enc);
  const env = decryptTenantEnv(row.env_enc ?? "");
  return {
    code: String(row.code),
    licenseeId: row.licensee_id ? String(row.licensee_id) : null,
    status: String(row.status ?? "provisioning"),
    apiHosts: (row.api_hosts ?? []).map(normaliseHost).filter(Boolean),
    portalHosts: (row.portal_hosts ?? []).map(normaliseHost).filter(Boolean),
    clientHosts: (row.client_hosts ?? []).map(normaliseHost).filter(Boolean),
    databaseName: String(row.database_name ?? ""),
    databaseUrl,
    env,
    updatedAt: row.updated_at ? new Date(row.updated_at as string).toISOString() : null,
  };
}

type Snapshot = { at: number; tenants: Tenant[]; byCode: Map<string, Tenant>; byHost: Map<string, Tenant> };
let snapshot: Snapshot | null = null;
let loading: Promise<Snapshot> | null = null;

export function clearRegistryCache(): void {
  snapshot = null;
}

async function load(): Promise<Snapshot> {
  const rows = await loader();
  const tenants: Tenant[] = [];
  for (const row of rows) {
    try {
      tenants.push(rowToTenant(row));
    } catch (err) {
      // A row that cannot be decrypted is unusable; the brokerage answers unknown_brokerage until it is fixed.
      console.error(JSON.stringify({ event: "ks_tenant_row_unreadable", tenant: row?.code, message: (err as Error)?.message ?? String(err) }));
    }
  }
  const byCode = new Map<string, Tenant>();
  const byHost = new Map<string, Tenant>();
  for (const t of tenants) {
    byCode.set(t.code, t);
    for (const h of t.apiHosts) {
      if (byHost.has(h) && byHost.get(h)!.code !== t.code) {
        console.error(JSON.stringify({ event: "ks_tenant_host_duplicate", host: h, tenants: [byHost.get(h)!.code, t.code] }));
        continue;
      }
      byHost.set(h, t);
    }
  }
  return { at: Date.now(), tenants, byCode, byHost };
}

async function getSnapshot(): Promise<Snapshot> {
  if (snapshot && Date.now() - snapshot.at < REGISTRY_CACHE_MS) return snapshot;
  if (!loading) {
    loading = load()
      .then((s) => { snapshot = s; return s; })
      .catch((err) => {
        console.error(JSON.stringify({ event: "ks_registry_load_failed", message: (err as Error)?.message ?? String(err) }));
        // Keep answering from the last good copy while the control database is unreachable.
        if (snapshot) return snapshot;
        throw err;
      })
      .finally(() => { loading = null; });
  }
  return loading;
}

export async function listTenants(): Promise<Tenant[]> {
  return (await getSnapshot()).tenants;
}

export async function findTenantByCode(code: string): Promise<Tenant | null> {
  return (await getSnapshot()).byCode.get(String(code ?? "").trim().toLowerCase()) ?? null;
}

export async function findTenantByHost(host: string): Promise<Tenant | null> {
  const h = normaliseHost(host);
  if (!h) return null;
  return (await getSnapshot()).byHost.get(h) ?? null;
}

/** Statuses whose background jobs run (cancelled never; provisioning has no data yet). */
export function jobsRunFor(status: string): boolean {
  return status !== "cancelled" && status !== "provisioning";
}

/** Statuses whose database is migrated (every brokerage that is not cancelled). */
export function migratesFor(status: string): boolean {
  return status !== "cancelled";
}

export async function closeControlDb(): Promise<void> {
  const p = controlPool;
  controlPool = null;
  if (p) await p.end();
}
