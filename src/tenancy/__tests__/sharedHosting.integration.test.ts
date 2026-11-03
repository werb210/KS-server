// KS_SHARED_HOSTING_v1 - against a real Postgres: a control database with ks_tenants, and two brokerage databases,
// each with its own login role that can connect only to its own database (as KS-Ops provisions them). Two requests
// routed by Host must each see only their own brokerage's rows, through the server's exported `pool` and runQuery.
import express from "express";
import request from "supertest";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const adminUrl = process.env.DATABASE_URL ?? "";
const suffix = randomBytes(3).toString("hex");
const codes = [`it-alpha-${suffix}`, `it-beta-${suffix}`];
const dbName = (code: string) => `ks_${code.replace(/-/g, "_")}`;
const roleName = (code: string) => `${dbName(code)}_app`;
const controlDb = `ks_control_it_${suffix}`;
const KEY = "integration-tenant-key";

function urlFor(database: string, user?: string, password?: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${database}`;
  if (user) { u.username = user; u.password = password ?? ""; }
  return u.toString();
}

async function admin<T>(database: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: urlFor(database) });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

const integration = process.env.VITEST_INTEGRATION === "true" && adminUrl.length > 0;

describe.skipIf(!integration)("shared hosting: two brokerages, two databases, one server", () => {
  let app: express.Express;
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const adminDb = new URL(adminUrl).pathname.slice(1) || "postgres";
    await admin(adminDb, async (c) => {
      await c.query(`CREATE DATABASE ${controlDb}`);
      for (const code of codes) {
        await c.query(`CREATE DATABASE ${dbName(code)}`);
        await c.query(`CREATE ROLE ${roleName(code)} LOGIN PASSWORD '${code}-pw'`);
        await c.query(`REVOKE CONNECT ON DATABASE ${dbName(code)} FROM PUBLIC`);
        await c.query(`GRANT CONNECT ON DATABASE ${dbName(code)} TO ${roleName(code)}`);
      }
    });
    for (const code of codes) {
      await admin(dbName(code), async (c) => {
        await c.query("CREATE TABLE IF NOT EXISTS it_rows (name text NOT NULL)");
        await c.query("INSERT INTO it_rows (name) VALUES ($1), ($2)", [`${code} row 1`, `${code} row 2`]);
        await c.query(`GRANT SELECT, INSERT ON it_rows TO ${roleName(code)}`);
      });
    }

    process.env.KS_CONTROL_DATABASE_URL = urlFor(controlDb);
    process.env.KS_TENANT_KEY = KEY;
    const { encryptTenantValue } = await import("../crypto.js");
    await admin(controlDb, async (c) => {
      await c.query(`CREATE TABLE IF NOT EXISTS ks_tenants (
        code text PRIMARY KEY CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,30}$'),
        licensee_id uuid,
        status text NOT NULL DEFAULT 'provisioning',
        api_hosts text[] NOT NULL DEFAULT '{}',
        portal_hosts text[] NOT NULL DEFAULT '{}',
        client_hosts text[] NOT NULL DEFAULT '{}',
        database_name text NOT NULL,
        database_url_enc text NOT NULL,
        env_enc text NOT NULL DEFAULT '',
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      for (const code of codes) {
        await c.query(
          "INSERT INTO ks_tenants (code, status, api_hosts, database_name, database_url_enc, env_enc) VALUES ($1, 'active', $2, $3, $4, $5)",
          [
            code, [`${code}.api.example.test`], dbName(code),
            encryptTenantValue(urlFor(dbName(code), roleName(code), `${code}-pw`), KEY),
            encryptTenantValue(JSON.stringify({ JWT_SECRET: `${code}-jwt-secret-long-enough-0123456789` }), KEY),
          ],
        );
      }
    });

    // The server's own modules, loaded in multi-brokerage mode (KS_CONTROL_DATABASE_URL is now set).
    const { pool, runQuery } = await import("../../db.js");
    const { deps } = await import("../../system/deps.js");
    deps.db.ready = true;
    deps.db.client = pool;
    const { setTenantMigratorForTests } = await import("../migrations.js");
    setTenantMigratorForTests(async () => {}); // the full KS schema is not needed to prove isolation
    const { patchExpressForTenantContext, tenantMiddleware } = await import("../middleware.js");
    const { closeAllTenantPools } = await import("../pools.js");
    const { closeControlDb } = await import("../registry.js");

    patchExpressForTenantContext();
    app = express();
    app.use(tenantMiddleware());
    app.use(express.json());
    app.get("/api/rows", async (_req, res) => {
      const r = await pool.query<{ name: string; db: string }>("SELECT name, current_database() AS db FROM it_rows ORDER BY name");
      res.json({ rows: r.rows.map((x) => x.name), db: r.rows[0]?.db ?? null });
    });
    app.post("/api/rows", async (req, res) => {
      await runQuery("INSERT INTO it_rows (name) VALUES ($1)", [String(req.body?.name)]);
      const r = await runQuery<{ n: number }>("SELECT count(*)::int AS n FROM it_rows");
      res.json({ count: r.rows[0]?.n });
    });

    cleanup = async () => {
      await closeAllTenantPools();
      await closeControlDb();
      await admin(adminDb, async (c) => {
        for (const d of [controlDb, ...codes.map(dbName)]) await c.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
        for (const code of codes) await c.query(`DROP ROLE IF EXISTS ${roleName(code)}`);
      });
    };
  }, 60_000);

  afterAll(async () => {
    try { await cleanup?.(); } finally { delete process.env.KS_CONTROL_DATABASE_URL; }
  }, 60_000);

  it("routes each request by Host to its own database and rows", async () => {
    const [alpha, beta] = codes as [string, string];
    const a = await request(app).get("/api/rows").set("Host", `${alpha}.api.example.test`);
    const b = await request(app).get("/api/rows").set("Host", `${beta}.api.example.test:443`);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({ rows: [`${alpha} row 1`, `${alpha} row 2`], db: dbName(alpha) });
    expect(b.body).toEqual({ rows: [`${beta} row 1`, `${beta} row 2`], db: dbName(beta) });
  });

  it("writes through runQuery (after the JSON body parser) land only in that brokerage's database", async () => {
    const [alpha, beta] = codes as [string, string];
    const w = await request(app).post("/api/rows").set("Host", `${alpha}.api.example.test`).send({ name: `${alpha} row 3` });
    expect(w.body).toEqual({ count: 3 });
    const b = await request(app).get("/api/rows").set("Host", `${beta}.api.example.test`);
    expect(b.body.rows).toEqual([`${beta} row 1`, `${beta} row 2`]);
  });

  it("answers 404 for an unknown host, and a brokerage's role cannot open another brokerage's database", async () => {
    const r = await request(app).get("/api/rows").set("Host", "nobody.api.example.test");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "unknown_brokerage" });
    const [alpha, beta] = codes as [string, string];
    const c = new pg.Client({ connectionString: urlFor(dbName(beta), roleName(alpha), `${alpha}-pw`) });
    await expect(c.connect()).rejects.toThrow(/permission denied|not have CONNECT/i);
    await c.end().catch((err: unknown) => { console.warn("client end after refused connect", (err as Error)?.message); });
  });
});
