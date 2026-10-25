// KS_SERVER_v6_PLANS - the plan tables and routes against real Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";
import { pool } from "../db.js";
import planRoutes from "../routes/plan.js";
import { requireFeature } from "../plans/requireFeature.js";
import { clearPlanCache } from "../plans/state.js";
import { STORAGE_USED_SQL } from "../plans/storage.js";

const MIGRATION = "migrations/2026_10_22_ks_v6_plans_trial.sql";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const token = (role: string) => jwt.sign({ sub: ADMIN, id: ADMIN, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
let savedPlan: any = null;
let savedUsage: any[] = [];

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/plan", planRoutes);
  a.get("/api/gated", requireFeature("templates"), (_req, res) => { res.json({ ok: true }); });
  return a;
}

describe("KS v6 plans and trial (real Postgres)", () => {
  beforeAll(async () => {
    await pool.query(readFileSync(MIGRATION, "utf8"));
    await pool.query(readFileSync(MIGRATION, "utf8")); // safe to run again
    savedPlan = (await pool.query(`SELECT * FROM licensee_plan WHERE id = 1`)).rows[0] ?? null;
    savedUsage = (await pool.query(`SELECT * FROM plan_trial_feature_usage`)).rows;
    await pool.query(`DELETE FROM licensee_plan`);
    await pool.query(`DELETE FROM plan_trial_feature_usage`);
    await pool.query(`INSERT INTO licensee_plan (id, plan) VALUES (1, 'starter')`);
    clearPlanCache();
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM licensee_plan`).catch((e) => console.warn("cleanup", String(e)));
    await pool.query(`DELETE FROM plan_trial_feature_usage`).catch((e) => console.warn("cleanup", String(e)));
    for (const r of [savedPlan, ...savedUsage].filter(Boolean)) {
      const table = "feature" in r ? "plan_trial_feature_usage" : "licensee_plan";
      const cols = Object.keys(r);
      await pool.query(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(", ")})`, cols.map((c) => r[c]))
        .catch((e) => console.warn("restore", String(e)));
    }
    delete process.env.KS_OPS_KEY;
    clearPlanCache();
  });

  it("GET reads the real schema, including storage and seats", async () => {
    const r = await request(app()).get("/api/plan").set("Authorization", `Bearer ${token("Staff")}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, plan: "starter", effective_plan: "starter", trial: { status: "available" } });
    const used = Number((await pool.query(STORAGE_USED_SQL)).rows[0].used_bytes);
    expect(r.body.storage.used_bytes).toBe(used);
    expect(r.body.storage.seats).toBeGreaterThanOrEqual(1);
    expect(r.body.storage.allowance_bytes).toBe(r.body.storage.seats * 10 * 1024 ** 3);
  });

  it("starts the trial once, counts trial-only feature uses, and ops can change the plan", async () => {
    expect((await request(app()).get("/api/gated")).status).toBe(402);
    const t = await request(app()).post("/api/plan/trial").set("Authorization", `Bearer ${token("Admin")}`);
    expect(t.status).toBe(200);
    expect(t.body.trial.status).toBe("active");
    expect((await request(app()).post("/api/plan/trial").set("Authorization", `Bearer ${token("Admin")}`)).status).toBe(409);

    expect((await request(app()).get("/api/gated")).status).toBe(200);
    expect((await request(app()).get("/api/gated")).status).toBe(200);
    const u = (await pool.query(`SELECT uses FROM plan_trial_feature_usage WHERE feature = 'templates'`)).rows[0];
    expect(u.uses).toBe(2);

    process.env.KS_OPS_KEY = "integration-ops-key";
    expect((await request(app()).put("/api/plan").send({ plan: "pro" })).status).toBe(401);
    // KS_SERVER_v14_TRIAL_GROWTH - the trial runs on growth too, so moving starter -> growth keeps it; pro ends it.
    const g = await request(app()).put("/api/plan").set("X-KS-Ops-Key", "integration-ops-key").send({ plan: "growth", extra_storage_blocks: 1 });
    expect(g.body).toMatchObject({ plan: "growth", effective_plan: "pro", trial: { status: "active" }, storage: { extra_blocks: 1 } });
    const p = await request(app()).put("/api/plan").set("X-KS-Ops-Key", "integration-ops-key").send({ plan: "pro" });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ plan: "pro", effective_plan: "pro", trial: { status: "not_offered" } });
    await request(app()).put("/api/plan").set("X-KS-Ops-Key", "integration-ops-key").send({ plan: "growth" });
    const row = (await pool.query(`SELECT trial_ends_at, trial_ended_sent_at, updated_by FROM licensee_plan WHERE id = 1`)).rows[0];
    expect(new Date(row.trial_ends_at).getTime()).toBeLessThanOrEqual(Date.now());
    expect(row.trial_ended_sent_at).not.toBeNull();
    expect((await request(app()).get("/api/gated")).status).toBe(200); // growth includes templates
    expect((await pool.query(`SELECT uses FROM plan_trial_feature_usage WHERE feature = 'templates'`)).rows[0].uses).toBe(2);
  });
});
