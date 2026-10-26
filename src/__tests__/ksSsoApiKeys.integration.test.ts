// KS_SERVER_SSO_API_KEYS - SSO sign-in and the public REST API against real Postgres: the migration (twice), the SSO
// settings row, a full Google sign-in (only Google's token endpoint and signing key are faked) ending in a staff
// token, a refused deactivated user in the audit log, and API keys driving every public endpoint, then revocation.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";
import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { pool } from "../db.js";
import type { Q } from "../plans/state.js";
import { clearPlanCache } from "../plans/state.js";
import ssoRoutes, { setSsoKeyResolverForTests } from "../routes/authSso.js";
import { createPublicApiRouter } from "../publicApi/router.js";
import { currentPepper, generateApiKey, insertApiKey, revokeApiKey } from "../apiKeys/keys.js";
import { readSsoSettings, saveSsoSettings } from "../sso/settings.js";

const MIGRATION = "migrations/2026_11_02_ks_sso_api_keys.sql";
const db = pool as unknown as Q;
const STAFF = randomUUID();
const GONE = randomUUID();
const COMPANY = randomUUID();
const LENDER = randomUUID();
const APP_ID = randomUUID();
const tag = randomUUID().slice(0, 8);
const staffEmail = `sso-${tag}@acme.example`;
const goneEmail = `sso-gone-${tag}@acme.example`;
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
let emailForToken = staffEmail;
const realFetch = globalThis.fetch;
let savedPlan: Record<string, unknown> | null = null;

function ssoApp() {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use("/api/auth/sso", ssoRoutes);
  return a;
}
function apiApp() {
  const a = express();
  a.use(express.json());
  a.use("/api/open/v1", createPublicApiRouter());
  return a;
}

beforeAll(async () => {
  const sql = readFileSync(MIGRATION, "utf8");
  await pool.query(sql);
  await pool.query(sql);
  savedPlan = (await pool.query(`SELECT * FROM licensee_plan WHERE id = 1`)).rows[0] ?? null;
  await pool.query(`INSERT INTO licensee_plan (id, plan) VALUES (1, 'pro') ON CONFLICT (id) DO UPDATE SET plan = 'pro', trial_started_at = NULL, trial_ends_at = NULL`);
  clearPlanCache();
  await pool.query(`INSERT INTO users (id, email, role, active, silo) VALUES ($1, $2, 'Staff', true, 'BF'), ($3, $4, 'Staff', false, 'BF')`, [STAFF, staffEmail, GONE, goneEmail]);
  await pool.query(`INSERT INTO companies (id, name, silo) VALUES ($1, $2, 'BF')`, [COMPANY, `Acme ${tag}`]);
  await pool.query(`INSERT INTO lenders (id, name, country, silo) VALUES ($1, $2, 'CA', 'BF')`, [LENDER, `Lender ${tag}`]);
  await pool.query(
    `INSERT INTO applications (id, name, pipeline_state, status, created_at, updated_at, silo, company_id) VALUES ($1, $2, 'Received', 'RECEIVED', now(), now(), 'BF', $3)`,
    [APP_ID, `App ${tag}`, COMPANY],
  );
  process.env.GOOGLE_OAUTH_CLIENT_ID = "int-google-client";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "int-google-secret";
  process.env.SSO_RETURN_URL = "https://staff.example/login";
  setSsoKeyResolverForTests(async (_p, kid) => (kid === "int" ? (keys.publicKey as KeyObject) : null));
  globalThis.fetch = (async (url: any, init?: any) => {
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
      const verifier = new URLSearchParams(String(init?.body ?? "")).get("code_verifier");
      const r = await pool.query(`SELECT nonce FROM sso_login_states WHERE code_verifier = $1`, [verifier]);
      const now = Math.floor(Date.now() / 1000);
      const idToken = jwt.sign({ iss: "https://accounts.google.com", aud: "int-google-client", sub: "g", email: emailForToken, email_verified: true, nonce: r.rows[0]?.nonce, iat: now, exp: now + 300 }, keys.privateKey, { algorithm: "RS256", keyid: "int" });
      return new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
    }
    return realFetch(url, init);
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  setSsoKeyResolverForTests(undefined);
  await pool.query(`DELETE FROM crm_notes WHERE application_id = $1`, [APP_ID]);
  await pool.query(`DELETE FROM application_stage_events WHERE application_id = $1`, [APP_ID]);
  await pool.query(`DELETE FROM applications WHERE id = $1`, [APP_ID]);
  await pool.query(`DELETE FROM contacts WHERE email LIKE $1`, [`%${tag}%`]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [COMPANY]);
  await pool.query(`DELETE FROM lenders WHERE id = $1`, [LENDER]);
  await pool.query(`DELETE FROM api_keys WHERE name LIKE $1`, [`%${tag}%`]);
  await pool.query(`DELETE FROM sso_settings WHERE id = 1`);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[STAFF, GONE]]).catch((e) => console.warn("cleanup", String(e)));
  // Leave the plan row as it was: other suites (planMounts) depend on the default plan.
  await pool.query(`DELETE FROM licensee_plan`).catch((e) => console.warn("cleanup", String(e)));
  if (savedPlan) {
    const cols = Object.keys(savedPlan);
    await pool.query(`INSERT INTO licensee_plan (${cols.join(", ")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(", ")})`, cols.map((c) => savedPlan![c]))
      .catch((e) => console.warn("restore", String(e)));
  }
  clearPlanCache();
});

