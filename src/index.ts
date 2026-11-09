// BF_SERVER_TRACE_DEPRECATION_v183
// v155 added --trace-deprecation to package.json "start". Azure App Service
// launches `node dist/index.js` directly and never runs npm start, so the flag
// has never reached the process and the pg client.query deprecation still has
// no stack. This property is the in-process equivalent and does not depend on
// the startup command or on an app setting.
// KS_SERVER_v2_FRESH_START - `node --trace-deprecation` (npm start) makes this property read-only, and assigning it then
// threw at startup ("Cannot assign to read only property 'traceDeprecation'"), so the server never came up.
try {
  if (!process.traceDeprecation) process.traceDeprecation = true;
} catch {
  /* already on via the command-line flag */
}

// BF_SERVER_BLOCK_v_SAFE_ERROR_LOGGING_v1 - never console.error the raw error
// object: pg errors reference the live Connection (TLSSocket, processID,
// secretKey, query queue), so logging the object leaked DB credentials into the
// Azure log stream and flooded it. Log message + code + stack only.
function logFatal(tag: string, err: unknown): void {
  const e = err as { message?: unknown; code?: unknown; stack?: string } | null | undefined;
  const code = e && e.code != null ? ` (${String(e.code)})` : "";
  console.error(tag, String(e?.message ?? err) + code);
  if (e?.stack) console.error(e.stack);
}

// BF_SERVER_v784_PROCESS_HANDLERS - an unhandled rejection is logged only (one
// stray promise must not take the API down); an uncaught exception leaves the
// process in an undefined state, so log and exit(1) and let the host restart it.
process.on("unhandledRejection", (err) => {
  logFatal("[UNHANDLED REJECTION]", err);
});

process.on("uncaughtException", (err) => {
  logFatal("[UNCAUGHT EXCEPTION]", err);
  process.exit(1);
});

import "./system/errors.js";
import { createApp } from "./app.js";
import { initDb } from "./db/init.js";
import { verifyRequiredTables } from "./db/tableHealthCheck.js";
import { listRoutes } from "./debug/printRoutes.js";
import { pgcryptoAvailable } from "./security/ssnCrypto.js";
import { markReady } from "./startupState.js";
import { startKeepWarm } from "./ops/keepWarm.js";
import { initTeamWebSocket } from "./ws/teamSocket.js"; // BF_SERVER_BLOCK_v750_TEAM_CHAT
import { logGraphConfigStatus } from "./services/email/graphSendService.js"; // BF_SERVER_v72_BLOCK_1_5
import { initializeClientPushProvider } from "./services/clientPushService.js";
import { initializeWatchPushProvider } from "./watch/initWatchPush.js";
import { initializeStaffPushProvider } from "./services/notifications/staffAlerts.js"; // BF_SERVER_v820_WATCH_CALLS
import { assertJwtSecretAtStartup } from "./startup/jwtSecretPolicy.js"; // BF_SERVER_v789_JWT_SECRET_POLICY
import { warnIfOtpHashSaltDerived } from "./modules/auth/otpHashSalt.js"; // BF_SERVER_v789_OTP_HASH_SALT
import { isMultiBrokerage } from "./tenancy/mode.js"; // KS_SHARED_HOSTING_v1

const PORT = Number(process.env.PORT) || 8080;

// KS_SERVER_v10_DEMO - the demo server (DEMO_MODE=true) has no Twilio and sends no texts.
// KS_SHARED_HOSTING_v1 - on the shared server the Verify SID is each brokerage's own (checked per brokerage there).
if (process.env.NODE_ENV === "production" && String(process.env.DEMO_MODE ?? "").toLowerCase() !== "true" && !isMultiBrokerage()) {
  const twilioSid = process.env.TWILIO_VERIFY_SERVICE_SID?.trim();
  const KNOWN_FAKE_SIDS = ["VA_YOUR_REAL_SERVICE_SID_HERE", "your_service_sid", "REPLACE_ME"];

  if (!twilioSid || KNOWN_FAKE_SIDS.some((fakeSid) => twilioSid.toUpperCase().includes(fakeSid.toUpperCase()))) {
    throw new Error(
      "[FATAL] TWILIO_VERIFY_SERVICE_SID must be a real Twilio Verify Service SID (starts with VA). " +
      "Get one at console.twilio.com → Verify → Services.",
    );
  }
}

