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
      "/watch": "watch_app",
      "/lender": "lender_portal",
      "/referrer": "referrer_portal", // KS_SERVER_v9_PORTAL_PLANS
      "/broker": "broker_portal",
      "/lender-referrals": "lender_portal",
      "/admin/referrers": "referrer_portal",
      "/broker-imports": "broker_portal",
      "/templates": "templates",
      "/reporting": "full_reports", // KS_SERVER_v7_NO_REPORTS_ON_STARTER
      "/sso-settings": "sso", // KS_SERVER_SSO_API_KEYS
      "/api-keys": "api_access", // KS_SERVER_SSO_API_KEYS
      "/custom-fields": "custom_fields", // KS_SERVER_v20_CRM_FIELDS (every plan)
      "/webhook-endpoints": "webhooks", // KS_SERVER_v20_WEBHOOKS
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
    for (const [path, feature] of [["/api/templates", "templates"], ["/api/admin/referrers", "referrer_portal"], ["/api/referrer/me", "referrer_portal"], ["/api/broker/me", "broker_portal"], ["/api/broker-imports", "broker_portal"], ["/api/watch/face", "watch_app"], ["/api/reporting", "full_reports"], ["/api/sso-settings", "sso"], ["/api/api-keys", "api_access"], ["/api/webhook-endpoints", "webhooks"]]) {
      const r = await request(app).get(path);
      expect(r.status, path).toBe(402);
      expect(r.body).toMatchObject({ ok: false, error: "feature_not_in_plan", feature });
    }
  });

  it("leaves other mounts alone", async () => {
    expect((await request(app).get("/api/plan")).status).toBe(401);
    // KS_SERVER_v9_PORTAL_PLANS - the lender portal is on every plan, starter included.
    expect((await request(app).get("/api/lender/me")).status).not.toBe(402);
    expect((await request(app).get("/api/lender-referrals")).status).not.toBe(402);
    expect((await request(app).get("/api/calls")).status).not.toBe(402);
    // KS_SERVER_v20_CRM_FIELDS - custom fields are on every plan.
    expect((await request(app).get("/api/custom-fields")).status).toBe(401);
  });
});
