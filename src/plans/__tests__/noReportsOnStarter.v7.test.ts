// KS_SERVER_v7_NO_REPORTS_ON_STARTER - no reports on starter; starter keeps the basic Dashboard sections.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", () => ({ pool: { query: queryMock }, db: { query: queryMock } }));
vi.mock("../../services/reports/data.js", () => ({
  DATA: new Proxy({}, { get: () => async () => ({ rows: [{ ok: 1 }] }) }),
}));

import reportsSection from "../../routes/reportsSection.js";
import { clearPlanCache } from "../state.js";
import { FEATURES, STARTER_DASHBOARD_REPORTS } from "../catalogue.js";

let plan = "starter";
queryMock.mockImplementation(async (sql: string) => {
  if (/FROM licensee_plan/.test(sql) && /^\s*SELECT/.test(sql)) return { rows: [{ plan, trial_started_at: null, trial_ends_at: null, extra_storage_blocks: 0 }], rowCount: 1 };
  if (/FROM users/.test(sql)) return { rows: [{ id: "11111111-1111-4111-8111-111111111111", role: "Admin", email: "a@x.test", silo: "BF", active: true, token_version: 0 }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
});

const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", id: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
const app = express();
app.use(express.json());
app.use("/api/reports", reportsSection);
const get = (path: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);

beforeEach(() => { plan = "starter"; clearPlanCache(); });

describe("no reports on starter", () => {
  it("there is no basic-reports feature; Reports is a growth feature", () => {
    expect(FEATURES.some((f) => f.key === "basic_reports")).toBe(false);
    expect(FEATURES.find((f) => f.key === "full_reports")).toMatchObject({ label: "Reports", plan: "growth" });
  });

  it("starter keeps the basic dashboard sections", async () => {
    for (const key of STARTER_DASHBOARD_REPORTS) expect((await get(`/api/reports/data/${key}`)).status, key).toBe(200);
    const cat = await get("/api/reports/catalog?for=dashboard");
    expect(cat.status).toBe(200);
    expect((cat.body.reports as Array<{ key: string }>).every((r) => STARTER_DASHBOARD_REPORTS.has(r.key))).toBe(true);
  });

  it("every other report, goals and commission tracking answer 402 on starter", async () => {
    for (const path of ["/api/reports/data/stuck_deals", "/api/reports/data/dash_marketing_perf"]) {
      const r = await get(path);
      expect(r.status, path).toBe(402);
      expect(r.body).toMatchObject({ error: "feature_not_in_plan", feature: "full_reports", required_plan: "growth" });
    }
    expect((await request(app).put("/api/reports/goals").set("Authorization", `Bearer ${token}`).send({})).status).toBe(402);
    expect((await get("/api/reports/catalog")).body.reports.length).toBe(0); // the Reports page has nothing to list
  });

  it("growth gets every report", async () => {
    plan = "growth"; clearPlanCache();
    expect((await get("/api/reports/data/stuck_deals")).status).toBe(200);
    expect((await get("/api/reports/catalog")).body.reports.length).toBeGreaterThan(0);
  });
});
