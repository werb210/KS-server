// KS_SERVER_v23_FORECAST - the forecast against real Postgres: plan gate, stage odds (Admin), a file's close date and
// category, per rep / team / total, goals, Staff seeing only their own, and the Reports card.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pool } from "../db.js";
import forecastRoutes from "../routes/forecast.js";
import { clearPlanCache } from "../plans/state.js";
import { currentMonth } from "../forecast/forecast.js";

const tag = randomUUID().slice(0, 8);
const ADMIN = randomUUID(), REP = randomUUID(), REP2 = randomUUID(), TEAM = randomUUID();
const A1 = randomUUID(), A2 = randomUUID(), A3 = randomUUID();
const tok = (id: string, role: string) => jwt.sign({ sub: id, id, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
let savedPlan: Record<string, any> | null = null;
let savedOdds: any[] = [];
const app = () => { const a = express(); a.use(express.json()); a.use("/api/forecast", forecastRoutes); return a; };
async function setPlan(plan: string) { await pool.query(`DELETE FROM licensee_plan`); await pool.query(`INSERT INTO licensee_plan (id, plan) VALUES (1, $1)`, [plan]); clearPlanCache(); }
const month = currentMonth();
const day = (d: number) => `${month}-${String(d).padStart(2, "0")}`;

describe("KS v23 forecast (real Postgres)", () => {
  beforeAll(async () => {
    const sql = readFileSync("migrations/2026_11_06_ks_v23_forecast.sql", "utf8");
    await pool.query(sql);
    await pool.query(sql);
    savedPlan = (await pool.query(`SELECT * FROM licensee_plan WHERE id = 1`)).rows[0] ?? null;
    savedOdds = (await pool.query(`SELECT stage, probability FROM forecast_stage_probabilities`)).rows;
    for (const [id, role, n] of [[ADMIN, "Admin", "Ada"], [REP, "Staff", "Rita"], [REP2, "Staff", "Ray"]]) {
      await pool.query(`INSERT INTO users (id, email, active, role, first_name, last_name) VALUES ($1, $2, true, $3, $4, $5)`, [id, `${n}-${tag}@example.com`, role, n, tag]);
    }
    await pool.query(`INSERT INTO sales_teams (id, name) VALUES ($1, $2)`, [TEAM, `West ${tag}`]);
    await pool.query(`INSERT INTO sales_team_members (team_id, user_id) VALUES ($1, $2)`, [TEAM, REP]);
    const ins = `INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, owner_user_id, business_legal_name, metadata, submitted_at, silo, requested_amount, funded_amount, funded_at)
                 VALUES ($1, $2, now(), now(), $3, 'RECEIVED', $4, $2, '{}'::jsonb, now(), 'BF', $5, $6, $7)`;
    await pool.query(ins, [A1, `Open ${tag}`, "Offer", REP, 100000, null, null]);
    await pool.query(ins, [A2, `Funded ${tag}`, "Accepted", REP, 50000, 50000, `${day(2)}T18:00:00Z`]);
    await pool.query(ins, [A3, `Other ${tag}`, "In Review", REP2, 200000, null, null]);
    await pool.query(`INSERT INTO report_goals (user_id, month, funding_target, commission_target) VALUES ($1, $2::date, 200000, 4000) ON CONFLICT (user_id, month) DO UPDATE SET commission_target = 4000`, [REP, `${month}-01`]);
  });

  afterAll(async () => {
    const warn = (e: unknown) => console.warn("cleanup", String(e));
    await pool.query(`DELETE FROM report_goals WHERE user_id = ANY($1::uuid[])`, [[ADMIN, REP, REP2]]).catch(warn);
    await pool.query(`DELETE FROM applications WHERE id = ANY($1::text[])`, [[A1, A2, A3]]).catch(warn);
    await pool.query(`DELETE FROM sales_teams WHERE id = $1`, [TEAM]).catch(warn);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ADMIN, REP, REP2]]).catch(warn);
    for (const r of savedOdds) await pool.query(`UPDATE forecast_stage_probabilities SET probability = $2 WHERE stage = $1`, [r.stage, r.probability]).catch(warn);
    await pool.query(`DELETE FROM licensee_plan`).catch(warn);
    if (savedPlan) { const cols = Object.keys(savedPlan); await pool.query(`INSERT INTO licensee_plan (${cols.join(", ")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(", ")})`, cols.map((c) => savedPlan![c])).catch(warn); }
    clearPlanCache();
  });

  it("is growth and up", async () => {
    await setPlan("starter");
    const r = await request(app()).get(`/api/forecast`).set("Authorization", `Bearer ${tok(ADMIN, "Admin")}`);
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ feature: "forecasting", required_plan: "growth" });
  });

  it("Admins edit stage odds; staff set a file's close date and category", async () => {
    await setPlan("growth");
    expect((await request(app()).put(`/api/forecast/stages`).set("Authorization", `Bearer ${tok(REP, "Staff")}`).send({ stages: { Offer: 50 } })).status).toBe(403);
    expect((await request(app()).put(`/api/forecast/stages`).set("Authorization", `Bearer ${tok(ADMIN, "Admin")}`).send({ stages: { Offer: 101 } })).status).toBe(400);
    const s = await request(app()).put(`/api/forecast/stages`).set("Authorization", `Bearer ${tok(ADMIN, "Admin")}`).send({ stages: { Offer: 60 } });
    expect(s.body.stages.find((x: any) => x.stage === "Offer").probability).toBe(60);
    expect((await request(app()).put(`/api/forecast/applications/${A1}`).set("Authorization", `Bearer ${tok(REP, "Staff")}`).send({ forecast_category: "maybe" })).status).toBe(400);
    const f = await request(app()).put(`/api/forecast/applications/${A1}`).set("Authorization", `Bearer ${tok(REP, "Staff")}`).send({ expected_close_date: day(20), forecast_category: "commit" });
    expect(f.body).toMatchObject({ expected_close_date: day(20), forecast_category: "commit", probability: 60, effective_category: "commit" });
    await request(app()).put(`/api/forecast/applications/${A3}`).set("Authorization", `Bearer ${tok(ADMIN, "Admin")}`).send({ expected_close_date: day(25) });
  });

  it("per rep, team and total against goals; staff see only their own", async () => {
    const r = await request(app()).get(`/api/forecast?granularity=month&periods=2`).set("Authorization", `Bearer ${tok(ADMIN, "Admin")}`);
    expect(r.status).toBe(200);
    const rita = r.body.reps.find((x: any) => x.user_id === REP);
    // funded 50,000 x 2% = 1,000 closed; open 100,000 x 2% = 2,000 in commit at 60%
    expect(rita.periods[0]).toMatchObject({ closed: 1000, commit: 3000, best_case: 3000, pipeline: 3000, weighted: 2200, goal_commission: 4000 });
    const ray = r.body.reps.find((x: any) => x.user_id === REP2);
    expect(ray.periods[0]).toMatchObject({ commit: 0, pipeline: 4000, weighted: 1000 }); // In Review 25%
    expect(r.body.teams.find((t: any) => t.team_id === TEAM).periods[0]).toMatchObject({ closed: 1000, commit: 3000 });
    expect(r.body.deals.some((d: any) => d.id === A1 && d.owner_name.startsWith("Rita"))).toBe(true);

    const own = await request(app()).get(`/api/forecast?user_id=${REP2}`).set("Authorization", `Bearer ${tok(REP, "Staff")}`);
    expect(own.body.own).toBe(true);
    expect(own.body.reps.map((x: any) => x.user_id)).toEqual([REP]);
    expect(own.body.teams).toEqual([]);
    const team = await request(app()).get(`/api/forecast?team_id=${TEAM}`).set("Authorization", `Bearer ${tok(ADMIN, "Admin")}`);
    expect(team.body.reps.map((x: any) => x.user_id)).toEqual([REP]);
  });
});
