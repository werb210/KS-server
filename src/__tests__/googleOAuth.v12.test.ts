// KS_SERVER_v12_GOOGLE_WORKSPACE - Google connect: state bound to the user + single-use nonce cookie, PKCE (S256),
// token exchange with the verifier, tokens encrypted at rest, refresh, invalid_grant -> reconnect, revoke on
// disconnect, and the restricted Gmail read scope never requested while GOOGLE_GMAIL_READ_ENABLED is off.
import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StateRow = { nonce_hash: string; user_id: string; code_verifier: string; expires_at: Date; consumed_at: Date | null };
const db = vi.hoisted(() => ({
  states: [] as any[],
  account: null as null | Record<string, any>,
  writes: [] as Array<{ sql: string; params: any[] }>,
  currentUser: "11111111-1111-1111-1111-111111111111",
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.user = { id: db.currentUser, role: "Staff" }; next(); },
}));
vi.mock("../db.js", () => ({
  pool: {
    query: vi.fn(async (sql: string, params: any[] = []) => {
      if (/INSERT INTO google_oauth_states/i.test(sql)) {
        db.states.push({ nonce_hash: params[0], user_id: params[1], code_verifier: params[2], expires_at: params[3], consumed_at: null });
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM google_oauth_states/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/UPDATE google_oauth_states/i.test(sql)) {
        const row = (db.states as StateRow[]).find((r) => r.nonce_hash === params[0] && r.consumed_at === null && r.expires_at.getTime() > Date.now());
        if (!row) return { rows: [], rowCount: 0 };
        row.consumed_at = new Date();
        return { rows: [{ user_id: row.user_id, code_verifier: row.code_verifier }], rowCount: 1 };
      }
      if (/INSERT INTO google_workspace_accounts/i.test(sql)) {
        db.writes.push({ sql, params });
        db.account = { user_id: params[0], google_email: params[1], access_token_enc: params[3], refresh_token_enc: params[4], access_token_expires_at: params[5], scopes: params[6], status: "connected" };
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT google_email, access_token_enc/i.test(sql)) return { rows: db.account ? [db.account] : [], rowCount: db.account ? 1 : 0 };
      if (/UPDATE google_workspace_accounts\s+SET status = 'reauth_required'/i.test(sql)) {
        db.writes.push({ sql, params });
        if (db.account) Object.assign(db.account, { status: "reauth_required", access_token_enc: null, refresh_token_enc: null });
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE google_workspace_accounts/i.test(sql)) {
        db.writes.push({ sql, params });
        if (db.account) Object.assign(db.account, { access_token_enc: params[1], access_token_expires_at: params[2] });
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM google_workspace_accounts/i.test(sql)) { db.writes.push({ sql, params }); db.account = null; return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }),
  },
  runQuery: vi.fn(),
}));

import googleOAuth from "../routes/googleOAuth.js";
import { getGoogleForUser, codeChallenge } from "../services/workspace/googleAuth.js";
import { decryptToken, encryptToken } from "../services/workspace/tokenCrypto.js";
import { RESTRICTED_SCOPES, requestedScopes } from "../services/workspace/googleConfig.js";
import { pool } from "../db.js";

const app = express();
app.use(express.json());
app.use("/api/google", googleOAuth);

const fetchCalls: Array<{ url: string; body: string }> = [];
let tokenResponse: { status: number; body: any } = { status: 200, body: { access_token: "AT-1", refresh_token: "RT-1", expires_in: 3600, scope: "openid email https://www.googleapis.com/auth/gmail.send" } };

beforeEach(() => {
  db.states.length = 0;
  db.writes.length = 0;
  db.account = null;
  fetchCalls.length = 0;
  tokenResponse = { status: 200, body: { access_token: "AT-1", refresh_token: "RT-1", expires_in: 3600, scope: "openid email https://www.googleapis.com/auth/gmail.send" } };
  process.env.GOOGLE_OAUTH_CLIENT_ID = "gclient.apps.googleusercontent.com";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "gsecret";
  process.env.GOOGLE_OAUTH_REDIRECT_URI = "https://server.example/api/google/oauth/callback";
  process.env.GOOGLE_OAUTH_RETURN_URL = "https://staff.example/settings";
  process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  delete process.env.GOOGLE_GMAIL_READ_ENABLED;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any = {}) => {
    fetchCalls.push({ url: String(url), body: String(init?.body ?? "") });
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify(tokenResponse.body), { status: tokenResponse.status });
    if (String(url).startsWith("https://openidconnect.googleapis.com/v1/userinfo")) return new Response(JSON.stringify({ email: "pat@acme.example", sub: "sub-1" }), { status: 200 });
    if (String(url).startsWith("https://oauth2.googleapis.com/revoke")) return new Response("", { status: 200 });
    if (String(url).startsWith("https://gmail.googleapis.com/")) return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
    return new Response("unexpected", { status: 599 });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT_URI", "GOOGLE_OAUTH_RETURN_URL", "GOOGLE_TOKEN_ENCRYPTION_KEY", "GOOGLE_GMAIL_READ_ENABLED"]) delete process.env[k];
});

