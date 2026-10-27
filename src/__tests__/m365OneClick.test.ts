// KS_SERVER_M365_ONE_CLICK - Microsoft 365 connects with one click from the brokerage's admin: Microsoft's admin consent
// flow saves the tenant (no app registration, nothing typed), every Microsoft call reads that tenant (falling back to
// MSAL_TENANT_ID on servers with their own app), a revoked consent shows on the health check, and Keystone's redirect
// broker state is signed and checked on both ends.
import { createHash, createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  states: [] as Array<{ nonce_hash: string; user_id: string; expires_at: Date; consumed_at: Date | null; purpose: string }>,
  settings: { office365_tenant_id: "", office365_send_as: "", m365_consent: null as any, m365_last_sync_at: null as Date | null } as Record<string, any>,
  usersCleared: 0,
  role: "Admin",
  userId: "11111111-aaaa-4aaa-8aaa-111111111111",
  audits: [] as Array<{ action: string; success: boolean; metadata: any }>,
  staffConnected: 0,
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.user = { id: db.userId, role: db.role }; next(); },
  auth: (req: any, _res: any, next: any) => { req.user = { id: db.userId, role: db.role }; next(); },
  requireAuthorization: (opts: { roles?: string[] }) => (req: any, res: any, next: any) =>
    (opts.roles ?? []).includes(req.user?.role) ? next() : res.status(403).json({ error: "forbidden" }),
}));
vi.mock("../modules/audit/audit.service.js", () => ({
  recordAuditEvent: vi.fn(async (e: any) => { db.audits.push({ action: e.action, success: e.success, metadata: e.metadata }); }),
}));
vi.mock("../db.js", () => ({
  pool: {
    query: vi.fn(async (sql: string, params: any[] = []) => {
      if (/INSERT INTO o365_oauth_states/i.test(sql)) {
        db.states.push({ nonce_hash: params[0], user_id: params[1], expires_at: params[2], consumed_at: null, purpose: params[3] ?? "user" });
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM o365_oauth_states/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/UPDATE o365_oauth_states/i.test(sql)) {
        const withCookie = params[1] === true;
        const row = db.states.find((r) => r.nonce_hash === params[0] && r.consumed_at === null && r.expires_at.getTime() > Date.now()
          && ((r.purpose === "admin_consent" && withCookie) || r.purpose === "admin_consent_link"));
        if (!row) return { rows: [], rowCount: 0 };
        row.consumed_at = new Date();
        return { rows: [{ user_id: row.user_id, purpose: row.purpose }], rowCount: 1 };
      }
      if (/INSERT INTO licensee_settings .*m365_consent/is.test(sql)) {
        db.settings.office365_tenant_id = params[1] ?? "";
        db.settings.m365_consent = params[2] ? JSON.parse(params[2]) : null;
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT m365_consent FROM licensee_settings/i.test(sql)) return { rows: [{ m365_consent: db.settings.m365_consent }] };
      if (/SELECT m365_last_sync_at, office365_send_as/i.test(sql)) return { rows: [{ m365_last_sync_at: db.settings.m365_last_sync_at, office365_send_as: db.settings.office365_send_as }] };
      if (/FROM licensee_settings WHERE id = 1/i.test(sql)) return { rows: [{ ...db.settings }] };
      if (/UPDATE users SET o365_access_token = NULL/i.test(sql)) { db.usersCleared += 1; return { rows: [], rowCount: 3 }; }
      if (/count\(\*\)::int AS n, min\(lower\(split_part\(o365_user_email/i.test(sql)) return { rows: [{ n: db.staffConnected, domain: db.staffConnected ? "prairie.example" : null }] };
      if (/FROM google_workspace_accounts/i.test(sql)) return { rows: [{ ok: 1, bad: 0, first_at: new Date("2026-10-20T00:00:00Z"), domains: ["prairie.example"] }] };
      if (/FROM users WHERE id::text = \$1/i.test(sql)) return { rows: [{ name: "Dana Smith", email: "dana@prairie.example" }] };
      return { rows: [], rowCount: 0 };
    }),
  },
  runQuery: vi.fn(),
}));

import o365OAuth from "../routes/o365OAuth.js";
import { pool } from "../db.js";
import { setLastLoadedConnections } from "../licensee/settings.js";
import { m365App, m365AppOnly, m365Delegated, m365SendAsMailbox, m365TenantInfo } from "../modules/o365/m365App.js";
import { checkM365Health, consentErrorKind, m365Status, resetM365HealthCache } from "../modules/o365/m365Consent.js";
import { brokerConfig, redirectUriFor, unwrapState, wrapState } from "../licensee/oauthBroker.js";
import { providerConfig } from "../sso/oidc.js";
import { googleOAuthConfig } from "../services/workspace/googleConfig.js";
import { opsConnectionsView, workspaceConnections } from "../licensee/workspaceConnections.js";

const TENANT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const LICENSEE = "22222222-3333-4444-8555-666666666666";
const OPS_KEY = "ksops_test_key";
const ENV_KEYS = [
  "MSAL_CLIENT_ID", "MSAL_CLIENT_SECRET", "MSAL_TENANT_ID", "MS_GRAPH_CLIENT_ID", "MS_GRAPH_CLIENT_SECRET", "MS_GRAPH_TENANT_ID", "MS_GRAPH_SEND_AS",
  "KS_M365_CLIENT_ID", "KS_M365_CLIENT_SECRET", "KS_OAUTH_BROKER_URL", "KS_LICENSEE_ID", "KS_OPS_KEY", "O365_CONSENT_RETURN_URL",
  "KS_SERVER_URL", "SSO_MICROSOFT_TENANT", "SSO_MICROSOFT_REDIRECT_URI", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET",
  "KS_GOOGLE_OAUTH_CLIENT_ID", "KS_GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_TOKEN_ENCRYPTION_KEY", "GOOGLE_OAUTH_REDIRECT_URI", "O365_OAUTH_REDIRECT_URI",
];
const saved: Record<string, string | undefined> = {};

const app = express();
app.use(express.json());
app.use("/api/o365-oauth", o365OAuth);

function connections(tenant = "", sendAs = "") {
  setLastLoadedConnections({ twilio_main_number: "", google_ads_customer_id: "", office365_tenant_id: tenant, office365_send_as: sendAs });
}

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.KS_M365_CLIENT_ID = "keystone-app-id";
  process.env.KS_M365_CLIENT_SECRET = "keystone-app-secret";
  process.env.KS_SERVER_URL = "https://ks-prairie-server.azurewebsites.net";
  process.env.O365_CONSENT_RETURN_URL = "https://portal.prairie.example/settings/connections";
  db.states.length = 0;
  db.audits.length = 0;
  db.usersCleared = 0;
  db.role = "Admin";
  db.staffConnected = 0;
  db.settings = { office365_tenant_id: "", office365_send_as: "", m365_consent: null, m365_last_sync_at: null };
  connections();
  resetM365HealthCache();
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setLastLoadedConnections(null);
  vi.unstubAllGlobals();
});

async function startConsent() {
  const r = await request(app).get("/api/o365-oauth/admin-consent/start");
  expect(r.status).toBe(200);
  const url = new URL(r.body.url);
  const setCookie = ([] as string[]).concat(r.headers["set-cookie"] ?? []).find((c) => c.startsWith("o365_consent_nonce="))!;
  return { url, state: url.searchParams.get("state")!, cookie: setCookie.split(";")[0]!, setCookie };
}
const consentCallback = (query: string, cookie?: string) => {
  const r = request(app).get(`/api/o365-oauth/admin-consent/callback?${query}`);
  return cookie ? r.set("Cookie", cookie) : r;
};
const ok = (state: string, tenant = TENANT) => `admin_consent=True&tenant=${tenant}&scope=${encodeURIComponent("https://graph.microsoft.com/.default")}&state=${encodeURIComponent(state)}`;

describe("Connect Microsoft 365 (admin consent)", () => {
  it("sends the Admin to Microsoft's admin consent page for Keystone's app, with a cookie-bound single-use state", async () => {
    const { url, state, setCookie } = await startConsent();
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/organizations/v2.0/adminconsent");
    expect(url.searchParams.get("client_id")).toBe("keystone-app-id");
    expect(url.searchParams.get("scope")).toBe("https://graph.microsoft.com/.default");
    expect(url.searchParams.get("redirect_uri")).toBe("https://ks-prairie-server.azurewebsites.net/api/o365-oauth/admin-consent/callback");
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(db.states[0]).toMatchObject({ nonce_hash: createHash("sha256").update(state).digest("hex"), purpose: "admin_consent", user_id: db.userId });
  });

  it("success: saves the tenant Microsoft returned, who connected it, and every Microsoft call now uses it", async () => {
    const { state, cookie } = await startConsent();
    const r = await consentCallback(ok(state), cookie);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("https://portal.prairie.example/settings/connections?m365=connected");
    expect(db.settings.office365_tenant_id).toBe(TENANT);
    expect(db.settings.m365_consent).toMatchObject({ tenant_id: TENANT, consented_by: "Dana Smith (dana@prairie.example)", via: "button" });
    expect(m365TenantInfo()).toEqual({ tenant: TENANT, source: "connected" });
    expect(m365Delegated()).toMatchObject({ tenant: TENANT, clientId: "keystone-app-id", source: "keystone" });
    expect(m365AppOnly()).toEqual({ tenant: TENANT, clientId: "keystone-app-id", clientSecret: "keystone-app-secret" });
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "m365_connected", success: true }));
  });

  it("declined: nothing is saved and the page says so", async () => {
    const { state, cookie } = await startConsent();
    const r = await consentCallback(`error=access_denied&error_description=${encodeURIComponent("AADSTS65004: User declined to consent to access the app.")}&state=${encodeURIComponent(state)}`, cookie);
    expect(r.headers.location).toContain("m365=declined");
    expect(db.settings.office365_tenant_id).toBe("");
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "m365_consent_refused", success: false, metadata: expect.objectContaining({ reason: "declined" }) }));
  });

  it("a person who is not a Microsoft 365 admin: the page offers the link for their admin", async () => {
    const { state, cookie } = await startConsent();
    const r = await consentCallback(`error=access_denied&error_description=${encodeURIComponent("AADSTS90094: The grant requires admin permission.")}&state=${encodeURIComponent(state)}`, cookie);
    expect(r.headers.location).toContain("m365=needs_admin");
    expect(db.settings.office365_tenant_id).toBe("");
  });

  it("the copyable link works in the Microsoft 365 admin's own browser (no cookie), once, for 7 days", async () => {
    const r = await request(app).post("/api/o365-oauth/admin-consent/link");
    expect(r.status).toBe(200);
    const state = new URL(r.body.url).searchParams.get("state")!;
    expect(Date.parse(r.body.expires_at) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(db.states[0]!.purpose).toBe("admin_consent_link");
    const cb = await consentCallback(ok(state));
    expect(cb.headers.location).toContain("m365=connected");
    expect(db.settings.m365_consent.via).toBe("link");
    expect((await consentCallback(ok(state, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"))).headers.location).toContain("m365=state");
    expect(db.settings.office365_tenant_id).toBe(TENANT);
  });

  it("bad state: no cookie for a button flow, an unknown state, or a tenant that is not a GUID", async () => {
    const { state, cookie } = await startConsent();
    expect((await consentCallback(ok(state))).headers.location).toContain("m365=state");
    expect((await consentCallback(ok("A".repeat(43)), `o365_consent_nonce=${"A".repeat(43)}`)).headers.location).toContain("m365=state");
    expect((await consentCallback(ok(state, "contoso.com"), cookie)).headers.location).toContain("m365=error");
    expect(db.settings.office365_tenant_id).toBe("");
  });

  it("only Keystone Admins can connect, make a link, see the status or disconnect", async () => {
    db.role = "Staff";
    expect((await request(app).get("/api/o365-oauth/admin-consent/start")).status).toBe(403);
    expect((await request(app).post("/api/o365-oauth/admin-consent/link")).status).toBe(403);
    expect((await request(app).get("/api/o365-oauth/admin-consent/status")).status).toBe(403);
    expect((await request(app).post("/api/o365-oauth/admin-consent/disconnect")).status).toBe(403);
  });

  it("disconnect forgets the tenant and signs every staff member out of Microsoft", async () => {
    const { state, cookie } = await startConsent();
    await consentCallback(ok(state), cookie);
    const r = await request(app).post("/api/o365-oauth/admin-consent/disconnect");
    expect(r.status).toBe(200);
    expect(db.settings.office365_tenant_id).toBe("");
    expect(db.usersCleared).toBe(1);
    expect(m365TenantInfo().source).toBe("none");
  });

  it("a tenant set by the server's own settings cannot be disconnected from the portal", async () => {
    process.env.MSAL_TENANT_ID = TENANT;
    const r = await request(app).post("/api/o365-oauth/admin-consent/disconnect");
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("set_by_server");
  });

  it("a staff member's own connect waits for the company connection, then uses its tenant", async () => {
    const before = await request(app).get("/api/o365-oauth/start");
    expect(before.status).toBe(409);
    expect(before.body.message).toMatch(/administrator connects it once in Settings > Connections/);
    connections(TENANT);
    const after = await request(app).get("/api/o365-oauth/start");
    expect(after.status).toBe(200);
    expect(after.body.url).toContain(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?client_id=keystone-app-id`);
    expect(new URL(after.body.url).searchParams.get("scope")).toContain("Mail.ReadWrite.Shared");
  });
});

describe("which app and tenant", () => {
  it("a server with its own app registration keeps it, and MSAL_TENANT_ID is the fallback tenant", () => {
    process.env.MSAL_CLIENT_ID = "own-id";
    process.env.MSAL_CLIENT_SECRET = "own-secret";
    process.env.MSAL_TENANT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    expect(m365App()).toEqual({ clientId: "own-id", clientSecret: "own-secret", source: "own" });
    expect(m365TenantInfo()).toEqual({ tenant: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", source: "server_settings" });
    connections(TENANT);
    expect(m365TenantInfo()).toEqual({ tenant: TENANT, source: "connected" });
  });

  it("app-only calls use MS_GRAPH_* when set (Boreal), else Keystone's app, always in the connected tenant", () => {
    connections(TENANT, "submissions@prairie.example");
    expect(m365AppOnly()).toMatchObject({ clientId: "keystone-app-id", tenant: TENANT });
    process.env.MS_GRAPH_CLIENT_ID = "graph-id";
    process.env.MS_GRAPH_CLIENT_SECRET = "graph-secret";
    expect(m365AppOnly()).toEqual({ tenant: TENANT, clientId: "graph-id", clientSecret: "graph-secret" });
    expect(m365SendAsMailbox()).toBe("submissions@prairie.example");
    connections(TENANT);
    process.env.MS_GRAPH_SEND_AS = "old@prairie.example";
    expect(m365SendAsMailbox()).toBe("old@prairie.example");
  });

  it("nothing set up: no app, no calls", () => {
    delete process.env.KS_M365_CLIENT_ID;
    expect(m365App()).toBeNull();
    expect(m365Delegated()).toBeNull();
    expect(m365AppOnly()).toBeNull();
  });

  it("staff sign-in with Microsoft is pinned to the connected tenant and uses Keystone's app", () => {
    connections(TENANT);
    expect(providerConfig("microsoft")).toMatchObject({ clientId: "keystone-app-id", serverTenant: TENANT, authorityTenant: TENANT });
    connections();
    expect(providerConfig("microsoft")).toMatchObject({ serverTenant: null, authorityTenant: "organizations" });
  });
});

describe("health: a revoked or partial consent shows, with the fix", () => {
  const jwt = (roles: string[]) => `h.${Buffer.from(JSON.stringify({ roles })).toString("base64url")}.s`;
  const tokenFetch = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("connected with every permission", async () => {
    connections(TENANT);
    db.settings.m365_consent = { tenant_id: TENANT, consented_at: "2026-10-26T12:00:00.000Z", consented_by: "Dana Smith (dana@prairie.example)", via: "button" };
    db.staffConnected = 2;
    const all = ["User.Read.All", "Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite", "OnlineMeetings.ReadWrite.All", "OnlineMeetingTranscript.Read.All", "OnlineMeetingRecording.Read.All"];
    const s = await m365Status(pool as any, { fetcher: tokenFetch(200, { access_token: jwt(all) }) });
    expect(s.state).toBe("connected");
    expect(s.headline).toBe("Connected to prairie.example by Dana Smith (dana@prairie.example) on 2026-10-26.");
    expect(s.fix).toBeNull();
    expect(s.permissions.application.every((p) => p.granted)).toBe(true);
  });

  it("revoked (Keystone removed from the tenant): says so and how to fix it", async () => {
    connections(TENANT);
    const s = await m365Status(pool as any, {
      refresh: true,
      fetcher: tokenFetch(400, { error: "invalid_client", error_description: "AADSTS7000229: The client application keystone-app-id is missing service principal in the tenant." }),
    });
    expect(s.state).toBe("revoked");
    expect(s.fix).toMatch(/Reconnect/);
  });

  it("a permission taken back shows as partial", async () => {
    connections(TENANT);
    const h = await checkM365Health({ refresh: true, fetcher: tokenFetch(200, { access_token: jwt(["User.Read.All", "Mail.Send"]) }) });
    expect(h).toMatchObject({ state: "ok", missing: expect.arrayContaining(["Mail.ReadWrite", "Calendars.ReadWrite"]) });
    const none = await checkM365Health({ refresh: true, fetcher: tokenFetch(200, { access_token: jwt([]) }) });
    expect(none.state).toBe("revoked");
  });

  it("Keystone's own key expiring is not put on the brokerage", async () => {
    connections(TENANT);
    const h = await checkM365Health({ refresh: true, fetcher: tokenFetch(401, { error: "invalid_client", error_description: "AADSTS7000222: The provided client secret keys are expired." }) });
    expect(h.state).toBe("app_key");
    expect((h as { message: string }).message).toMatch(/nothing is needed from you/);
  });

  it("classifies Microsoft's consent errors", () => {
    expect(consentErrorKind("access_denied", "AADSTS65004: User declined")).toBe("declined");
    expect(consentErrorKind("access_denied", "AADSTS90094: admin permission")).toBe("needs_admin");
    expect(consentErrorKind("server_error", "AADSTS50000")).toBe("error");
  });
});

describe("Keystone's redirect broker", () => {
  const broker = () => {
    process.env.KS_OAUTH_BROKER_URL = "https://ops.keystone.example/api/oauth/callback";
    process.env.KS_LICENSEE_ID = LICENSEE;
    process.env.KS_OPS_KEY = OPS_KEY;
  };

  it("off without its three settings: own redirect URIs and plain states (today's behaviour)", () => {
    expect(brokerConfig()).toBeNull();
    expect(redirectUriFor("microsoft", "https://own/cb")).toBe("https://own/cb");
    expect(wrapState("o365", "nonce", 60_000)).toBe("nonce");
  });

  it("wraps the state as KS-Ops checks it (licensee, flow, expiry, HMAC with the ops key) and unwraps it again", () => {
    broker();
    const now = Date.parse("2026-10-26T12:00:00Z");
    const s = wrapState("consent", "N".repeat(43), 600_000, process.env, now);
    const parts = s.split(".");
    expect(parts.slice(0, 4)).toEqual(["ks1", LICENSEE, "consent", String(now / 1000 + 600)]);
    expect(parts[5]).toBe(createHmac("sha256", OPS_KEY).update(parts.slice(0, 5).join("."), "utf8").digest("base64url"));
    expect(unwrapState("consent", s, process.env, now)).toBe("N".repeat(43));
    expect(unwrapState("o365", s, process.env, now)).toBeNull(); // another flow
    expect(unwrapState("consent", s.replace("consent", "o365"), process.env, now)).toBeNull(); // tampered
    expect(unwrapState("consent", s, process.env, now + 601_000)).toBeNull(); // expired
    expect(unwrapState("consent", s, { ...process.env, KS_OPS_KEY: "other" }, now)).toBeNull(); // another licensee's key
  });

  it("every flow's redirect URI is the broker's, and a broker state reaches the consent callback", async () => {
    broker();
    expect(redirectUriFor("microsoft", "x")).toBe("https://ops.keystone.example/api/oauth/callback/microsoft");
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
    process.env.KS_GOOGLE_OAUTH_CLIENT_ID = "g-id";
    process.env.KS_GOOGLE_OAUTH_CLIENT_SECRET = "g-secret";
    expect(googleOAuthConfig()).toMatchObject({ clientId: "g-id", redirectUri: "https://ops.keystone.example/api/oauth/callback/google" });
    expect(providerConfig("google")?.redirectUri).toBe("https://ops.keystone.example/api/oauth/callback/google");
    expect(providerConfig("microsoft")?.redirectUri).toBe("https://ops.keystone.example/api/oauth/callback/microsoft");
    const { url, state, cookie } = await startConsent();
    expect(url.searchParams.get("redirect_uri")).toBe("https://ops.keystone.example/api/oauth/callback/microsoft");
    expect(state.startsWith(`ks1.${LICENSEE}.consent.`)).toBe(true);
    const r = await consentCallback(ok(state), cookie);
    expect(r.headers.location).toContain("m365=connected");
    // A forged broker state is refused before any database lookup.
    const forged = state.slice(0, -3) + "abc";
    expect((await consentCallback(ok(forged), cookie)).headers.location).toContain("m365=state");
  });
});

describe("what the Connections page and KS-Ops see", () => {
  it("both providers in plain English; KS-Ops gets no names", async () => {
    connections(TENANT);
    db.settings.m365_consent = { tenant_id: TENANT, consented_at: "2026-10-26T12:00:00.000Z", consented_by: "Dana Smith (dana@prairie.example)", via: "button" };
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
    process.env.KS_GOOGLE_OAUTH_CLIENT_ID = "g-id";
    process.env.KS_GOOGLE_OAUTH_CLIENT_SECRET = "g-secret";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: `h.${Buffer.from(JSON.stringify({ roles: ["Mail.Send"] })).toString("base64url")}.s` }), { status: 200 })));
    const c = await workspaceConnections(pool as any, { refresh: true });
    expect(c.microsoft).toMatchObject({ state: "partial", connected_by: "Dana Smith (dana@prairie.example)", tenant_source: "connected" });
    expect(c.microsoft.fix).toMatch(/Reconnect/);
    expect(c.google).toMatchObject({ state: "connected", app: "keystone", domains: ["prairie.example"], staff_connected: 1, gmail_reading: false });
    expect(c.google.permissions.map((p) => p.name)).not.toContain("https://www.googleapis.com/auth/gmail.readonly");
    const ops = await opsConnectionsView(pool as any);
    expect(JSON.stringify(ops)).not.toContain("Dana");
    expect(ops.microsoft.headline).toBe(`Connected to ${TENANT} on 2026-10-26.`);
    expect(ops.microsoft.missing_permissions).toContain("Calendars.ReadWrite");
  });
});
