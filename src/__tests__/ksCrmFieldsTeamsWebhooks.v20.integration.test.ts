// KS_SERVER_v20 - custom fields, teams and record visibility, and outgoing webhooks against real Postgres:
// the migration (twice), the Admin APIs with plan gating, visibility in list, search, detail, bulk, reports and the
// scoped views, and the outbox triggers feeding signed deliveries.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { clearPlanCache, type Q } from "../plans/state.js";
import crmRoutes from "../routes/crm.js";
import companiesRoutes from "../routes/companies.js";
import portalRoutes from "../routes/portal.js";
import applicationsRoutes from "../modules/applications/applications.routes.js";
import reportsRoutes from "../routes/reports.js";
import customFieldsRoutes from "../routes/customFields.js";
import salesTeamsRoutes from "../routes/salesTeams.js";
import webhookEndpointsRoutes, { setWebhookResolverForTests } from "../routes/webhookEndpoints.js";
import { requireFeature } from "../plans/requireFeature.js";
import { clearVisibilityCache, resolveScope } from "../visibility/scope.js";
import { runScoped } from "../visibility/scopedDb.js";
import { clearCustomFieldCache } from "../customFields/service.js";
import { claimDue, deliverOne, type Transport } from "../outboundWebhooks/deliver.js";
import { verifySignature } from "../outboundWebhooks/signing.js";
import { markReady } from "../startupState.js";
import { deps } from "../system/deps.js";

const MIGRATION = "migrations/2026_11_03_ks_v20_crm_fields_teams_webhooks.sql";
const db = pool as unknown as Q;
const tag = randomUUID().slice(0, 8);
const ADMIN = randomUUID(), S1 = randomUUID(), S2 = randomUUID(), S3 = randomUUID();
const tok = (id: string, role: string) => `Bearer ${jwt.sign({ sub: id, id, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET))}`;
const c1 = randomUUID(), c2 = randomUUID(), c3 = randomUUID(), c4 = randomUUID();
const co1 = randomUUID(), co3 = randomUUID();
const a1 = randomUUID(), a3 = randomUUID();
let savedPlan: Record<string, any> | null = null;

async function setPlan(plan: "starter" | "growth" | "pro") {
  await pool.query(`DELETE FROM licensee_plan`);
  await pool.query(`INSERT INTO licensee_plan (id, plan) VALUES (1, $1)`, [plan]);
  clearPlanCache();
  clearVisibilityCache();
}

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/crm", crmRoutes);
  a.use("/api/companies", companiesRoutes);
  a.use("/api/portal", portalRoutes);
  a.use("/api/applications", applicationsRoutes);
  a.use("/api/reports", reportsRoutes);
  a.use("/api/custom-fields", requireFeature("custom_fields"), customFieldsRoutes);
  a.use("/api/teams", salesTeamsRoutes);
  a.use("/api/webhook-endpoints", requireFeature("webhooks"), webhookEndpointsRoutes);
  return a;
}
const http = () => request(app());
const ids = (rows: any[]) => rows.map((r) => String(r.id)).sort();

