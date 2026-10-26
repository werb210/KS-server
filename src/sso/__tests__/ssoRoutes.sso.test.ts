// KS_SERVER_SSO_API_KEYS - the SSO sign-in routes end to end with a mocked database and provider: buttons hidden when
// the plan, env or setting is missing; start -> callback -> one-time code -> the staff session token; refusals for a
// deactivated or unknown user and a forged state, each audit-logged; "require SSO" never applies to Admins.
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  plan: "pro" as string,
  trialEndsAt: null as string | null,
  settings: { microsoft_enabled: false, google_enabled: true, microsoft_tenant_id: "", google_hosted_domain: "", require_sso: false } as Record<string, unknown>,
  states: [] as Array<{ state_hash: string; provider: string; code_verifier: string; nonce: string; consumed: boolean }>,
  handoffs: [] as Array<{ code_hash: string; user_id: string; provider: string; consumed: boolean }>,
  users: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, any>>,
}));

vi.mock("../../db.js", () => {
  const query = vi.fn(async (sql: string, params: any[] = []) => {
    if (/FROM licensee_plan/i.test(sql)) return { rows: [{ plan: db.plan, trial_started_at: db.trialEndsAt ? new Date(Date.now() - 86_400_000) : null, trial_ends_at: db.trialEndsAt }] };
    if (/FROM sso_settings/i.test(sql)) return { rows: [db.settings] };
    if (/INSERT INTO sso_login_states/i.test(sql)) {
      db.states.push({ state_hash: params[0], provider: params[1], code_verifier: params[2], nonce: params[3], consumed: false });
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE sso_login_states/i.test(sql)) {
      const row = db.states.find((s) => s.state_hash === params[0] && s.provider === params[1] && !s.consumed);
      if (!row) return { rows: [], rowCount: 0 };
      row.consumed = true;
      return { rows: [{ code_verifier: row.code_verifier, nonce: row.nonce }], rowCount: 1 };
    }
    if (/INSERT INTO sso_login_handoffs/i.test(sql)) {
      db.handoffs.push({ code_hash: params[0], user_id: params[1], provider: params[2], consumed: false });
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE sso_login_handoffs/i.test(sql)) {
      const row = db.handoffs.find((h) => h.code_hash === params[0] && !h.consumed);
      if (!row) return { rows: [], rowCount: 0 };
      row.consumed = true;
      return { rows: [{ user_id: row.user_id, provider: row.provider }], rowCount: 1 };
    }
    if (/FROM users WHERE lower\(email\) = \$1/i.test(sql)) return { rows: db.users.filter((u) => String(u.email).toLowerCase() === params[0]) };
    if (/FROM users WHERE id::text = \$1/i.test(sql)) return { rows: db.users.filter((u) => u.id === params[0]) };
    if (/from users u\s+where u\.id = \$1/i.test(sql)) {
      const u = db.users.find((x) => x.id === params[0]);
      return { rows: u ? [{ ...u, tokenVersion: 0, phoneNumber: null }] : [] };
    }
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query }, runQuery: query, dbQuery: query };
});
vi.mock("../../modules/audit/audit.service.js", () => ({
  recordAuditEvent: vi.fn(async (e: Record<string, any>) => { db.audits.push(e); }),
}));

import ssoRoutes, { setSsoKeyResolverForTests, staffRefusal } from "../../routes/authSso.js";
import { clearPlanCache } from "../../plans/state.js";
import { ssoRequiredFor } from "../settings.js";
import { pool } from "../../db.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth/sso", ssoRoutes);

let idTokenClaims: Record<string, unknown> = {};
const realFetch = globalThis.fetch;

function idToken(nonce: string) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ iss: "https://accounts.google.com", aud: "g-client", sub: "g-1", email: "ann@acme.com", email_verified: true, nonce, iat: now, exp: now + 600, ...idTokenClaims }, keys.privateKey, { algorithm: "RS256", keyid: "k1" });
}

