// KS_SERVER_v6_PLANS - the plan routes, the feature gate and the notices, against a database fake that answers by
// SQL content (not call order).
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { queryMock, sendMock } = vi.hoisted(() => ({ queryMock: vi.fn(), sendMock: vi.fn() }));

vi.mock("../../db.js", () => ({ pool: { query: queryMock }, db: { query: queryMock } }));
vi.mock("../email.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../email.js")>();
  return { ...real, sendPlanMail: sendMock };
});

import planRoutes from "../../routes/plan.js";
import { requireFeature } from "../requireFeature.js";
import { clearPlanCache } from "../state.js";
import { runPlanNotices } from "../notices.js";
import { GB } from "../catalogue.js";

type Row = Record<string, any>;
let row: Row | null;
let usage: Record<string, number>;
let usedBytes: number;
let seats: number;

function fakeDb(sql: string, params: unknown[] = []): { rows: any[]; rowCount: number } {
  const ok = (rows: any[]) => ({ rows, rowCount: rows.length });
  if (/FROM licensee_plan WHERE id = 1/.test(sql) && /^\s*SELECT/.test(sql)) return ok(row ? [{ ...row }] : []);
  if (/INSERT INTO licensee_plan/.test(sql)) {
    if (!row) row = { plan: params[0], trial_started_at: null, trial_ends_at: null, extra_storage_blocks: 0 };
    return ok([]);
  }
  if (/UPDATE licensee_plan\s+SET trial_started_at/.test(sql)) {
    if (!row || !["starter", "growth"].includes(row.plan) || row.trial_started_at) return ok([]);
    Object.assign(row, { trial_started_at: new Date(String(params[0])), trial_ends_at: new Date(String(params[1])), trial_started_by: params[2] });
    return ok([{ ...row }]);
  }
  if (/UPDATE licensee_plan SET updated_at/.test(sql)) {
    const planIdx = sql.match(/plan = \$(\d+)/);
    const blocksIdx = sql.match(/extra_storage_blocks = \$(\d+)/);
    if (planIdx) row!.plan = params[Number(planIdx[1]) - 1];
    if (blocksIdx) row!.extra_storage_blocks = params[Number(blocksIdx[1]) - 1];
    if (planIdx && row!.plan === "pro" && row!.trial_ends_at && row!.trial_ends_at > new Date()) row!.trial_ends_at = new Date();
    return ok([]);
  }
  const marker = sql.match(/UPDATE licensee_plan SET (\w+_sent_at) = (now\(\)|NULL)/);
  if (marker) {
    const [, col, val] = marker;
    if (val === "NULL") { row![col] = null; return ok([]); }
    if (row![col]) return ok([]);
    row![col] = new Date();
    if (/storage_80_sent_at = COALESCE/.test(sql)) row!.storage_80_sent_at ??= new Date();
    return ok([{ id: 1 }]);
  }
  if (/INSERT INTO plan_trial_feature_usage/.test(sql)) {
    const k = String(params[0]);
    usage[k] = (usage[k] ?? 0) + 1;
    return ok([]);
  }
  if (/FROM plan_trial_feature_usage/.test(sql)) return ok(Object.entries(usage).map(([feature, uses]) => ({ feature, uses })));
  if (/AS used_bytes/.test(sql)) return ok([{ used_bytes: String(usedBytes) }]);
  if (/AS seats FROM users/.test(sql)) return ok([{ seats }]);
  if (/SELECT email FROM users WHERE role = 'Admin'/.test(sql)) return ok([{ email: "owner@prairie.example" }]);
  return ok([]);
}

const token = (role: string) => jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", id: "11111111-1111-4111-8111-111111111111", role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/plan", planRoutes);
  a.get("/api/gated", requireFeature("call_recording"), (_req, res) => { res.json({ ok: true }); });
  return a;
}

beforeEach(() => {
  row = { plan: "starter", trial_started_at: null, trial_ends_at: null, extra_storage_blocks: 0 };
  usage = {};
  usedBytes = 0;
  seats = 2;
  clearPlanCache();
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: unknown, params?: unknown[]) => fakeDb(String(sql), params ?? []));
  sendMock.mockReset();
  sendMock.mockResolvedValue({ ok: true });
  delete process.env.KS_OPS_KEY;
  delete process.env.KS_PLAN;
});

