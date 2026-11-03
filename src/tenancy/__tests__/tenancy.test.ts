// KS_SHARED_HOSTING_v1 - one shared server, a database per brokerage: resolution, encryption, pools, env overlay, jobs.
import express from "express";
import request from "supertest";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptTenantEnv, decryptTenantValue, encryptTenantValue } from "../crypto.js";
import { currentTenantCode, NoBrokerageContextError, runWithTenant, tenantKey, tenantLocal } from "../context.js";
import { createEnvOverlay, installEnvOverlay, uninstallEnvOverlayForTests } from "../envOverlay.js";
import { forEachTenant, serialAcrossTenants } from "../jobs.js";
import { setTenantMigratorForTests } from "../migrations.js";
import { patchExpressForTenantContext, tenantMiddleware } from "../middleware.js";
import { tenantOpsRouter } from "../opsRoutes.js";
import {
  closeAllTenantPools, contextFor, createTenantPoolProxy, getTenantPool, setTenantPoolFactoryForTests, sweepIdlePools,
  TENANT_POOL_CLOSE_AFTER_IDLE_MS, TENANT_POOL_MAX, tenantPoolConfig,
} from "../pools.js";
import { clearRegistryCache, setRegistryLoaderForTests, type RegistryRow } from "../registry.js";
import { createTenantSupervisor } from "../server.js";
import type { Tenant } from "../types.js";

const KEY = "unit-test-tenant-key";
const SECRET_A = "a-very-long-random-jwt-secret-for-northwind-0001";
const SECRET_B = "a-very-long-random-jwt-secret-for-southpoint-0002";

function row(code: string, over: Partial<RegistryRow> = {}, env: Record<string, string> = {}): RegistryRow {
  return {
    code,
    licensee_id: null,
    status: "active",
    api_hosts: [`${code}.api.example.test`],
    portal_hosts: [`${code}.portal.example.test`],
    client_hosts: [`${code}.app.example.test`],
    database_name: `ks_${code}`,
    database_url_enc: encryptTenantValue(`postgres://ks_${code}_app:pw@db.example.test:5432/ks_${code}`, KEY),
    env_enc: encryptTenantValue(JSON.stringify({ JWT_SECRET: code === "northwind" ? SECRET_A : SECRET_B, ...env }), KEY),
    updated_at: null,
    ...over,
  };
}

function tenant(code: string, over: Partial<Tenant> = {}): Tenant {
  return {
    code, licenseeId: null, status: "active", apiHosts: [`${code}.api.example.test`], portalHosts: [], clientHosts: [],
    databaseName: `ks_${code}`, databaseUrl: `postgres://ks_${code}_app:pw@db.example.test/ks_${code}`,
    env: { JWT_SECRET: SECRET_A }, updatedAt: null, ...over,
  };
}

type FakePool = Pool & { url: string; ended: boolean };
function fakeFactory(created: FakePool[]) {
  return (config: { connectionString?: string }) => {
    const p = {
      url: String(config.connectionString),
      ended: false,
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      options: config,
      on: () => p,
      query: async () => ({ rows: [{ db: String(config.connectionString) }], rowCount: 1 }),
      end: async () => { p.ended = true; },
    } as unknown as FakePool;
    created.push(p);
    return p;
  };
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["KS_CONTROL_DATABASE_URL", "KS_TENANT_KEY", "KS_OPS_SERVICE_KEY"]) saved[k] = process.env[k];
  process.env.KS_CONTROL_DATABASE_URL = "postgres://reader:pw@control.example.test/ks_control";
  process.env.KS_TENANT_KEY = KEY;
  setTenantMigratorForTests(async () => {});
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  setRegistryLoaderForTests(null);
  setTenantMigratorForTests(null);
  setTenantPoolFactoryForTests(null);
  await closeAllTenantPools();
  clearRegistryCache();
});

