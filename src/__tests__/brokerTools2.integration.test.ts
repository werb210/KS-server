// KS_BROKER_TOOLS_2 - broker tools part 2 against real Postgres: migrations (twice), then each tool's API flow.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { clearPlanCache } from "../plans/state.js"; // KS_ONLY_PLAN
import dealDeskRoutes from "../routes/dealDesk.js";
import vendorPortalRoutes from "../routes/vendorPortal.js";
import clientCreditRoutes from "../routes/clientCredit.js";
import { markReady } from "../startupState.js";
import { deps } from "../system/deps.js";
import { setInvoiceReader } from "../brokerTools/invoices.js";
import { afterFunded } from "../brokerTools/hooks.js";
import { creditLineReminders } from "../brokerTools/creditLines.js";
import { simpleDocx, unzip } from "../brokerTools/docx.js";

const MIGRATIONS = readdirSync("migrations").filter((f) => f.includes("_broker_tools_")).sort().map((f) => `migrations/${f}`);
const tag = randomUUID().slice(0, 8);
const ADMIN = randomUUID(), STAFF = randomUUID();
const contactId = randomUUID(), appId = randomUUID(), docId = randomUUID(), companyId = randomUUID();
const tok = (id: string, role: string) => `Bearer ${jwt.sign({ sub: id, id, userId: id, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET))}`;
let savedPlan: Record<string, any> | null = null; // KS_ONLY_PLAN

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/deal-desk", dealDeskRoutes);
  a.use("/api/vendor-portal", vendorPortalRoutes);
  a.use("/api/client-credit", clientCreditRoutes);
  return a;
}
const http = () => request(app());
const as = (role: "Admin" | "Staff") => ({ Authorization: tok(role === "Admin" ? ADMIN : STAFF, role) });

// KS_ONLY_PLAN_START
async function setPlan(plan: "starter" | "growth" | "pro") {
  await pool.query(`DELETE FROM licensee_plan`);
  await pool.query(`INSERT INTO licensee_plan (id, plan) VALUES (1, $1)`, [plan]);
  clearPlanCache();
}
// KS_ONLY_PLAN_END

