// KS_SERVER_PLAN_FIXES (Todd, Oct 26) - on a starter copy the registry refuses snippets and templates (/api/templates),
// automations (/api/automations) and call recording playback with 402 feature_not_in_plan.
// KS_PLAN=starter makes starter the plan in force even with no database (the plan row read fails -> default plan).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express, { Router } from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { clearPlanCache } from "../state.js";

describe("starter refuses snippets, templates, automations and recording playback", () => {
  let app: express.Express;
  const token = jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", id: "11111111-1111-4111-8111-111111111111", role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));

  beforeAll(async () => {
    process.env.KS_PLAN = "starter";
    clearPlanCache();
    const { registerApiRouteMounts } = await import("../../routes/routeRegistry.js");
    const api = Router();
    registerApiRouteMounts(api);
    app = express();
    app.use(express.json());
    app.use("/api", api);
  }, 120_000);

  afterAll(() => {
    delete process.env.KS_PLAN;
    clearPlanCache();
  });

  it("402 feature_not_in_plan", async () => {
    for (const [method, path, feature] of [
      ["get", "/api/templates?snippets=1", "templates"],
      ["post", "/api/templates", "templates"],
      ["get", "/api/templates/quick?channel=sms", "templates"],
      ["get", "/api/automations", "automations"],
      ["post", "/api/automations", "automations"],
      ["get", "/api/automations/catalog", "automations"],
      ["get", "/api/communications/recordings/by-conference/11111111-2222-3333-4444-555555555555/media", "call_recording_playback"],
    ] as const) {
      const r = await (request(app) as any)[method](path).set("Authorization", `Bearer ${token}`).send({});
      expect(r.status, path).toBe(402);
      expect(r.body, path).toMatchObject({ ok: false, error: "feature_not_in_plan", feature });
    }
  });

  it("automations still need sign-in first", async () => {
    expect((await request(app).get("/api/automations")).status).toBe(401);
  });
});
