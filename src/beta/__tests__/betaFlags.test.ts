// KS_SERVER_BETA_v1 - beta feature flags: what KS-Ops pushes is stored and read back, isEnabled / requireBeta gate
// code, the Labs routes are admin-only for join/leave and forward to KS-Ops, and feedback is relayed. The database
// fake answers by SQL content (not call order).
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", () => ({ pool: { query: queryMock }, db: { query: queryMock } }));

import betaRoutes from "../../routes/beta.js";
import planRoutes from "../../routes/plan.js";
import { clearPlanCache } from "../../plans/state.js";
import { clearBetaCache, isEnabled, normaliseFeatures, parseBetaPatch, requireBeta } from "../flags.js";

let row: Record<string, any>;
const OPS_KEY = "ks-ops-key-for-tests-0123456789";
const LICENSEE = "22222222-2222-4222-8222-222222222222";

const feature = (over: Record<string, unknown> = {}) => ({
  key: "ai_call_notes", name: "AI call notes", description: "Writes the call note.", status: "public_beta",
  enabled: false, enrolled: false, can_join: true, can_leave: false, feedback_url: null, docs_url: null, ...over,
});

function fakeDb(sql: string, params: unknown[] = []) {
  const ok = (rows: any[]) => ({ rows, rowCount: rows.length });
  if (/SELECT beta_features FROM licensee_plan/.test(sql)) return ok([{ beta_features: row.beta_features }]);
  if (/UPDATE licensee_plan SET beta_features = \$1::jsonb/.test(sql)) {
    row.beta_features = JSON.parse(String(params[0]));
    return ok([]);
  }
  if (/FROM licensee_plan WHERE id = 1/.test(sql) && /^\s*SELECT/.test(sql)) return ok([{ ...row }]);
  if (/AS used_bytes/.test(sql)) return ok([{ used_bytes: "0" }]);
  if (/AS seats FROM users/.test(sql)) return ok([{ seats: 1 }]);
  return ok([]);
}

const token = (role: string) =>
  jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", id: "11111111-1111-4111-8111-111111111111", role, email: "ann@brokerage.example", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/beta", betaRoutes);
  a.use("/api/plan", planRoutes);
  a.get("/api/gated", requireBeta("ai_call_notes"), (_req, res) => { res.json({ ok: true }); });
  return a;
}

const clear = async () => {
  clearBetaCache();
  clearPlanCache();
  (await import("../flags.js")).clearBetaCache();
};

let fetchMock: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  row = { plan: "pro", trial_started_at: null, trial_ends_at: null, extra_storage_blocks: 0, addons: {}, beta_features: [] };
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: unknown, params?: unknown[]) => fakeDb(String(sql), params ?? []));
  process.env.KS_OPS_KEY = OPS_KEY;
  process.env.KS_OPS_URL = "https://ops.example.test";
  process.env.KS_LICENSEE_ID = LICENSEE;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  await clear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.KS_OPS_KEY;
  delete process.env.KS_OPS_URL;
  delete process.env.KS_LICENSEE_ID;
});

describe("normalising what KS-Ops sends", () => {
  it("keeps known fields, drops bad keys, retired items, duplicates and non-https links", () => {
    const out = normaliseFeatures([
      feature({ feedback_url: "http://insecure.example", extra: "x" }),
      feature(),
      { key: "Bad Key", status: "ga" },
      feature({ key: "old_one", status: "retired" }),
    ]);
    expect(out).toEqual([feature()]);
    expect(normaliseFeatures("not json")).toEqual([]);
    expect(parseBetaPatch("nope")).toEqual({ ok: false });
    expect(parseBetaPatch([])).toEqual({ ok: true, value: [] });
    expect(parseBetaPatch(undefined)).toEqual({ ok: true, value: undefined });
  });
});

