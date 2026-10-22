// KS_SERVER_v9_PORTAL_PLANS - the broker link refuses on a starter copy exactly like the referrer portal does (402
// feature_not_in_plan); a plain referrer sign-up is not stopped by the broker gate.
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  // The plan row cannot be read -> the default plan (KS_PLAN) is in force.
  return { ...actual, pool: { query: async () => { throw new Error("no database in this test"); } } };
});

import { clearPlanCache } from "../state.js";
import referrerSelfRouter from "../../routes/referrerSelf.js";

const app = express();
app.use(express.json());
app.use("/api/referrer", referrerSelfRouter);

describe("broker sign-up gate", () => {
  beforeAll(() => { process.env.KS_PLAN = "starter"; clearPlanCache(); });
  afterAll(() => { delete process.env.KS_PLAN; clearPlanCache(); });

  it("answers 402 broker_portal on starter for the broker link", async () => {
    const r = await request(app).post("/api/referrer/signup").send({ kind: "broker", full_name: "Bea Broker" });
    expect(r.status).toBe(402);
    expect(r.body).toEqual({ ok: false, error: "feature_not_in_plan", feature: "broker_portal", required_plan: "growth", trial_available: true });
  });

  it("lets a plain referrer sign-up reach the handler", async () => {
    const r = await request(app).post("/api/referrer/signup").send({ full_name: "Rae Referrer" });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("name_email_phone_required");
  });

  it("lets the broker link through on growth", async () => {
    process.env.KS_PLAN = "growth";
    clearPlanCache();
    const r = await request(app).post("/api/referrer/signup").send({ kind: "broker", full_name: "Bea Broker" });
    expect(r.status).toBe(400);
  });
});
