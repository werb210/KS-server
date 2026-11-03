// KS_SHARED_HOSTING_v1 - startup of the shared server (multi-brokerage mode, KS_CONTROL_DATABASE_URL set).
//
// The single-brokerage start() in src/index.ts is unchanged; this is its counterpart for many brokerages:
//   1. the process.env overlay is installed (before anything reads a brokerage's settings);
//   2. every brokerage that is not cancelled is migrated, one at a time (a failure is logged; that brokerage answers
//      503 until a later migrate succeeds, and the others are unaffected);
//   3. the app listens; requests find their brokerage in tenancy/middleware.ts;
//   4. a supervisor starts each brokerage's background work inside that brokerage's context, one brokerage at a time:
//      the brand and security-settings refreshers and (unless BF_WORKERS_ENABLED=false) every worker in
//      startup/backgroundWorkers.ts. Every minute it re-reads the registry: new brokerages are migrated and started,
//      cancelled or removed ones are stopped, and a brokerage whose database URL or settings changed is restarted.
import { createApp } from "../app.js";
import { listRoutes } from "../debug/printRoutes.js";
import { markReady } from "../startupState.js";
import { deps } from "../system/deps.js";
import { runWithTenant } from "./context.js";
import { installEnvOverlay } from "./envOverlay.js";
import { isTenantMigrated, migrateTenantNow } from "./migrations.js";
import { tenantJwtSecretOk } from "./middleware.js";
import { closeAllTenantPools, contextFor } from "./pools.js";
import { closeControlDb, jobsRunFor, listTenants, migratesFor } from "./registry.js";
import type { Tenant } from "./types.js";

export const SUPERVISOR_INTERVAL_MS = 60_000;

type Running = { fingerprint: string; stops: Array<() => void> };

function errMessage(err: unknown): string {
  return (err as { message?: string } | null)?.message ?? String(err);
}

function fingerprint(t: Tenant): string {
  return JSON.stringify([t.databaseUrl, t.status, t.env]);
}

export type SupervisorDeps = {
  /** Start one brokerage's background work; called inside its context. Pushes stop functions. */
  startTenantWork: (tenant: Tenant, stops: Array<() => void>) => Promise<void>;
  /** Tests: the registry. */
  listTenants?: () => Promise<Tenant[]>;
  migrate?: (tenant: Tenant) => Promise<void>;
  isMigrated?: (tenant: Tenant) => boolean;
};

/** Keeps each brokerage's background work running (exported for tests). */
export function createTenantSupervisor(d: SupervisorDeps) {
  const running = new Map<string, Running>();
  let busy: Promise<void> | null = null;
  const list = d.listTenants ?? listTenants;
  const migrate = d.migrate ?? migrateTenantNow;
  const migrated = d.isMigrated ?? isTenantMigrated;

  function stop(code: string): void {
    const r = running.get(code);
    if (!r) return;
    running.delete(code);
    for (const s of r.stops) {
      try { s(); } catch (err) {
        console.warn(JSON.stringify({ event: "ks_tenant_stop_failed", tenant: code, message: errMessage(err) }));
      }
    }
    console.log(JSON.stringify({ event: "ks_tenant_work_stopped", tenant: code }));
  }

  async function start(t: Tenant): Promise<void> {
    if (!migrated(t)) await migrate(t);
    const stops: Array<() => void> = [];
    running.set(t.code, { fingerprint: fingerprint(t), stops });
    await runWithTenant(contextFor(t), () => d.startTenantWork(t, stops));
    console.log(JSON.stringify({ event: "ks_tenant_work_started", tenant: t.code }));
  }

  async function reconcileOnce(): Promise<void> {
    let tenants: Tenant[];
    try {
      tenants = await list();
    } catch (err) {
      console.error(JSON.stringify({ event: "ks_supervisor_registry_failed", message: errMessage(err) }));
      return;
    }
    const wanted = new Map(tenants.filter((t) => jobsRunFor(String(t.status)) && tenantJwtSecretOk(t)).map((t) => [t.code, t]));
    for (const code of [...running.keys()]) {
      const t = wanted.get(code);
      if (!t || running.get(code)!.fingerprint !== fingerprint(t)) stop(code);
    }
    for (const t of wanted.values()) {
      if (running.has(t.code)) continue;
      try {
        await start(t);
      } catch (err) {
        // Not marked running, so the next pass tries again.
        stop(t.code);
        console.error(JSON.stringify({ event: "ks_tenant_work_start_failed", tenant: t.code, message: errMessage(err) }));
      }
    }
  }

  return {
    /** One pass over the registry; passes never overlap. */
    reconcile(): Promise<void> {
      if (!busy) busy = reconcileOnce().finally(() => { busy = null; });
      return busy;
    },
    stopAll(): void {
      for (const code of [...running.keys()]) stop(code);
    },
    runningCodes(): string[] {
      return [...running.keys()];
    },
  };
}