describe("KS v20 custom fields, teams and webhooks (real Postgres)", () => {
  beforeAll(async () => {
    markReady();
    deps.db.client = pool;
    deps.db.ready = true;
    await pool.query(readFileSync(MIGRATION, "utf8"));
    await pool.query(readFileSync(MIGRATION, "utf8")); // safe to run again
    savedPlan = (await pool.query(`SELECT * FROM licensee_plan WHERE id = 1`)).rows[0] ?? null;
    await setPlan("growth");
    // Nothing from earlier runs listens, so the triggers stay quiet until this test registers an endpoint.
    await pool.query(`DELETE FROM webhook_endpoints`);
    await pool.query(`DELETE FROM role_record_visibility`);
    await pool.query(`DELETE FROM custom_field_definitions WHERE object_type = 'contact' AND name LIKE 'v20_%'`);
    for (const [id, role, first] of [[ADMIN, "Admin", "Ada"], [S1, "Staff", "Sam"], [S2, "Staff", "Sue"], [S3, "Staff", "Sid"]]) {
      await pool.query(`INSERT INTO users (id, email, active, role, first_name, last_name) VALUES ($1, $2, true, $3, $4, 'V20')`, [id, `${first.toLowerCase()}-${tag}@example.com`, role, first]);
    }
    const contact = `INSERT INTO contacts (id, name, email, owner_id, silo) VALUES ($1, $2, $3, $4, 'BF')`;
    await pool.query(contact, [c1, `Vis${tag} One`, `one-${tag}@example.com`, S1]);
    await pool.query(contact, [c2, `Vis${tag} Two`, `two-${tag}@example.com`, S2]);
    await pool.query(contact, [c3, `Vis${tag} Three`, `three-${tag}@example.com`, S3]);
    await pool.query(contact, [c4, `Vis${tag} Nobody`, `four-${tag}@example.com`, null]);
    await pool.query(`INSERT INTO companies (id, name, owner_id, silo) VALUES ($1, $2, $3, 'BF'), ($4, $5, $6, 'BF')`, [co1, `VisCo${tag} One`, S1, co3, `VisCo${tag} Three`, S3]);
    const appSql = `INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, contact_id, owner_user_id, silo, submitted_at)
                    VALUES ($1, $2, now(), now(), 'Received', 'RECEIVED', $3, $4, 'BF', now())`;
    await pool.query(appSql, [a1, `VisApp${tag} One`, c1, S1]);
    await pool.query(appSql, [a3, `VisApp${tag} Three`, c3, S3]);
  });

  afterAll(async () => {
    setWebhookResolverForTests(null);
    await pool.query(`DELETE FROM webhook_endpoints`);
    await pool.query(`DELETE FROM role_record_visibility`);
    await pool.query(`DELETE FROM sales_teams WHERE name LIKE $1`, [`%${tag}%`]);
    await pool.query(`DELETE FROM custom_field_definitions WHERE object_type = 'contact' AND name LIKE 'v20_%'`);
    await pool.query(`DELETE FROM applications WHERE id = ANY($1::text[])`, [[a1, a3]]);
    await pool.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [[c1, c2, c3, c4]]);
    await pool.query(`DELETE FROM companies WHERE id = ANY($1::uuid[])`, [[co1, co3]]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ADMIN, S1, S2, S3]]);
    await pool.query(`DELETE FROM licensee_plan`);
    if (savedPlan) await pool.query(`INSERT INTO licensee_plan (id, plan) VALUES (1, $1)`, [savedPlan.plan]);
    clearPlanCache();
  });

  describe("custom fields", () => {
    let tierId = "";
    it("admins create fields; staff cannot", async () => {
      const r = await http().post("/api/custom-fields/contact").set("Authorization", tok(ADMIN, "Admin"))
        .send({ label: "V20 Tier", name: "v20_tier", field_type: "single_select", options: ["Gold", "Silver"], group_name: "Broker" });
      expect(r.status).toBe(201);
      expect(r.body.field).toMatchObject({ name: "v20_tier", options: [{ value: "gold", label: "Gold" }, { value: "silver", label: "Silver" }] });
      tierId = r.body.field.id;
      expect((await http().post("/api/custom-fields/contact").set("Authorization", tok(ADMIN, "Admin")).send({ label: "V20 Licence", name: "v20_licence", field_type: "text", required: true })).status).toBe(201);
      expect((await http().post("/api/custom-fields/contact").set("Authorization", tok(S1, "Staff")).send({ label: "Nope", field_type: "text" })).status).toBe(403);
      expect((await http().post("/api/custom-fields/contact").set("Authorization", tok(ADMIN, "Admin")).send({ label: "V20 Tier", name: "v20_tier", field_type: "text" })).status).toBe(409);
    });

    it("values are validated, saved, listed, filtered and exported with the record", async () => {
      clearCustomFieldCache();
      const bad = await http().put(`/api/custom-fields/contact/records/${c1}`).set("Authorization", tok(ADMIN, "Admin")).send({ values: { v20_tier: "Platinum" } });
      expect(bad.status).toBe(400);
      expect(bad.body.errors.map((e: any) => e.field).sort()).toEqual(["v20_licence", "v20_tier"]); // required licence missing too
      const ok = await http().put(`/api/custom-fields/contact/records/${c1}`).set("Authorization", tok(ADMIN, "Admin")).send({ values: { v20_tier: "Gold", v20_licence: "AB-1" } });
      expect(ok.status).toBe(200);
      expect(ok.body.values).toMatchObject({ v20_tier: "gold", v20_licence: "AB-1" });
      const patched = await http().patch(`/api/crm/contacts/${c2}`).set("Authorization", tok(ADMIN, "Admin")).send({ custom_fields: { v20_tier: "silver" } });
      expect(patched.status).toBe(200);
      const list = await http().get(`/api/crm/contacts?q=Vis${tag}&cf_v20_tier=gold`).set("Authorization", tok(ADMIN, "Admin"));
      expect(ids(list.body.data)).toEqual([c1]);
      expect(list.body.data[0].custom_fields).toMatchObject({ v20_tier: "gold" });
      const rec = await http().get(`/api/custom-fields/contact/records/${c1}`).set("Authorization", tok(ADMIN, "Admin"));
      expect(rec.body.values).toMatchObject({ v20_licence: "AB-1" });
    });

    it("archiving hides a field but keeps its values; it is never deleted", async () => {
      expect((await http().post(`/api/custom-fields/contact/${tierId}/archive`).set("Authorization", tok(ADMIN, "Admin"))).status).toBe(200);
      const active = await http().get(`/api/custom-fields/contact`).set("Authorization", tok(S1, "Staff"));
      expect(active.body.fields.map((f: any) => f.name)).not.toContain("v20_tier");
      expect((await pool.query(`SELECT custom_fields->>'v20_tier' AS t FROM contacts WHERE id = $1`, [c1])).rows[0].t).toBe("gold");
      const rec = await http().get(`/api/custom-fields/contact/records/${c1}`).set("Authorization", tok(ADMIN, "Admin"));
      expect(rec.body.fields.find((f: any) => f.name === "v20_tier")?.archived_at).toBeTruthy();
      expect((await http().post(`/api/custom-fields/contact/${tierId}/unarchive`).set("Authorization", tok(ADMIN, "Admin"))).status).toBe(200);
    });
  });

  describe("teams and record visibility", () => {
    let teamId = "";
    it("default All: staff see every record (nothing changes for existing brokerages)", async () => {
      const r = await http().get(`/api/crm/contacts?q=Vis${tag}`).set("Authorization", tok(S1, "Staff"));
      expect(ids(r.body.data)).toEqual([c1, c2, c3, c4].sort());
    });

    it("Own records only: list, search, detail, sub-resources, companies, pipeline, applications and bulk actions", async () => {
      expect((await http().put("/api/teams/visibility/roles").set("Authorization", tok(ADMIN, "Admin")).send({ Staff: "own" })).status).toBe(200);
      const list = await http().get(`/api/crm/contacts?q=Vis${tag}`).set("Authorization", tok(S1, "Staff"));
      expect(ids(list.body.data)).toEqual([c1]);
      expect(list.body.meta?.total ?? list.body.total ?? 1).toBe(1);
      expect((await http().get(`/api/crm/contacts/${c1}`).set("Authorization", tok(S1, "Staff"))).status).toBe(200);
      expect((await http().get(`/api/crm/contacts/${c3}`).set("Authorization", tok(S1, "Staff"))).status).toBe(404);
      expect((await http().get(`/api/crm/contacts/${c3}/applications`).set("Authorization", tok(S1, "Staff"))).status).toBe(404);
      const cos = await http().get(`/api/crm/companies?q=VisCo${tag}`).set("Authorization", tok(S1, "Staff"));
      expect(ids(cos.body.data)).toEqual([co1]);
      expect((await http().get(`/api/companies/${co3}`).set("Authorization", tok(S1, "Staff"))).status).toBe(404);
      const pipe = await http().get(`/api/portal/applications`).set("Authorization", tok(S1, "Staff"));
      expect(pipe.body.applications.map((x: any) => x.id).filter((id: string) => [a1, a3].includes(id))).toEqual([a1]);
      expect((await http().get(`/api/portal/applications/${a3}`).set("Authorization", tok(S1, "Staff"))).status).toBe(404);
      expect((await http().get(`/api/applications/${a3}`).set("Authorization", tok(S1, "Staff"))).status).toBe(404);
      const tagged = await http().post(`/api/crm/contacts/bulk-tag`).set("Authorization", tok(S1, "Staff")).send({ ids: [c1, c3], tags: [`t${tag}`], op: "add" });
      expect(tagged.body.updated).toBe(1);
      expect((await pool.query(`SELECT tags FROM contacts WHERE id = $1`, [c3])).rows[0].tags).not.toContain(`t${tag}`);
      // Admins always see everything.
      const adm = await http().get(`/api/crm/contacts?q=Vis${tag}`).set("Authorization", tok(ADMIN, "Admin"));
      expect(ids(adm.body.data)).toEqual([c1, c2, c3, c4].sort());
    });

    it("reports and exports read only the user's records (scoped views), and the views never leak", async () => {
      const stuck = await http().get(`/api/reports/data/stuck_deals`).set("Authorization", tok(S1, "Staff"));
      expect(stuck.status).toBe(200);
      const mine = stuck.body.items.map((i: any) => i.application_id);
      expect(mine).toContain(a1);
      expect(mine).not.toContain(a3);
      const scope = await resolveScope(db, S1, "Staff");
      const n = await runScoped(scope, async () => (await pool.query(`SELECT count(*)::int AS n FROM applications WHERE id = ANY($1::text[])`, [[a1, a3]])).rows[0].n);
      expect(n).toBe(1);
      const after = await pool.query(`SELECT count(*)::int AS n FROM applications WHERE id = ANY($1::text[])`, [[a1, a3]]);
      expect(after.rows[0].n).toBe(2);
      // The request's connection drops its views as the response ends (asynchronously): none remain shortly after.
      let left = -1;
      for (let i = 0; i < 40 && left !== 0; i++) {
        left = (await pool.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname LIKE 'pg_temp%' AND c.relname IN ('applications', 'contacts', 'companies')`)).rows[0].n;
        if (left) await new Promise((r) => setTimeout(r, 50));
      }
      expect(left).toBe(0);
    });

    it("Team's records: the user's teammates' records too; a per-user setting beats the role", async () => {
      const t = await http().post("/api/teams").set("Authorization", tok(ADMIN, "Admin")).send({ name: `North ${tag}` });
      expect(t.status).toBe(201);
      teamId = t.body.team.id;
      expect((await http().put(`/api/teams/${teamId}/members`).set("Authorization", tok(ADMIN, "Admin")).send({ user_ids: [S1, S2] })).status).toBe(200);
      expect((await pool.query(`SELECT primary_team_id::text AS p FROM users WHERE id = $1`, [S1])).rows[0].p).toBe(teamId);
      expect((await http().put(`/api/teams/users/${S1}`).set("Authorization", tok(ADMIN, "Admin")).send({ record_visibility: "team" })).status).toBe(200);
      const list = await http().get(`/api/crm/contacts?q=Vis${tag}`).set("Authorization", tok(S1, "Staff"));
      expect(ids(list.body.data)).toEqual([c1, c2].sort());
      expect((await http().get(`/api/crm/contacts/${c2}`).set("Authorization", tok(S1, "Staff"))).status).toBe(200);
      expect((await http().get(`/api/crm/contacts/${c3}`).set("Authorization", tok(S1, "Staff"))).status).toBe(404);
      const me = await http().get(`/api/teams/me`).set("Authorization", tok(S1, "Staff"));
      expect(me.body).toMatchObject({ visibility: "team", teams: [{ id: teamId, is_primary: true }] });
      // S2 still follows the role (own).
      const s2 = await http().get(`/api/crm/contacts?q=Vis${tag}`).set("Authorization", tok(S2, "Staff"));
      expect(ids(s2.body.data)).toEqual([c2]);
    });

    it("the Team filter narrows the pipeline", async () => {
      const r = await http().get(`/api/portal/applications?team_id=${teamId}`).set("Authorization", tok(ADMIN, "Admin"));
      const got = r.body.applications.map((x: any) => x.id).filter((id: string) => [a1, a3].includes(id));
      expect(got).toEqual([a1]);
    });

    it("plan gating: teams are growth and up; on starter everyone sees everything again", async () => {
      await setPlan("starter");
      expect((await http().get("/api/teams").set("Authorization", tok(ADMIN, "Admin"))).status).toBe(402);
      const list = await http().get(`/api/crm/contacts?q=Vis${tag}`).set("Authorization", tok(S1, "Staff"));
      expect(ids(list.body.data)).toEqual([c1, c2, c3, c4].sort());
      await setPlan("growth");
      await pool.query(`DELETE FROM role_record_visibility`);
      await pool.query(`UPDATE users SET record_visibility = NULL WHERE id = ANY($1::uuid[])`, [[S1, S2, S3]]);
      clearVisibilityCache();
    });
  });

  describe("outgoing webhooks", () => {
    let endpointId = "";
    let secret = "";
    it("are pro only, https only, and refuse private targets", async () => {
      setWebhookResolverForTests(async (h) => (h === "hooks.example.com" ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "10.0.0.9", family: 4 }]));
      expect((await http().get("/api/webhook-endpoints").set("Authorization", tok(ADMIN, "Admin"))).status).toBe(402);
      await setPlan("pro");
      expect((await http().get("/api/webhook-endpoints").set("Authorization", tok(S1, "Staff"))).status).toBe(403);
      const http1 = await http().post("/api/webhook-endpoints").set("Authorization", tok(ADMIN, "Admin")).send({ url: "http://hooks.example.com/x", events: ["contact.created"] });
      expect(http1.status).toBe(400);
      const priv = await http().post("/api/webhook-endpoints").set("Authorization", tok(ADMIN, "Admin")).send({ url: "https://intranet-hooks.example.com/x", events: ["contact.created"] });
      expect(priv.status).toBe(400);
      const ok = await http().post("/api/webhook-endpoints").set("Authorization", tok(ADMIN, "Admin"))
        .send({ url: "https://hooks.example.com/catch", events: ["contact.created", "contact.updated", "application.stage_changed", "deal.funded", "note.added", "document.uploaded"] });
      expect(ok.status).toBe(201);
      endpointId = ok.body.endpoint.id;
      secret = ok.body.secret;
      expect(secret).toMatch(/^whsec_/);
      const listed = await http().get("/api/webhook-endpoints").set("Authorization", tok(ADMIN, "Admin"));
      expect(JSON.stringify(listed.body)).not.toContain(secret); // shown once
    });

    it("the row triggers fill the outbox for each subscribed event, and only for real changes", async () => {
      const c5 = randomUUID();
      await pool.query(`INSERT INTO contacts (id, name, email, silo) VALUES ($1, $2, $3, 'BF')`, [c5, `Hook${tag}`, `hook-${tag}@example.com`]);
      await pool.query(`UPDATE contacts SET updated_at = now() WHERE id = $1`, [c5]); // no real change
      await pool.query(`UPDATE contacts SET job_title = 'Owner' WHERE id = $1`, [c5]);
      await pool.query(`UPDATE applications SET pipeline_state = 'In Review' WHERE id = $1`, [a1]);
      await pool.query(`UPDATE applications SET funded_at = now(), funded_amount = 1000 WHERE id = $1`, [a1]);
      await pool.query(`INSERT INTO crm_notes (body, contact_id, silo) VALUES ('hello', $1, 'BF')`, [c5]);
      await pool.query(`INSERT INTO documents (id, application_id, created_at, category, filename) VALUES ($1, $2, now(), 'bank_statements', 'x.pdf')`, [randomUUID(), a1]);
      await pool.query(`INSERT INTO companies (id, name, silo) VALUES ($1, $2, 'BF')`, [randomUUID(), `HookCo${tag}`]); // not subscribed
      const r = await pool.query(`SELECT event_type, object_id, payload FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at, event_type`, [endpointId]);
      const types = r.rows.map((x) => x.event_type);
      expect(types.filter((t) => t === "contact.created")).toHaveLength(1);
      expect(types.filter((t) => t === "contact.updated")).toHaveLength(1);
      expect(types).toEqual(expect.arrayContaining(["application.stage_changed", "deal.funded", "note.added", "document.uploaded"]));
      expect(types).not.toContain("company.created");
      const stage = r.rows.find((x) => x.event_type === "application.stage_changed");
      expect(stage.payload.extra).toEqual({ from_stage: "Received", to_stage: "In Review" });
      await pool.query(`DELETE FROM crm_notes WHERE contact_id = $1`, [c5]);
      await pool.query(`DELETE FROM contacts WHERE id = $1`, [c5]);
    });

    it("deliveries go out signed; the log lists them and resend queues the same event again", async () => {
      const sent: any[] = [];
      const transport: Transport = async (req) => { sent.push(req); return { status: 200, body: "ok" }; };
      let n = 0;
      // KS_SERVER_TEST_ISOLATION - other files write contacts in parallel, so this endpoint can have more than one batch
      // due. Drain every batch, then judge only the deliveries that were due when draining finished.
      for (let round = 0; round < 20; round += 1) {
        const batch = await claimDue(db, 50);
        if (!batch.length) break;
        for (const d of batch) { if (d.endpoint_id === endpointId) { await deliverOne(db, d, { transport }); n++; } }
      }
      expect(n).toBeGreaterThanOrEqual(6);
      for (const s of sent) expect(verifySignature(secret, s.headers["X-Webhook-Signature"], s.body)).toEqual({ ok: true });
      const log = await http().get(`/api/webhook-endpoints/${endpointId}/deliveries`).set("Authorization", tok(ADMIN, "Admin"));
      const settled = log.body.deliveries.filter((d: any) => d.status !== "pending");
      expect(settled.length).toBeGreaterThanOrEqual(6);
      expect(settled.every((d: any) => d.status === "succeeded")).toBe(true);
      const first = log.body.deliveries[0];
      const re = await http().post(`/api/webhook-endpoints/deliveries/${first.id}/resend`).set("Authorization", tok(ADMIN, "Admin"));
      expect(re.status).toBe(202);
      const again = (await pool.query(`SELECT event_id::text, status, resend_of::text FROM webhook_deliveries WHERE id = $1`, [re.body.delivery_id])).rows[0];
      expect(again).toMatchObject({ event_id: first.event_id, status: "pending", resend_of: first.id });
      const test = await http().post(`/api/webhook-endpoints/${endpointId}/test`).set("Authorization", tok(ADMIN, "Admin")).send({ event: "deal.funded" });
      expect(test.status).toBe(202);
      const detail = await http().get(`/api/webhook-endpoints/deliveries/${test.body.delivery_id}`).set("Authorization", tok(ADMIN, "Admin"));
      expect(detail.body.delivery.body).toMatchObject({ type: "deal.funded", data: { test: true, object: { funded_amount: 240000 } } });
    });

    it("a paused endpoint stops receiving events", async () => {
      expect((await http().patch(`/api/webhook-endpoints/${endpointId}`).set("Authorization", tok(ADMIN, "Admin")).send({ status: "paused" })).status).toBe(200);
      const before = (await pool.query(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1`, [endpointId])).rows[0].n;
      await pool.query(`UPDATE contacts SET job_title = 'CFO' WHERE id = $1`, [c1]);
      const after = (await pool.query(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1`, [endpointId])).rows[0].n;
      expect(after).toBe(before);
    });
  });
});
