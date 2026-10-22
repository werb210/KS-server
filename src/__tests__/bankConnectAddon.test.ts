// KS_SERVER_BANK_CONNECT_ADDON - bank connect is a hidden per-licensee add-on, not a plan feature. Off (the default):
// nothing about it exists - no plan catalogue entry, no fraud check 3, no Connect Bank task or request step, and its
// routes answer 404. On (set only by Keystone operations through PUT /api/plan { addons }): everything works as before.
// The database fake answers by SQL content.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return {
    ...actual,
    pool: { query: queryMock, connect: vi.fn(async () => ({ query: queryMock, release: vi.fn() })) },
    runQuery: queryMock, dbQuery: queryMock, query: queryMock, safeQuery: queryMock,
  };
});
vi.mock("../services/notifications/notifyClient.js", () => ({ notifyClient: vi.fn(async () => ({ channel: "sms" })) }));

import { clearPlanCache, type Q } from "../plans/state.js";
import { normaliseAddons, parseAddonPatch, isBankConnectTask } from "../plans/addons.js";
import { requireAddon } from "../plans/addonGate.js";
import { FEATURES, featuresFor } from "../plans/catalogue.js";
import { allowedChecks } from "../fraud/store.js";
import { fraudProviders, providerStatus } from "../fraud/providers/index.js";