async function start() {
  const r = await request(app).get("/api/google/oauth/start");
  expect(r.status).toBe(200);
  const url = new URL(r.body.url);
  const setCookie = String((r.headers["set-cookie"] as unknown as string[])[0]);
  const cookie = setCookie.split(";")[0]!;
  return { url, state: url.searchParams.get("state")!, cookie, setCookie };
}

describe("Google connect start", () => {
  it("asks Google for an offline code with PKCE S256 and a state bound to the user", async () => {
    const { url, state, setCookie } = await start();
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("https://server.example/api/google/oauth/callback");
    const row = db.states[0] as StateRow;
    expect(row.user_id).toBe(db.currentUser);
    expect(row.nonce_hash).toBe(createHash("sha256").update(state).digest("hex"));
    expect(row.nonce_hash).not.toBe(state);
    expect(url.searchParams.get("code_challenge")).toBe(codeChallenge(row.code_verifier));
    expect(row.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
  });

  it("requests only the standard scopes; the restricted Gmail read scope never appears while the switch is off", async () => {
    const { url } = await start();
    const scopes = url.searchParams.get("scope")!.split(" ");
    expect(scopes).toEqual(["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/tasks", "https://www.googleapis.com/auth/drive.file"]);
    for (const restricted of RESTRICTED_SCOPES) expect(scopes).not.toContain(restricted);
    for (const v of ["", "false", "0", "no", "off", "maybe"]) {
      expect(requestedScopes({ GOOGLE_GMAIL_READ_ENABLED: v } as any)).not.toContain("https://www.googleapis.com/auth/gmail.readonly");
    }
  });

  it("adds gmail.readonly only when GOOGLE_GMAIL_READ_ENABLED=true", async () => {
    process.env.GOOGLE_GMAIL_READ_ENABLED = "true";
    const { url } = await start();
    expect(url.searchParams.get("scope")!.split(" ")).toContain("https://www.googleapis.com/auth/gmail.readonly");
  });

  it("is 503 with a reason when Google is not configured", async () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    const r = await request(app).get("/api/google/oauth/start");
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("google_oauth_not_configured");
    const s = await request(app).get("/api/google/status");
    expect(s.body).toMatchObject({ configured: false, connected: false });
    expect(String(s.body.configProblem)).toMatch(/not set up/);
  });
});

