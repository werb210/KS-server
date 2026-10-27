// KS_HUBSPOT_GAPS_1 - the HubSpot-parity gaps against real Postgres: the migrations (twice), plan gating, record
// visibility and the end-to-end flows of each feature with Stripe, Zoom, Google and Twilio stubbed at the edge.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { clearPlanCache } from "../plans/state.js";
import { clearVisibilityCache } from "../visibility/scope.js";
import { markReady } from "../startupState.js";
import { deps } from "../system/deps.js";
import { loadCrmTimeline } from "../routes/crm/timeline.js";
import paymentsRoutes, { setPaymentSendDepsForTests } from "../routes/payments.js";
import { setStripeFetchForTests, signStripePayload } from "../payments/stripe.js";

const MIGRATIONS = [
  "migrations/2026_11_04_ks_hg1_payments.sql",
];
const tag = randomUUID().slice(0, 8);
const ADMIN = randomUUID(), S1 = randomUUID(), S2 = randomUUID();
const tok = (id: string, role: string) => `Bearer ${jwt.sign({ sub: id, id, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET))}`;
const C1 = randomUUID(), C2 = randomUUID();
const A1 = randomUUID(), A2 = randomUUID();
let savedPlan: Record<string, any> | null = null;
const ENV_KEYS = ["STRIPE_SECRET_KEY", "STRIPE_CONNECT_CLIENT_ID", "STRIPE_CONNECT_WEBHOOK_SECRET"];
const savedEnv: Record<string, string | undefined> = {};

async function setPlan(plan: "starter" | "growth" | "pro") {
  await pool.query(`DELETE FROM licensee_plan`);
  await pool.query(`INSERT INTO licensee_plan (id, plan) VALUES (1, $1)`, [plan]);
  clearPlanCache();
  clearVisibilityCache();
}

function app() {
  const a = express();
  a.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
  a.use(express.urlencoded({ extended: false }));
  a.use("/api/payments", paymentsRoutes);
  return a;
}
const http = () => request(app());