const APP_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const STAFF_ID = "00000000-0000-4000-8000-0000000000c1";
const staffToken = () => jwt.sign({ sub: STAFF_ID, id: STAFF_ID, role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

let planRow: Record<string, any>;
let prompts: Array<Record<string, any>>;

function install(extra: Array<[RegExp, unknown]> = []) {
  queryMock.mockImplementation(answerBySql([
    ...extra,
    [/FROM licensee_plan WHERE id = 1/, () => ({ rows: [{ ...planRow }] })],
    [/UPDATE licensee_plan SET updated_at/, (sql: string, params?: unknown[]) => {
      const m = sql.match(/addons = COALESCE\(addons, '\{\}'::jsonb\) \|\| \$(\d+)::jsonb/);
      if (m) planRow.addons = { ...(planRow.addons ?? {}), ...JSON.parse(String(params![Number(m[1]) - 1])) };
      return { rows: [] };
    }],
    [/SELECT id FROM applications WHERE id::text/, { rows: [{ id: APP_ID }] }],
    [/SELECT silo FROM applications/, { rows: [{ silo: "BF" }] }],
    [/SELECT DISTINCT cta_action, max\(cta_label\)/, () => ({ rows: prompts.map((p) => ({ cta_action: p.cta_action, cta_label: p.cta_label })) })],
    [/SELECT DISTINCT cta_action FROM communications_messages/, () => ({ rows: prompts.map((p) => ({ cta_action: p.cta_action })) })],
    [/FROM communications_messages/, () => ({ rows: prompts })],
  ]));
}

// src/tests/setup.ts resets the module registry before each test, so the plan cache the routes use is the one a
// dynamic import returns now (the static import above is an older copy).
const freshClear = async () => { clearPlanCache(); (await import("../plans/state.js")).clearPlanCache(); };
const on = async () => { planRow.addons = { bank_connect: true }; await freshClear(); };

beforeEach(async () => {
  planRow = { plan: "pro", trial_started_at: null, trial_ends_at: null, extra_storage_blocks: 0, addons: {} };
  prompts = [
    { id: "m1", direction: "outbound", body: "Please connect your bank (view-only).", staff_name: "Todd", cta_label: "Connect Bank (View-Only)", cta_action: "flinks", created_at: "2026-10-01T00:00:00Z" },
    { id: "m2", direction: "outbound", body: "Please complete the CRA authorization.", staff_name: "Todd", cta_label: "CRA Authorization", cta_action: "cra", created_at: "2026-10-02T00:00:00Z" },
  ];
  await freshClear();
  queryMock.mockReset();
  install();
  process.env.KS_OPS_KEY = "ops-key-0123456789";
});

describe("add-on parsing", () => {
  it("keeps only known add-ons that are true, and validates the ops patch", () => {
    expect(normaliseAddons({ bank_connect: true, other: true })).toEqual({ bank_connect: true });
    expect(normaliseAddons('{"bank_connect":false}')).toEqual({});
    expect(normaliseAddons(null)).toEqual({});
    expect(parseAddonPatch({ bank_connect: false })).toEqual({ ok: true, value: { bank_connect: false } });
    expect(parseAddonPatch({ bank_connect: "yes" })).toEqual({ ok: false });
    expect(parseAddonPatch({ sso: true })).toEqual({ ok: false });
    expect(parseAddonPatch(["bank_connect"])).toEqual({ ok: false });
    expect(isBankConnectTask("form:flinks")).toBe(true);
    expect(isBankConnectTask("cra")).toBe(false);
  });

  it("is never a plan feature: no plan includes bank_connect or fraud_3", () => {
    expect(FEATURES.map((f) => f.key)).not.toContain("bank_connect");
    expect(FEATURES.map((f) => f.key)).not.toContain("fraud_3");
    expect(featuresFor("pro")).not.toHaveProperty("bank_connect");
    expect(featuresFor("pro")).not.toHaveProperty("fraud_3");
  });
});

describe("GET / PUT /api/plan", () => {
  async function planApp() {
    const router = (await import("../routes/plan.js")).default;
    const a = express();
    a.use(express.json());
    a.use("/api/plan", router);
    return a;
  }

  it("shows no add-ons while off, and operations switches bank_connect on and off", async () => {
    const a = await planApp();
    const before = await request(a).get("/api/plan").set("Authorization", `Bearer ${staffToken()}`);
    expect(before.status).toBe(200);
    expect(before.body.addons).toEqual({});
    expect(JSON.stringify(before.body)).not.toMatch(/bank_connect|fraud_3/);

    const put = await request(a).put("/api/plan").set("X-KS-Ops-Key", "ops-key-0123456789").send({ addons: { bank_connect: true } });
    expect(put.status).toBe(200);
    expect(put.body.addons).toEqual({ bank_connect: true });
    expect(put.body.catalogue.map((f: any) => f.key)).not.toContain("bank_connect");
    const update = callsMatching(queryMock, /UPDATE licensee_plan SET updated_at/)[0]!;
    expect(String(update[0])).toContain("addons = COALESCE(addons, '{}'::jsonb) ||");

    const off = await request(a).put("/api/plan").set("X-KS-Ops-Key", "ops-key-0123456789").send({ addons: { bank_connect: false } });
    expect(off.body.addons).toEqual({});
  });

  it("only operations can set it, and junk is refused", async () => {
    const a = await planApp();
    expect((await request(a).put("/api/plan").set("Authorization", `Bearer ${staffToken()}`).send({ addons: { bank_connect: true } })).status).toBe(401);
    expect((await request(a).put("/api/plan").set("X-KS-Ops-Key", "ops-key-0123456789").send({ addons: { bank_connect: 1 } })).body).toMatchObject({ error: "invalid_addons" });
    expect((await request(a).put("/api/plan").set("X-KS-Ops-Key", "ops-key-0123456789").send({ addons: {} })).body).toMatchObject({ error: "nothing_to_change" });
    expect(planRow.addons).toEqual({});
  });
});

describe("fraud check 3", () => {
  it("is not an allowed check while off (even on pro) and is allowed on any plan while on", async () => {
    expect((await allowedChecks({ query: queryMock } as unknown as Q)).has("fraud_3")).toBe(false);
    planRow.plan = "starter";
    await on();
    const allowed = await allowedChecks({ query: queryMock } as unknown as Q);
    expect(allowed.has("fraud_3")).toBe(true);
    expect(allowed.has("fraud_9")).toBe(false);
  });

  it("the Flinks provider row is listed only when on", () => {
    const p = fraudProviders({ NODE_ENV: "test" } as any);
    expect(providerStatus(p).some((s) => s.key === "bank")).toBe(false);
    expect(providerStatus(p, { bankConnect: true }).find((s) => s.key === "bank")).toMatchObject({ used_by: ["fraud_3"] });
  });

  it("the add-on gate answers 404 while off and lets the request through while on", async () => {
    const a = express();
    a.put("/x", requireAddon("bank_connect"), (_req, res) => { res.json({ ok: true }); });
    const off = await request(a).put("/x");
    expect(off.status).toBe(404);
    expect(off.body).toEqual({ ok: false, error: "not_found" });
    await on();
    expect((await request(a).put("/x")).status).toBe(200);
  });
});

describe("applicant tasks and staff requests", () => {
  async function appsApp() {
    const router = (await import("../modules/applications/applications.routes.js")).default;
    const { errorHandler } = await import("../middleware/errors.js");
    const a = express();
    a.use(express.json());
    a.use("/api/applications", router);
    a.use(errorHandler);
    return a;
  }

  it("Request Items cannot request Connect Bank while off", async () => {
    prompts = [];
    const a = await appsApp();
    const only = await request(a).post(`/api/applications/${APP_ID}/request-steps`).set("Authorization", `Bearer ${staffToken()}`).send({ forms: ["flinks"] });
    expect(only.status).toBe(400);
    expect(only.body.error).toBe("no_steps");
    const both = await request(a).post(`/api/applications/${APP_ID}/request-steps`).set("Authorization", `Bearer ${staffToken()}`).send({ forms: ["cra", "flinks"] });
    expect(both.status).toBe(200);
    expect(both.body.posted.forms).toEqual(["cra"]);
  });

  it("Request Items posts Connect Bank while on", async () => {
    prompts = [];
    await on();
    const a = await appsApp();
    const r = await request(a).post(`/api/applications/${APP_ID}/request-steps`).set("Authorization", `Bearer ${staffToken()}`).send({ forms: ["flinks"] });
    expect(r.status).toBe(200);
    expect(r.body.posted.forms).toEqual(["flinks"]);
  });

  it("the staff task list leaves Connect Bank out while off and shows it while on", async () => {
    const a = await appsApp();
    const off = await request(a).get(`/api/applications/${APP_ID}/task-status`).set("Authorization", `Bearer ${staffToken()}`);
    expect(off.status).toBe(200);
    expect(off.body.tasks.map((t: any) => t.key)).toEqual(["cra"]);
    expect(JSON.stringify(off.body)).not.toMatch(/Connect Bank|flinks/i);
    await on();
    const onRes = await request(a).get(`/api/applications/${APP_ID}/task-status`).set("Authorization", `Bearer ${staffToken()}`);
    expect(onRes.body.tasks.map((t: any) => t.key).sort()).toEqual(["cra", "flinks"]);
  });

  it("the requested-forms list (applicant to-do) drops Connect Bank while off", async () => {
    const { getRequestedFormIds } = await import("../routes/clientDocumentsNeeded.js");
    expect(await getRequestedFormIds(APP_ID)).toEqual(["cra"]);
    await on();
    expect((await getRequestedFormIds(APP_ID)).sort()).toEqual(["cra", "flinks"]);
  });
});