describe("encryption (v1:<iv>:<tag>:<ciphertext>, AES-256-GCM, key = SHA-256(KS_TENANT_KEY))", () => {
  it("round-trips, with a fresh 12-byte IV each time", () => {
    const a = encryptTenantValue("postgres://ks_x_app:secret@host/ks_x", KEY);
    const b = encryptTenantValue("postgres://ks_x_app:secret@host/ks_x", KEY);
    expect(a).not.toBe(b);
    const parts = a.split(":");
    expect(parts[0]).toBe("v1");
    expect(Buffer.from(parts[1]!, "base64")).toHaveLength(12);
    expect(Buffer.from(parts[2]!, "base64")).toHaveLength(16);
    expect(decryptTenantValue(a, KEY)).toBe("postgres://ks_x_app:secret@host/ks_x");
    expect(decryptTenantValue("" + b)).toBe("postgres://ks_x_app:secret@host/ks_x"); // KS_TENANT_KEY from the env
  });

  it("refuses a wrong key, a tampered value and an unknown format", () => {
    const v = encryptTenantValue("héllo", KEY);
    expect(() => decryptTenantValue(v, "another-key")).toThrow();
    const [p0, iv, tag, ct] = v.split(":");
    const flipped = Buffer.from(ct!, "base64"); flipped[0] = flipped[0]! ^ 1;
    expect(() => decryptTenantValue([p0, iv, tag, flipped.toString("base64")].join(":"), KEY)).toThrow();
    expect(() => decryptTenantValue("v2:a:b:c", KEY)).toThrow(/bad_format/);
  });

  it("env_enc decrypts to an object of strings; empty means none", () => {
    expect(decryptTenantEnv(encryptTenantValue(JSON.stringify({ A: "1", B: 2 }), KEY), KEY)).toEqual({ A: "1", B: "2" });
    expect(decryptTenantEnv("", KEY)).toEqual({});
    expect(() => decryptTenantEnv(encryptTenantValue("[1]", KEY), KEY)).toThrow(/not_object/);
  });
});

describe("how a request finds its brokerage", () => {
  function app() {
    patchExpressForTenantContext();
    const a = express();
    a.use(tenantMiddleware());
    a.use(express.json());
    a.get("/health", (_req, res) => { res.json({ status: "ok", tenant: currentTenantCode() }); });
    a.get("/api/whoami", (_req, res) => { res.json({ tenant: currentTenantCode(), jwt: process.env.JWT_SECRET ?? null }); });
    // A JSON body: the parser calls next() from a stream callback, which must not lose the brokerage.
    a.post("/api/echo", (req, res) => { res.json({ tenant: currentTenantCode(), body: req.body }); });
    return a;
  }

  beforeEach(() => {
    installEnvOverlay({ force: true });
    setRegistryLoaderForTests(async () => [row("northwind"), row("southpoint"), row("closedco", { status: "cancelled" })]);
  });
  afterEach(() => uninstallEnvOverlayForTests());

  it("uses X-KS-Tenant first", async () => {
    const r = await request(app()).get("/api/whoami").set("Host", "northwind.api.example.test").set("X-KS-Tenant", "southpoint");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ tenant: "southpoint", jwt: SECRET_B });
  });

  it("otherwise matches the Host header (lowercased, port removed) against api_hosts", async () => {
    const r = await request(app()).get("/api/whoami").set("Host", "NorthWind.API.example.test:443");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ tenant: "northwind", jwt: SECRET_A });
  });

  it("keeps the brokerage through the JSON body parser", async () => {
    const r = await request(app()).post("/api/echo").set("Host", "southpoint.api.example.test").send({ hello: "there" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ tenant: "southpoint", body: { hello: "there" } });
  });

  it("answers 404 unknown_brokerage for an unknown host or code", async () => {
    const r1 = await request(app()).get("/api/whoami").set("Host", "nobody.api.example.test");
    expect(r1.status).toBe(404);
    expect(r1.body).toEqual({ error: "unknown_brokerage" });
    const r2 = await request(app()).get("/api/whoami").set("X-KS-Tenant", "nobody");
    expect(r2.status).toBe(404);
  });

  it("answers 410 brokerage_closed for a cancelled brokerage", async () => {
    const r = await request(app()).get("/api/whoami").set("Host", "closedco.api.example.test");
    expect(r.status).toBe(410);
    expect(r.body).toEqual({ error: "brokerage_closed" });
  });

  it("answers health checks without a brokerage (and without the registry)", async () => {
    setRegistryLoaderForTests(async () => { throw new Error("control database down"); });
    const r = await request(app()).get("/health").set("Host", "nobody.example.test");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "ok", tenant: null });
  });

  it("answers 503 while a brokerage's migrations have failed", async () => {
    setTenantMigratorForTests(async () => { throw new Error("relation exploded"); });
    const r = await request(app()).get("/api/whoami").set("Host", "northwind.api.example.test");
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: "brokerage_unavailable" });
  });

  it("refuses to serve a brokerage without a real JWT_SECRET", async () => {
    setRegistryLoaderForTests(async () => [row("weakco", { env_enc: encryptTenantValue(JSON.stringify({ JWT_SECRET: "changeme" }), KEY) })]);
    const r = await request(app()).get("/api/whoami").set("Host", "weakco.api.example.test");
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: "brokerage_misconfigured" });
  });
});

