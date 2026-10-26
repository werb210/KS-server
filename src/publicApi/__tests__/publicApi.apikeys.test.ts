// KS_SERVER_SSO_API_KEYS - API keys (format, HMAC hashing with the pepper, lookup, revoke) and the public REST API's
// gate: missing / wrong / revoked keys, read-only keys refused on writes, the Pro plan (trial included) required at
// request time, brokerage-scoped queries, pagination, JSON errors and the OpenAPI document.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  plan: "pro" as string,
  trial: false,
  keys: [] as Array<Record<string, any>>,
  queries: [] as Array<{ sql: string; params: any[] }>,
  contacts: [] as Array<Record<string, any>>,
}));

vi.mock("../../db.js", () => {
  const query = vi.fn(async (sql: string, params: any[] = []) => {
    store.queries.push({ sql, params });
    if (/FROM licensee_plan/i.test(sql)) {
      return { rows: [{ plan: store.plan, trial_started_at: store.trial ? new Date(Date.now() - 86_400_000) : null, trial_ends_at: store.trial ? new Date(Date.now() + 86_400_000) : null }] };
    }
    if (/FROM api_keys WHERE id = \$1::uuid/i.test(sql)) return { rows: store.keys.filter((k) => k.id === params[0]) };
    if (/UPDATE api_keys SET last_used_at/i.test(sql)) return { rows: [], rowCount: 1 };
    if (/FROM contacts c/i.test(sql)) {
      const limit = params[params.length - 2];
      const offset = params[params.length - 1];
      return { rows: store.contacts.slice(offset, offset + limit) };
    }
    if (/FROM applications WHERE silo = \$1 AND id::text = \$2/i.test(sql)) return { rows: params[1] === "app-1" ? [{ id: "app-1", stage: "Received" }] : [] };
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query }, runQuery: query, dbQuery: query };
});
vi.mock("../../modules/applications/applications.service.js", () => ({ transitionPipelineState: vi.fn(async () => undefined) }));
vi.mock("../../modules/automation/automationEngine.js", () => ({ emitAutomationEvent: vi.fn(async () => undefined) }));

import {
  authenticateApiKey, currentPepper, generateApiKey, hashApiKey, keyMatches, parseApiKey, scopeAllows,
} from "../../apiKeys/keys.js";
import { createPublicApiRouter, pageParams, paged } from "../router.js";
import { clearPlanCache } from "../../plans/state.js";
import { pool } from "../../db.js";
import { transitionPipelineState } from "../../modules/applications/applications.service.js";

const ENV = { KS_API_KEY_PEPPER: "pepper-for-tests-123", JWT_SECRET: "jwt-secret-for-tests" } as NodeJS.ProcessEnv;

function makeKey(scope: "read" | "read_write", extra: Record<string, unknown> = {}) {
  const k = generateApiKey(currentPepper(process.env)!);
  store.keys.push({ id: k.id, name: "Test", scope, key_prefix: k.key_prefix, key_hash: k.key_hash, pepper_source: k.pepper_source, created_by: "22222222-2222-2222-2222-222222222222", created_at: new Date(), last_used_at: null, revoked_at: null, ...extra });
  return k.key;
}

const app = express();
app.use(express.json());
app.use("/api/open/v1", createPublicApiRouter());

beforeEach(() => {
  clearPlanCache();
  store.plan = "pro";
  store.trial = false;
  store.keys.length = 0;
  store.queries.length = 0;
  store.contacts = Array.from({ length: 30 }, (_, i) => ({ id: `c-${i}`, first_name: "A", last_name: String(i) }));
  process.env.KS_API_KEY_PEPPER = ENV.KS_API_KEY_PEPPER;
});

describe("API key hashing and lookup", () => {
  it("has the ks_live_ shape, a short display prefix, and stores only an HMAC of the key", () => {
    const k = generateApiKey({ source: "env", pepper: ENV.KS_API_KEY_PEPPER! });
    expect(k.key).toMatch(/^ks_live_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);
    expect(k.key_prefix).toBe(`ks_live_${k.id.replace(/-/g, "").slice(0, 8)}`);
    expect(k.key_hash).toBe(hashApiKey(k.key, ENV.KS_API_KEY_PEPPER!));
    expect(k.key_hash).not.toContain(k.key.slice(-43));
    expect(parseApiKey(k.key)).toEqual({ id: k.id });
    expect(parseApiKey("ks_live_nothex_abc")).toBeNull();
  });
  it("matches only the exact key with the right pepper", () => {
    const k = generateApiKey({ source: "env", pepper: ENV.KS_API_KEY_PEPPER! });
    const row = { key_hash: k.key_hash, pepper_source: "env" as const };
    expect(keyMatches(row, k.key, ENV)).toBe(true);
    expect(keyMatches(row, k.key.slice(0, -1) + (k.key.endsWith("A") ? "B" : "A"), ENV)).toBe(false);
    expect(keyMatches(row, k.key, { ...ENV, KS_API_KEY_PEPPER: "a-different-pepper" })).toBe(false);
  });
  it("falls back to JWT_SECRET when no pepper is set, and remembers which one hashed each key", () => {
    const p = currentPepper({ JWT_SECRET: "jwt-secret-for-tests" })!;
    expect(p.source).toBe("jwt");
    const k = generateApiKey(p);
    expect(keyMatches({ key_hash: k.key_hash, pepper_source: "jwt" }, k.key, ENV)).toBe(true);
    expect(currentPepper({})).toBeNull();
  });
  it("authenticates a stored key, refuses an unknown one and a revoked one", async () => {
    const key = makeKey("read");
    expect((await authenticateApiKey(pool as any, key)).ok).toBe(true);
    expect(await authenticateApiKey(pool as any, key.replace(/.$/, (c) => (c === "x" ? "y" : "x")))).toEqual({ ok: false, reason: "unknown" });
    store.keys[0].revoked_at = new Date();
    expect(await authenticateApiKey(pool as any, key)).toEqual({ ok: false, reason: "revoked" });
  });
  it("scope: read keys may only read; read_write keys may write", () => {
    expect(scopeAllows("read", "GET")).toBe(true);
    expect(scopeAllows("read", "POST")).toBe(false);
    expect(scopeAllows("read", "PATCH")).toBe(false);
    expect(scopeAllows("read_write", "PATCH")).toBe(true);
    expect(scopeAllows("bogus", "GET")).toBe(false);
  });
});

