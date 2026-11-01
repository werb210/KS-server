// KS_SERVER_v23_QUOTES - quotes against real Postgres: plan gate, a draft built from a lender offer, editing, the PDF,
// sending (PDF stored on Documents, client button), the client's view (counted, owner told) and acceptance (the offer
// staged for acceptance like its own Accept button), and declines.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pool } from "../db.js";
import quotesRoutes from "../routes/quotes.js";
import clientQuotesRoutes from "../routes/clientQuotes.js";
import { clearPlanCache } from "../plans/state.js";
import { sendQuote, type Db } from "../quotes/service.js";

const tag = randomUUID().slice(0, 8);
const STAFF = randomUUID();
const APP = randomUUID();
const CONTACT = randomUUID();
const OFFER = randomUUID();
const PHONE = `403555${String(Math.floor(Math.random() * 9000) + 1000)}`;
const staff = () => jwt.sign({ sub: STAFF, id: STAFF, role: "Staff", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
const client = (phone = PHONE) => jwt.sign({ sub: `client-${tag}`, role: "Client", phone }, String(process.env.JWT_SECRET));
let savedPlan: Record<string, any> | null = null;
const app = () => { const a = express(); a.use(express.json()); a.use("/api/quotes", quotesRoutes); a.use("/api/client/quotes", clientQuotesRoutes); return a; };
async function setPlan(plan: string) { await pool.query(`DELETE FROM licensee_plan`); await pool.query(`INSERT INTO licensee_plan (id, plan) VALUES (1, $1)`, [plan]); clearPlanCache(); }

describe("KS v23 quotes (real Postgres)", () => {
  beforeAll(async () => {
    const sql = readFileSync("migrations/2026_11_06_ks_v23_quotes.sql", "utf8");
    await pool.query(sql);
    await pool.query(sql);
    savedPlan = (await pool.query(`SELECT * FROM licensee_plan WHERE id = 1`)).rows[0] ?? null;
    await pool.query(`INSERT INTO users (id, email, active, role, first_name, last_name) VALUES ($1, $2, true, 'Staff', 'Sam', 'Staff')`, [STAFF, `q-${tag}@example.com`]);
    await pool.query(`INSERT INTO contacts (id, name, phone) VALUES ($1, 'Jane Doe', $2)`, [CONTACT, PHONE]);
    await pool.query(
      `INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, contact_id, owner_user_id, business_legal_name, metadata, submitted_at)
       VALUES ($1, $2, now(), now(), 'Offer', 'RECEIVED', $3, $4, $2, '{}'::jsonb, now())`, [APP, `Quote Co ${tag}`, CONTACT, STAFF]);
    await pool.query(`INSERT INTO offers (id, application_id, lender_name, amount, rate_factor, term, payment_frequency, status) VALUES ($1, $2, 'Northern Capital', 75000, '1.28', '9 months', 'Weekly', 'pending')`, [OFFER, APP]);
  });

  afterAll(async () => {
    const warn = (e: unknown) => console.warn("cleanup", String(e));
    await pool.query(`DELETE FROM quotes WHERE application_id = $1`, [APP]).catch(warn);
    await pool.query(`DELETE FROM notifications WHERE application_id = $1`, [APP]).catch(warn);
    await pool.query(`DELETE FROM communications_messages WHERE application_id::text = $1`, [APP]).catch(warn);
    await pool.query(`DELETE FROM document_versions WHERE document_id IN (SELECT id FROM documents WHERE application_id = $1)`, [APP]).catch(warn);
    await pool.query(`DELETE FROM documents WHERE application_id = $1`, [APP]).catch(warn);
    await pool.query(`DELETE FROM offers WHERE id = $1`, [OFFER]).catch(warn);
    await pool.query(`DELETE FROM applications WHERE id = $1`, [APP]).catch(warn);
    await pool.query(`DELETE FROM contacts WHERE id = $1`, [CONTACT]).catch(warn);
    await pool.query(`DELETE FROM users WHERE id = $1`, [STAFF]).catch(warn);
    await pool.query(`DELETE FROM licensee_plan`).catch(warn);
    if (savedPlan) { const cols = Object.keys(savedPlan); await pool.query(`INSERT INTO licensee_plan (${cols.join(", ")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(", ")})`, cols.map((c) => savedPlan![c])).catch(warn); }
    clearPlanCache();
  });

  it("is growth and up", async () => {
    await setPlan("starter");
    const r = await request(app()).get(`/api/quotes/applications/${APP}`).set("Authorization", `Bearer ${staff()}`);
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ feature: "quotes", required_plan: "growth" });
  });

  let quoteId = "";
  let optionId = "";
  it("builds a draft from the lender offer, edits it and previews the PDF", async () => {
    await setPlan("growth");
    const list = await request(app()).get(`/api/quotes/applications/${APP}`).set("Authorization", `Bearer ${staff()}`);
    expect(list.body.offers.map((o: any) => o.id)).toContain(OFFER);
    const made = await request(app()).post(`/api/quotes/applications/${APP}`).set("Authorization", `Bearer ${staff()}`).send({ offer_ids: [OFFER] });
    expect(made.status).toBe(201);
    quoteId = made.body.quote.id;
    expect(made.body.quote).toMatchObject({ status: "draft", options: [{ offer_id: OFFER, lender_name: "Northern Capital", rate_kind: "factor_rate", payment_frequency: "weekly" }] });
    expect(made.body.quote.options[0].total_repayment).toBe(96000);

    const opts = made.body.quote.options.map((o: any) => ({ ...o, fees: [{ label: "Origination", amount: 1500, deducted: true }] }));
    const edit = await request(app()).put(`/api/quotes/${quoteId}`).set("Authorization", `Bearer ${staff()}`).send({ message: "Best offer we found.", options: opts });
    expect(edit.status).toBe(200);
    expect(edit.body.quote.options[0]).toMatchObject({ total_fees: 1500, net_proceeds: 73500, cost_of_borrowing: 22500 });
    optionId = edit.body.quote.options[0].id;

    const pdf = await request(app()).get(`/api/quotes/${quoteId}/pdf`).set("Authorization", `Bearer ${staff()}`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on("data", (d) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    // the client cannot see a draft
    expect((await request(app()).get(`/api/client/quotes/${quoteId}`).set("Authorization", `Bearer ${client()}`)).status).toBe(404);
  });

  it("sends it: the PDF lands on Documents, the client gets a button; a sent quote cannot change", async () => {
    const storage = { put: async (x: any) => ({ blobName: `q/${x.filename}`, url: `https://blob/${x.filename}`, hash: "h", sizeBytes: x.buffer.length }) };
    const r = await sendQuote(quoteId, STAFF, { db: pool as unknown as Db, storage });
    expect(r.ok && r.quote.status).toBe("sent");
    const doc = await pool.query(`SELECT category, document_type FROM documents WHERE application_id = $1`, [APP]);
    expect(doc.rows).toEqual([{ category: "Quote", document_type: "quote_pdf" }]);
    const cta = await pool.query(`SELECT cta_action FROM communications_messages WHERE application_id::text = $1`, [APP]);
    expect(cta.rows.map((x: any) => x.cta_action)).toContain(`quote:${quoteId}`);
    const edit = await request(app()).put(`/api/quotes/${quoteId}`).set("Authorization", `Bearer ${staff()}`).send({ title: "x" });
    expect(edit.status).toBe(409);
  });

  it("the client views (counted, owner told) and accepts; the offer is staged for acceptance", async () => {
    expect((await request(app()).get(`/api/client/quotes/${quoteId}`).set("Authorization", `Bearer ${client("4035550000")}`)).status).toBe(403);
    const v = await request(app()).get(`/api/client/quotes/${quoteId}`).set("Authorization", `Bearer ${client()}`);
    expect(v.status).toBe(200);
    expect(v.body.quote.status).toBe("viewed");
    expect(JSON.stringify(v.body)).not.toContain(OFFER);
    await request(app()).get(`/api/client/quotes/${quoteId}`).set("Authorization", `Bearer ${client()}`);
    const row = (await pool.query(`SELECT view_count, first_viewed_at FROM quotes WHERE id = $1`, [quoteId])).rows[0];
    expect(row.view_count).toBe(2);
    const notes = await pool.query(`SELECT type FROM notifications WHERE application_id = $1 ORDER BY created_at`, [APP]);
    expect(notes.rows.map((n: any) => n.type)).toEqual(["quote_viewed"]);

    const bad = await request(app()).post(`/api/client/quotes/${quoteId}/accept`).set("Authorization", `Bearer ${client()}`).send({ option_id: optionId, name: "Jane Doe", agree: false });
    expect(bad.body.error).toBe("tick_to_agree");
    const ok = await request(app()).post(`/api/client/quotes/${quoteId}/accept`).set("Authorization", `Bearer ${client()}`).send({ option_id: optionId, name: "Jane Doe", agree: true });
    expect(ok.status).toBe(200);
    expect(ok.body.quote).toMatchObject({ status: "accepted", accepted_option_id: optionId });
    const offer = (await pool.query(`SELECT status FROM offers WHERE id = $1`, [OFFER])).rows[0];
    expect(offer.status).toBe("pending_acceptance");
    const a = (await pool.query(`SELECT pending_acceptance_offer_id::text AS o FROM applications WHERE id = $1`, [APP])).rows[0];
    expect(a.o).toBe(OFFER);
    const again = await request(app()).post(`/api/client/quotes/${quoteId}/decline`).set("Authorization", `Bearer ${client()}`).send({});
    expect(again.status).toBe(409);
    const tl = await request(app()).get(`/api/quotes/${quoteId}`).set("Authorization", `Bearer ${staff()}`);
    expect(tl.body.events.map((e: any) => e.kind)).toEqual(["created", "edited", "sent", "viewed", "accepted"]);
  });

  it("duplicate makes a new draft; withdraw closes it", async () => {
    const d = await request(app()).post(`/api/quotes/${quoteId}/duplicate`).set("Authorization", `Bearer ${staff()}`);
    expect(d.status).toBe(201);
    expect(d.body.quote.status).toBe("draft");
    const w = await request(app()).post(`/api/quotes/${d.body.quote.id}/withdraw`).set("Authorization", `Bearer ${staff()}`);
    expect(w.body.quote.status).toBe("withdrawn");
  });
});