describe("broker tools part 2 (real Postgres)", () => {
  beforeAll(async () => {
    markReady();
    deps.db.client = pool;
    deps.db.ready = true;
    for (const m of MIGRATIONS) await pool.query(readFileSync(m, "utf8"));
    for (const m of MIGRATIONS) await pool.query(readFileSync(m, "utf8")); // safe to run again
    savedPlan = (await pool.query(`SELECT * FROM licensee_plan WHERE id = 1`)).rows[0] ?? null; // KS_ONLY_PLAN
    await setPlan("pro"); // KS_ONLY_PLAN
    for (const [id, role, first] of [[ADMIN, "Admin", "Ada"], [STAFF, "Staff", "Sam"]]) {
      await pool.query(`INSERT INTO users (id, email, active, role, first_name, last_name) VALUES ($1, $2, true, $3, $4, 'Broker')`, [id, `${first.toLowerCase()}-${tag}@example.com`, role, first]);
    }
    await pool.query(`INSERT INTO contacts (id, name, email, phone, silo) VALUES ($1, $2, $3, $4, 'BF')`, [contactId, `Client ${tag}`, `client-${tag}@example.com`, "+17805550199"]);
    await pool.query(`INSERT INTO companies (id, name, legal_name, province, city, address_street) VALUES ($1, $2, $3, 'AB', 'Edmonton', '1 Main St')`, [companyId, `Dig ${tag}`, `Dig ${tag} Ltd.`]);
    await pool.query(
      `INSERT INTO applications (id, name, pipeline_state, created_at, updated_at, silo, contact_id, requested_amount, owner_user_id, metadata, status, product_category, company_id)
       VALUES ($1, $2, 'Accepted', now(), now(), 'BF', $3, 90000, $4, $5::jsonb, 'ACCEPTED', 'EQUIPMENT_FINANCE', $6)`,
      [appId, `Excavator ${tag}`, contactId, STAFF, JSON.stringify({ business: { province: "AB", legalName: `Dig ${tag} Ltd.` }, kyc: { yearsInBusiness: 6, annualRevenue: 1200000 } }), companyId],
    );
    await pool.query(`INSERT INTO documents (id, application_id, filename, created_at, category, status) VALUES ($1, $2, 'Kubota invoice.pdf', now(), 'equipment_invoice', 'uploaded')`, [docId, appId]);
    await pool.query(`INSERT INTO ocr_document_results (id, document_id, provider, model, extracted_text, created_at, updated_at) VALUES ($1, $2, 'test', 'test', $3, now(), now())`,
      [randomUUID(), docId, "PRAIRIE EQUIPMENT LTD. Invoice INV-2041 Kubota KX040 excavator serial KX040-55123 subtotal 86,500.00 GST 4,325.00 total 90,825.00"]);
  }, 120_000);

  afterAll(async () => {
    setInvoiceReader(null);
    const del = (sql: string, p: unknown[]) => pool.query(sql, p).catch((e) => console.warn("cleanup", e.message));
    if ((await pool.query(`SELECT to_regclass('public.active_contract_assets') IS NOT NULL AS ok`)).rows[0].ok) {
      await del(`DELETE FROM active_contract_assets WHERE contract_id IN (SELECT id FROM active_contracts WHERE application_id = $1)`, [appId]);
      await del(`DELETE FROM active_contracts WHERE application_id = $1`, [appId]);
    }
    await del(`DELETE FROM vendor_invoices WHERE application_id = $1`, [appId]);
    await del(`DELETE FROM deal_structures WHERE application_id = $1`, [appId]);
    await del(`DELETE FROM contract_documents WHERE application_id = $1`, [appId]);
    await del(`DELETE FROM credit_pulls WHERE application_id = $1`, [appId]);
    await del(`DELETE FROM credit_consents WHERE application_id = $1`, [appId]);
    await del(`DELETE FROM vendor_fees WHERE vendor_id IN (SELECT user_id FROM vendor_profiles WHERE company_name LIKE $1)`, [`%${tag}%`]);
    await del(`DELETE FROM vendor_quotes WHERE vendor_id IN (SELECT user_id FROM vendor_profiles WHERE company_name LIKE $1)`, [`%${tag}%`]);
    await del(`DELETE FROM users WHERE id IN (SELECT user_id FROM vendor_profiles WHERE company_name LIKE $1)`, [`%${tag}%`]);
    await del(`DELETE FROM vendor_profiles WHERE company_name LIKE $1`, [`%${tag}%`]);
    await del(`DELETE FROM contract_templates WHERE name LIKE $1`, [`%${tag}%`]);
    await del(`DELETE FROM application_scorecards WHERE application_id = $1`, [appId]);
    await del(`DELETE FROM banking_analyses WHERE application_id = $1`, [appId]);
    await del(`DELETE FROM credit_scorecard_settings WHERE id = 1 AND updated_by = ANY($1::uuid[])`, [[ADMIN, STAFF]]);
    await del(`DELETE FROM rate_cards WHERE name LIKE $1`, [`%${tag}%`]);
    await del(`DELETE FROM tasks WHERE title LIKE $1`, [`%${tag}%`]);
    await del(`DELETE FROM credit_line_reminders WHERE credit_line_id IN (SELECT id FROM credit_lines WHERE application_id = $1)`, [appId]);
    await del(`DELETE FROM credit_line_draws WHERE credit_line_id IN (SELECT id FROM credit_lines WHERE application_id = $1)`, [appId]);
    await del(`DELETE FROM credit_lines WHERE application_id = $1`, [appId]);
    await del(`DELETE FROM ocr_document_results WHERE document_id = $1`, [docId]);
    await del(`DELETE FROM documents WHERE application_id = $1`, [appId]);
    await del(`DELETE FROM applications WHERE id = $1`, [appId]);
    await del(`DELETE FROM contacts WHERE id = $1`, [contactId]);
    await del(`DELETE FROM companies WHERE id = $1`, [companyId]);
    await del(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ADMIN, STAFF]]);
    // KS_ONLY_PLAN_START
    await pool.query(`DELETE FROM licensee_plan`);
    if (savedPlan) await pool.query(`INSERT INTO licensee_plan SELECT * FROM json_populate_record(NULL::licensee_plan, $1::json)`, [JSON.stringify(savedPlan)]);
    clearPlanCache();
    // KS_ONLY_PLAN_END
  });

  // KS_BROKER_TOOLS_INVOICES
  describe("2 vendor invoice reading", () => {
    it("reads an invoice on the file into a draft, takes corrections, and confirming fills the deal and the contract", async () => {
      setInvoiceReader(async (input) => {
        expect(input.text).toContain("KX040-55123"); // the stored OCR text is used, not the file again
        return { model: "test", raw: {
          vendor: { name: "Prairie Equipment Ltd." }, invoice_number: "INV-2041", invoice_date: "2026-10-03",
          line_items: [{ description: "Kubota KX040 excavator", amount: 85000 }, { description: "Freight", amount: 1500 }],
          subtotal: 86500, taxes: [{ label: "GST 5%", amount: 4325 }], total: 90825,
          equipment: [{ description: "Kubota KX040 excavator", year: 2024, make: "Kubota", model: "KX040", serial_number: "KX040-55l23", cost: 85000 }],
        } };
      });
      const base = `/api/deal-desk/applications/${appId}`;
      const docs = await http().get(`${base}/invoice-documents`).set(as("Staff"));
      expect(docs.status).toBe(200);
      expect(docs.body.documents[0]).toMatchObject({ id: docId, likely_invoice: true });

      const read = await http().post(`${base}/invoices/read`).set(as("Staff")).send({ document_id: docId });
      expect(read.status).toBe(201);
      const inv = read.body.invoice;
      expect(inv).toMatchObject({ status: "draft", document_id: docId });
      expect(inv.data).toMatchObject({ vendor_name: "Prairie Equipment Ltd.", subtotal: 86500, total: 90825 });
      expect(inv.warnings).toEqual([]); // Alberta: GST 5% is right

      const fixed = { ...inv.data, equipment: [{ ...inv.data.equipment[0], serial_number: "KX040-55123" }] };
      const patched = await http().patch(`${base}/invoices/${inv.id}`).set(as("Staff")).send(fixed);
      expect(patched.status).toBe(200);
      expect(patched.body.invoice.data.equipment[0].serial_number).toBe("KX040-55123");

      // Active Contracts may not be installed on this server: the equipment goes onto the contract only when it is.
      const hasContracts = (await pool.query(`SELECT to_regclass('public.active_contract_assets') IS NOT NULL AS ok`)).rows[0].ok === true;
      const contractId = randomUUID();
      if (hasContracts) await pool.query(`INSERT INTO active_contracts (id, silo, application_id, original_amount) VALUES ($1, 'BF', $2, 90825)`, [contractId, appId]);
      const ok = await http().post(`${base}/invoices/${inv.id}/confirm`).set(as("Staff"));
      expect(ok.status).toBe(200);
      expect(ok.body.invoice).toMatchObject({ status: "confirmed", assets_contract_id: hasContracts ? contractId : null });
      const md = (await pool.query(`SELECT metadata FROM applications WHERE id = $1`, [appId])).rows[0].metadata;
      expect(md.equipment_amount).toBe(86500);
      expect(md.equipment_invoices[0]).toMatchObject({ invoice_number: "INV-2041", vendor: "Prairie Equipment Ltd." });
      if (hasContracts) {
        const assets = (await pool.query(`SELECT serial_number, vendor, cost FROM active_contract_assets WHERE contract_id = $1`, [contractId])).rows;
        expect(assets).toEqual([{ serial_number: "KX040-55123", vendor: "Prairie Equipment Ltd.", cost: "85000.00" }]);
      }

      expect((await http().post(`${base}/invoices/${inv.id}/confirm`).set(as("Staff"))).status).toBe(409);
      expect((await http().get(`/api/deal-desk/applications/${randomUUID()}/invoices`).set(as("Staff"))).status).toBe(404);
    });
  });

  // KS_BROKER_TOOLS_CREDIT_LINES
  describe("5 rate cards and structuring", () => {
    it("an Admin loads a card by CSV; staff compare payment options on the deal with Alberta GST, and save one", async () => {
      const made = await http().post("/api/deal-desk/rate-cards").set(as("Admin"))
        .send({ name: `Equipment ${tag}`, lender_name: `Northern ${tag}`, rate_kind: "apr", min_amount: 10000, max_amount: 1000000, fees: [{ label: "Documentation fee", amount: 350, taxable: true }] });
      expect(made.status).toBe(201);
      const cid = made.body.card.id;
      expect((await http().post("/api/deal-desk/rate-cards").set(as("Staff")).send({ name: "x", lender_name: "y" })).status).toBe(403);
      const bad = await http().post(`/api/deal-desk/rate-cards/${cid}/import`).set(as("Admin")).send({ csv: "term,rate\n36,abc" });
      expect(bad.status).toBe(400);
      const imp = await http().post(`/api/deal-desk/rate-cards/${cid}/import`).set(as("Admin")).send({ csv: "term,min,max,tier,rate\n36,0,,,8.9\n48,0,,,9.4\n60,0,,,9.9\n36,0,,A,7.5" });
      expect(imp.body.imported).toBe(4);
      const csv = await http().get(`/api/deal-desk/rate-cards/${cid}/export`).set(as("Staff"));
      expect(csv.text.split("\n")[0]).toBe("term,min,max,tier,rate");

      const base = `/api/deal-desk/applications/${appId}/structure`;
      const defaults = await http().get(base).set(as("Staff"));
      expect(defaults.body.defaults).toMatchObject({ amount: 86500, province: "AB" }); // the confirmed invoice's subtotal
      const run = await http().post(base).set(as("Staff")).send({ terms: [36, 60], tax_mode: "lease" });
      expect(run.status).toBe(200);
      const mine = run.body.options.filter((o: any) => o.card_id === cid);
      expect(mine.map((o: any) => [o.term_months, o.rate])).toEqual([[36, 8.9], [60, 9.9]]);
      expect(mine[0].payment_tax[0].label).toBe("GST 5%");
      const save = await http().post(base).set(as("Staff")).send({ terms: [36, 60], save: true, chosen: run.body.options.indexOf(run.body.options.find((o: any) => o.card_id === cid)) });
      expect(save.body.saved_id).toBeTruthy();
      expect((await http().get(base).set(as("Staff"))).body.saved.chosen).toMatchObject({ card_id: cid, term_months: 36 });
      expect((await http().delete(`/api/deal-desk/rate-cards/${cid}`).set(as("Admin"))).status).toBe(200);
    });
  });

  // KS_BROKER_TOOLS_SCORECARDS
  describe("9 vendor and dealer portal", () => {
    it("an Admin adds a vendor; the vendor quotes from the rate cards, sees the deal from its link, and is owed a fee when it funds", async () => {
      const phoneDigits = String(Math.floor(1000000 + Math.random() * 8999999));
      // KS_ONLY_PLAN_START
      await setPlan("growth");
      expect((await http().get("/api/deal-desk/vendors").set(as("Staff"))).status).toBe(402);
      await setPlan("pro");
      // KS_ONLY_PLAN_END
      const add = await http().post("/api/deal-desk/vendors").set(as("Admin"))
        .send({ company_name: `Prairie ${tag}`, contact_name: "Pat Vendor", email: `pat-${tag}@example.com`, phone: `780${phoneDigits}`, province: "AB", fee_pct: 1.5, fee_flat: 250 });
      expect(add.status).toBe(201);
      const v = add.body.vendor;
      expect(v.status).toBe("invited");
      const vtok = `Bearer ${jwt.sign({ sub: `referrer:${v.user_id}`, role: "Referrer", referrerId: v.user_id, tokenVersion: 0 }, String(process.env.JWT_SECRET))}`;
      expect((await http().get("/api/vendor-portal/me").set("Authorization", vtok)).status).toBe(403); // not signed yet
      expect((await http().patch(`/api/deal-desk/vendors/${v.user_id}`).set(as("Admin")).send({ status: "active" })).body.vendor.status).toBe("active");
      const me = await http().get("/api/vendor-portal/me").set("Authorization", vtok);
      expect(me.status).toBe(200);
      expect(me.body.apply_link).toContain(`ref=${v.code}`);
      const staffTok = tok(STAFF, "Staff");
      expect((await http().get("/api/vendor-portal/me").set("Authorization", staffTok)).status).toBe(403);

      const card = await http().post("/api/deal-desk/rate-cards").set(as("Admin")).send({ name: `Vendor card ${tag}`, lender_name: `Northern ${tag}`, rate_kind: "apr" });
      await http().post(`/api/deal-desk/rate-cards/${card.body.card.id}/import`).set(as("Admin")).send({ csv: "term,rate\n36,8.9\n48,9.4" });
      const quote = await http().post("/api/vendor-portal/quote").set("Authorization", vtok)
        .send({ customer_name: "Dig Co", amount: 50000, terms: [36, 48], equipment_description: "Mini excavator" });
      expect(quote.status).toBe(201);
      const mine = quote.body.quote.options.filter((o: any) => o.card_id === card.body.card.id);
      expect(mine.map((o: any) => o.term_months)).toEqual([36, 48]);
      expect(mine[0].payment_tax[0].label).toBe("GST 5%"); // the vendor's province
      expect(quote.body.apply_link).toContain(`vq=${quote.body.quote.id}`);
      expect((await http().get("/api/vendor-portal/quotes").set("Authorization", vtok)).body.quotes).toHaveLength(1);

      await pool.query(`UPDATE applications SET metadata = metadata || $2::jsonb WHERE id = $1`, [appId, JSON.stringify({ attribution: { ref: v.code, vq: quote.body.quote.id } })]);
      const deals = await http().get("/api/vendor-portal/deals").set("Authorization", vtok);
      expect(deals.body.deals).toHaveLength(1);
      expect(deals.body.deals[0]).toMatchObject({ application_id: appId, quote_id: quote.body.quote.id, stage: "Accepted" });
      expect(Object.keys(deals.body.deals[0])).not.toContain("lender_name");
      expect((await http().post(`/api/vendor-portal/deals/${randomUUID()}/invoice`).set("Authorization", vtok).attach("file", Buffer.from("%PDF-1.4"), "inv.pdf")).status).toBe(404);

      await pool.query(`UPDATE applications SET funded_amount = 60000 WHERE id = $1`, [appId]);
      await afterFunded(appId);
      const fees = await http().get("/api/vendor-portal/fees").set("Authorization", vtok);
      expect(fees.body.fees).toHaveLength(1);
      expect(fees.body.fees[0]).toMatchObject({ fee_amount: "1150.00", status: "expected" });
      expect((await http().patch(`/api/deal-desk/vendor-fees/${fees.body.fees[0].id}`).set(as("Admin")).send({ status: "paid", paid_on: "2026-11-20" })).status).toBe(200);
      const list = await http().get("/api/deal-desk/vendors").set(as("Staff"));
      expect(list.body.vendors.find((x: any) => x.user_id === v.user_id)).toMatchObject({ quotes: 1, deals: 1, fees_paid: "1150.00" });
      await http().delete(`/api/deal-desk/rate-cards/${card.body.card.id}`).set(as("Admin"));
      await pool.query(`UPDATE applications SET metadata = metadata - 'attribution' WHERE id = $1`, [appId]);
    });

    it("a vendor signs up from the portal; without e-signing set up it waits for an Admin", async () => {
      const prev = process.env.SIGNNOW_API_KEY;
      delete process.env.SIGNNOW_API_KEY;
      try {
        const r = await http().post("/api/vendor-portal/signup").send({ company_name: `Self ${tag}`, email: `self-${tag}@example.com`, phone: `587${String(Math.floor(1000000 + Math.random() * 8999999))}` });
        expect(r.status).toBe(201);
        expect(r.body).toMatchObject({ agreementConfigured: false, signingUrl: null });
        expect((await http().post("/api/vendor-portal/signup/complete").send({ vendorId: r.body.vendorId })).body.active).toBe(false);
      } finally {
        if (prev !== undefined) process.env.SIGNNOW_API_KEY = prev;
      }
    });
  });

  // KS_BROKER_TOOLS_CREDIT_BUREAU
  describe("6 credit bureau pulls", () => {
    // Credit bureau is off unless the server switches it on (no plan key until the real connectors exist).
    beforeAll(() => { process.env.CREDIT_BUREAU_MOCK = "on"; });
    afterAll(() => { delete process.env.CREDIT_BUREAU_MOCK; });
    it("staff ask for consent, the client gives it in the client app, staff pull; the score feeds the scorecard", async () => {
      const base = `/api/deal-desk/applications/${appId}/credit-bureau`;
      const clientTok = `Bearer ${jwt.sign({ phone: "+17805550199", role: "client" }, String(process.env.JWT_SECRET))}`;
      const strangerTok = `Bearer ${jwt.sign({ phone: "+17805550111", role: "client" }, String(process.env.JWT_SECRET))}`;
      const ask = await http().post(`${base}/consents`).set(as("Staff")).send({ first_name: "Ann", last_name: "Client", city: "Edmonton", province: "AB" });
      expect(ask.status).toBe(201);
      const cid = ask.body.consent.id;
      const early = await http().post(`${base}/pulls`).set(as("Staff")).send({ consent_id: cid, bureau: "equifax_ca" });
      expect(early.status).toBe(409);
      expect(early.body.error).toBe("no_consent");

      expect((await http().get(`/api/client-credit/consents?applicationId=${appId}`).set("Authorization", strangerTok)).status).toBe(403);
      const mine = await http().get(`/api/client-credit/consents?applicationId=${appId}`).set("Authorization", clientTok);
      expect(mine.body.consents[0]).toMatchObject({ id: cid, person: "Ann Client", status: "requested", needs_date_of_birth: true });
      expect((await http().post(`/api/client-credit/consents/${cid}`).set("Authorization", clientTok).send({ applicationId: appId, full_name: "Ann Client", agree: true })).status).toBe(400);
      const gave = await http().post(`/api/client-credit/consents/${cid}`).set("Authorization", clientTok).send({ applicationId: appId, full_name: "Ann Client", date_of_birth: "1980-04-02", agree: true });
      expect(gave.body.consent.status).toBe("given");

      const pull = await http().post(`${base}/pulls`).set(as("Staff")).send({ consent_id: cid, bureau: "transunion_ca" });
      expect(pull.status).toBe(201);
      expect(pull.body.pull).toMatchObject({ provider: "mock", status: "completed" });
      const score = pull.body.pull.score;
      const md = (await pool.query(`SELECT metadata FROM applications WHERE id = $1`, [appId])).rows[0].metadata;
      expect(md.credit_bureau).toMatchObject({ lowest_score: score, pulls: [{ person: "Ann Client", bureau: "TransUnion Canada", score }] });
      const usage = await pool.query(`SELECT count(*)::int AS n FROM usage_events WHERE kind = 'credit_pull' AND ref LIKE $1`, [`%${pull.body.pull.id}`]); // KS_ONLY_USAGE
      expect(usage.rows[0].n).toBe(0); // test pulls are not billed  KS_ONLY_USAGE
      const report = await http().get(`${base}/pulls/${pull.body.pull.id}/report`).set(as("Staff"));
      expect(report.headers["content-type"]).toBe("application/pdf");
      const scored = await http().post(`/api/deal-desk/applications/${appId}/scorecard`).set(as("Staff"));
      expect(scored.body.result.inputs.credit_score).toBe(score);
      const view = await http().get(base).set(as("Staff"));
      expect(view.body.pulls).toHaveLength(1);
      expect(view.body.providers.every((p: any) => p.test_mode)).toBe(true);
    });
  });
});