describe("KS HubSpot gaps 1 (real Postgres)", () => {
  beforeAll(async () => {
    markReady();
    deps.db.client = pool;
    deps.db.ready = true;
    for (const m of MIGRATIONS) {
      await pool.query(readFileSync(m, "utf8"));
      await pool.query(readFileSync(m, "utf8")); // safe to run again
    }
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.STRIPE_SECRET_KEY = "sk_test_int";
    process.env.STRIPE_CONNECT_CLIENT_ID = "ca_int";
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_int";
    savedPlan = (await pool.query(`SELECT * FROM licensee_plan WHERE id = 1`)).rows[0] ?? null;
    await setPlan("growth");
    await pool.query(`DELETE FROM role_record_visibility`);
    for (const [id, role, first] of [[ADMIN, "Admin", "Ada"], [S1, "Staff", "Sam"], [S2, "Staff", "Sue"]]) {
      await pool.query(`INSERT INTO users (id, email, active, role, first_name, last_name) VALUES ($1, $2, true, $3, $4, 'HG1')`, [id, `${first.toLowerCase()}-${tag}@example.com`, role, first]);
    }
    const contact = `INSERT INTO contacts (id, name, first_name, email, phone, owner_id, silo, sms_consent) VALUES ($1, $2, $3, $4, $5, $6, 'BF', $7)`;
    await pool.query(contact, [C1, `Hg${tag} One`, "Pat", `one-${tag}@example.com`, "+14035550111", S1, true]);
    await pool.query(contact, [C2, `Hg${tag} Two`, "Lee", `two-${tag}@example.com`, "+14035550112", S2, false]);
    const appSql = `INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, contact_id, owner_user_id, silo, submitted_at, requested_amount)
                    VALUES ($1, $2, now(), now(), 'Received', 'RECEIVED', $3, $4, 'BF', now(), 100000)`;
    await pool.query(appSql, [A1, `HgApp${tag} One`, C1, S1]);
    await pool.query(appSql, [A2, `HgApp${tag} Two`, C2, S2]);
  });

  afterAll(async () => {
    setStripeFetchForTests(null);
    setPaymentSendDepsForTests(null);
    for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    await pool.query(`DELETE FROM role_record_visibility`);
    await pool.query(`DELETE FROM payment_links WHERE application_id = ANY($1::text[]) OR contact_id = ANY($2::uuid[])`, [[A1, A2], [C1, C2]]);
    await pool.query(`DELETE FROM stripe_connection`);
    await pool.query(`DELETE FROM crm_timeline_events WHERE contact_id = ANY($1::uuid[])`, [[C1, C2]]);
    await pool.query(`DELETE FROM applications WHERE id = ANY($1::text[])`, [[A1, A2]]);
    await pool.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [[C1, C2]]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ADMIN, S1, S2]]);
    await pool.query(`DELETE FROM licensee_plan`);
    if (savedPlan) await pool.query(`INSERT INTO licensee_plan (id, plan) VALUES (1, $1)`, [savedPlan.plan]);
    clearPlanCache();
  });

  // ------------------------------------------------------------------ 1. payment links
  describe("payment links", () => {
    let linkId = "";
    let token = "";
    const sent: Array<{ ch: string; to: string; body: string }> = [];

    it("is refused on Starter and needs a connected Stripe account", async () => {
      await setPlan("starter");
      const r = await http().get("/api/payments/settings").set("Authorization", tok(ADMIN, "Admin"));
      expect(r.status).toBe(402);
      await setPlan("growth");
      await pool.query(`DELETE FROM stripe_connection`);
      const none = await http().post("/api/payments/links").set("Authorization", tok(S1, "Staff")).send({ application_id: A1, amount: 2000, description: "Broker fee" });
      expect(none.status).toBe(409);
      expect(none.body.error).toBe("stripe_not_connected");
    });

    it("Admins start Stripe's connect screen; staff cannot", async () => {
      const r = await http().post("/api/payments/connect").set("Authorization", tok(ADMIN, "Admin"));
      expect(r.status).toBe(200);
      expect(r.body.url).toMatch(/^https:\/\/connect\.stripe\.com\/oauth\/authorize\?/);
      expect((await http().post("/api/payments/connect").set("Authorization", tok(S1, "Staff"))).status).toBe(403);
      // Stripe sends the Admin back with the code; the platform redeems it for the account id.
      const state = new URL(r.body.url).searchParams.get("state")!;
      setStripeFetchForTests(async (url) => {
        if (url.startsWith("https://connect.stripe.com/oauth/token")) return new Response(JSON.stringify({ stripe_user_id: "acct_INT1", livemode: false }), { status: 200 });
        if (url.includes("/accounts/acct_INT1")) return new Response(JSON.stringify({ id: "acct_INT1", country: "CA", default_currency: "cad", charges_enabled: true, business_profile: { name: "Acme Capital" }, capabilities: { acss_debit_payments: "active" } }), { status: 200 });
        return new Response("{}", { status: 404 });
      });
      const back = await http().get(`/api/payments/stripe/callback?code=ac_1&state=${encodeURIComponent(state)}`);
      expect(back.status).toBe(303);
      expect(back.headers.location).toContain("/settings/payments?stripe=connected");
      const again = await http().get(`/api/payments/stripe/callback?code=ac_1&state=${encodeURIComponent(state)}`);
      expect(again.headers.location).toContain("stripe=expired"); // one use only
      const s = await http().get("/api/payments/settings").set("Authorization", tok(ADMIN, "Admin"));
      expect(s.body.connection).toMatchObject({ status: "connected", account_id: "acct_INT1", business_name: "Acme Capital", acss_debit_enabled: true });
    });

    it("staff send a link from an application they may see, by email and (with consent) text", async () => {
      setPaymentSendDepsForTests({
        email: async (to, _s, _h, text) => { sent.push({ ch: "email", to, body: text }); return { ok: true }; },
        sms: async (to, body) => { sent.push({ ch: "sms", to, body }); return { ok: true }; },
      });
      await pool.query(`INSERT INTO role_record_visibility (role, visibility) VALUES ('Staff', 'own') ON CONFLICT (role) DO UPDATE SET visibility = 'own'`);
      clearVisibilityCache();
      const hidden = await http().post("/api/payments/links").set("Authorization", tok(S1, "Staff")).send({ application_id: A2, amount: 500, description: "Broker fee" });
      expect(hidden.status).toBe(404);
      const r = await http().post("/api/payments/links").set("Authorization", tok(S1, "Staff"))
        .send({ application_id: A1, amount: "2,500", description: "Broker fee", methods: ["card", "acss_debit"], send: { email: true, sms: true } });
      expect(r.status).toBe(201);
      expect(r.body.sent).toEqual(["email", "sms"]);
      expect(r.body.link).toMatchObject({ contact_id: C1, amount: 2500, status: "open", sent_channels: ["email", "sms"] });
      linkId = r.body.link.id;
      token = String(r.body.link.url).split("/pay/")[1]!;
      expect(sent.map((s) => s.ch)).toEqual(["email", "sms"]);
      expect(sent[0]!.body).toContain(r.body.link.url);
      const list = await http().get(`/api/payments/links?application_id=${A1}`).set("Authorization", tok(S1, "Staff"));
      expect(list.body.links.map((l: any) => l.id)).toEqual([linkId]);
      expect((await http().get(`/api/payments/links?application_id=${A1}`).set("Authorization", tok(S2, "Staff"))).status).toBe(404);
    });

    it("the client's link opens Stripe Checkout on the brokerage's account", async () => {
      const seen: Array<{ url: string; headers: Record<string, string> }> = [];
      setStripeFetchForTests(async (url, init) => {
        seen.push({ url, headers: init?.headers as Record<string, string> });
        return new Response(JSON.stringify({ id: "cs_int1", url: "https://checkout.stripe.com/c/cs_int1", expires_at: Math.floor(Date.now() / 1000) + 3600 * 20 }), { status: 200 });
      });
      const r = await http().get(`/api/payments/pay/${token}`);
      expect(r.status).toBe(303);
      expect(r.headers.location).toBe("https://checkout.stripe.com/c/cs_int1");
      expect(seen[0]!.headers["Stripe-Account"]).toBe("acct_INT1");
      expect((await http().get(`/api/payments/pay/${token}`)).headers.location).toBe("https://checkout.stripe.com/c/cs_int1"); // reused
      expect(seen).toHaveLength(1);
      expect((await http().get(`/api/payments/pay/not-a-real-token-xxxxxxxxxx`)).status).toBe(404);
    });

    it("a signed Stripe event marks it paid, once, on the timeline and in the report", async () => {
      const event = { id: `evt_${tag}`, type: "checkout.session.completed", account: "acct_INT1",
        data: { object: { id: "cs_int1", client_reference_id: linkId, metadata: { keystone_payment_link: linkId }, amount_total: 250000, payment_status: "paid", payment_intent: "pi_int1" } } };
      const body = JSON.stringify(event);
      const bad = await http().post("/api/payments/stripe/webhook").set("Content-Type", "application/json").set("Stripe-Signature", signStripePayload(body, "whsec_wrong")).send(body);
      expect(bad.status).toBe(400);
      const ok = await http().post("/api/payments/stripe/webhook").set("Content-Type", "application/json").set("Stripe-Signature", signStripePayload(body, "whsec_int")).send(body);
      expect(ok.status).toBe(200);
      expect(ok.body.handled).toBe(true);
      const dup = await http().post("/api/payments/stripe/webhook").set("Content-Type", "application/json").set("Stripe-Signature", signStripePayload(body, "whsec_int")).send(body);
      expect(dup.body.duplicate).toBe(true);
      const row = (await pool.query(`SELECT status, payment_method_type, quickbooks_status FROM payment_links WHERE id = $1`, [linkId])).rows[0];
      expect(row).toMatchObject({ status: "paid", payment_method_type: "card", quickbooks_status: "not_applicable" }); // no QuickBooks invoice here
      const tl = await loadCrmTimeline(true, C1, "BF");
      expect(tl.map((t: any) => t.title)).toEqual(expect.arrayContaining(["Payment received: $2,500.00", "Payment link sent: $2,500.00"]));
      const rep = await http().get("/api/payments/report?days=30").set("Authorization", tok(ADMIN, "Admin"));
      expect(rep.body.paid.count).toBeGreaterThanOrEqual(1);
      const own = await http().get("/api/payments/report?days=30").set("Authorization", tok(S2, "Staff"));
      expect(own.body.paid.count).toBe(0); // Sue cannot see Sam's deal
      const page = await http().get(`/api/payments/pay/${token}`);
      expect(page.status).toBe(200);
      expect(page.text).toContain("Already paid");
    });

    it("texts are refused without consent; a paid link cannot be cancelled", async () => {
      await pool.query(`DELETE FROM role_record_visibility`);
      clearVisibilityCache();
      const r = await http().post("/api/payments/links").set("Authorization", tok(ADMIN, "Admin")).send({ contact_id: C2, amount: 100, description: "Deposit", send: { sms: true } });
      expect(r.status).toBe(201);
      expect(r.body.sent).toEqual([]);
      expect(r.body.refused.sms).toMatch(/not agreed to texts/);
      expect((await http().post(`/api/payments/links/${r.body.link.id}/cancel`).set("Authorization", tok(ADMIN, "Admin"))).status).toBe(200);
      expect((await http().post(`/api/payments/links/${linkId}/cancel`).set("Authorization", tok(ADMIN, "Admin"))).status).toBe(409);
    });
  });
});