export async function start(): Promise<void> {
  // KS_SHARED_HOSTING_v1 - KS_CONTROL_DATABASE_URL set: one shared server for every brokerage (src/tenancy/server.ts).
  // Without it, everything below runs exactly as before.
  if (isMultiBrokerage()) {
    const { startSharedServer } = await import("./tenancy/server.js");
    return startSharedServer();
  }
  // BF_SERVER_v789_JWT_SECRET_POLICY - refuse to start on a missing, short or placeholder
  // JWT_SECRET (before any DB work); warn when shorter than 32.
  assertJwtSecretAtStartup(process.env.JWT_SECRET);
  warnIfOtpHashSaltDerived(process.env.OTP_HASH_SALT); // BF_SERVER_v789_OTP_HASH_SALT (logs once)
  // BF_SERVER_BLOCK_v335 -- push init moved after listen. Watch push is
  // optional, so its configuration must not stop the API accepting traffic.
  initializeClientPushProvider();
  // BF_SERVER_PUSH_CONFIG_DIAG_v153 - the provider logs only that it is not
  // configured; this says which variable names are absent, so a restart is
  // enough to diagnose it.
  try {
    const { pushConfigSummary } = await import("./modules/diagnostics/pushConfig.js");
    console.log(JSON.stringify({ event: "push_config", detail: pushConfigSummary() }));
  } catch {
    /* diagnostics must never block start */
  }
  await initDb();

  {
    const { pool } = await import("./db.js");
    const { runMigrations } = await import("./startup/runMigrations.js");
    try {
      // BF_SERVER_v789_MIGRATION_LOCK_WAIT - throws on any migration error and when the
      // migration lock is not acquired within 5 minutes; "All migrations applied" is
      // logged by runMigrations itself, only once every file really is applied.
      await runMigrations(pool);
      logGraphConfigStatus(); // BF_SERVER_v72_BLOCK_1_5
      try {
        const has = await pgcryptoAvailable(pool);
        console.log(JSON.stringify({ event: "ssn_crypto_mode", mode: has ? "pgcrypto" : "node_aes_256_gcm" }));
      } catch (err) {
        console.log(JSON.stringify({ event: "ssn_crypto_mode_check_failed", error: String(err) }));
      }
    } catch (err) {
      logFatal("[MIGRATIONS] FATAL - refusing to start:", err); // BF_SERVER_v789_MIGRATIONS_STRICT
      // Exit so Azure App Service restarts and does not route traffic to a broken schema.
      process.exit(1);
    }
  }
  // KS_SERVER_v4_BRANDING - load the licensee's name before anything sends a message, then refresh it every minute.
  try {
    const { pool } = await import("./db.js");
    const { startBrandRefresh } = await import("./licensee/brand.js");
    await startBrandRefresh(pool).ready;
  } catch (err) {
    console.warn("[startup] licensee brand refresh not started:", err instanceof Error ? err.message : String(err));
  }
  // BF_SERVER_v886_OCR_REEXTRACT (KS port) - once per brokerage database, re-read every stored document with the current
  // field parser (two minutes after start, in the background, one brokerage at a time; never fatal).
  {
    const t = setTimeout(() => {
      void Promise.all([import("./db.js"), import("./modules/ocr/reextract.js"), import("./tenancy/jobs.js")])
        .then(([{ pool }, m, j]) => j.forEachTenant(() => m.runOcrReextractOnce(pool as any), { job: "ocr_reextract" }))
        .catch((err) => console.error("[startup] ocr re-extract failed:", err instanceof Error ? err.message : String(err)));
    }, 120_000);
    (t as any).unref?.();
  }
  // BF_SERVER_TEMPLATE_LANDING_BACKFILL_v28 - repair marketing template landing
  // pages (bad host from a misconfigured LANDING_BASE_URL, or seeded rows that
  // never had html and so never had a page). Deliberately not fatal.
  try {
    const { pool } = await import("./db.js");
    const { backfillTemplateLandingPages } = await import("./startup/templateLandingBackfill.js");
    const out = await backfillTemplateLandingPages(pool);
    console.log(JSON.stringify({ event: "template_landing_backfill", ...out }));
  } catch (err) {
    console.error(JSON.stringify({
      event: "template_landing_backfill_error",
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  await verifyRequiredTables([
    "users",
    "applications",
    "documents",
    "lender_products",
    "audit_events",
    "otp_verifications",
  ]);

  // KS_SERVER_v10_DEMO - no staff accounts on the demo server (prospects get demo tokens from KS-Ops).
  if (process.env.NODE_ENV !== "test" && String(process.env.DEMO_MODE ?? "").toLowerCase() !== "true") {
    try {
      const { pool } = await import("./db.js");
      const { rows } = await pool.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM users WHERE role = 'Admin'"
      );

      const adminCount = rows[0]?.count ?? 0;
      const shouldBootstrap = adminCount === 0 || Boolean(process.env.BOOTSTRAP_ADMIN_PHONE?.trim());

      if (shouldBootstrap) {
        if (adminCount === 0) {
          console.log("[BOOTSTRAP] No admin users found — running seed...");
        } else {
          console.log("[BOOTSTRAP] BOOTSTRAP_ADMIN_PHONE set — running seed...");
        }

        const { seedAdminUser, seedSecondAdminUser } = await import("./db/seed.js");
        await seedAdminUser();
        await seedSecondAdminUser();
        console.log("[BOOTSTRAP] Admin users seeded.");
      }
    } catch (err) {
      console.warn(
        "[BOOTSTRAP] Seed check failed (table may not exist yet):",
        String(err)
      );
    }
  }
  const app = createApp();
  const routeSet = new Set(listRoutes(app).map((entry) => `${entry.method} ${entry.path}`));
  const requiredRoutes = [
    "POST /api/auth/otp/start",
    "POST /api/auth/otp/verify",
  ];

  const missing = requiredRoutes.filter((route) => !routeSet.has(route));
  if (missing.length > 0) {
    throw new Error(`Missing required auth routes: ${missing.join(", ")}`);
  }


  if (!process.env.MAYA_URL && !process.env.MAYA_SERVICE_URL) {
    console.warn(
      "[STARTUP][MAYA] MAYA_URL not set — all /api/maya/* and " +
      "/api/ai/maya/* routes will return 503. Set MAYA_URL on " +
      "App Service to the agent service URL."
    );
  }

  // BF_SERVER_v789_JWT_SECRET_POLICY - JWT_SECRET is validated at the top of start().

  // BF_AZURE_OCR_TERMSHEET_v44 — Azure Blob storage hard-check (production).
  // In development/test the storage factory falls back to LocalBackend.
  if (process.env.NODE_ENV === "production" && !process.env.AZURE_STORAGE_CONNECTION_STRING && String(process.env.DEMO_MODE ?? "").toLowerCase() !== "true") { // KS_SERVER_v10_DEMO - demo files live in Postgres
    throw new Error(
      "[FATAL] AZURE_STORAGE_CONNECTION_STRING is required in production. " +
      "Set it on Azure App Service → Configuration → Application settings."
    );
  }

  // BF_AZURE_OCR_TERMSHEET_v44 — start OCR + banking auto-workers.
  // Both are no-ops if NODE_ENV=test.
  // BF_SERVER_BLOCK_v479_BF_WORKERS_SWITCH - and off where BF_WORKERS_ENABLED=false (staging slot).
  const { bfWorkersEnabled } = await import("./startup/workersSwitch.js");
  // KS_SERVER_v10_DEMO - the demo server's own jobs: progress events to KS-Ops and the expired-session wipe.
  if (process.env.NODE_ENV !== "test" && String(process.env.DEMO_MODE ?? "").toLowerCase() === "true") {
    const { pool } = await import("./db.js");
    const { startDemoWorkers } = await import("./demo/index.js");
    startDemoWorkers(pool);
  }
  // KS_SETTINGS_PACK_v1_SECURITY - every instance (workers or not) enforces the Admin's "require a passkey or two-step
  // sign-in" switch; it is re-read every minute.
  if (process.env.NODE_ENV !== "test") {
    try {
      const { pool } = await import("./db.js");
      const { startSecuritySettingsRefresh } = await import("./security/sessions.js");
      startSecuritySettingsRefresh(pool as any);
    } catch (err) {
      console.error("[startup] security settings refresh failed to start:", err);
    }
  }
  if (process.env.NODE_ENV !== "test" && !bfWorkersEnabled()) {
    console.warn("[startup] BF workers NOT started: BF_WORKERS_ENABLED=false (staging slot) - this instance sends no texts, emails or lender packages");
  }
  if (process.env.NODE_ENV !== "test" && bfWorkersEnabled()) {
    // BF_SERVER_WORKER_STAGGER_v785 - start the background workers one at a time, 1.5 s apart, after the server is
    // already answering. Starting ~30 at once after a restart (e.g. a slot swap) opened a burst of new outbound
    // connections that exhausted Azure's SNAT ports and timed out the database for minutes (Oct 8 2026).
    const staggerMs = Math.max(0, Number(process.env.WORKER_STAGGER_MS ?? 1500));
    const workerStagger = () => new Promise<void>((resolve) => setTimeout(resolve, staggerMs));
    void (async () => {
    const { pool } = await import("./db.js");
    // KS_SERVER_v8_SERVICE_STATUS - workers pause while operations has suspended or cancelled this licensee.
    {
      const { setServiceStoppedCheck } = await import("./workers/claim.js");
      const { serviceStoppedNow } = await import("./plans/serviceGate.js");
      setServiceStoppedCheck(() => serviceStoppedNow(pool as any));
    }
    const workerStops: Array<() => void> = [];
    // KS_SHARED_HOSTING_v1 - the workers themselves moved to startup/backgroundWorkers.ts (unchanged, same order), so
    // the shared server can start the same set once per brokerage.
    const { startBackgroundWorkers } = await import("./startup/backgroundWorkers.js");
    await startBackgroundWorkers(pool, workerStagger, workerStops);

    // BF_SERVER_BLOCK_v665 — graceful shutdown. On container recycle the workers'
    // poll loops must stop BEFORE the pool tears down, otherwise each tick queries
    // a dying pool and logs "Connection terminated due to connection timeout".
    let shuttingDown = false;
    const gracefulShutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[shutdown] ${signal} received — stopping workers, draining pool`);
      for (const stop of workerStops) { try { stop(); } catch { /* ignore */ } }
      // BF_SERVER_v789_WORKER_CLAIM - hand the worker-lock session back first; pool.end() waits for it.
      try { const { closeWorkerLocks } = await import("./workers/claim.js"); await closeWorkerLocks(); }
      catch (err) { console.error("[shutdown] worker lock close failed:", (err as Error)?.message ?? String(err)); }
      try { await pool.end(); } catch (err) { console.error("[shutdown] pool.end failed:", err); }
      process.exit(0);
    };
    process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
    process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
    })().catch((err) => console.error("[startup] worker startup failed", err));
  }

  const httpServer = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on ${PORT}`);
    void import("./lib/netSockets.js").then((m) => m.startSocketReport()).catch((err) => console.warn("[net-sockets] not started", err?.message)); // BF_SERVER_SNAT_REUSE_v784
    markReady();
    startKeepWarm();
    // Optional subsystems come up only once the port is serving.
    try {
      initializeWatchPushProvider();
    } catch (err) {
      console.error(JSON.stringify({ event: "watch_push_init_failed", error: String(err) }));
    }
    // BF_SERVER_v820_WATCH_CALLS - staff dialler alerts; optional, never stops the server.
    try {
      initializeStaffPushProvider();
    } catch (err) {
      console.error(JSON.stringify({ event: "staff_push_init_failed", error: String(err) }));
    }
  });
  initTeamWebSocket(httpServer); // BF_SERVER_BLOCK_v750_TEAM_CHAT
}

if (process.env.NODE_ENV !== "test") {
  // BF_SERVER_v784_PROCESS_HANDLERS - a failed boot must not leave a half-started process.
  start().catch((err) => {
    logFatal("[STARTUP FAILED]", err);
    process.exit(1);
  });
}
