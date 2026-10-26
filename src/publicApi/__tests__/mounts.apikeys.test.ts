// KS_SERVER_SSO_API_KEYS - the new routes as the real app mounts them: the public API answers in its own JSON shape
// (nothing in front of it demands a staff session), SSO config is public, and the Admin settings are Admin-only and
// plan-gated (402 below Pro).
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ plan: "pro" as string, settingsWrites: [] as any[][] }));

vi.mock("../../db.js", async (orig) => {
  const actual: any = await orig();
  const query = vi.fn(async (sql: string, params: any[] = []) => {
    if (/FROM licensee_plan/i.test(sql)) return { rows: [{ plan: state.plan, trial_started_at: new Date(Date.now() - 30 * 86_400_000), trial_ends_at: new Date(Date.now() - 16 * 86_400_000) }] };
    if (/FROM sso_settings/i.test(sql)) return { rows: [] };
    if (/INSERT INTO sso_settings/i.test(sql)) {
      state.settingsWrites.push(params);
      return { rows: [{ microsoft_enabled: params[0], google_enabled: params[1], microsoft_tenant_id: params[2], google_hosted_domain: params[3], require_sso: params[4] }] };
    }
    return { rows: [], rowCount: 0 };
  });
  return { ...actual, pool: { ...actual.pool, query }, runQuery: query, dbQuery: query };
});
vi.mock("../../modules/audit/audit.service.js", () => ({ recordAuditEvent: vi.fn(async () => undefined) }));

import { createApp } from "../../app.js";
import { signAccessToken } from "../../auth/jwt.js";
import { clearPlanCache } from "../../plans/state.js";

const app = createApp();
const token = (role: "Admin" | "Staff") => signAccessToken({ sub: "00000000-0000-0000-0000-0000000000a1", role, tokenVersion: 0 } as any);

beforeEach(() => {
  clearPlanCache();
  state.plan = "pro";
  state.settingsWrites.length = 0;
});

describe("mounted routes", () => {
  it("public API: JSON 401 without a key, OpenAPI without one", async () => {
    const r = await request(app).get("/api/open/v1/contacts");
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("unauthorized");
    expect((await request(app).get("/api/open/v1/openapi.json")).status).toBe(200);
  });
  it("SSO config is public and shows nothing when no provider is switched on", async () => {
    const r = await request(app).get("/api/auth/sso/config");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, microsoft: false, google: false, require_sso: false });
  });
  it("SSO settings: Admin only, Pro only, validated", async () => {
    expect((await request(app).get("/api/sso-settings").set("Authorization", `Bearer ${token("Staff")}`)).status).toBe(403);
    const ok = await request(app).get("/api/sso-settings").set("Authorization", `Bearer ${token("Admin")}`);
    expect(ok.status).toBe(200);
    expect(ok.body.providers.google).toHaveProperty("redirect_uri");
    const bad = await request(app).put("/api/sso-settings").set("Authorization", `Bearer ${token("Admin")}`).send({ microsoft_tenant_id: "not-a-guid" });
    expect(bad.status).toBe(400);
    const noProvider = await request(app).put("/api/sso-settings").set("Authorization", `Bearer ${token("Admin")}`).send({ require_sso: true });
    expect(noProvider.status).toBe(400);
    expect(noProvider.body.error).toBe("no_provider");
    const saved = await request(app).put("/api/sso-settings").set("Authorization", `Bearer ${token("Admin")}`).send({ google_enabled: true, google_hosted_domain: "@Acme.com" });
    expect(saved.status).toBe(200);
    expect(state.settingsWrites[0]).toEqual([false, true, "", "acme.com", false, "00000000-0000-0000-0000-0000000000a1"]);
    clearPlanCache();
    state.plan = "growth";
    const locked = await request(app).get("/api/sso-settings").set("Authorization", `Bearer ${token("Admin")}`);
    expect(locked.status).toBe(402);
    expect(locked.body).toMatchObject({ error: "feature_not_in_plan", feature: "sso", required_plan: "pro" });
  });
  it("API keys: Admin only and Pro only", async () => {
    expect((await request(app).get("/api/api-keys").set("Authorization", `Bearer ${token("Staff")}`)).status).toBe(403);
    expect((await request(app).get("/api/api-keys").set("Authorization", `Bearer ${token("Admin")}`)).status).toBe(200);
    expect((await request(app).post("/api/api-keys").set("Authorization", `Bearer ${token("Admin")}`).send({ name: "", scope: "read" })).status).toBe(400);
    expect((await request(app).post("/api/api-keys").set("Authorization", `Bearer ${token("Admin")}`).send({ name: "Zapier", scope: "admin" })).status).toBe(400);
    clearPlanCache();
    state.plan = "starter";
    const locked = await request(app).get("/api/api-keys").set("Authorization", `Bearer ${token("Admin")}`);
    expect(locked.status).toBe(402);
    expect(locked.body.feature).toBe("api_access");
  });
});