describe("GET /api/plan", () => {
  it("answers any signed-in staff with the plan, trial, features, allowances and storage", async () => {
    usedBytes = 4 * GB;
    const r = await request(app()).get("/api/plan").set("Authorization", `Bearer ${token("Staff")}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true, plan: "starter", effective_plan: "starter",
      trial: { status: "available", started_at: null, ends_at: null, days_left: null },
      allowances: { minutes_per_seat: 50, texts_per_seat: 100, assistant_chats: 200, trial_bonus_minutes: 0, trial_bonus_texts: 0, storage_gb_per_seat: 10 },
      storage: { used_bytes: 4 * GB, allowance_bytes: 20 * GB, extra_blocks: 0, seats: 2, percent: 20 },
      trial_usage: {},
    });
    expect(r.body.features.contacts).toBe(true);
    expect(r.body.features.call_recording).toBe(false);
    expect(r.body.catalogue).toContainEqual({ key: "lender_portal", label: "Lender portal (lenders can send you deals they can't place)", plan: "starter" }); // KS_SERVER_v9_PORTAL_PLANS
    expect(r.body.catalogue).toContainEqual({ key: "broker_portal", label: "Broker portal", plan: "growth" });
    expect(r.body.features.lender_portal).toBe(true);
    expect(r.body.features.broker_portal).toBe(false);
    expect((await request(app()).get("/api/plan")).status).toBe(401);
  });

  it("with no stored row the default plan (pro) applies", async () => {
    row = null;
    const r = await request(app()).get("/api/plan").set("Authorization", `Bearer ${token("Admin")}`);
    expect(r.body).toMatchObject({ plan: "pro", effective_plan: "pro", trial: { status: "not_offered" } });
  });
});

describe("POST /api/plan/trial", () => {
  it("is Admin only, starts a 14-day pro trial once, then 409s", async () => {
    expect((await request(app()).post("/api/plan/trial").set("Authorization", `Bearer ${token("Staff")}`)).status).toBe(403);
    const r = await request(app()).post("/api/plan/trial").set("Authorization", `Bearer ${token("Admin")}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ plan: "starter", effective_plan: "pro", trial: { status: "active", days_left: 14 } });
    expect(r.body.features.sso).toBe(true);
    expect(r.body.allowances).toMatchObject({ minutes_per_seat: 150, texts_per_seat: 200, assistant_chats: null, storage_gb_per_seat: 50 });
    const ms = new Date(r.body.trial.ends_at).getTime() - new Date(r.body.trial.started_at).getTime();
    expect(ms).toBe(14 * 86_400_000);
    const again = await request(app()).post("/api/plan/trial").set("Authorization", `Bearer ${token("Admin")}`);
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ ok: false, error: "trial_not_available", reason: "active" });
  });

  it("is offered on growth too (KS_SERVER_v14_TRIAL_GROWTH), but not on pro", async () => {
    row!.plan = "growth";
    const r = await request(app()).post("/api/plan/trial").set("Authorization", `Bearer ${token("Admin")}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ plan: "growth", effective_plan: "pro", trial: { status: "active" } });
    row!.plan = "pro";
    row!.trial_started_at = null;
    clearPlanCache();
    const p = await request(app()).post("/api/plan/trial").set("Authorization", `Bearer ${token("Admin")}`);
    expect(p.status).toBe(409);
    expect(p.body.reason).toBe("not_offered");
  });
});

describe("PUT /api/plan (operations)", () => {
  it("is disabled without KS_OPS_KEY and refuses a wrong key or a staff token", async () => {
    expect((await request(app()).put("/api/plan").set("X-KS-Ops-Key", "x").send({ plan: "pro" })).status).toBe(403);
    process.env.KS_OPS_KEY = "ops-secret-123";
    expect((await request(app()).put("/api/plan").set("X-KS-Ops-Key", "wrong").send({ plan: "pro" })).status).toBe(401);
    expect((await request(app()).put("/api/plan").set("Authorization", `Bearer ${token("Admin")}`).send({ plan: "pro" })).status).toBe(401);
    expect(row!.plan).toBe("starter");
  });

  it("sets the plan and extra storage blocks; moving to growth keeps a running trial, moving to pro ends it", async () => {
    process.env.KS_OPS_KEY = "ops-secret-123";
    await request(app()).post("/api/plan/trial").set("Authorization", `Bearer ${token("Admin")}`);
    expect((await request(app()).put("/api/plan").set("X-KS-Ops-Key", "ops-secret-123").send({ plan: "gold" })).status).toBe(400);
    const r = await request(app()).put("/api/plan").set("X-KS-Ops-Key", "ops-secret-123").send({ plan: "growth", extra_storage_blocks: 2 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ plan: "growth", effective_plan: "pro", trial: { status: "active" } });
    expect(row!.trial_ends_at.getTime()).toBeGreaterThan(Date.now());
    const p = await request(app()).put("/api/plan").set("X-KS-Ops-Key", "ops-secret-123").send({ plan: "pro" });
    expect(p.body).toMatchObject({ plan: "pro", effective_plan: "pro", trial: { status: "not_offered" } });
    expect(row!.trial_ends_at.getTime()).toBeLessThanOrEqual(Date.now());
    const back = await request(app()).put("/api/plan").set("X-KS-Ops-Key", "ops-secret-123").send({ plan: "growth" });
    expect(back.body).toMatchObject({ plan: "growth", effective_plan: "growth", trial: { status: "used" } });
    expect(back.body.storage).toMatchObject({ extra_blocks: 2, allowance_bytes: (2 * 25 + 2 * 50) * GB });
  });
});

describe("POST /api/plan/upgrade-request", () => {
  it("is Admin only and emails sales with the plan, extra storage and trial usage", async () => {
    usage = { call_recording: 4 };
    expect((await request(app()).post("/api/plan/upgrade-request").set("Authorization", `Bearer ${token("Staff")}`).send({ plan: "pro" })).status).toBe(403);
    expect((await request(app()).post("/api/plan/upgrade-request").set("Authorization", `Bearer ${token("Admin")}`).send({ plan: "x" })).status).toBe(400);
    const r = await request(app()).post("/api/plan/upgrade-request").set("Authorization", `Bearer ${token("Admin")}`)
      .send({ plan: "starter", extra_storage_blocks: 1 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    const mail = sendMock.mock.calls[0][0];
    expect(mail.to).toEqual(["keystone@boreal.financial"]);
    expect(mail.subject).toContain("+ 1 x 50 GB");
    expect(mail.text).toContain("Current plan: starter");
    expect(mail.text).toContain("Extra storage blocks requested: 1");
    expect(mail.text).toContain("Call recording: 4");
  });

  it("reports a failed send", async () => {
    sendMock.mockResolvedValue({ ok: false, error: "email_not_configured" });
    const r = await request(app()).post("/api/plan/upgrade-request").set("Authorization", `Bearer ${token("Admin")}`).send({ plan: "pro" });
    expect(r.status).toBe(502);
  });
});

describe("requireFeature", () => {
  it("answers 402 with the required plan, and offers the trial when it is available", async () => {
    const r = await request(app()).get("/api/gated");
    expect(r.status).toBe(402);
    expect(r.body).toEqual({ ok: false, error: "feature_not_in_plan", feature: "call_recording", required_plan: "growth", trial_available: true });
  });

  it("counts uses only while the trial is what opens the feature", async () => {
    row!.plan = "growth";
    expect((await request(app()).get("/api/gated")).status).toBe(200);
    expect(usage).toEqual({});

    row = { plan: "starter", trial_started_at: new Date(Date.now() - 86_400_000), trial_ends_at: new Date(Date.now() + 86_400_000), extra_storage_blocks: 0 };
    clearPlanCache();
    expect((await request(app()).get("/api/gated")).status).toBe(200);
    expect((await request(app()).get("/api/gated")).status).toBe(200);
    expect(usage).toEqual({ call_recording: 2 });

    row.trial_ends_at = new Date(Date.now() - 1000);
    clearPlanCache();
    const after = await request(app()).get("/api/gated");
    expect(after.status).toBe(402);
    expect(after.body.trial_available).toBe(false);
    expect(usage).toEqual({ call_recording: 2 });
  });

  it("lets the request through on the default plan when the plan row cannot be read", async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      if (/licensee_plan/.test(String(sql))) throw new Error("relation \"licensee_plan\" does not exist");
      return { rows: [], rowCount: 0 };
    });
    expect((await request(app()).get("/api/gated")).status).toBe(200);
  });
});

describe("plan notices", () => {
  const now = new Date("2026-11-10T12:00:00Z");

  it("warns once with 3 days left and once when the trial ends, naming the features used", async () => {
    row = { plan: "starter", trial_started_at: new Date(now.getTime() - 11 * 86_400_000), trial_ends_at: new Date(now.getTime() + 3 * 86_400_000), extra_storage_blocks: 0 };
    usage = { call_recording: 3, broker_portal: 1 };
    let r = await runPlanNotices({ query: queryMock as any }, now);
    expect(r.sent).toEqual(["trial_warning_sent_at"]);
    expect(sendMock.mock.calls[0][0].subject).toContain("ends in 3 days");
    expect(sendMock.mock.calls[0][0].text).toContain("Call recording, Broker portal");
    expect(sendMock.mock.calls[0][0].to).toEqual(["owner@prairie.example"]);
    r = await runPlanNotices({ query: queryMock as any }, now);
    expect(r.sent).toEqual([]);

    const later = new Date(now.getTime() + 4 * 86_400_000);
    r = await runPlanNotices({ query: queryMock as any }, later);
    expect(r.sent).toEqual(["trial_ended_sent_at"]);
    expect(sendMock.mock.calls[1][0].subject).toContain("has ended");
    expect((await runPlanNotices({ query: queryMock as any }, later)).sent).toEqual([]);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("releases the marker when the send fails, so the next run retries", async () => {
    row = { plan: "starter", trial_started_at: new Date(now.getTime() - 20 * 86_400_000), trial_ends_at: new Date(now.getTime() - 6 * 86_400_000), extra_storage_blocks: 0 };
    sendMock.mockResolvedValueOnce({ ok: false, error: "boom" });
    expect((await runPlanNotices({ query: queryMock as any }, now)).failed).toEqual(["trial_ended_sent_at"]);
    expect(row.trial_ended_sent_at).toBeNull();
    expect((await runPlanNotices({ query: queryMock as any }, now)).sent).toEqual(["trial_ended_sent_at"]);
  });

  it("storage: 80% once, 100% once, and again after usage drops below", async () => {
    row = { plan: "starter", trial_started_at: null, trial_ends_at: null, extra_storage_blocks: 0 };
    seats = 1; // 10 GB
    usedBytes = 8.5 * GB;
    expect((await runPlanNotices({ query: queryMock as any }, now)).sent).toEqual(["storage_80_sent_at"]);
    expect(sendMock.mock.calls[0][0].text).toContain("$10/month for each 50 GB");
    expect((await runPlanNotices({ query: queryMock as any }, now)).sent).toEqual([]);
    usedBytes = 10 * GB;
    expect((await runPlanNotices({ query: queryMock as any }, now)).sent).toEqual(["storage_100_sent_at"]);
    expect(sendMock.mock.calls[1][0].subject).toContain("storage is full");
    expect((await runPlanNotices({ query: queryMock as any }, now)).sent).toEqual([]);
    usedBytes = 5 * GB;
    expect((await runPlanNotices({ query: queryMock as any }, now)).sent).toEqual([]);
    expect(row.storage_80_sent_at).toBeNull();
    expect(row.storage_100_sent_at).toBeNull();
    usedBytes = 12 * GB;
    expect((await runPlanNotices({ query: queryMock as any }, now)).sent).toEqual(["storage_100_sent_at"]);
    usedBytes = 9 * GB; // dips to 90%: no 80% email, since 100% covered it
    expect((await runPlanNotices({ query: queryMock as any }, now)).sent).toEqual([]);
    expect(sendMock).toHaveBeenCalledTimes(3);
  });
});
