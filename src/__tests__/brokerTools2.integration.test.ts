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
import { markReady } from "../startupState.js";
import { deps } from "../system/deps.js";
import { setInvoiceReader } from "../brokerTools/invoices.js";
import { afterFunded } from "../brokerTools/hooks.js";
import { creditLineReminders } from "../brokerTools/creditLines.js";

const MIGRATIONS = readdirSync("migrations").filter((f) => f.includes("_broker_tools_")).sort().map((f) => `migrations/${f}`);
const tag = randomUUID().slice(0, 8);
const ADMIN = randomUUID(), STAFF = randomUUID();
const contactId = randomUUID(), appId = randomUUID(), docId = randomUUID();
const tok = (id: string, role: string) => `Bearer ${jwt.sign({ sub: id, id, userId: id, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET))}`;
let savedPlan: Record<string, any> | null = null; // KS_ONLY_PLAN

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/deal-desk", dealDeskRoutes);
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
    await pool.query(
      `INSERT INTO applications (id, name, pipeline_state, created_at, updated_at, silo, contact_id, requested_amount, owner_user_id, metadata, status, product_category)
       VALUES ($1, $2, 'Accepted', now(), now(), 'BF', $3, 90000, $4, $5::jsonb, 'ACCEPTED', 'EQUIPMENT_FINANCE')`,
      [appId, `Excavator ${tag}`, contactId, STAFF, JSON.stringify({ business: { province: "AB", legalName: `Dig ${tag} Ltd.` }, kyc: { yearsInBusiness: 6, annualRevenue: 1200000 } })],
    );
    await pool.query(`INSERT INTO documents (id, application_id, filename, created_at, category, status) VALUES ($1, $2, 'Kubota invoice.pdf', now(), 'equipment_invoice', 'uploaded')`, [docId, appId]);
    await pool.query(`INSERT INTO ocr_document_results (id, document_id, provider, model, extracted_text, created_at, updated_at) VALUES ($1, $2, 'test', 'test', $3, now(), now())`,
      [randomUUID(), docId, "PRAIRIE EQUIPMENT LTD. Invoice INV-2041 Kubota KX040 excavator serial KX040-55123 subtotal 86,500.00 GST 4,325.00 total 90,825.00"]);
  }, 120_000);

  afterAll(async () => {
    setInvoiceReader(null);
    const del = (sql: string, p: unknown[]) => pool.query(sql, p).catch((e) => console.warn("cleanup", e.message));
    await del(`DELETE FROM active_contract_assets WHERE contract_id IN (SELECT id FROM active_contracts WHERE application_id = $1)`, [appId]);
    await del(`DELETE FROM active_contracts WHERE application_id = $1`, [appId]);
    await del(`DELETE FROM vendor_invoices WHERE application_id = $1`, [appId]);
    await del(`DELETE FROM deal_structures WHERE application_id = $1`, [appId]);
    await del(`DELETE FROM rate_cards WHERE name LIKE $1`, [`%${tag}%`]);
    await del(`DELETE FROM tasks WHERE title LIKE $1`, [`%${tag}%`]);
    await del(`DELETE FROM credit_line_reminders WHERE credit_line_id IN (SELECT id FROM credit_lines WHERE application_id = $1)`, [appId]);
    await del(`DELETE FROM credit_line_draws WHERE credit_line_id IN (SELECT id FROM credit_lines WHERE application_id = $1)`, [appId]);
    await del(`DELETE FROM credit_lines WHERE application_id = $1`, [appId]);
    await del(`DELETE FROM ocr_document_results WHERE document_id = $1`, [docId]);
    await del(`DELETE FROM documents WHERE application_id = $1`, [appId]);
    await del(`DELETE FROM applications WHERE id = $1`, [appId]);
    await del(`DELETE FROM contacts WHERE id = $1`, [contactId]);
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

      const contractId = randomUUID();
      await pool.query(`INSERT INTO active_contracts (id, silo, application_id, original_amount) VALUES ($1, 'BF', $2, 90825)`, [contractId, appId]);
      const ok = await http().post(`${base}/invoices/${inv.id}/confirm`).set(as("Staff"));
      expect(ok.status).toBe(200);
      expect(ok.body.invoice).toMatchObject({ status: "confirmed", assets_contract_id: contractId });
      const md = (await pool.query(`SELECT metadata FROM applications WHERE id = $1`, [appId])).rows[0].metadata;
      expect(md.equipment_amount).toBe(86500);
      expect(md.equipment_invoices[0]).toMatchObject({ invoice_number: "INV-2041", vendor: "Prairie Equipment Ltd." });
      const assets = (await pool.query(`SELECT serial_number, vendor, cost FROM active_contract_assets WHERE contract_id = $1`, [contractId])).rows;
      expect(assets).toEqual([{ serial_number: "KX040-55123", vendor: "Prairie Equipment Ltd.", cost: "85000.00" }]);

      expect((await http().post(`${base}/invoices/${inv.id}/confirm`).set(as("Staff"))).status).toBe(409);
      expect((await http().get(`/api/deal-desk/applications/${randomUUID()}/invoices`).set(as("Staff"))).status).toBe(404);
    });
  });

  // KS_BROKER_TOOLS_CREDIT_LINES
  describe("4 approved credit lines", () => {
    it("records a line, draws reduce what is available, a funded linked deal draws once, and expiry makes one task", async () => {
      const base = `/api/deal-desk/applications/${appId}`;
      // KS_ONLY_PLAN_START
      await setPlan("starter");
      expect((await http().get(`${base}/credit-lines`).set(as("Staff"))).status).toBe(402);
      await setPlan("pro");
      // KS_ONLY_PLAN_END
      const expiry = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
      const made = await http().post(`${base}/credit-lines`).set(as("Staff"))
        .send({ lender_name: `Northern ${tag}`, limit_amount: "250,000", expiry_date: expiry, conditions: "Annual financials", reminder_days: 30 });
      expect(made.status).toBe(201);
      const line = made.body.line;
      expect(line).toMatchObject({ limit_amount: 250000, used: 0, available: 250000, expiring_soon: true });

      const d1 = await http().post(`/api/deal-desk/credit-lines/${line.id}/draws`).set(as("Staff")).send({ amount: 100000, note: "first unit" });
      expect(d1.body.line).toMatchObject({ used: 100000, available: 150000 });
      expect((await http().post(`/api/deal-desk/credit-lines/${line.id}/draws`).set(as("Staff")).send({ amount: 200000 })).status).toBe(409);

      expect((await http().put(`${base}/credit-line`).set(as("Staff")).send({ credit_line_id: line.id })).body.linked_line_id).toBe(line.id);
      await pool.query(`UPDATE applications SET funded_amount = 60000 WHERE id = $1`, [appId]);
      await afterFunded(appId);
      await afterFunded(appId); // once only
      const list = await http().get(`${base}/credit-lines`).set(as("Staff"));
      expect(list.body.linked_line_id).toBe(line.id);
      const after = list.body.lines.find((l: any) => l.id === line.id);
      expect(after).toMatchObject({ used: 160000, available: 90000 });
      expect(after.draws.filter((d: any) => d.source === "funded")).toHaveLength(1);

      const firstDraw = after.draws.find((d: any) => d.note === "first unit");
      const rev = await http().delete(`/api/deal-desk/credit-lines/${line.id}/draws/${firstDraw.id}`).set(as("Staff"));
      expect(rev.body.line.available).toBe(190000);

      await pool.query(`UPDATE credit_lines SET lender_name = $2 WHERE id = $1`, [line.id, `Northern ${tag}`]);
      expect(await creditLineReminders(pool as any)).toBeGreaterThanOrEqual(1);
      await creditLineReminders(pool as any);
      const tasks = await pool.query(`SELECT title FROM tasks WHERE title LIKE $1`, [`%Northern ${tag}%`]);
      expect(tasks.rows).toHaveLength(1);

      expect((await http().get("/api/deal-desk/credit-lines?expiring_within=30").set(as("Staff"))).body.lines.some((l: any) => l.id === line.id)).toBe(true);
      expect((await http().patch(`/api/deal-desk/credit-lines/${line.id}`).set(as("Staff")).send({ status: "closed" })).body.line.status).toBe("closed");
      expect((await http().post(`/api/deal-desk/credit-lines/${line.id}/draws`).set(as("Staff")).send({ amount: 1 })).status).toBe(409);
    });
  });

  // KS_BROKER_TOOLS_RATE_CARDS
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
});
