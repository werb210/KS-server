// KS_SERVER_v22_KYC - ID verification against real Postgres: the migration, staff request and plan gate, the
// applicant's manual upload through the client routes, a staff decision, a signed vendor webhook that lands the
// result, the images (as documents) and one usage event, and fraud check 8 reading the result.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pool } from "../db.js";
import kycRoutes from "../routes/kyc.js";
import clientKycRoutes from "../routes/clientKyc.js";
import { clearPlanCache, type Q } from "../plans/state.js";
import { handleWebhook } from "../kyc/service.js";
import { onfidoProvider, type BinaryFetch } from "../kyc/providers/onfido.js";
import { manualProvider } from "../kyc/providers/index.js";
import { runFraudChecks } from "../fraud/engine.js";
import { fraudProviders } from "../fraud/providers/index.js";
import { listResults } from "../fraud/store.js";

const db = pool as unknown as Q;
const tag = randomUUID().slice(0, 8);
const STAFF = randomUUID();
const APP = randomUUID();
const CONTACT = randomUUID();
const PHONE = `587555${String(Math.floor(Math.random() * 9000) + 1000)}`;
const staffToken = () => jwt.sign({ sub: STAFF, id: STAFF, role: "Staff", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
const clientToken = (phone = PHONE) => jwt.sign({ sub: `client-${tag}`, role: "Client", phone }, String(process.env.JWT_SECRET));
let savedPlan: Record<string, any> | null = null;

function app() {
  const a = express();
  a.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
  a.use("/api/kyc", kycRoutes);
  a.use("/api/client/kyc", clientKycRoutes);
  return a;
}

async function setPlan(plan: "starter" | "growth" | "pro") {
  await pool.query(`DELETE FROM licensee_plan`);
  await pool.query(`INSERT INTO licensee_plan (id, plan) VALUES (1, $1)`, [plan]);
  clearPlanCache();
}

describe("KS v22 ID verification (real Postgres)", () => {
  beforeAll(async () => {
    const sql = readFileSync("migrations/2026_11_05_ks_v22_kyc.sql", "utf8");
    await pool.query(sql);
    await pool.query(sql); // safe to run again
    savedPlan = (await pool.query(`SELECT * FROM licensee_plan WHERE id = 1`)).rows[0] ?? null;
    await pool.query(`UPDATE kyc_settings SET provider = NULL, wizard_step = false WHERE id = 1`);
    await pool.query(`INSERT INTO users (id, email, active, role, first_name, last_name) VALUES ($1, $2, true, 'Staff', 'Sam', 'Staff')`, [STAFF, `kyc-${tag}@example.com`]);
    await pool.query(`INSERT INTO contacts (id, name, first_name, last_name, phone, email) VALUES ($1, 'Jane Doe', 'Jane', 'Doe', $2, $3)`, [CONTACT, PHONE, `jane-${tag}@example.com`]);
    await pool.query(
      `INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, contact_id, owner_user_id, business_legal_name, metadata, submitted_at)
       VALUES ($1, $2, now(), now(), 'Received', 'RECEIVED', $3, $4, $2, '{}'::jsonb, now())`,
      [APP, `KYC Co ${tag}`, CONTACT, STAFF],
    );
  });

  afterAll(async () => {
    const warn = (e: unknown) => console.warn("cleanup", String(e));
    await pool.query(`DELETE FROM kyc_verifications WHERE application_id = $1`, [APP]).catch(warn);
    await pool.query(`DELETE FROM usage_events WHERE kind = 'id_check' AND ref = $1`, [`onfido:run-${tag}`]).catch(warn);
    await pool.query(`DELETE FROM communications_messages WHERE application_id::text = $1`, [APP]).catch(warn);
    for (const t of ["fraud_check_results", "fraud_queue", "document_fingerprints"]) await pool.query(`DELETE FROM ${t} WHERE application_id = $1`, [APP]).catch(warn);
    await pool.query(`DELETE FROM document_versions WHERE document_id IN (SELECT id FROM documents WHERE application_id = $1)`, [APP]).catch(warn);
    await pool.query(`DELETE FROM documents WHERE application_id = $1`, [APP]).catch(warn);
    await pool.query(`DELETE FROM applications WHERE id = $1`, [APP]).catch(warn);
    await pool.query(`DELETE FROM contacts WHERE id = $1`, [CONTACT]).catch(warn);
    await pool.query(`DELETE FROM users WHERE id = $1`, [STAFF]).catch(warn);
    await pool.query(`DELETE FROM licensee_plan`).catch(warn);
    if (savedPlan) {
      const cols = Object.keys(savedPlan);
      await pool.query(`INSERT INTO licensee_plan (${cols.join(", ")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(", ")})`, cols.map((c) => savedPlan![c])).catch(warn);
    }
    clearPlanCache();
  });

  it("is growth and up", async () => {
    await setPlan("starter");
    const r = await request(app()).get(`/api/kyc/applications/${APP}`).set("Authorization", `Bearer ${staffToken()}`);
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ error: "feature_not_in_plan", feature: "id_verification", required_plan: "growth" });
    const c = await request(app()).get(`/api/client/kyc/applications/${APP}`).set("Authorization", `Bearer ${clientToken()}`);
    expect(c.body).toMatchObject({ ok: true, enabled: false });
  });

  it("staff send a request (manual review without a vendor); the applicant uploads ID and selfie; staff approve", async () => {
    await setPlan("growth");
    const view = await request(app()).get(`/api/kyc/applications/${APP}`).set("Authorization", `Bearer ${staffToken()}`);
    expect(view.status).toBe(200);
    expect(view.body.provider).toMatchObject({ key: "manual", configured: true });
    expect(view.body.people[0]).toMatchObject({ contact_id: CONTACT, role: "applicant" });

    const sent = await request(app()).post(`/api/kyc/applications/${APP}/requests`).set("Authorization", `Bearer ${staffToken()}`).send({});
    expect(sent.status).toBe(201);
    const vid = sent.body.verification.id;
    const cta = await pool.query(`SELECT cta_action FROM communications_messages WHERE application_id::text = $1`, [APP]);
    expect(cta.rows.map((r: any) => r.cta_action)).toContain("id_verify");

    expect((await request(app()).get(`/api/client/kyc/applications/${APP}`).set("Authorization", `Bearer ${clientToken("4035550000")}`)).status).toBe(403);
    const mine = await request(app()).get(`/api/client/kyc/applications/${APP}`).set("Authorization", `Bearer ${clientToken()}`);
    expect(mine.body).toMatchObject({ enabled: true, verifications: [{ id: vid, status: "requested", mode: "upload" }] });
    const start = await request(app()).post(`/api/client/kyc/verifications/${vid}/start`).set("Authorization", `Bearer ${clientToken()}`);
    expect(start.body).toMatchObject({ ok: true, mode: "upload" });

    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
    const up = await request(app()).post(`/api/client/kyc/verifications/${vid}/upload`).set("Authorization", `Bearer ${clientToken()}`)
      .attach("id_front", jpg, { filename: "front.jpg", contentType: "image/jpeg" })
      .attach("selfie", jpg, { filename: "me.jpg", contentType: "image/jpeg" });
    expect(up.status).toBe(200);
    expect(up.body).toEqual({ ok: true, status: "review" });
    const docs = await pool.query(`SELECT category, uploaded_by FROM documents WHERE application_id = $1`, [APP]);
    expect(docs.rows).toHaveLength(2);
    expect(docs.rows.every((d: any) => d.category === "Identity verification")).toBe(true);

    const ok = await request(app()).post(`/api/kyc/verifications/${vid}/decision`).set("Authorization", `Bearer ${staffToken()}`).send({ decision: "approved", note: "Matches" });
    expect(ok.status).toBe(200);
    expect(ok.body.verification).toMatchObject({ status: "approved", decision_source: "staff" });
    const full = await request(app()).get(`/api/kyc/verifications/${vid}/id-details?full=1`).set("Authorization", `Bearer ${staffToken()}`);
    expect(full.status).toBe(403);
  });

  it("a signed vendor webhook lands the result encrypted, stores the images and counts one ID check; fraud check 8 reads it", async () => {
    const run = `run-${tag}`;
    const vid = randomUUID();
    await pool.query(
      `INSERT INTO kyc_verifications (id, application_id, contact_id, person_role, provider, status, vendor_session_id, vendor_applicant_id)
       VALUES ($1, $2, $3, 'guarantor', 'onfido', 'in_progress', $4, 'appl-1')`,
      [vid, APP, CONTACT, run],
    );
    const routes: Record<string, any> = {
      [`/workflow_runs/${run}`]: { id: run, status: "declined", applicant_id: "appl-1", reasons: ["document_tampered"] },
      "/checks": { checks: [{ report_ids: ["rep-doc"] }] },
      "/reports/rep-doc": { name: "document", result: "consider", sub_result: "suspected", properties: { document_numbers: [{ value: "X99887766" }], date_of_birth: "1970-01-01" } },
      "/documents?": { documents: [{ id: "d1", side: "front", file_type: "jpg" }] },
      "/documents/d1/download": {},
      "/live_photos?": { live_photos: [] },
    };
    const f: BinaryFetch = (async (url: string) => {
      const path = url.replace(/^https:\/\/api\.ca\.onfido\.com\/v3\.6/, "");
      const key = Object.keys(routes).find((k) => path.startsWith(k));
      return { ok: Boolean(key), status: key ? 200 : 404, json: async () => (key ? routes[key] : {}), arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 9, 0xff, 0xd9]).buffer, headers: { get: () => "image/jpeg" } };
    }) as BinaryFetch;
    const env = { ONFIDO_API_TOKEN: "t", ONFIDO_WORKFLOW_ID: "w", ONFIDO_WEBHOOK_TOKEN: "hook", NODE_ENV: "test" } as any;
    const providers = { onfido: onfidoProvider(env, f), manual: manualProvider() };
    const body = { payload: { resource_type: "workflow_run", action: "workflow_run.completed", object: { id: run } } };
    const raw = Buffer.from(JSON.stringify(body));
    const sig = createHmac("sha256", "hook").update(raw).digest("hex");
    const out = await handleWebhook("onfido", raw, { "x-sha2-signature": sig }, body, { providers });
    expect(out).toMatchObject({ status: 200, outcome: "processed" });
    expect((await handleWebhook("onfido", raw, { "x-sha2-signature": sig }, body, { providers })).outcome).toBe("duplicate");
    const row = (await pool.query(`SELECT * FROM kyc_verifications WHERE id = $1`, [vid])).rows[0];
    expect(row.status).toBe("declined");
    expect(row.document_ids).toHaveLength(1);
    expect(JSON.stringify(row)).not.toContain("X99887766");
    expect(row.pii_enc).toBeTruthy();
    const usage = await pool.query(`SELECT quantity FROM usage_events WHERE kind = 'id_check' AND ref = $1`, [`onfido:${run}`]);
    expect(usage.rows).toEqual([{ quantity: 1 }]);
    const reveal = await request(app()).get(`/api/kyc/verifications/${vid}/id-details`).set("Authorization", `Bearer ${staffToken()}`);
    expect(reveal.body.details.document_number).toBe("*****7766");

    await runFraudChecks(db, APP, { providers: fraudProviders({ NODE_ENV: "test" } as any), loadFile: async () => null });
    const f8 = (await listResults(db, APP)).find((r) => r.check_key === "fraud_8");
    expect(f8?.status).toBe("red");
    expect(JSON.stringify(f8?.reasons)).toContain("idv_declined");
  });
});