/** Migrate every brokerage that is not cancelled, one at a time. Returns the codes that failed. */
export async function migrateAllTenants(): Promise<string[]> {
  const failed: string[] = [];
  let tenants: Tenant[];
  try {
    tenants = await listTenants();
  } catch (err) {
    console.error(JSON.stringify({ event: "ks_startup_registry_failed", message: errMessage(err) }));
    return failed;
  }
  for (const t of tenants) {
    if (!migratesFor(String(t.status))) continue;
    try {
      await migrateTenantNow(t);
    } catch {
      failed.push(t.code); // migrateTenantNow logged it
    }
  }
  return failed;
}

export async function startSharedServer(): Promise<void> {
  installEnvOverlay();
  console.log(JSON.stringify({ event: "ks_shared_hosting_start" }));
  if (String(process.env.DEMO_MODE ?? "").toLowerCase() === "true") {
    console.warn("[shared] DEMO_MODE is ignored on the shared server; the demo server runs single-brokerage");
  }

  const { initializeClientPushProvider } = await import("../services/clientPushService.js");
  initializeClientPushProvider();
  try {
    const { pushConfigSummary } = await import("../modules/diagnostics/pushConfig.js");
    console.log(JSON.stringify({ event: "push_config", detail: pushConfigSummary() }));
  } catch {
    /* diagnostics must never block start */
  }

  // The shared `pool` delegates to the current brokerage's pool; runQuery() goes through it.
  const { pool } = await import("../db.js");
  deps.db.ready = true;
  deps.db.client = pool;

  const failed = await migrateAllTenants();
  if (failed.length) console.error(JSON.stringify({ event: "ks_startup_migrations_failed", tenants: failed }));

  const supervisor = createTenantSupervisor({ startTenantWork });
  const app = createApp({
    tenantOps: {
      afterMigrate: () => { void supervisor.reconcile(); },
      afterReload: () => { void supervisor.reconcile(); },
    },
  });
  const routeSet = new Set(listRoutes(app).map((entry) => `${entry.method} ${entry.path}`));
  const missing = ["POST /api/auth/otp/start", "POST /api/auth/otp/verify"].filter((r) => !routeSet.has(r));
  if (missing.length > 0) throw new Error(`Missing required auth routes: ${missing.join(", ")}`);

  if (process.env.NODE_ENV === "production" && !process.env.AZURE_STORAGE_CONNECTION_STRING) {
    throw new Error("[FATAL] AZURE_STORAGE_CONNECTION_STRING is required in production.");
  }

  const { setServiceStoppedCheck } = await import("../workers/claim.js");
  const { serviceStoppedNow } = await import("../plans/serviceGate.js");
  // Inside each brokerage's job context, so the plan state read is that brokerage's.
  setServiceStoppedCheck(() => serviceStoppedNow(pool as any));

  const PORT = Number(process.env.PORT) || 8080;
  const httpServer = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on ${PORT} (shared, multi-brokerage)`);
    void import("../lib/netSockets.js").then((m) => m.startSocketReport()).catch((err) => console.warn("[net-sockets] not started", err?.message));
    markReady();
    void import("../ops/keepWarm.js").then((m) => m.startKeepWarm()).catch((err) => console.warn("[keepWarm] not started", err?.message));
    void import("../watch/initWatchPush.js").then((m) => m.initializeWatchPushProvider()).catch((err) => {
      console.error(JSON.stringify({ event: "watch_push_init_failed", error: String(err) }));
    });
    void import("../services/notifications/staffAlerts.js").then((m) => m.initializeStaffPushProvider()).catch((err) => {
      console.error(JSON.stringify({ event: "staff_push_init_failed", error: String(err) }));
    });
  });
  const { initTeamWebSocket } = await import("../ws/teamSocket.js");
  initTeamWebSocket(httpServer);

  if (process.env.NODE_ENV !== "test") {
    void supervisor.reconcile();
    const timer = setInterval(() => { void supervisor.reconcile(); }, SUPERVISOR_INTERVAL_MS);
    timer.unref?.();

    let shuttingDown = false;
    const gracefulShutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[shutdown] ${signal} received - stopping every brokerage's workers, draining pools`);
      clearInterval(timer);
      supervisor.stopAll();
      try { const { closeWorkerLocks } = await import("../workers/claim.js"); await closeWorkerLocks(); }
      catch (err) { console.error("[shutdown] worker lock close failed:", errMessage(err)); }
      try { await closeAllTenantPools(); } catch (err) { console.error("[shutdown] tenant pools close failed:", errMessage(err)); }
      try { await closeControlDb(); } catch (err) { console.error("[shutdown] control database close failed:", errMessage(err)); }
      process.exit(0);
    };
    process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
    process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
  }
}