describe("per-brokerage pools", () => {
  it("gives two brokerages different pools, each on its own database, with the contract's limits", () => {
    const created: FakePool[] = [];
    setTenantPoolFactoryForTests(fakeFactory(created) as any);
    const a = getTenantPool(tenant("northwind"));
    const b = getTenantPool(tenant("southpoint"));
    expect(a).not.toBe(b);
    expect((a as FakePool).url).toContain("/ks_northwind");
    expect((b as FakePool).url).toContain("/ks_southpoint");
    expect(getTenantPool(tenant("northwind"))).toBe(a); // reused
    const cfg = tenantPoolConfig("postgres://x@y/z");
    expect(cfg.max).toBe(TENANT_POOL_MAX);
    expect(cfg.max).toBe(5);
    expect(cfg.idleTimeoutMillis).toBe(30_000);
  });

  it("the shared pool proxy queries the current brokerage's pool and throws no_brokerage_context outside one", async () => {
    setTenantPoolFactoryForTests(fakeFactory([]) as any);
    const proxy = createTenantPoolProxy();
    const r1 = await runWithTenant(contextFor(tenant("northwind")), () => proxy.query("SELECT 1"));
    const r2 = await runWithTenant(contextFor(tenant("southpoint")), () => proxy.query("SELECT 1"));
    expect(r1.rows[0].db).toContain("/ks_northwind");
    expect(r2.rows[0].db).toContain("/ks_southpoint");
    expect(() => proxy.query("SELECT 1")).toThrow(NoBrokerageContextError);
    expect(() => proxy.query("SELECT 1")).toThrow(/no_brokerage_context/);
  });

  it("replaces a pool when the database URL changes and closes pools idle for 10 minutes", async () => {
    const created: FakePool[] = [];
    setTenantPoolFactoryForTests(fakeFactory(created) as any);
    const first = getTenantPool(tenant("northwind"));
    const second = getTenantPool(tenant("northwind", { databaseUrl: "postgres://ks_northwind_app:new@db/ks_northwind" }));
    expect(second).not.toBe(first);
    await new Promise((r) => setTimeout(r, 0));
    expect((first as FakePool).ended).toBe(true);
    expect(await sweepIdlePools(Date.now())).toEqual([]);
    expect(await sweepIdlePools(Date.now() + TENANT_POOL_CLOSE_AFTER_IDLE_MS + 1)).toEqual(["northwind"]);
    expect((second as FakePool).ended).toBe(true);
  });
});