async function signIn(agent = ssoApp()) {
  const start = await request(agent).get("/api/auth/sso/google/start");
  const cookie = String(start.headers["set-cookie"]?.[0] ?? "").split(";")[0];
  const state = new URL(start.headers.location).searchParams.get("state")!;
  return request(agent).get(`/api/auth/sso/google/callback?code=c&state=${encodeURIComponent(state)}`).set("Cookie", cookie);
}

describe("SSO against Postgres", () => {
  it("stores the settings in one row", async () => {
    await saveSsoSettings(db, { microsoft_enabled: false, google_enabled: true, microsoft_tenant_id: "", google_hosted_domain: "", require_sso: false }, STAFF);
    expect(await readSsoSettings(db)).toMatchObject({ google_enabled: true, require_sso: false });
  });

  it("signs an active staff member in and refuses a deactivated one, both audit-logged", async () => {
    emailForToken = staffEmail.toUpperCase();
    const ok = await signIn();
    expect(ok.headers.location).toMatch(/#sso_code=/);
    const code = new URLSearchParams(ok.headers.location.split("#")[1]).get("sso_code")!;
    const ex = await request(ssoApp()).post("/api/auth/sso/exchange").send({ code });
    expect(ex.status).toBe(200);
    expect((jwt.decode(ex.body.data.token) as any).sub).toBe(STAFF);

    emailForToken = goneEmail;
    const refused = await signIn();
    expect(refused.headers.location).toContain("sso_error=user_inactive");
    const audit = await pool.query(
      `SELECT event_action, success FROM audit_events WHERE target_id = ANY($1::text[]) AND event_action LIKE 'sso_sign_in%' ORDER BY created_at`,
      [[STAFF, GONE]],
    );
    expect(audit.rows.map((r: any) => `${r.event_action}:${r.success}`)).toEqual(["sso_sign_in:true", "sso_sign_in_refused:false"]);
  });
});

describe("public API against Postgres", () => {
  let readKey = "";
  let writeKey = "";
  let readKeyId = "";
  beforeAll(async () => {
    const r = generateApiKey(currentPepper()!);
    readKeyId = (await insertApiKey(db, r, `read ${tag}`, "read", STAFF)).id;
    readKey = r.key;
    const w = generateApiKey(currentPepper()!);
    await insertApiKey(db, w, `write ${tag}`, "read_write", STAFF);
    writeKey = w.key;
  });
  const auth = (k: string) => ({ Authorization: `Bearer ${k}` });

  it("reads companies, applications (with stage) and lenders; records last use", async () => {
    const co = await request(apiApp()).get(`/api/open/v1/companies/${COMPANY}`).set(auth(readKey));
    expect(co.body.data).toMatchObject({ id: COMPANY, name: `Acme ${tag}` });
    const app = await request(apiApp()).get(`/api/open/v1/applications/${APP_ID}`).set(auth(readKey));
    expect(app.body.data).toMatchObject({ id: APP_ID, stage: "Received", company_id: COMPANY });
    const lenders = await request(apiApp()).get(`/api/open/v1/lenders?limit=100`).set(auth(readKey));
    expect(lenders.body.data.some((l: any) => l.id === LENDER)).toBe(true);
    expect(lenders.body.data[0]).not.toHaveProperty("api_key_encrypted");
    const used = await pool.query(`SELECT last_used_at FROM api_keys WHERE id = $1`, [readKeyId]);
    expect(used.rows[0].last_used_at).not.toBeNull();
  });

  it("creates a contact, moves the stage and adds a note with a read-write key", async () => {
    const c = await request(apiApp()).post("/api/open/v1/contacts").set(auth(writeKey))
      .send({ first_name: "Ann", last_name: "Lee", email: `ann-${tag}@acme.example`, company_id: COMPANY, job_title: "CFO" });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ first_name: "Ann", company_name: `Acme ${tag}`, job_title: "CFO", owner_id: STAFF });
    const found = await request(apiApp()).get(`/api/open/v1/contacts?email=ann-${tag}@acme.example`).set(auth(readKey));
    expect(found.body.data).toHaveLength(1);

    const s = await request(apiApp()).patch(`/api/open/v1/applications/${APP_ID}/stage`).set(auth(writeKey)).send({ stage: "In Review" });
    expect(s.status).toBe(200);
    expect(s.body.data.stage).toBe("In Review");
    const illegal = await request(apiApp()).patch(`/api/open/v1/applications/${APP_ID}/stage`).set(auth(writeKey)).send({ stage: "Received" });
    expect(illegal.status).toBeGreaterThanOrEqual(400);
    expect(illegal.body.error.code).toBeTruthy();

    const n = await request(apiApp()).post(`/api/open/v1/applications/${APP_ID}/notes`).set(auth(writeKey)).send({ body: "From the API" });
    expect(n.status).toBe(201);
    const notes = await request(apiApp()).get(`/api/open/v1/applications/${APP_ID}/notes`).set(auth(readKey));
    expect(notes.body.data.map((x: any) => x.body)).toContain("From the API");
  });

  it("a revoked key stops working at once", async () => {
    await revokeApiKey(db, readKeyId, STAFF);
    const r = await request(apiApp()).get("/api/open/v1/companies").set(auth(readKey));
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("api_key_revoked");
  });
});
