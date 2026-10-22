// KS_SERVER_v6_PLANS - the registry puts the feature gate in front of the plan-gated mounts (and only those).
// KS_PLAN=starter makes starter the plan in force even with no database (the plan row read fails -> default plan).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express, { Router } from "express";
import request from "supertest";
import { clearPlanCache } from "../state.js";

let app: express.Express;

describe("plan-gated mounts", () => {
  beforeAll(async () => {
    process.env.KS_PLAN = "starter";
    clearPlanCache();
    const { API_ROUTE_MOUNTS, registerApiRouteMounts } = await import("../../routes/routeRegistry.js");
    expect(Object.fromEntries(API_ROUTE_MOUNTS.filter((m) => m.feature).map((m) => [m.path, m.feature]))).toEqual({
      "/watch": "watch_ipad_apps",
      "/lender": "lender_portal",
      "/lender-referrals": "lender_portal",
      "/admin/referrers": "referrer_portal",
      "/templates": "templates",
    });
    const api = Router();
    registerApiRouteMounts(api);
    app = express();
    app.use(express.json());
    app.use("/api", api);
  }, 120_000); // the registry imports every route module

  afterAll(() => {
    delete process.env.KS_PLAN;
    clearPlanCache();
  });

  it("answers 402 on a starter copy", async () => {
    for (const [path, feature] of [["/api/templates", "templates"], ["/api/lender/me", "lender_portal"], ["/api/admin/referrers", "referrer_portal"], ["/api/watch/face", "watch_ipad_apps"]]) {
      const r = await request(app).get(path);
      expect(r.status, path).toBe(402);
      expect(r.body).toMatchObject({ ok: false, error: "feature_not_in_plan", feature });
    }
  });

  it("leaves other mounts alone", async () => {
    expect((await request(app).get("/api/plan")).status).toBe(401);
    expect((await request(app).get("/api/calls")).status).not.toBe(402);
  });
});