describe("the process.env overlay", () => {
  const base = { OPENAI_API_KEY: "shared-openai", JWT_SECRET: "shared-should-not-leak", TWILIO_ACCOUNT_SID: "ACshared", NODE_ENV: "test" } as NodeJS.ProcessEnv;
  const env = createEnvOverlay(base);
  const ctx = contextFor(tenant("northwind", { env: { JWT_SECRET: SECRET_A, OPENAI_API_KEY: "northwind-openai" } }));

  it("returns the brokerage's values inside its context", () => {
    runWithTenant(ctx, () => {
      expect(env.JWT_SECRET).toBe(SECRET_A);
      expect(env.OPENAI_API_KEY).toBe("northwind-openai"); // a per-brokerage value overrides a shared one
      expect(env.DATABASE_URL).toContain("/ks_northwind");
      expect(env.NODE_ENV).toBe("test"); // Keystone-wide values stay shared
    });
  });

  it("never falls back to the shared value of a per-brokerage key the brokerage does not have", () => {
    runWithTenant(ctx, () => {
      expect(env.TWILIO_ACCOUNT_SID).toBeUndefined();
      expect("TWILIO_ACCOUNT_SID" in env).toBe(false);
      expect(Object.keys(env)).not.toContain("TWILIO_ACCOUNT_SID");
      expect(Object.keys(env)).toContain("JWT_SECRET");
      expect({ ...env }.JWT_SECRET).toBe(SECRET_A);
    });
  });

  it("is the shared environment outside any brokerage, and writes go to it", () => {
    expect(env.JWT_SECRET).toBe("shared-should-not-leak");
    expect(env.TWILIO_ACCOUNT_SID).toBe("ACshared");
    env.SOME_FLAG = "1";
    expect(base.SOME_FLAG).toBe("1");
  });

  it("installs once as process.env and can be removed", () => {
    const real = process.env;
    expect(installEnvOverlay({ force: true })).toBe(true);
    try {
      expect(process.env).not.toBe(real);
      process.env.KS_OVERLAY_PROBE = "x";
      expect(real.KS_OVERLAY_PROBE).toBe("x");
      runWithTenant(ctx, () => { expect(process.env.JWT_SECRET).toBe(SECRET_A); });
    } finally {
      uninstallEnvOverlayForTests();
      delete process.env.KS_OVERLAY_PROBE;
    }
    expect(process.env).toBe(real);
  });
});

describe("background jobs", () => {
  it("forEachTenant runs once per brokerage in its context, one at a time, past a failing one", async () => {
    const seen: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const r = await forEachTenant(async () => {
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((res) => setTimeout(res, 5));
      concurrent--;
      const code = currentTenantCode()!;
      seen.push(code);
      if (code === "bravo") throw new Error("bravo's database is down");
    }, {
      job: "test_job",
      tenants: [tenant("alpha"), tenant("bravo"), tenant("charlie"), tenant("gone", { status: "cancelled" }), tenant("newco", { status: "provisioning" })],
    });
    expect(seen).toEqual(["alpha", "bravo", "charlie"]);
    expect(r.ran).toEqual(["alpha", "charlie"]);
    expect(r.failed).toEqual([{ code: "bravo", message: "bravo's database is down" }]);
    expect(maxConcurrent).toBe(1);
  });

  it("forEachTenant reads the registry, and runs fn once with no brokerage in single-brokerage mode", async () => {
    setRegistryLoaderForTests(async () => [row("northwind"), row("southpoint")]);
    const seen: Array<string | null> = [];
    await forEachTenant(() => { seen.push(currentTenantCode()); });
    expect(seen).toEqual(["northwind", "southpoint"]);
    delete process.env.KS_CONTROL_DATABASE_URL;
    seen.length = 0;
    await forEachTenant(() => { seen.push(currentTenantCode()); });
    expect(seen).toEqual([null]);
  });

  it("serialAcrossTenants makes one job's brokerages take turns", async () => {
    const order: string[] = [];
    const job = (code: string) => runWithTenant(contextFor(tenant(code)), () => serialAcrossTenants("same_job", async () => {
      order.push(`${code}:start`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`${code}:end`);
    }));
    await Promise.all([job("alpha"), job("bravo")]);
    expect(order).toEqual(["alpha:start", "alpha:end", "bravo:start", "bravo:end"]);
  });

  it("the supervisor starts eligible brokerages and stops cancelled ones", async () => {
    let tenants = [tenant("alpha"), tenant("bravo")];
    const started: string[] = [];
    const stopped: string[] = [];
    const sup = createTenantSupervisor({
      listTenants: async () => tenants,
      isMigrated: () => true,
      startTenantWork: async (t, stops) => {
        expect(currentTenantCode()).toBe(t.code);
        started.push(t.code);
        stops.push(() => stopped.push(t.code));
        if (t.code === "bravo" && started.filter((c) => c === "bravo").length === 1) throw new Error("first start fails");
      },
    });
    await sup.reconcile();
    expect(sup.runningCodes()).toEqual(["alpha"]);
    expect(stopped).toEqual(["bravo"]); // the failed start was cleaned up
    tenants = [tenant("alpha", { status: "cancelled" }), tenant("bravo")];
    await sup.reconcile();
    expect(sup.runningCodes()).toEqual(["bravo"]);
    expect(stopped).toEqual(["bravo", "alpha"]);
    sup.stopAll();
  });
});

