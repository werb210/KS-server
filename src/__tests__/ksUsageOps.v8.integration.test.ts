// KS_SERVER_v8_USAGE - usage metering, support tickets and the licensee connection settings against real Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import planRoutes from "../routes/plan.js";
import supportRoutes from "../routes/support.js";
import licenseeRoutes from "../routes/licensee.js";
import { clearPlanCache } from "../plans/state.js";
import { clearLicenseeCache } from "../licensee/settings.js";
import { CALL_MINUTES_SQL, licenseeTimeZone, periodBounds, recordOutboundText, usageCounts } from "../plans/usage.js";
import { runUsageNotices } from "../plans/usageNotices.js";
import dataExportRoutes from "../routes/dataExport.js";
import { runLicenseePurge } from "../plans/purge.js";

const MIGRATION = "migrations/2026_10_22_ks_v8_usage_ops.sql";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const token = (role: string) => jwt.sign({ sub: ADMIN, id: ADMIN, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
// A month far from real data so other rows cannot leak into the counts.
const PERIOD = "2031-03";
const TZ = licenseeTimeZone();
const { start } = periodBounds(PERIOD, TZ);
const at = (mins: number) => new Date(start.getTime() + mins * 60_000).toISOString();
const callIds: string[] = [];
const sessionIds: string[] = [];
const ticketIds: string[] = [];
let savedSettings: Record<string, any> | null = null;
let savedPlan: Record<string, any> | null = null;

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/plan", planRoutes);
  a.use("/api/support", supportRoutes);
  a.use("/api/licensee", licenseeRoutes);
  a.use("/api/export", dataExportRoutes);
  return a;
}

describe("KS v8 usage and ops link (real Postgres)", () => {
  beforeAll(async () => {
    await pool.query(readFileSync(MIGRATION, "utf8"));
    await pool.query(readFileSync(MIGRATION, "utf8")); // safe to run again
    savedSettings = (await pool.query(`SELECT * FROM licensee_settings WHERE id = 1`)).rows[0] ?? null;
    savedPlan = (await pool.query(`SELECT * FROM licensee_plan WHERE id = 1`)).rows[0] ?? null;
    for (const [secs, offset] of [[61, 10], [30, 20], [0, 30], [null, 40], [600, -5]] as const) {
      const id = randomUUID();
      callIds.push(id);
      await pool.query(
        `INSERT INTO call_logs (id, twilio_call_sid, direction, status, duration_seconds, started_at) VALUES ($1, $2, 'inbound', 'completed', $3, $4)`,
        [id, `CA-v8-${id}`, secs, at(offset)],
      );
    }
    for (const offset of [5, 6, -10]) {
      const id = randomUUID();
      sessionIds.push(id);
      await pool.query(`INSERT INTO chat_sessions (id, source, status, created_at) VALUES ($1, 'maya', 'ai', $2)`, [id, at(offset)]);
    }
    clearPlanCache();
    clearLicenseeCache();
  });

  afterAll(async () => {
    const warn = (e: unknown) => console.warn("cleanup", String(e));
    await pool.query(`DELETE FROM call_logs WHERE id = ANY($1::uuid[])`, [callIds]).catch(warn);
    await pool.query(`DELETE FROM chat_sessions WHERE id = ANY($1::uuid[])`, [sessionIds]).catch(warn);
    await pool.query(`DELETE FROM usage_events WHERE ref LIKE 'SM-v8-%'`).catch(warn);
    await pool.query(`DELETE FROM usage_notices WHERE period = $1`, [PERIOD]).catch(warn);
    await pool.query(`DELETE FROM support_tickets WHERE id = ANY($1::uuid[])`, [ticketIds]).catch(warn);
    await pool.query(
      `UPDATE licensee_settings SET twilio_main_number = $1, google_ads_customer_id = $2, office365_tenant_id = $3 WHERE id = 1`,
      [savedSettings?.twilio_main_number ?? null, savedSettings?.google_ads_customer_id ?? null, savedSettings?.office365_tenant_id ?? null],
    ).catch(warn);
    await pool.query(`DELETE FROM licensee_plan`).catch(warn);
    if (savedPlan) {
      const cols = Object.keys(savedPlan);
      await pool.query(`INSERT INTO licensee_plan (${cols.join(", ")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(", ")})`, cols.map((c) => savedPlan![c])).catch(warn);
    }
    clearPlanCache();
    for (const k of ["KS_OPS_KEY", "KS_LICENSEE_ID", "KS_OPS_URL"]) delete process.env[k];
    clearLicenseeCache();
  });

  it("counts minutes rounded up per call, texts by segments, and new assistant conversations in the local month", async () => {
    const db = pool as any;
    await recordOutboundText(db, { sid: "SM-v8-1", numSegments: "2" });
    await recordOutboundText(db, { sid: "SM-v8-1", numSegments: "2" }); // once per SID
    await recordOutboundText(db, { sid: "SM-v8-2" });
    await pool.query(`UPDATE usage_events SET occurred_at = $1 WHERE ref LIKE 'SM-v8-%'`, [at(50)]);
    const c = await usageCounts(db, PERIOD, TZ);
    expect(c).toEqual({ minutes: 3, texts: 3, assistant_chats: 2 }); // 61 s -> 2, 30 s -> 1; the -5 min call is February
    const m = await pool.query(CALL_MINUTES_SQL, [start.toISOString(), at(60 * 24)]);
    expect(Number(m.rows[0].minutes)).toBe(3);
  });

  it("GET /api/plan carries usage; the usage report is ops-key only", async () => {
    const r = await request(app()).get("/api/plan").set("Authorization", `Bearer ${token("Staff")}`);
    expect(r.status).toBe(200);
    expect(r.body.usage).toMatchObject({ overage: { minutes: expect.any(Number), texts: expect.any(Number) } });
    expect(r.body.usage.allowances.minutes).toBeGreaterThan(0);
    process.env.KS_OPS_KEY = "int-key";
    process.env.KS_LICENSEE_ID = "lic-int";
    expect((await request(app()).get(`/api/plan/usage-report?period=${PERIOD}`)).status).toBe(401);
    const rep = await request(app()).get(`/api/plan/usage-report?period=${PERIOD}`).set("X-KS-Ops-Key", "int-key");
    expect(rep.status).toBe(200);
    expect(rep.body).toMatchObject({ licensee_id: "lic-int", period: PERIOD, minutes: 3, texts: 3, assistant_chats: 2 });
  });

  it("usage_notices markers are unique per month, metric and level", async () => {
    await pool.query(`INSERT INTO usage_notices (period, metric, level) VALUES ($1, 'minutes', 80)`, [PERIOD]);
    const again = await pool.query(
      `INSERT INTO usage_notices (period, metric, level) VALUES ($1, 'minutes', 80) ON CONFLICT (period, metric, level) DO NOTHING RETURNING level`,
      [PERIOD],
    );
    expect(again.rows).toHaveLength(0);
    // The notice job runs its real queries without error (current month; nothing may be due).
    await expect(runUsageNotices(pool as any, new Date(), async () => ({ ok: true }))).resolves.toBeDefined();
  });

  it("stores support tickets (relay not configured) and lists them", async () => {
    const r = await request(app()).post("/api/support/tickets").set("Authorization", `Bearer ${token("Staff")}`)
      .send({ subject: "Integration ticket", body: "Testing", priority: "urgent" });
    expect(r.status).toBe(201);
    ticketIds.push(r.body.ticket.id);
    expect(r.body).toMatchObject({ relayed: false, relay_error: "ops_not_configured", ticket: { priority: "urgent", status: "open" } });
    const list = await request(app()).get("/api/support/tickets").set("Authorization", `Bearer ${token("Admin")}`);
    expect(list.body.tickets.map((t: any) => t.id)).toContain(r.body.ticket.id);
  });

  it("connection settings are saved, admin-only, and absent from the public licensee", async () => {
    const put = await request(app()).put("/api/licensee").set("Authorization", `Bearer ${token("Admin")}`)
      .send({ twilio_main_number: "+1 587 555 0199", google_ads_customer_id: "123-456-7890" });
    expect(put.status).toBe(200);
    expect(put.body.licensee).toMatchObject({ twilio_main_number: "+15875550199", google_ads_customer_id: "123-456-7890" });
    const pub = await request(app()).get("/api/licensee");
    expect(pub.body.licensee).not.toHaveProperty("twilio_main_number");
    const adm = await request(app()).get("/api/licensee/admin").set("Authorization", `Bearer ${token("Admin")}`);
    expect(adm.body.licensee.google_ads_customer_id).toBe("123-456-7890");
    expect((await request(app()).get("/api/licensee/admin").set("Authorization", `Bearer ${token("Staff")}`)).status).toBe(403);
  });

  it("service status: ops cancels, the export streams a zip of the real schema, the purge dry run deletes nothing", async () => {
    process.env.KS_OPS_KEY = "int-key";
    const put = await request(app()).put("/api/plan").set("X-KS-Ops-Key", "int-key").send({ status: "cancelled" });
    expect(put.status).toBe(200);
    expect(put.body.service_status).toBe("cancelled");
    expect(put.body.cancelled_at).toBeTruthy();

    const exp = await request(app()).get("/api/export").set("Authorization", `Bearer ${token("Admin")}`)
      .buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });
    expect(exp.status).toBe(200);
    expect(exp.headers["content-type"]).toMatch(/zip/);
    const zip = exp.body as Buffer;
    expect(zip.subarray(0, 2).toString()).toBe("PK");
    expect(zip.includes(Buffer.from("tables/contacts.jsonl"))).toBe(true);
    expect(zip.includes(Buffer.from("tables/otp_codes.jsonl"))).toBe(false);
    expect((await request(app()).get("/api/export").set("Authorization", `Bearer ${token("Staff")}`)).status).toBe(403);

    await pool.query(`UPDATE licensee_plan SET cancelled_at = now() - interval '200 days' WHERE id = 1`);
    const before = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM call_logs`)).rows[0].n);
    const dry = await runLicenseePurge(pool as any, new Date(), { dryRun: true });
    expect(dry.action).toBe("would_purge");
    expect((dry as any).tables).toContain("contacts");
    expect((dry as any).tables).not.toContain("schema_migrations");
    expect(Number((await pool.query(`SELECT COUNT(*)::int AS n FROM call_logs`)).rows[0].n)).toBe(before);

    await request(app()).put("/api/plan").set("X-KS-Ops-Key", "int-key").send({ status: "active" });
    expect(await runLicenseePurge(pool as any, new Date(), { dryRun: true })).toEqual({ action: "none", reason: "not_cancelled" });
  });
});