describe("Google connect callback", () => {
  it("exchanges the code with the PKCE verifier and stores the tokens encrypted on the user who started", async () => {
    const { state, cookie } = await start();
    const r = await request(app).get(`/api/google/oauth/callback?code=CODE&state=${encodeURIComponent(state)}`).set("Cookie", cookie);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("https://staff.example/settings?google=connected");
    const tokenCall = fetchCalls.find((c) => c.url.startsWith("https://oauth2.googleapis.com/token"))!;
    const body = new URLSearchParams(tokenCall.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("CODE");
    expect(body.get("code_verifier")).toBe((db.states[0] as StateRow).code_verifier);
    expect(body.get("client_secret")).toBe("gsecret");
    const saved = db.writes.find((w) => /INSERT INTO google_workspace_accounts/.test(w.sql))!;
    expect(saved.params[0]).toBe(db.currentUser);
    expect(saved.params[1]).toBe("pat@acme.example");
    expect(saved.params[3]).not.toContain("AT-1");
    expect(saved.params[4]).not.toContain("RT-1");
    expect(decryptToken(saved.params[3])).toBe("AT-1");
    expect(decryptToken(saved.params[4])).toBe("RT-1");
  });

  it("refuses a callback without the browser's nonce cookie, with a different cookie, or a reused state", async () => {
    const { state, cookie } = await start();
    const noCookie = await request(app).get(`/api/google/oauth/callback?code=C&state=${encodeURIComponent(state)}`);
    expect(noCookie.headers.location).toMatch(/google=error&reason=state/);
    const wrong = await request(app).get(`/api/google/oauth/callback?code=C&state=${encodeURIComponent(state)}`).set("Cookie", "google_oauth_nonce=someone-else");
    expect(wrong.headers.location).toMatch(/google=error&reason=state/);
    expect(fetchCalls.some((c) => c.url.includes("/token"))).toBe(false);
    const ok = await request(app).get(`/api/google/oauth/callback?code=C&state=${encodeURIComponent(state)}`).set("Cookie", cookie);
    expect(ok.headers.location).toMatch(/google=connected/);
    const again = await request(app).get(`/api/google/oauth/callback?code=C&state=${encodeURIComponent(state)}`).set("Cookie", cookie);
    expect(again.headers.location).toMatch(/google=error&reason=state/);
  });

  it("an expired state is refused", async () => {
    const { state, cookie } = await start();
    (db.states[0] as StateRow).expires_at = new Date(Date.now() - 1000);
    const r = await request(app).get(`/api/google/oauth/callback?code=C&state=${encodeURIComponent(state)}`).set("Cookie", cookie);
    expect(r.headers.location).toMatch(/google=error/);
  });

  it("a failed token exchange returns to the portal with an error and saves nothing", async () => {
    tokenResponse = { status: 400, body: { error: "invalid_grant" } };
    const { state, cookie } = await start();
    const r = await request(app).get(`/api/google/oauth/callback?code=C&state=${encodeURIComponent(state)}`).set("Cookie", cookie);
    expect(r.headers.location).toMatch(/google=error&reason=exchange/);
    expect(db.account).toBeNull();
  });
});

describe("Google tokens after connect", () => {
  const uid = "11111111-1111-1111-1111-111111111111";
  const connect = (expiresInMs: number) => {
    db.account = { user_id: uid, google_email: "pat@acme.example", access_token_enc: encryptToken("AT-old"), refresh_token_enc: encryptToken("RT-1"), access_token_expires_at: new Date(Date.now() + expiresInMs), scopes: "openid email", status: "connected" };
  };

  it("refreshes an expiring access token with the refresh token and persists it encrypted", async () => {
    connect(10_000);
    tokenResponse = { status: 200, body: { access_token: "AT-new", expires_in: 3600 } };
    const g = await getGoogleForUser(pool as any, uid);
    expect(g?.accessToken).toBe("AT-new");
    const body = new URLSearchParams(fetchCalls.find((c) => c.url.includes("/token"))!.body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("RT-1");
    expect(decryptToken(db.account!.access_token_enc)).toBe("AT-new");
  });

  it("retries once with a refreshed token when Google answers 401", async () => {
    connect(3_600_000);
    tokenResponse = { status: 200, body: { access_token: "AT-new", expires_in: 3600 } };
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any = {}) => {
      if (String(url).includes("/token")) return new Response(JSON.stringify(tokenResponse.body), { status: 200 });
      seen.push(String(init.headers?.Authorization));
      return new Response("{}", { status: seen.length === 1 ? 401 : 200 });
    }));
    const g = await getGoogleForUser(pool as any, uid);
    const r = await g!.fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile");
    expect(r.status).toBe(200);
    expect(seen).toEqual(["Bearer AT-old", "Bearer AT-new"]);
  });

  it("invalid_grant marks the account for reconnection and returns no client", async () => {
    connect(-1000);
    tokenResponse = { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
    const g = await getGoogleForUser(pool as any, uid);
    expect(g).toBeNull();
    expect(db.account!.status).toBe("reauth_required");
    const s = await request(app).get("/api/google/status");
    expect(s.body).toMatchObject({ configured: true, connected: false, status: "reauth_required" });
  });

  it("disconnect revokes the grant at Google and forgets the tokens", async () => {
    connect(3_600_000);
    const r = await request(app).post("/api/google/oauth/disconnect").send({});
    expect(r.body).toMatchObject({ ok: true, connected: false, revoked: true });
    const revoke = fetchCalls.find((c) => c.url.startsWith("https://oauth2.googleapis.com/revoke"))!;
    expect(new URLSearchParams(revoke.body).get("token")).toBe("RT-1");
    expect(db.account).toBeNull();
  });
});