describe("PUT /api/plan { beta_features } and isEnabled", () => {
  it("stores the list from KS-Ops and turns the gate on and off", async () => {
    expect(await isEnabled("ai_call_notes")).toBe(false);
    expect((await request(app()).get("/api/gated")).status).toBe(404);

    const put = await request(app()).put("/api/plan").set("X-KS-Ops-Key", OPS_KEY).send({ beta_features: [feature({ enabled: true, enrolled: true, can_join: false, can_leave: true })] });
    expect(put.status).toBe(200);
    expect(row.beta_features).toEqual([expect.objectContaining({ key: "ai_call_notes", enabled: true })]);
    await clear();
    expect(await isEnabled("ai_call_notes")).toBe(true);
    expect((await request(app()).get("/api/gated")).status).toBe(200);
    expect((await request(app()).get("/api/beta/flags")).body).toEqual({ enabled: ["ai_call_notes"] });

    await request(app()).put("/api/plan").set("X-KS-Ops-Key", OPS_KEY).send({ plan: "pro", beta_features: [] });
    await clear();
    expect(await isEnabled("ai_call_notes")).toBe(false);
  });

  it("refuses a bad list and a wrong ops key", async () => {
    expect((await request(app()).put("/api/plan").set("X-KS-Ops-Key", OPS_KEY).send({ beta_features: { a: 1 } })).body.error).toBe("invalid_beta_features");
    expect((await request(app()).put("/api/plan").set("X-KS-Ops-Key", "wrong").send({ beta_features: [] })).status).toBe(401);
  });

  it("treats a database failure as off", async () => {
    queryMock.mockImplementation(async () => { throw new Error("relation does not exist"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await isEnabled("ai_call_notes")).toBe(false);
    warn.mockRestore();
  });
});

describe("Labs routes", () => {
  it("lists features for staff and refuses anonymous callers", async () => {
    row.beta_features = [feature()];
    expect((await request(app()).get("/api/beta/features")).status).toBe(401);
    const r = await request(app()).get("/api/beta/features").set("Authorization", `Bearer ${token("Staff")}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ features: [feature()], enabled: [] });
  });

  it("lets only an Admin join, forwards it to KS-Ops and stores the list it answers", async () => {
    row.beta_features = [feature()];
    expect((await request(app()).post("/api/beta/features/ai_call_notes/join").set("Authorization", `Bearer ${token("Staff")}`)).status).toBe(403);
    const joined = [feature({ enabled: true, enrolled: true, can_join: false, can_leave: true })];
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, status: "joined", beta_features: joined }), text: async () => "" });
    const r = await request(app()).post("/api/beta/features/ai_call_notes/join").set("Authorization", `Bearer ${token("Admin")}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: "joined", enabled: ["ai_call_notes"] });
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe(`https://ops.example.test/api/licensees/${LICENSEE}/beta/enrolment`);
    expect(init.headers["X-KS-Ops-Key"]).toBe(OPS_KEY);
    expect(JSON.parse(init.body)).toMatchObject({ feature_key: "ai_call_notes", action: "join", requested_by: "ann@brokerage.example" });
    expect(row.beta_features[0].enabled).toBe(true);
  });

  it("does not forward a join that is not open, a leave that is not allowed, or an unknown feature", async () => {
    row.beta_features = [feature({ can_join: false }), feature({ key: "now_ga", status: "ga", enabled: true, can_leave: false })];
    const admin = { Authorization: `Bearer ${token("Admin")}` };
    expect((await request(app()).post("/api/beta/features/ai_call_notes/join").set(admin)).status).toBe(409);
    expect((await request(app()).post("/api/beta/features/now_ga/leave").set(admin)).status).toBe(409);
    expect((await request(app()).post("/api/beta/features/nope_nope/join").set(admin)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 503 when KS-Ops cannot be reached", async () => {
    row.beta_features = [feature()];
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await request(app()).post("/api/beta/features/ai_call_notes/join").set("Authorization", `Bearer ${token("Admin")}`);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("ops_unavailable");
    warn.mockRestore();
  });

  it("relays feedback to KS-Ops", async () => {
    row.beta_features = [feature({ enabled: true, enrolled: true })];
    fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({ ok: true }), text: async () => "" });
    const auth = { Authorization: `Bearer ${token("Staff")}` };
    expect((await request(app()).post("/api/beta/features/ai_call_notes/feedback").set(auth).send({ message: "  " })).status).toBe(400);
    expect((await request(app()).post("/api/beta/features/ai_call_notes/feedback").set(auth).send({ message: "Good", rating: 9 })).status).toBe(400);
    const r = await request(app()).post("/api/beta/features/ai_call_notes/feedback").set(auth).send({ message: "Saves time.", rating: 4 });
    expect(r.status).toBe(201);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toMatch(/\/beta\/feedback$/);
    expect(JSON.parse(init.body)).toMatchObject({ feature_key: "ai_call_notes", message: "Saves time.", rating: 4, author_email: "ann@brokerage.example" });
  });
});