/** One brokerage's background work, inside its context (what start() does once in single-brokerage mode). */
async function startTenantWork(tenant: Tenant, stops: Array<() => void>): Promise<void> {
  const { pool } = await import("../db.js");
  const { warnIfOtpHashSaltDerived } = await import("../modules/auth/otpHashSalt.js");
  warnIfOtpHashSaltDerived(process.env.OTP_HASH_SALT);

  try {
    const { startBrandRefresh } = await import("../licensee/brand.js");
    const b = startBrandRefresh(pool);
    stops.push(b.stop);
    await b.ready;
  } catch (err) {
    console.warn(JSON.stringify({ event: "ks_tenant_brand_refresh_failed", tenant: tenant.code, message: errMessage(err) }));
  }
  try {
    const { backfillTemplateLandingPages } = await import("../startup/templateLandingBackfill.js");
    const out = await backfillTemplateLandingPages(pool);
    console.log(JSON.stringify({ event: "template_landing_backfill", tenant: tenant.code, ...out }));
  } catch (err) {
    console.error(JSON.stringify({ event: "template_landing_backfill_error", tenant: tenant.code, error: errMessage(err) }));
  }
  try {
    const { verifyRequiredTables } = await import("../db/tableHealthCheck.js");
    await verifyRequiredTables(["users", "applications", "documents", "lender_products", "audit_events", "otp_verifications"]);
  } catch (err) {
    console.error(JSON.stringify({ event: "ks_tenant_required_tables_missing", tenant: tenant.code, message: errMessage(err) }));
  }
  try {
    const { startSecuritySettingsRefresh } = await import("../security/sessions.js");
    stops.push(startSecuritySettingsRefresh(pool as any).stop);
  } catch (err) {
    console.error(JSON.stringify({ event: "ks_tenant_security_refresh_failed", tenant: tenant.code, message: errMessage(err) }));
  }

  const { bfWorkersEnabled } = await import("../startup/workersSwitch.js");
  if (!bfWorkersEnabled()) return;
  const staggerMs = Math.max(0, Number(process.env.WORKER_STAGGER_MS ?? 1500));
  const workerStagger = () => new Promise<void>((resolve) => setTimeout(resolve, staggerMs));
  const { startBackgroundWorkers } = await import("../startup/backgroundWorkers.js");
  await startBackgroundWorkers(pool, workerStagger, stops);
}
