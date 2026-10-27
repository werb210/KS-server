// KS_SERVER_v9_FRAUD - the fraud suite against real Postgres: the migration, the engine over seeded applications,
// the routes with plan gating, the worker queue, the client beacon, the watchlist sync and inside-job alerts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import fraudRoutes from "../routes/fraud.js";
import { clearPlanCache, type Q } from "../plans/state.js";
import { runFraudChecks } from "../fraud/engine.js";
import { fraudProviders } from "../fraud/providers/index.js";
import { listResults, saveFraudSettings, enqueueFraudRun } from "../fraud/store.js";
import { recordSignals, parseSignals } from "../fraud/deviceSignals.js";
import { recordStatementMath } from "../fraud/statementHook.js";
import { handleCandidates, alertAdmins } from "../fraud/insider.js";
import { processQueue, queueNewWork, syncWatchlist } from "../workers/fraudWorker.js";
import { loadPrescreenForPackage } from "../fraud/prescreen.js";
import { makeJpeg, textPdf } from "../fraud/__tests__/fixtures.js";

const MIGRATION = "migrations/2026_10_23_ks_v9_fraud.sql";
const db = pool as unknown as Q;
const tag = randomUUID().slice(0, 8);
const ADMIN = randomUUID();
const ADMIN2 = randomUUID();
const STAFF = randomUUID();
const token = (role: string, id = ADMIN) => jwt.sign({ sub: id, id, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
const A = randomUUID(), B = randomUUID(), F = randomUUID(), C = randomUUID();
const contactA = randomUUID(), contactB = randomUUID(), contactF = randomUUID();
const docs: Record<string, Buffer> = {};
let savedPlan: Record<string, any> | null = null;
let savedSettings: Record<string, any> | null = null;
const providers = fraudProviders({ NODE_ENV: "test" } as any);

const cheque = makeJpeg(900, 400, 88, 2);
const loadFile = async (d: { id: string }) => docs[d.id] ?? null;

async function setPlan(plan: "starter" | "growth" | "pro", addons: Record<string, boolean> = {}) {
  await pool.query(`DELETE FROM licensee_plan`);
  await pool.query(`INSERT INTO licensee_plan (id, plan, addons) VALUES (1, $1, $2::jsonb)`, [plan, JSON.stringify(addons)]); // KS_SERVER_BANK_CONNECT_ADDON
  clearPlanCache();
}

async function addDoc(appId: string, category: string, file: Buffer, uploadedBy = "client"): Promise<string> {
  const id = randomUUID();
  docs[id] = file;
  await pool.query(`INSERT INTO documents (id, application_id, created_at, category, filename, uploaded_by) VALUES ($1, $2, now(), $3, $4, $5)`, [id, appId, category, `${category}-${tag}`, uploadedBy]);
  return id;
}

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/fraud", fraudRoutes);
  return a;
}

describe("KS v9 fraud suite (real Postgres)", () => {
  beforeAll(async () => {
    await pool.query(readFileSync(MIGRATION, "utf8"));
    await pool.query(readFileSync(MIGRATION, "utf8")); // safe to run again
    savedPlan = (await pool.query(`SELECT * FROM licensee_plan WHERE id = 1`)).rows[0] ?? null;
    savedSettings = (await pool.query(`SELECT * FROM fraud_settings WHERE id = 1`)).rows[0] ?? null;
    await setPlan("pro");
    await pool.query(`INSERT INTO users (id, email, active, role, first_name, last_name) VALUES ($1, $2, true, 'Admin', 'Pat', 'Admin'), ($3, $4, true, 'Admin', 'Second', 'Admin')`, [ADMIN, `a-${tag}@example.com`, ADMIN2, `b-${tag}@example.com`]);
    for (const [id, name, phone, email] of [[contactA, "Jane Doe", "5875550100", `jane-${tag}@acme.example`], [contactB, "Sam Roe", "4035550199", `sam-${tag}@other.example`], [contactF, "Jay Fraud", "5875550100", `jay-${tag}@fraud.example`]]) {
      await pool.query(`INSERT INTO contacts (id, name, phone, email) VALUES ($1, $2, $3, $4)`, [id, name, phone, email]);
    }
    const ins = `INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, contact_id, owner_user_id, business_legal_name, metadata, submitted_at)
                 VALUES ($1, $2, now(), now(), $3, 'RECEIVED', $4, $5, $2, $6::jsonb, now())`;
    await pool.query(ins, [A, `Acme ${tag}`, "Received", contactA, ADMIN, JSON.stringify({ kyc: { annualRevenue: "$2,000,000" }, applicant: { firstName: "Jane", lastName: "Doe", email: `jane-${tag}@acme.example`, phone: "5875550100" } })]);
    await pool.query(ins, [B, `Other ${tag}`, "Received", contactB, null, JSON.stringify({})]);
    await pool.query(ins, [F, `Fraudco ${tag}`, "Fraud", contactF, null, JSON.stringify({})]);
    await pool.query(`UPDATE applications SET fraud_confirmed_at = now() WHERE id = $1`, [F]);
    await addDoc(A, "void_cheque", cheque);
    await addDoc(A, "bank_statements_6_months", await textPdf({ producer: "Adobe Photoshop" }));
    await addDoc(B, "void_cheque", makeJpeg(900, 400, 55, 2)); // same picture, saved again
    // Banking: about 50k a month deposited, plus an undisclosed MCA advance and daily repayments.
    await pool.query(`INSERT INTO banking_analyses (application_id, total_avg_monthly_deposits, months_detected, status) VALUES ($1, 50000, 6, 'analysis_complete')`, [A]);
    await pool.query(`INSERT INTO banking_transactions (application_id, transaction_date, description, amount) VALUES ($1, '2031-02-01', 'MERCHANT GROWTH FUNDING', 40000)`, [A]);
    for (let i = 2; i < 16; i++) await pool.query(`INSERT INTO banking_transactions (application_id, transaction_date, description, amount) VALUES ($1, $2, 'ACH DEBIT MERCHANT GROWTH', -412.50)`, [A, `2031-02-${String(i).padStart(2, "0")}`]);
  });

  afterAll(async () => {
    const warn = (e: unknown) => console.warn("cleanup", String(e));
    const apps = [A, B, F, C];
    for (const t of ["fraud_check_results", "fraud_queue", "document_fingerprints", "fraud_device_signals", "fraud_watchlist_shares", "fraud_bank_links", "banking_transactions"]) {
      await pool.query(`DELETE FROM ${t} WHERE application_id = ANY($1::text[])`, [apps]).catch(warn);
    }
    await pool.query(`DELETE FROM banking_analyses WHERE application_id = ANY($1::text[])`, [apps]).catch(warn);
    await pool.query(`DELETE FROM staff_risk_events WHERE user_id = ANY($1::text[])`, [[ADMIN, ADMIN2]]).catch(warn);
    await pool.query(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [[ADMIN, ADMIN2]]).catch(warn);
    await pool.query(`DELETE FROM documents WHERE application_id = ANY($1::text[])`, [apps]).catch(warn);
    await pool.query(`DELETE FROM applications WHERE id = ANY($1::text[])`, [apps]).catch(warn);
    await pool.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [[contactA, contactB, contactF]]).catch(warn);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ADMIN, ADMIN2]]).catch(warn);
    await pool.query(`DELETE FROM licensee_plan`).catch(warn);
    if (savedPlan) {
      const cols = Object.keys(savedPlan);
      await pool.query(`INSERT INTO licensee_plan (${cols.join(", ")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(", ")})`, cols.map((c) => savedPlan![c])).catch(warn);
    }
    if (savedSettings) await pool.query(`UPDATE fraud_settings SET watchlist_opt_in = $1, include_prescreen_in_package = $2 WHERE id = 1`, [savedSettings.watchlist_opt_in, savedSettings.include_prescreen_in_package]).catch(warn);
    clearPlanCache();
  });

  it("the client beacon stores hashes only, and only what the plan uses", async () => {
    const signals = (appId: string) => parseSignals({ application_id: appId, device_id: `device-${tag}`, platform: "web", behaviour: { completion_seconds: 25, fields_completed: 40, pasted_fields: ["sin", "account_number", "transit"] } })!;
    expect(await recordSignals(db, signals(A), { ip: "203.0.113.7", allowed: new Set(["fraud_9", "fraud_10"]), ipIntel: null })).toBe("stored");
    expect(await recordSignals(db, signals(B), { ip: "203.0.113.7", allowed: new Set(["fraud_9", "fraud_10"]), ipIntel: null })).toBe("stored");
    expect(await recordSignals(db, signals(C), { ip: null, allowed: new Set(["fraud_9"]), ipIntel: null })).toBe("unknown_application");
    expect(await recordSignals(db, signals(A), { ip: null, allowed: new Set(["fraud_1"]), ipIntel: null })).toBe("not_in_plan");
    const row = (await pool.query(`SELECT * FROM fraud_device_signals WHERE application_id = $1`, [A])).rows[0];
    expect(row.device_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain("203.0.113.7");
    expect(JSON.stringify(row)).not.toContain(`device-${tag}`);
  });

  it("runs every check on a pro plan and stores honest results", async () => {
    await runFraudChecks(db, B, { loadFile, providers });
    const r = await runFraudChecks(db, A, { loadFile, providers, licenseeCountry: async () => "CA" });
    expect(r!.errors).toEqual([]);
    const rows = await listResults(db, A);
    const by = (k: string, subject = "") => rows.find((x) => x.check_key === k && x.subject === subject);
    const tamper = rows.filter((x) => x.check_key === "fraud_1");
    expect(tamper).toHaveLength(2);
    expect(tamper.some((t) => t.status === "red")).toBe(true); // Photoshop-made bank statement
    expect(by("fraud_4")!.status).toBe("red"); // same void cheque on another business
    expect(by("fraud_5")!.status).toBe("red"); // 2M claimed vs about 600k a year deposited
    expect(by("fraud_11")!.status).toBe("red");
    expect(by("fraud_12")!.status).toBe("red"); // shares a phone with a confirmed fraud file
    expect(by("fraud_9")!.status).toBe("amber"); // device used for one other business
    expect(by("fraud_10")!.status).toBe("red"); // 25 seconds for 40 fields
    expect(by("fraud_3")).toBeUndefined(); // KS_SERVER_BANK_CONNECT_ADDON - add-on off: check 3 does not run, even on pro
    expect(by("fraud_6")!.status).not.toBe("green"); // nothing it could check
    expect(by("fraud_15")!.status).toBe("not_applicable");
    expect(by("fraud_13")!.status).toBe("not_applicable"); // sharing is off
    expect(Number(by("fraud_16")!.details.score)).toBeGreaterThanOrEqual(50);
  });

  it("the overview route shows all 15 on pro, marks locked checks on starter, and gated routes answer 402", async () => {
    try { await overviewAndGates(); } finally { await setPlan("pro"); }
  });

  async function overviewAndGates() {
    const pro = await request(app()).get(`/api/fraud/applications/${A}`).set("Authorization", `Bearer ${token("Staff")}`);
    expect(pro.status).toBe(200);
    expect(pro.body.checks).toHaveLength(15); // KS_SERVER_BANK_CONNECT_ADDON - fraud_3 hidden while the add-on is off
    expect(pro.body.checks.some((c: any) => c.key === "fraud_3")).toBe(false);
    const link = await request(app()).put(`/api/fraud/applications/${A}/bank-link`).set("Authorization", `Bearer ${token("Staff")}`).send({ login_id: "5e2f6a3b-1111-4c4c-9d9d-000000000001" });
    expect(link.status).toBe(404);
    expect(pro.body.checks.filter((c: any) => c.locked)).toEqual([]);
    expect(pro.body.score.score).toBeGreaterThanOrEqual(50);
    expect(pro.body.documents).toHaveLength(2);
    expect(pro.body.documents.every((d: any) => d.tamper)).toBe(true);
    const net = await request(app()).get(`/api/fraud/applications/${A}/network`).set("Authorization", `Bearer ${token("Staff")}`);
    expect(net.status).toBe(200);
    expect(JSON.stringify(net.body)).not.toContain("5875550100");
    expect(net.body.network.nodes.some((n: any) => n.fraud)).toBe(true);
    const pre = await request(app()).get(`/api/fraud/applications/${A}/prescreen`).set("Authorization", `Bearer ${token("Staff")}`);
    expect(pre.body.lines.at(-1)).toMatch(/not a finding of fraud/);

    await setPlan("starter");
    const starter = await request(app()).get(`/api/fraud/applications/${A}`).set("Authorization", `Bearer ${token("Staff")}`);
    const locked = starter.body.checks.filter((c: any) => c.locked).map((c: any) => Number(c.key.slice(6))).sort((a: number, b: number) => a - b);
    expect(locked).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]); // never "locked 3": an off add-on is not an upsell
    expect(starter.body.score).toBeNull();
    const refused = await request(app()).get(`/api/fraud/applications/${A}/network`).set("Authorization", `Bearer ${token("Staff")}`);
    expect(refused.status).toBe(402);
    expect(refused.body).toMatchObject({ error: "feature_not_in_plan", feature: "fraud_12", required_plan: "pro" });
    const optIn = await request(app()).put(`/api/fraud/settings`).set("Authorization", `Bearer ${token("Admin")}`).send({ watchlist_opt_in: true });
    expect(optIn.status).toBe(402);
    const staffSettings = await request(app()).get(`/api/fraud/settings`).set("Authorization", `Bearer ${token("Staff", STAFF)}`); // auth reads the role from users; STAFF has no row
    expect(staffSettings.status).toBe(403);
    const settings = await request(app()).get(`/api/fraud/settings`).set("Authorization", `Bearer ${token("Admin")}`);
    expect(settings.body.services.find((s: any) => s.key === "voice").configured).toBe(false);
    expect(settings.body.services.some((s: any) => s.key === "bank")).toBe(false);
    expect(settings.body.allowed).not.toContain("fraud_3");
  }

  // KS_SERVER_BANK_CONNECT_ADDON - operations switched bank connect on for this licensee (any plan).
  it("with the bank_connect add-on on, check 3 runs, is listed and the bank link can be saved", async () => {
    try {
      await setPlan("starter", { bank_connect: true });
      await runFraudChecks(db, A, { loadFile, providers, licenseeCountry: async () => "CA" });
      expect((await listResults(db, A)).find((x) => x.check_key === "fraud_3" && x.subject === "")!.status).toBe("not_configured");
      const ov = await request(app()).get(`/api/fraud/applications/${A}`).set("Authorization", `Bearer ${token("Staff")}`);
      const three = ov.body.checks.find((c: any) => c.key === "fraud_3");
      expect(three).toMatchObject({ label: "Statement vs live bank data", locked: false });
      const link = await request(app()).put(`/api/fraud/applications/${A}/bank-link`).set("Authorization", `Bearer ${token("Staff")}`).send({ login_id: "5e2f6a3b-1111-4c4c-9d9d-000000000001" });
      expect(link.status).toBe(200);
      expect((await pool.query(`SELECT login_id FROM fraud_bank_links WHERE application_id = $1`, [A])).rows[0].login_id).toBe("5e2f6a3b-1111-4c4c-9d9d-000000000001");
      const settings = await request(app()).get(`/api/fraud/settings`).set("Authorization", `Bearer ${token("Admin")}`);
      expect(settings.body.services.find((s: any) => s.key === "bank")).toMatchObject({ used_by: ["fraud_3"] });
      const del = await request(app()).delete(`/api/fraud/applications/${A}/bank-link`).set("Authorization", `Bearer ${token("Staff")}`);
      expect(del.status).toBe(200);
    } finally {
      await pool.query(`DELETE FROM fraud_check_results WHERE application_id = $1 AND check_key = 'fraud_3'`, [A]);
      await setPlan("pro");
    }
  });

  it("statement math is stored per document from the banking hook", async () => {
    const docId = (await pool.query(`SELECT id FROM documents WHERE application_id = $1 AND category = 'bank_statements_6_months'`, [A])).rows[0].id;
    await recordStatementMath(db, A, docId, [{ date: "2031-02-01", description: "Opening balance", balance: 100 }, { date: "2031-02-02", description: "x", amount: 50, balance: 150 }, { date: "2031-02-03", description: "y", amount: 50, balance: 900 }, { date: "2031-02-04", description: "z", amount: 50, balance: 950 }, { date: "2031-02-28", description: "Closing balance", balance: 950 }]);
    const row = (await listResults(db, A)).find((x) => x.check_key === "fraud_2" && x.subject === docId)!;
    expect(row.status).toBe("red");
  });

  it("the worker queues new documents and runs them", async () => {
    await pool.query(`INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status) VALUES ($1, $2, now(), now(), 'Received', 'RECEIVED')`, [C, `C ${tag}`]);
    const docId = await addDoc(C, "other", await textPdf());
    expect(await queueNewWork(db)).toBeGreaterThanOrEqual(1);
    await processQueue(db, { loadFile, providers }, 50);
    const q = (await pool.query(`SELECT done_at, requested_at FROM fraud_queue WHERE application_id = $1`, [C])).rows[0];
    expect(q.done_at).not.toBeNull();
    expect((await pool.query(`SELECT 1 FROM document_fingerprints WHERE document_id = $1`, [docId])).rows).toHaveLength(1);
    await enqueueFraudRun(db, C, "again");
    expect((await pool.query(`SELECT done_at < requested_at AS due FROM fraud_queue WHERE application_id = $1`, [C])).rows[0].due).toBe(true);
  });

  it("shares confirmed fraud with the watchlist as hashes and withdraws it when restored", async () => {
    await saveFraudSettings(db, { watchlist_opt_in: true }, ADMIN);
    const env = { KS_WATCHLIST_PEPPER: "network-pepper-0123456789", KS_OPS_URL: "https://ops.example", KS_LICENSEE_ID: randomUUID(), KS_OPS_KEY: "k" } as any;
    const sent: any[] = [];
    const fetchImpl: any = async (url: string, init: any) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "" }; };
    await syncWatchlist(db, { env, fetchImpl });
    const report = sent.find((s) => s.url.endsWith("/watchlist/report") && s.body.entries.length);
    expect(report).toBeTruthy();
    expect(JSON.stringify(report.body)).not.toMatch(/5875550100|Jay|fraud\.example/);
    await pool.query(`UPDATE applications SET pipeline_state = 'Received', fraud_confirmed_at = NULL WHERE id = $1`, [F]);
    await syncWatchlist(db, { env, fetchImpl });
    expect(sent.some((s) => s.url.endsWith("/watchlist/withdraw"))).toBe(true);
    await saveFraudSettings(db, { watchlist_opt_in: false }, ADMIN);
  });

  it("inside-job events alert the other Admins once", async () => {
    await handleCandidates(db, { id: ADMIN, label: "Pat Admin" }, [{ kind: "banking_details_changed", severity: "red", applicationId: A, detail: { fields: ["transit_number"] } }], new Date());
    await handleCandidates(db, { id: ADMIN, label: "Pat Admin" }, [{ kind: "banking_details_changed", severity: "red", applicationId: A, detail: { fields: ["transit_number"] } }], new Date()); // same hour: deduped
    await alertAdmins(db);
    await alertAdmins(db);
    // KS_SERVER_TEST_ISOLATION - other files add Admins to the shared database in parallel; look only at this file's two.
    const n = await pool.query(`SELECT user_id::text AS u, body FROM notifications WHERE type = 'fraud_staff_alert' AND application_id = $1 AND user_id::text = ANY($2::text[])`, [A, [ADMIN, ADMIN2]]);
    expect(n.rows).toEqual([{ u: ADMIN2, body: "Pat Admin changed the banking details on a file. Review it in the file's Fraud check tab." }]);
  });

  it("adds the pre-screen PDF to the lender package only when asked", async () => {
    expect(await loadPrescreenForPackage(db, A, "Northwind")).toBeNull();
    await pool.query(`UPDATE applications SET fraud_prescreen_in_package = true WHERE id = $1`, [A]);
    const pdf = await loadPrescreenForPackage(db, A, "Northwind");
    expect(pdf?.filename).toBe("fraud-prescreen.pdf");
    expect(pdf?.content.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
