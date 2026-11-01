// KS_HUBSPOT_GAPS_1 - the HubSpot-parity gaps against real Postgres: the migrations (twice), plan gating, record
// visibility and the end-to-end flows of each feature with Stripe, Zoom, Google and Twilio stubbed at the edge.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import callScriptsRoutes from "../routes/callScripts.js";
import { clearCustomFieldCache } from "../customFields/service.js";
import meetingNotesRoutes from "../routes/meetingNotes.js";
import { setZoomFetchForTests } from "../meetingNotes/zoom.js";
import { runMeetingNotesSync } from "../meetingNotes/sync.js";
import pipelinesRoutes from "../routes/pipelines.js";
import portalRoutes from "../routes/portal.js";
import callQueuesRoutes from "../routes/callQueues.js";
import callQueueWebhooksRoutes from "../routes/callQueueWebhooks.js";
import { enqueueCaller, getQueue, setQueueTwilioForTests } from "../callQueues/queues.js";

vi.mock("../middleware/twilioWebhookValidation.js", () => ({ twilioWebhookValidation: (_req: any, _res: any, next: any) => next() }));

const intel = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../services/teams/meetingIntel.js", () => ({ runMeetingIntel: async () => { intel.calls++; } }));

const MIGRATIONS = [
  "migrations/2026_11_04_ks_hg1_payments.sql",
  "migrations/2026_11_04_ks_hg1_call_scripts.sql",
  "migrations/2026_11_04_ks_hg1_meeting_notes.sql",
  "migrations/2026_11_04_ks_hg1_pipelines.sql",
  "migrations/2026_11_04_ks_hg1_call_queues.sql",
];
const tag = randomUUID().slice(0, 8);
const ADMIN = randomUUID(), S1 = randomUUID(), S2 = randomUUID();
const tok = (id: string, role: string) => `Bearer ${jwt.sign({ sub: id, id, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET))}`;
const C1 = randomUUID(), C2 = randomUUID();
const A1 = randomUUID(), A2 = randomUUID();
let savedPlan: Record<string, any> | null = null;
const ENV_KEYS = ["STRIPE_SECRET_KEY", "STRIPE_CONNECT_CLIENT_ID", "STRIPE_CONNECT_WEBHOOK_SECRET", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "ZOOM_TOKEN_ENCRYPTION_KEY", "GOOGLE_MEET_NOTES_ENABLED"];
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
  a.use("/api/call-scripts", callScriptsRoutes);
  a.use("/api/meeting-notes", meetingNotesRoutes);
  a.use("/api/pipelines", pipelinesRoutes);
  a.use("/api/portal", portalRoutes);
  a.use("/api/call-queues", callQueuesRoutes);
  a.use("/api/webhooks/twilio/queue", callQueueWebhooksRoutes);
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
    process.env.ZOOM_CLIENT_ID = "zoom_int";
    process.env.ZOOM_CLIENT_SECRET = "zoom_secret";
    process.env.ZOOM_TOKEN_ENCRYPTION_KEY = "zoom-int-key-for-tests";
    delete process.env.GOOGLE_MEET_NOTES_ENABLED;
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
    setZoomFetchForTests(null);
    setQueueTwilioForTests(null);
    await pool.query(`DELETE FROM call_queue_calls WHERE queue_id IN (SELECT id FROM call_queues WHERE name LIKE $1)`, [`%${tag}%`]);
    await pool.query(`DELETE FROM call_queue_members WHERE queue_id IN (SELECT id FROM call_queues WHERE name LIKE $1)`, [`%${tag}%`]);
    await pool.query(`DELETE FROM call_queues WHERE name LIKE $1`, [`%${tag}%`]);
    await pool.query(`DELETE FROM call_queue_agents WHERE user_id = ANY($1::uuid[])`, [[ADMIN, S1, S2]]);
    await pool.query(`DELETE FROM staff_presence WHERE user_id = ANY($1::uuid[])`, [[ADMIN, S1, S2]]);
    await pool.query(`DELETE FROM brokerage_settings WHERE key = 'call_queue_main_line'`);
    await pool.query(`DELETE FROM teams_meetings WHERE organizer_user_id = ANY($1::uuid[])`, [[ADMIN, S1, S2]]);
    await pool.query(`DELETE FROM zoom_accounts WHERE user_id = ANY($1::uuid[])`, [[ADMIN, S1, S2]]);
    setPaymentSendDepsForTests(null);
    for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    await pool.query(`DELETE FROM role_record_visibility`);
    await pool.query(`DELETE FROM payment_links WHERE application_id = ANY($1::text[]) OR contact_id = ANY($2::uuid[])`, [[A1, A2], [C1, C2]]);
    await pool.query(`DELETE FROM stripe_connection`);
    await pool.query(`DELETE FROM call_script_runs WHERE contact_id = ANY($1::uuid[])`, [[C1, C2]]);
    await pool.query(`DELETE FROM call_scripts WHERE name LIKE $1 OR name LIKE 'Intake - %'`, [`%${tag}%`]);
    await pool.query(`DELETE FROM custom_field_definitions WHERE name = $1`, [`hg1_band_${tag}`]);
    await pool.query(`DELETE FROM crm_timeline_events WHERE contact_id = ANY($1::uuid[])`, [[C1, C2]]);
    await pool.query(`DELETE FROM pipeline_moves WHERE application_id = ANY($1::text[])`, [[A1, A2]]);
    await pool.query(`UPDATE applications SET pipeline_id = NULL, pipeline_stage_id = NULL WHERE id = ANY($1::text[])`, [[A1, A2]]);
    await pool.query(`DELETE FROM pipeline_stages WHERE pipeline_id IN (SELECT id FROM pipelines WHERE name LIKE $1)`, [`%${tag}%`]);
    await pool.query(`DELETE FROM pipelines WHERE name LIKE $1`, [`%${tag}%`]);
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
  // ------------------------------------------------------------------ 2. call scripts
  describe("call scripts", () => {
    let scriptId = "";
    const field = `hg1_band_${tag}`;

    it("are refused on Starter; Admins add the starter intake scripts once", async () => {
      await setPlan("starter");
      expect((await http().get("/api/call-scripts").set("Authorization", tok(S1, "Staff"))).status).toBe(402);
      await setPlan("growth");
      await pool.query(`DELETE FROM role_record_visibility`);
      clearVisibilityCache();
      await pool.query(`DELETE FROM call_scripts WHERE name LIKE 'Intake - %'`);
      const r = await http().post("/api/call-scripts/starters").set("Authorization", tok(ADMIN, "Admin"));
      expect(r.body.added).toEqual(["Intake - term loan", "Intake - line of credit", "Intake - equipment"]);
      expect((await http().post("/api/call-scripts/starters").set("Authorization", tok(ADMIN, "Admin"))).body.added).toEqual([]);
      expect((await http().post("/api/call-scripts/starters").set("Authorization", tok(S1, "Staff"))).status).toBe(403);
    });

    it("Admins build a script whose answer maps to a custom field", async () => {
      await pool.query(`INSERT INTO custom_field_definitions (object_type, name, label, field_type, options) VALUES ('contact', $1, 'Band', 'single_select', $2::jsonb)`,
        [field, JSON.stringify([{ value: "a", label: "A" }, { value: "b", label: "B" }])]);
      clearCustomFieldCache();
      const r = await http().post("/api/call-scripts").set("Authorization", tok(ADMIN, "Admin")).send({
        name: `Renewal ${tag}`, use_for: "calls",
        sections: [{ title: "Check-in", body: "Ask how the last deal went.", questions: [
          { id: "band", label: "Band", type: "single_select", options: ["A", "B"], required: true, maps_to: { object: "contact", field } },
          { id: "notes", label: "Notes", type: "long_text" },
        ] }],
      });
      expect(r.status).toBe(201);
      scriptId = r.body.script.id;
      const list = await http().get("/api/call-scripts").set("Authorization", tok(S1, "Staff"));
      expect(list.body.scripts.map((x: any) => x.name)).toContain(`Renewal ${tag}`);
      expect(list.body.custom_fields.contact.map((f: any) => f.name)).toContain(field);
    });

    it("a finished run lands on the timeline and fills the custom field", async () => {
      const missing = await http().post("/api/call-scripts/runs").set("Authorization", tok(S1, "Staff")).send({ script_id: scriptId, contact_id: C1, answers: {}, finish: true });
      expect(missing.status).toBe(400);
      const started = await http().post("/api/call-scripts/runs").set("Authorization", tok(S1, "Staff")).send({ script_id: scriptId, application_id: A1, answers: { notes: "Going well" } });
      expect(started.status).toBe(201);
      expect(started.body.run).toMatchObject({ contact_id: C1, application_id: A1, status: "in_progress" });
      const done = await http().put(`/api/call-scripts/runs/${started.body.run.id}`).set("Authorization", tok(S1, "Staff")).send({ answers: { band: "B", notes: "Going well" }, finish: true });
      expect(done.status).toBe(200);
      expect(done.body.run).toMatchObject({ status: "completed", field_updates: [{ object: "contact", field }], field_errors: [] });
      expect((await pool.query(`SELECT custom_fields->>$2 AS v FROM contacts WHERE id = $1`, [C1, field])).rows[0].v).toBe("b");
      const tl = await loadCrmTimeline(true, C1, "BF");
      const entry = tl.find((t: any) => t.title === `Call script: Renewal ${tag}`);
      expect(entry?.body).toContain("Band: B");
      expect((await http().put(`/api/call-scripts/runs/${started.body.run.id}`).set("Authorization", tok(S1, "Staff")).send({ answers: {} })).status).toBe(409);
      const runs = await http().get(`/api/call-scripts/runs?contact_id=${C1}`).set("Authorization", tok(S1, "Staff"));
      expect(runs.body.runs[0]).toMatchObject({ script_name: `Renewal ${tag}`, user_name: "Sam HG1" });
    });

    it("staff limited to their own records cannot run a script on someone else's contact", async () => {
      await pool.query(`INSERT INTO role_record_visibility (role, visibility) VALUES ('Staff', 'own') ON CONFLICT (role) DO UPDATE SET visibility = 'own'`);
      clearVisibilityCache();
      expect((await http().post("/api/call-scripts/runs").set("Authorization", tok(S2, "Staff")).send({ script_id: scriptId, contact_id: C1, answers: {} })).status).toBe(404);
      expect((await http().get(`/api/call-scripts/runs?contact_id=${C1}`).set("Authorization", tok(S2, "Staff"))).status).toBe(404);
      await pool.query(`DELETE FROM role_record_visibility`);
      clearVisibilityCache();
    });
  });
  // ------------------------------------------------------------------ 3. Zoom and Google Meet notes
  describe("meeting notes", () => {
    it("staff connect their own Zoom; the callback stores the account (tokens encrypted)", async () => {
      const r = await http().post("/api/meeting-notes/zoom/connect").set("Authorization", tok(S1, "Staff"));
      expect(r.status).toBe(200);
      const state = new URL(r.body.url).searchParams.get("state")!;
      setZoomFetchForTests(async (url) => {
        if (url.startsWith("https://zoom.us/oauth/token")) return new Response(JSON.stringify({ access_token: "zat_1", refresh_token: "zrt_1", expires_in: 3600, scope: "cloud_recording:read:list_user_recordings" }), { status: 200 });
        if (url.endsWith("/users/me")) return new Response(JSON.stringify({ id: "zu1", email: "sam@zoom.test" }), { status: 200 });
        return new Response("{}", { status: 404 });
      });
      const back = await http().get(`/api/meeting-notes/zoom/callback?code=zc&state=${encodeURIComponent(state)}`);
      expect(back.headers.location).toContain("/settings/meeting-notes?zoom=connected");
      const row = (await pool.query(`SELECT zoom_email, status, access_token_enc FROM zoom_accounts WHERE user_id = $1`, [S1])).rows[0];
      expect(row).toMatchObject({ zoom_email: "sam@zoom.test", status: "connected" });
      expect(row.access_token_enc).toMatch(/^v1:/);
      expect(row.access_token_enc).not.toContain("zat_1");
      const st = await http().get("/api/meeting-notes/status").set("Authorization", tok(S1, "Staff"));
      expect(st.body.zoom).toMatchObject({ connected: true, email: "sam@zoom.test", problem: null });
      expect(st.body.google_meet).toMatchObject({ enabled: false });
    });

    it("brings transcripts in, matched to the contact by guest email, onto the timeline", async () => {
      setZoomFetchForTests(async (url) => {
        if (url.includes("/users/me/recordings")) return new Response(JSON.stringify({ meetings: [
          { uuid: `zm-${tag}-1`, id: 91, topic: "Acme renewal", start_time: new Date(Date.now() - 3600_000).toISOString(), duration: 30, share_url: "https://zoom.us/rec/share/abc",
            recording_files: [{ file_type: "TRANSCRIPT", status: "completed", download_url: "https://zoom.us/rec/download/vtt1" }] },
          { uuid: `zm-${tag}-2`, id: 92, topic: "Unknown caller", start_time: new Date(Date.now() - 7200_000).toISOString(), duration: 10,
            recording_files: [{ file_type: "TRANSCRIPT", status: "completed", download_url: "https://zoom.us/rec/download/vtt2" }] },
        ] }), { status: 200 });
        if (url.includes("/rec/download/")) return new Response("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nSam: Thanks for joining", { status: 200 });
        if (url.includes(`/past_meetings/zm-${tag}-1/participants`)) return new Response(JSON.stringify({ participants: [{ name: "Pat", user_email: `ONE-${tag}@example.com` }] }), { status: 200 });
        if (url.includes("/participants")) return new Response(JSON.stringify({ participants: [] }), { status: 200 });
        return new Response("{}", { status: 404 });
      });
      const before = intel.calls;
      const r = await http().post("/api/meeting-notes/sync").set("Authorization", tok(S1, "Staff"));
      expect(r.body.imported).toEqual({ zoom: 2, google_meet: 0 });
      expect(intel.calls).toBe(before + 1); // the AI summary runs on the new transcripts
      expect((await runMeetingNotesSync(pool, { userId: S1 })).zoom).toBe(0); // never twice
      const tl = await loadCrmTimeline(true, C1, "BF");
      const m = tl.find((t: any) => t.title === "Zoom meeting: Acme renewal");
      expect(m?.body).toContain("Thanks for joining");
      expect(m?.extra).toBe("https://zoom.us/rec/share/abc");
      const unmatched = await http().get("/api/meeting-notes/meetings?unmatched=1").set("Authorization", tok(S1, "Staff"));
      expect(unmatched.body.meetings.map((x: any) => x.subject)).toEqual(["Unknown caller"]);
      expect(unmatched.body.meetings[0].provider_label).toBe("Zoom");
      const id = unmatched.body.meetings[0].id;
      expect((await http().put(`/api/meeting-notes/meetings/${id}/contact`).set("Authorization", tok(S2, "Staff")).send({ contact_id: C2 })).status).toBe(404); // not Sue's meeting
      expect((await http().put(`/api/meeting-notes/meetings/${id}/contact`).set("Authorization", tok(S1, "Staff")).send({ contact_id: C2 })).status).toBe(200);
      expect((await loadCrmTimeline(true, C2, "BF")).map((t: any) => t.title)).toContain("Zoom meeting: Unknown caller");
    });

    it("disconnecting stops the sync", async () => {
      setZoomFetchForTests(async () => new Response("", { status: 200 }));
      expect((await http().post("/api/meeting-notes/zoom/disconnect").set("Authorization", tok(S1, "Staff"))).body.ok).toBe(true);
      expect((await pool.query(`SELECT status, access_token_enc FROM zoom_accounts WHERE user_id = $1`, [S1])).rows[0]).toEqual({ status: "disconnected", access_token_enc: null });
    });
  });
  // ------------------------------------------------------------------ 4. extra pipelines
  describe("extra pipelines", () => {
    let renewals = "";
    let stages: any[] = [];
    const stageBody = [{ name: "Due soon", color: "#0f766e", probability: 30 }, { name: "Quoted", probability: 60 }, { name: "Renewed", outcome: "won", probability: 100 }, { name: "Lost", outcome: "lost" }];

    it("Starter lists only the lending pipeline and cannot create one", async () => {
      await setPlan("starter");
      await pool.query(`UPDATE pipelines SET archived_at = now() WHERE archived_at IS NULL`); // earlier runs
      const r = await http().get("/api/pipelines").set("Authorization", tok(S1, "Staff"));
      expect(r.body).toMatchObject({ feature: false, can_create: false, limit: 1 });
      expect(r.body.pipelines.map((p: any) => p.id)).toEqual(["lending"]);
      expect((await http().post("/api/pipelines").set("Authorization", tok(ADMIN, "Admin")).send({ name: `Renewals ${tag}`, stages: stageBody })).status).toBe(402);
    });

    it("Growth: Admins add up to two more pipelines (3 in all); the lending stages stay locked", async () => {
      await setPlan("growth");
      const r = await http().post("/api/pipelines").set("Authorization", tok(ADMIN, "Admin")).send({ name: `Renewals ${tag}`, stages: stageBody });
      expect(r.status).toBe(201);
      renewals = r.body.pipeline.id;
      stages = r.body.pipeline.stages;
      expect(stages.map((x: any) => x.name)).toEqual(["Due soon", "Quoted", "Renewed", "Lost"]);
      expect((await http().post("/api/pipelines").set("Authorization", tok(S1, "Staff")).send({ name: `X ${tag}`, stages: stageBody })).status).toBe(403);
      expect((await http().post("/api/pipelines").set("Authorization", tok(ADMIN, "Admin")).send({ name: `Equipment ${tag}`, stages: stageBody })).status).toBe(201);
      const third = await http().post("/api/pipelines").set("Authorization", tok(ADMIN, "Admin")).send({ name: `MCA ${tag}`, stages: stageBody });
      expect(third.status).toBe(402);
      expect(third.body.error).toBe("pipeline_limit");
      expect((await http().put("/api/pipelines/lending").set("Authorization", tok(ADMIN, "Admin")).send({ name: "Mine", stages: stageBody })).status).toBe(409);
      const prob = await http().put("/api/pipelines/lending/probabilities").set("Authorization", tok(ADMIN, "Admin")).send({ Offer: 80 });
      expect(prob.body.pipeline.stages.find((x: any) => x.name === "Offer").probability).toBe(80);
      await setPlan("pro");
      expect((await http().post("/api/pipelines").set("Authorization", tok(ADMIN, "Admin")).send({ name: `MCA ${tag}`, stages: stageBody })).status).toBe(201);
      await setPlan("growth");
    });

    it("a deal moved to Renewals leaves the lending board, shows on the Renewals board and report, and can come back", async () => {
      const board0 = await http().get("/api/portal/applications").set("Authorization", tok(ADMIN, "Admin"));
      expect(board0.body.items.map((c: any) => c.id)).toContain(A1);
      const mv = await http().post("/api/pipelines/move").set("Authorization", tok(S1, "Staff")).send({ application_id: A1, pipeline_id: renewals, stage_id: stages[1].id });
      expect(mv.body).toMatchObject({ ok: true, pipeline_id: renewals, stage: "Quoted" });
      expect((await http().get(`/api/pipelines/application/${A1}`).set("Authorization", tok(S1, "Staff"))).body).toMatchObject({ pipeline_id: renewals, stage_id: stages[1].id, stage: "Quoted" });
      const board1 = await http().get("/api/portal/applications").set("Authorization", tok(ADMIN, "Admin"));
      expect(board1.body.items.map((c: any) => c.id)).not.toContain(A1);
      const rb = await http().get(`/api/pipelines/${renewals}/board`).set("Authorization", tok(S1, "Staff"));
      expect(rb.body.cards).toEqual([expect.objectContaining({ id: A1, stage_id: stages[1].id, lending_stage: "Received" })]);
      const rep = await http().get(`/api/pipelines/report?pipeline_id=${renewals}`).set("Authorization", tok(ADMIN, "Admin"));
      expect(rep.body.stages.find((x: any) => x.name === "Quoted")).toMatchObject({ deals: 1, amount: 100000, weighted: 60000 });
      expect(rep.body.totals).toMatchObject({ open_deals: 1, weighted_amount: 60000 });
      const lend = await http().get(`/api/pipelines/report?pipeline_id=lending`).set("Authorization", tok(ADMIN, "Admin"));
      expect(lend.body.stages.find((x: any) => x.name === "Received").deals).toBeGreaterThanOrEqual(1); // A2 still there
      // A stage with a deal in it cannot be removed.
      const edit = await http().put(`/api/pipelines/${renewals}`).set("Authorization", tok(ADMIN, "Admin")).send({ name: `Renewals ${tag}`, stages: [stages[0], stages[2], stages[3]] });
      expect(edit.status).toBe(409);
      expect((await http().post(`/api/pipelines/${renewals}/archive`).set("Authorization", tok(ADMIN, "Admin"))).status).toBe(409);
      // Sue (own records only) cannot move or see Sam's deal.
      await pool.query(`INSERT INTO role_record_visibility (role, visibility) VALUES ('Staff', 'own') ON CONFLICT (role) DO UPDATE SET visibility = 'own'`);
      clearVisibilityCache();
      expect((await http().post("/api/pipelines/move").set("Authorization", tok(S2, "Staff")).send({ application_id: A1, pipeline_id: "lending" })).status).toBe(404);
      expect((await http().get(`/api/pipelines/${renewals}/board`).set("Authorization", tok(S2, "Staff"))).body.cards).toEqual([]);
      await pool.query(`DELETE FROM role_record_visibility`);
      clearVisibilityCache();
      const back = await http().post("/api/pipelines/move").set("Authorization", tok(S1, "Staff")).send({ application_id: A1, pipeline_id: "lending" });
      expect(back.body).toMatchObject({ pipeline_id: "lending", stage: "Received" });
      const board2 = await http().get("/api/portal/applications").set("Authorization", tok(ADMIN, "Admin"));
      expect(board2.body.items.map((c: any) => c.id)).toContain(A1);
      expect((await pool.query(`SELECT count(*)::int AS n FROM pipeline_moves WHERE application_id = $1`, [A1])).rows[0].n).toBe(2);
    });
  });
  // ------------------------------------------------------------------ 5. call queues
  describe("call queues", () => {
    let queueId = "";
    const calls: any[] = [];
    const updates: any[] = [];
    const flush = () => new Promise((r) => setTimeout(r, 150));
    const twiml = async (path: string, body: Record<string, string>) => (await http().post(`/api/webhooks/twilio/queue/${path}`).type("form").send(body));

    beforeAll(async () => {
      setQueueTwilioForTests({
        createCall: async (args) => { calls.push(args); return { sid: `CA${String(calls.length).padStart(32, "0")}` }; },
        updateCall: async (sid, args) => { updates.push({ sid, ...args }); },
        dequeueMember: async () => {},
      });
      for (const [id, identity] of [[S1, `sam_${tag}`], [S2, `sue_${tag}`]]) {
        await pool.query(`INSERT INTO staff_presence (user_id, status, twilio_identity, last_heartbeat) VALUES ($1, 'available', $2, now())
                          ON CONFLICT (user_id) DO UPDATE SET status = 'available', twilio_identity = $2, last_heartbeat = now(), on_call = false, manual_busy = false`, [id, identity]);
      }
    });

    it("is Pro only; Admins build a queue", async () => {
      await setPlan("growth");
      expect((await http().get("/api/call-queues").set("Authorization", tok(ADMIN, "Admin"))).status).toBe(402);
      await setPlan("pro");
      const bad = await http().post("/api/call-queues").set("Authorization", tok(ADMIN, "Admin")).send({ name: `Sales ${tag}`, member_ids: [] });
      expect(bad.status).toBe(400);
      const r = await http().post("/api/call-queues").set("Authorization", tok(ADMIN, "Admin"))
        .send({ name: `Sales ${tag}`, greeting: "Thanks for calling. Someone will be with you shortly.", hold_message: "Thanks for waiting.", member_ids: [S1, S2], max_wait_seconds: 120, ring_seconds: 15, overflow: "ask" });
      expect(r.status).toBe(201);
      queueId = r.body.queue.id;
      expect((await http().put("/api/call-queues/main-line").set("Authorization", tok(ADMIN, "Admin")).send({ queue_id: queueId })).body.main_line_queue_id).toBe(queueId);
    });

    it("a caller waits, hears their place in line, and is offered to the longest-idle available member; a missed offer goes to the next", async () => {
      // Sam has been available longer than Sue.
      await pool.query(`INSERT INTO call_queue_agents (user_id, available, available_since) VALUES ($1, true, now() - interval '10 minutes'), ($2, true, now() - interval '1 minute')
                        ON CONFLICT (user_id) DO UPDATE SET available = true, available_since = EXCLUDED.available_since, last_call_ended_at = NULL, last_missed_at = NULL`, [S1, S2]);
      const { default: VoiceResponse } = await import("twilio/lib/twiml/VoiceResponse.js");
      const v = new VoiceResponse();
      expect(await enqueueCaller(pool, v, (await getQueue(pool as any, queueId))!, { callSid: `CAcaller1${tag}`, from: "+14035550111", callerName: "Pat", contactId: C1 })).toBe(true);
      expect(v.toString()).toContain(`ks-q-${queueId}</Enqueue>`);
      const id = (await pool.query(`SELECT id::text AS id FROM call_queue_calls WHERE call_sid = $1`, [`CAcaller1${tag}`])).rows[0].id;
      const wait = await twiml(`wait?qc=${id}`, { QueuePosition: "1", QueueTime: "3", QueueSid: "QU1", CallSid: `CAcaller1${tag}` });
      expect(wait.text).toContain("Thanks for calling. Someone will be with you shortly.");
      expect(wait.text).toContain("You are next in line.");
      expect(wait.text).toContain("<Play>");
      await flush();
      expect(calls).toHaveLength(1);
      expect(String(calls[0].to)).toMatch(new RegExp(`^client:sam_${tag}\\?`));
      expect(String(calls[0].to)).toContain("callerNumber=%2B14035550111");
      // Sam does not answer: Sue is offered the caller.
      expect((await twiml(`agent-status?qc=${id}&user=${S1}`, { CallStatus: "no-answer", CallSid: calls[0] && `CA${"1".padStart(32, "0")}` })).status).toBe(204);
      await flush();
      expect(calls).toHaveLength(2);
      expect(String(calls[1].to)).toMatch(new RegExp(`^client:sue_${tag}\\?`));
      const live = await http().get("/api/call-queues/live").set("Authorization", tok(ADMIN, "Admin"));
      const q = live.body.queues.find((x: any) => x.id === queueId);
      expect(q.waiting[0]).toMatchObject({ position: 1, caller_name: "Pat", ringing: "Sue HG1" });
      // Sue answers: she is connected to the caller Twilio dequeues.
      const bridge = await twiml(`bridge?qc=${id}`, { CallSid: `CA${"2".padStart(32, "0")}` });
      expect(bridge.text).toContain(`<Queue url="/api/webhooks/twilio/queue/connecting?qc=${id}" method="POST">ks-q-${queueId}</Queue>`);
      await twiml(`connecting?qc=${id}`, { CallSid: `CAcaller1${tag}`, DequeingCallSid: `CA${"2".padStart(32, "0")}` });
      const connected = (await http().get("/api/call-queues/live").set("Authorization", tok(ADMIN, "Admin"))).body.queues.find((x: any) => x.id === queueId);
      expect(connected.connected[0]).toMatchObject({ caller_name: "Pat", agent: "Sue HG1" });
      expect(connected.waiting).toEqual([]);
      await twiml(`agent-done?qc=${id}&user=${S2}`, { DialCallStatus: "completed" });
      const row = (await pool.query(`SELECT status, answered_user_id::text AS who, wait_seconds FROM call_queue_calls WHERE id = $1`, [id])).rows[0];
      expect(row).toMatchObject({ status: "completed", who: S2 });
      const today = (await http().get("/api/call-queues/live").set("Authorization", tok(ADMIN, "Admin"))).body.queues.find((x: any) => x.id === queueId).today;
      expect(today.answered).toBe(1);
    });

    it("past the longest wait the caller can ask for a callback; staff mark it done", async () => {
      const { default: VoiceResponse } = await import("twilio/lib/twiml/VoiceResponse.js");
      await pool.query(`UPDATE call_queue_agents SET available = false WHERE user_id = ANY($1::uuid[])`, [[S1, S2]]);
      await enqueueCaller(pool, new VoiceResponse(), (await getQueue(pool as any, queueId))!, { callSid: `CAcaller2${tag}`, from: "+14035550199", callerName: null, contactId: null });
      const id = (await pool.query(`SELECT id::text AS id FROM call_queue_calls WHERE call_sid = $1`, [`CAcaller2${tag}`])).rows[0].id;
      const wait = await twiml(`wait?qc=${id}`, { QueuePosition: "1", QueueTime: "130", QueueSid: "QU1" });
      expect(wait.text).toContain("<Leave/>");
      const left = await twiml(`left?qc=${id}`, { QueueResult: "leave", QueueTime: "130" });
      expect(left.text).toContain("press 1");
      const choice = await twiml(`overflow-choice?qc=${id}`, { Digits: "1" });
      expect(choice.text).toContain("will call you back");
      const live = await http().get("/api/call-queues/live").set("Authorization", tok(ADMIN, "Admin"));
      expect(live.body.callbacks.map((c: any) => c.from_number)).toContain("+14035550199");
      expect((await http().post(`/api/call-queues/callbacks/${id}/done`).set("Authorization", tok(S1, "Staff"))).status).toBe(200);
      expect((await http().post(`/api/call-queues/callbacks/${id}/done`).set("Authorization", tok(S1, "Staff"))).status).toBe(404);
    });

    it("staff switch themselves available; a caller who hangs up stops the agent's phone ringing", async () => {
      const me = await http().put("/api/call-queues/me").set("Authorization", tok(S1, "Staff")).send({ available: true });
      expect(me.body.available).toBe(true);
      expect((await http().get("/api/call-queues/me").set("Authorization", tok(S1, "Staff"))).body).toMatchObject({ available: true, queues: [`Sales ${tag}`] });
      const { default: VoiceResponse } = await import("twilio/lib/twiml/VoiceResponse.js");
      await enqueueCaller(pool, new VoiceResponse(), (await getQueue(pool as any, queueId))!, { callSid: `CAcaller3${tag}`, from: "+14035550177", callerName: null, contactId: null });
      const id = (await pool.query(`SELECT id::text AS id FROM call_queue_calls WHERE call_sid = $1`, [`CAcaller3${tag}`])).rows[0].id;
      await twiml(`wait?qc=${id}`, { QueuePosition: "1", QueueTime: "2", QueueSid: "QU1" });
      await flush();
      expect((await pool.query(`SELECT status FROM call_queue_calls WHERE id = $1`, [id])).rows[0].status).toBe("offered");
      await twiml(`left?qc=${id}`, { QueueResult: "hangup" });
      expect((await pool.query(`SELECT status FROM call_queue_calls WHERE id = $1`, [id])).rows[0].status).toBe("abandoned");
      expect(updates.at(-1)).toMatchObject({ status: "canceled" });
      expect((await http().post(`/api/call-queues/${queueId}/archive`).set("Authorization", tok(ADMIN, "Admin"))).status).toBe(200);
      expect((await pool.query(`SELECT value FROM brokerage_settings WHERE key = 'call_queue_main_line'`)).rows[0].value).toEqual({ queue_id: null });
    });
  });
});
