// KS_SERVER_v15_PROVISION - KS-Ops creates the first admin and asks whether teardown is allowed, against a database
// fake that answers by SQL content (not call order).
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", () => ({ pool: { query: queryMock }, db: { query: queryMock } }));

import provisionRoutes, { createFirstAdmin, e164, teardownCheck } from "../provision.js";

type Row = Record<string, any>;
let users: Row[];
let plan: Row | null;
let holds: number;
let archive: boolean;

function fakeDb(sql: string, params: unknown[] = []) {
  const ok = (rows: any[]) => ({ rows, rowCount: rows.length });
  if (/^\s*SELECT id, role FROM users/.test(sql)) {
    const [email, digits] = params as string[];
    return ok(users.filter((u) => u.email === email || String(u.phone_number).replace(/\D/g, "").slice(-10) === digits));
  }
  if (/^\s*INSERT INTO users/.test(sql)) {
    users.push({ id: params[0], email: params[1], phone_number: params[2], role: params[3], first_name: params[4], last_name: params[5] });
    return ok([{ id: params[0] }]);
  }
  if (/FROM licensee_plan WHERE id = 1/.test(sql)) return ok(plan ? [plan] : []);
  if (/to_regclass\('public.legal_holds'\)/.test(sql)) return ok([{ present: true }]);
  if (/FROM legal_holds WHERE released_at IS NULL/.test(sql)) return ok([{ n: holds }]);
  if (/to_regnamespace\('retention_archive'\)/.test(sql)) return ok([{ present: archive }]);
  throw new Error(`unexpected SQL: ${sql}`);
}

const app = express().use(express.json()).use("/api/provision", provisionRoutes);
const KEY = "ops-key-for-tests-0123456789";

beforeEach(() => {
  users = [];
  plan = null;
  holds = 0;
  archive = false;
  process.env.KS_OPS_KEY = KEY;
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string, params?: unknown[]) => fakeDb(sql, params));
});

describe("POST /api/provision/admin", () => {
  it("needs the ops key", async () => {
    expect((await request(app).post("/api/provision/admin").send({})).status).toBe(401);
    delete process.env.KS_OPS_KEY;
    expect((await request(app).post("/api/provision/admin").set("X-KS-Ops-Key", KEY).send({})).status).toBe(403);
  });

  it("creates the first Admin once, and never changes an existing user", async () => {
    const body = { name: "Ana Maria Acme", email: "Ana@Acme.example", phone: "(403) 555-0123" };
    const first = await request(app).post("/api/provision/admin").set("X-KS-Ops-Key", KEY).send(body);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ created: true, role: "Admin" });
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email: "ana@acme.example", phone_number: "+14035550123", role: "Admin", first_name: "Ana", last_name: "Maria Acme" });
    const again = await request(app).post("/api/provision/admin").set("X-KS-Ops-Key", KEY).send(body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, user_id: first.body.user_id });
    expect(users).toHaveLength(1);
  });

  it("refuses a bad email or phone", async () => {
    expect((await request(app).post("/api/provision/admin").set("X-KS-Ops-Key", KEY).send({ email: "nope", phone: "4035550123" })).body.error).toBe("invalid_email");
    expect(await createFirstAdmin({ query: queryMock }, { email: "a@b.co", phone: "12" })).toEqual({ ok: false, error: "invalid_phone" });
  });

  it("normalises phone numbers", () => {
    expect(e164("403-555-0123")).toBe("+14035550123");
    expect(e164("+1 403 555 0123")).toBe("+14035550123");
    expect(e164("+44 20 7946 0958")).toBe("+442079460958");
    expect(e164("555")).toBeNull();
  });
});

describe("GET /api/provision/teardown-check", () => {
  const check = () => request(app).get("/api/provision/teardown-check").set("X-KS-Ops-Key", KEY);

  it("refuses while the copy is live or not yet purged", async () => {
    plan = { service_status: "active" };
    expect((await check()).body).toMatchObject({ deletable: false, reason: expect.stringMatching(/not cancelled/) });
    plan = { service_status: "cancelled", purged_at: null };
    expect((await check()).body).toMatchObject({ deletable: false, reason: expect.stringMatching(/purge has not run/) });
  });

  it("refuses while records are kept for retention or a legal hold is open", async () => {
    plan = { service_status: "cancelled", purged_at: new Date(), retention_archived_at: new Date(), retention_released_at: null, retention_archive: { kept_until: "2033-04-01" } };
    archive = true;
    expect((await check()).body).toMatchObject({ deletable: false, retention_archive: true, kept_until: "2033-04-01" });
    archive = false;
    plan.retention_released_at = new Date();
    holds = 2;
    expect((await check()).body).toMatchObject({ deletable: false, legal_holds: 2, reason: "2 legal holds are open" });
  });

  it("allows teardown only once nothing is kept", async () => {
    plan = { service_status: "cancelled", purged_at: new Date(), retention_archived_at: new Date(), retention_released_at: new Date() };
    expect(await teardownCheck({ query: queryMock })).toMatchObject({ deletable: true, legal_holds: 0, retention_archive: false });
  });
});