beforeEach(() => {
  clearPlanCache();
  db.plan = "pro";
  db.trialEndsAt = null;
  db.settings = { microsoft_enabled: false, google_enabled: true, microsoft_tenant_id: "", google_hosted_domain: "", require_sso: false };
  db.states.length = 0;
  db.handoffs.length = 0;
  db.audits.length = 0;
  db.users = [{ id: "11111111-1111-1111-1111-111111111111", email: "Ann@acme.com", role: "Staff", active: true, disabled: false, deleted_at: null, status: "ACTIVE" }];
  idTokenClaims = {};
  process.env.GOOGLE_OAUTH_CLIENT_ID = "g-client";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "g-secret";
  delete process.env.MSAL_CLIENT_ID;
  delete process.env.MSAL_CLIENT_SECRET;
  process.env.SSO_RETURN_URL = "https://staff.example/login";
  setSsoKeyResolverForTests(async (_p, kid) => (kid === "k1" ? (keys.publicKey as KeyObject) : null));
  globalThis.fetch = vi.fn(async (url: any, init?: any) => {
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
      const verifier = new URLSearchParams(String(init?.body ?? "")).get("code_verifier");
      const row = db.states.find((s) => s.code_verifier === verifier);
      return new Response(JSON.stringify({ id_token: idToken(row?.nonce ?? "x") }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as any;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setSsoKeyResolverForTests(undefined);
  delete process.env.SSO_RETURN_URL;
});

async function startAndCallback() {
  const start = await request(app).get("/api/auth/sso/google/start");
  expect(start.status).toBe(302);
  const cookie = String(start.headers["set-cookie"]?.[0] ?? "");
  const state = new URL(start.headers.location).searchParams.get("state")!;
  return request(app).get(`/api/auth/sso/google/callback?code=auth-code&state=${encodeURIComponent(state)}`).set("Cookie", cookie.split(";")[0]);
}

describe("GET /api/auth/sso/config", () => {
  it("shows a provider only when the plan, the server set-up and the Admin switch all allow it", async () => {
    expect((await request(app).get("/api/auth/sso/config")).body).toMatchObject({ google: true, microsoft: false });
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    expect((await request(app).get("/api/auth/sso/config")).body).toMatchObject({ google: false });
    process.env.GOOGLE_OAUTH_CLIENT_ID = "g-client";
    clearPlanCache();
    db.plan = "growth";
    expect((await request(app).get("/api/auth/sso/config")).body).toMatchObject({ google: false, require_sso: false });
  });
  it("a growth brokerage on its trial gets Pro features, SSO included", async () => {
    db.plan = "growth";
    db.trialEndsAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    expect((await request(app).get("/api/auth/sso/config")).body).toMatchObject({ google: true });
  });
});

describe("sign-in flow", () => {
  it("start sets an HttpOnly state cookie and sends PKCE + nonce to Google", async () => {
    const r = await request(app).get("/api/auth/sso/google/start");
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.location);
    expect(loc.origin).toBe("https://accounts.google.com");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("nonce")).toBeTruthy();
    expect(String(r.headers["set-cookie"]?.[0])).toMatch(/ks_sso_state=.*HttpOnly.*Secure|ks_sso_state=.*Secure.*HttpOnly/);
  });

  it("callback signs an active staff member in: one-time code in the fragment, exchanged once for a staff token", async () => {
    const cb = await startAndCallback();
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toMatch(/^https:\/\/staff\.example\/login#sso_code=/);
    expect(db.audits.at(-1)).toMatchObject({ action: "sso_sign_in", success: true, actorUserId: db.users[0].id });
    const code = new URLSearchParams(cb.headers.location.split("#")[1]).get("sso_code")!;
    const ex = await request(app).post("/api/auth/sso/exchange").send({ code });
    expect(ex.status).toBe(200);
    const claims = jwt.decode(ex.body.data.token) as Record<string, unknown>;
    expect(claims).toMatchObject({ sub: db.users[0].id, role: "Staff" });
    expect((await request(app).post("/api/auth/sso/exchange").send({ code })).status).toBe(401);
  });

  it("refuses a deactivated user and audit-logs it", async () => {
    db.users[0].active = false;
    const cb = await startAndCallback();
    expect(cb.headers.location).toBe("https://staff.example/login?sso_error=user_inactive");
    expect(db.audits.at(-1)).toMatchObject({ action: "sso_sign_in_refused", success: false, metadata: expect.objectContaining({ reason: "user_inactive" }) });
    expect(db.handoffs).toHaveLength(0);
  });

  it("never creates a user: an unknown email is refused", async () => {
    db.users = [];
    const cb = await startAndCallback();
    expect(cb.headers.location).toContain("sso_error=no_user");
  });

  it("refuses an unverified email from the provider", async () => {
    idTokenClaims = { email_verified: false };
    const cb = await startAndCallback();
    expect(cb.headers.location).toContain("sso_error=email_not_verified");
    expect(db.audits.at(-1)).toMatchObject({ action: "sso_sign_in_refused" });
  });

  it("refuses a state that does not match the browser's cookie", async () => {
    const start = await request(app).get("/api/auth/sso/google/start");
    const state = new URL(start.headers.location).searchParams.get("state")!;
    const cb = await request(app).get(`/api/auth/sso/google/callback?code=c&state=${state}`).set("Cookie", "ks_sso_state=forged");
    expect(cb.headers.location).toContain("sso_error=state");
  });

  it("the Google hosted-domain restriction refuses other domains", async () => {
    db.settings.google_hosted_domain = "other.com";
    const cb = await startAndCallback();
    expect(cb.headers.location).toContain("sso_error=wrong_domain");
  });

  it("refuses once the plan drops below Pro", async () => {
    db.plan = "starter";
    const r = await request(app).get("/api/auth/sso/google/start");
    expect(r.headers.location).toContain("sso_error=sso_off");
  });
});

describe("require SSO for staff", () => {
  it("applies to staff, never to Admins, and only while a provider is offered", async () => {
    db.settings.require_sso = true;
    expect(await ssoRequiredFor(pool as any, "Staff")).toBe(true);
    expect(await ssoRequiredFor(pool as any, "Admin")).toBe(false);
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    expect(await ssoRequiredFor(pool as any, "Staff")).toBe(false);
  });
  it("staffRefusal: deactivated, disabled, deleted and non-staff users are refused", () => {
    const base = { id: "u", role: "Staff", active: true, disabled: false, deleted_at: null, status: "ACTIVE" };
    expect(staffRefusal(base)).toBeNull();
    expect(staffRefusal({ ...base, active: false })).toBe("user_inactive");
    expect(staffRefusal({ ...base, disabled: true })).toBe("user_inactive");
    expect(staffRefusal({ ...base, deleted_at: "2026-01-01" })).toBe("user_inactive");
    expect(staffRefusal({ ...base, status: "INACTIVE" })).toBe("user_inactive");
    expect(staffRefusal({ ...base, role: "Referrer" })).toBe("not_staff");
    expect(staffRefusal(undefined)).toBe("no_user");
  });
});