describe("public API gate", () => {
  it("serves the OpenAPI document without a key", async () => {
    const r = await request(app).get("/api/open/v1/openapi.json");
    expect(r.status).toBe(200);
    expect(r.body.openapi).toBe("3.0.3");
    expect(Object.keys(r.body.paths)).toEqual(expect.arrayContaining(["/contacts", "/applications/{id}/stage", "/lenders/{id}"]));
  });
  it("needs a valid key (JSON errors)", async () => {
    expect((await request(app).get("/api/open/v1/contacts")).body).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
    const bad = await request(app).get("/api/open/v1/contacts").set("Authorization", "Bearer ks_live_" + "0".repeat(32) + "_" + "a".repeat(43));
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("invalid_api_key");
    const key = makeKey("read", { revoked_at: new Date() });
    expect((await request(app).get("/api/open/v1/contacts").set("Authorization", `Bearer ${key}`)).body.error.code).toBe("api_key_revoked");
  });
  it("refuses writes with a read-only key", async () => {
    const key = makeKey("read");
    const r = await request(app).post("/api/open/v1/contacts").set("Authorization", `Bearer ${key}`).send({ first_name: "A", last_name: "B" });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("insufficient_scope");
    const p = await request(app).patch("/api/open/v1/applications/app-1/stage").set("Authorization", `Bearer ${key}`).send({ stage: "In Review" });
    expect(p.status).toBe(403);
    expect(transitionPipelineState).not.toHaveBeenCalled();
  });
  it("a key stops working when the plan is below Pro, and works during a trial", async () => {
    const key = makeKey("read");
    store.plan = "growth";
    const r = await request(app).get("/api/open/v1/contacts").set("Authorization", `Bearer ${key}`);
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe("feature_not_in_plan");
    clearPlanCache();
    store.trial = true;
    expect((await request(app).get("/api/open/v1/contacts").set("Authorization", `Bearer ${key}`)).status).toBe(200);
  });
  it("lists this brokerage's contacts a page at a time", async () => {
    const key = makeKey("read");
    const r = await request(app).get("/api/open/v1/contacts?limit=10&offset=20").set("Authorization", `Bearer ${key}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(10);
    expect(r.body.pagination).toEqual({ limit: 10, offset: 20, next_offset: null });
    const q = store.queries.find((x) => /FROM contacts c/i.test(x.sql))!;
    expect(q.sql).toMatch(/c\.silo = \$1/);
    expect(q.params[0]).toBe("BF");
    expect((await request(app).get("/api/open/v1/contacts?limit=500").set("Authorization", `Bearer ${key}`)).status).toBe(400);
  });
  it("moves an application's stage with a read-write key, validating the stage", async () => {
    const key = makeKey("read_write");
    const bad = await request(app).patch("/api/open/v1/applications/app-1/stage").set("Authorization", `Bearer ${key}`).send({ stage: "Fraud" });
    expect(bad.status).toBe(400);
    const missing = await request(app).patch("/api/open/v1/applications/nope/stage").set("Authorization", `Bearer ${key}`).send({ stage: "In Review" });
    expect(missing.status).toBe(404);
    const ok = await request(app).patch("/api/open/v1/applications/app-1/stage").set("Authorization", `Bearer ${key}`).send({ stage: "In Review" });
    expect(ok.status).toBe(200);
    expect(transitionPipelineState).toHaveBeenCalledWith(expect.objectContaining({ applicationId: "app-1", nextState: "In Review", trigger: "api" }));
  });
  it("unknown endpoints answer a JSON 404", async () => {
    const key = makeKey("read");
    const r = await request(app).get("/api/open/v1/nothing").set("Authorization", `Bearer ${key}`);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("not_found");
  });
});

describe("pagination helpers", () => {
  it("validates limit/offset and reports the next page", () => {
    expect(pageParams({})).toEqual({ limit: 25, offset: 0 });
    expect(pageParams({ limit: "0" })).toHaveProperty("error");
    expect(pageParams({ offset: "-1" })).toHaveProperty("error");
    expect(paged([1, 2, 3], 2, 0)).toEqual({ data: [1, 2], pagination: { limit: 2, offset: 0, next_offset: 2 } });
  });
});