describe("caches that would mix brokerages", () => {
  it("tenantKey and tenantLocal keep one value per brokerage, and plain values in single-brokerage mode", () => {
    const slot = tenantLocal(() => 0);
    runWithTenant(contextFor(tenant("alpha")), () => { slot.value = 1; expect(tenantKey("ip:1.2.3.4")).toBe("alpha:ip:1.2.3.4"); });
    runWithTenant(contextFor(tenant("bravo")), () => { expect(slot.value).toBe(0); slot.value = 2; });
    runWithTenant(contextFor(tenant("alpha")), () => { expect(slot.value).toBe(1); });
    expect(slot.value).toBe(0);
    expect(tenantKey("ip:1.2.3.4")).toBe("ip:1.2.3.4");
    delete process.env.KS_CONTROL_DATABASE_URL;
    runWithTenant(contextFor(tenant("alpha")), () => { expect(slot.value).toBe(0); });
  });
});

describe("ops endpoints (X-KS-Ops-Service-Key)", () => {
  function app(hooks = {}) {
    const a = express();
    a.use("/api/ops/tenants", express.json(), tenantOpsRouter(hooks));
    return a;
  }

  it("refuse a missing or wrong key, and answer 503 when no key is configured", async () => {
    process.env.KS_OPS_SERVICE_KEY = "ops-service-key-123";
    expect((await request(app()).post("/api/ops/tenants/reload")).status).toBe(401);
    expect((await request(app()).post("/api/ops/tenants/reload").set("X-KS-Ops-Service-Key", "nope")).status).toBe(401);
    delete process.env.KS_OPS_SERVICE_KEY;
    expect((await request(app()).post("/api/ops/tenants/reload").set("X-KS-Ops-Service-Key", "x")).status).toBe(503);
  });

  it("reload clears the registry cache; migrate runs one brokerage's migrations", async () => {
    process.env.KS_OPS_SERVICE_KEY = "ops-service-key-123";
    let rows = [row("northwind")];
    setRegistryLoaderForTests(async () => rows);
    const migrated: string[] = [];
    setTenantMigratorForTests(async (_pool, t) => { migrated.push(t.code); });
    const after: string[] = [];
    const a = app({ afterMigrate: (c: string) => { after.push(c); } });
    const k = { "X-KS-Ops-Service-Key": "ops-service-key-123" };
    rows = [row("northwind"), row("newco", { status: "provisioning" })];
    expect((await request(a).post("/api/ops/tenants/reload").set(k)).body).toEqual({ ok: true });
    const m = await request(a).post("/api/ops/tenants/newco/migrate").set(k);
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ ok: true, code: "newco" });
    expect(migrated).toEqual(["newco"]);
    expect(after).toEqual(["newco"]);
    expect((await request(a).post("/api/ops/tenants/nobody/migrate").set(k)).status).toBe(404);
    rows = [row("newco", { status: "cancelled" })];
    expect((await request(a).post("/api/ops/tenants/newco/migrate").set(k)).status).toBe(410);
    setTenantMigratorForTests(async () => { throw new Error("boom"); });
    rows = [row("northwind")];
    const f = await request(a).post("/api/ops/tenants/northwind/migrate").set(k);
    expect(f.status).toBe(500);
    expect(f.body).toMatchObject({ ok: false, error: "migration_failed" });
  });
});
