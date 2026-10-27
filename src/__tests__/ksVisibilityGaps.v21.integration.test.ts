// KS_SERVER_v21_VISIBILITY_GAPS - against real Postgres: the assistant acts for the staff member named in the signed
// X-Maya-Context (and refuses a mismatched staff_user_id), and messages, calls, tasks, voicemails and the duplicate
// banner show a restricted user only activity on records they may see. Tasks assigned to the user always stay. Admin
// sees everything.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { clearPlanCache } from "../plans/state.js";
import crmRoutes from "../routes/crm.js";
import communicationsRoutes from "../routes/communications.js";
import messagesRoutes from "../routes/messages.js";
import tasksRoutes from "../routes/tasks.js";
import callsRoutes from "../routes/calls.js";
import voiceCallsRoutes from "../routes/voiceCalls.js";
import mayaStaffRouter, { verifyMayaService } from "../routes/mayaStaff.js";
import { signMayaContext } from "../services/mayaContext.js";
import { clearVisibilityCache } from "../visibility/scope.js";
import { scopedAssistantRequest } from "../visibility/scopedDb.js";
import { markReady } from "../startupState.js";
import { deps } from "../system/deps.js";

const tag = randomUUID().slice(0, 8);
const ADMIN = randomUUID(), S1 = randomUUID(), S2 = randomUUID();
const c1 = randomUUID(), c2 = randomUUID(), c5 = randomUUID();
const a1 = randomUUID(), a2 = randomUUID();
const tMine = randomUUID(), tTheirs = randomUUID(), tAssignedToMe = randomUUID(), tPlain = randomUUID();
const PHONE1 = "+17805550111", PHONE2 = "+17805550122";
let savedPlan: Record<string, any> | null = null;

const tok = (id: string, role: string) => `Bearer ${jwt.sign({ sub: id, id, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET))}`;
const svc = () => "Bearer " + jwt.sign({ kind: "service", source: "agent" }, String(process.env.JWT_SECRET), { algorithm: "HS256" });
const ctxFor = (id: string, role = "Staff") => signMayaContext({ audience: "staff", staff: { id, name: null, email: null, role }, silo: "BF" });

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/crm", crmRoutes);
  a.use("/api/communications", communicationsRoutes);
  a.use("/api/messages", messagesRoutes);
  a.use("/api/tasks", tasksRoutes);
  a.use("/api/calls", callsRoutes);
  a.use("/api/voice", voiceCallsRoutes);
  // The assistant's staff mount, as routeRegistry.ts builds it.
  const maya = express.Router();
  maya.use("/staff", (req, res, next) => (verifyMayaService(req) ? scopedAssistantRequest(req, res, next) : next()));
  maya.use(mayaStaffRouter);
  a.use("/api/maya", maya);
  return a;
}
const http = () => request(app());
const has = (rows: any[], key: string, id: string) => rows.some((r) => String(r?.[key]) === id);

describe("KS v21 record visibility for the assistant and activity lists (real Postgres)", () => {
  beforeAll(async () => {
    markReady();
    deps.db.client = pool;
    deps.db.ready = true;
    savedPlan = (await pool.query(`SELECT * FROM licensee_plan WHERE id = 1`)).rows[0] ?? null;
    await pool.query(`DELETE FROM licensee_plan`);
    await pool.query(`INSERT INTO licensee_plan (id, plan) VALUES (1, 'growth')`);
    clearPlanCache();
    for (const [id, role, first] of [[ADMIN, "Admin", "Ada"], [S1, "Staff", "Sam"], [S2, "Staff", "Sue"]]) {
      await pool.query(`INSERT INTO users (id, email, active, role, first_name, last_name) VALUES ($1, $2, true, $3, $4, 'V21')`, [id, `${first.toLowerCase()}-${tag}@example.com`, role, first]);
    }
    await pool.query(`UPDATE users SET record_visibility = 'own' WHERE id = $1`, [S1]);
    const contact = `INSERT INTO contacts (id, name, email, phone, owner_id, silo) VALUES ($1, $2, $3, $4, $5, 'BF')`;
    await pool.query(contact, [c1, `Gap${tag} Mine`, `dup-${tag}@example.com`, PHONE1, S1]);
    await pool.query(contact, [c2, `Gap${tag} Theirs`, `dup-${tag}@example.com`, PHONE2, S2]);
    await pool.query(contact, [c5, `Gap${tag} Mine Too`, `dup-${tag}@example.com`, null, S1]);
    const appSql = `INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, contact_id, owner_user_id, silo)
                    VALUES ($1, $2, now(), now(), 'Received', 'RECEIVED', $3, $4, 'BF')`;
    await pool.query(appSql, [a1, `GapApp${tag} Mine`, c1, S1]);
    await pool.query(appSql, [a2, `GapApp${tag} Theirs`, c2, S2]);
    const msg = `INSERT INTO communications_messages (id, contact_id, application_id, type, direction, body, from_number, to_number, silo, created_at)
                 VALUES ($1, $2, $3, $4, 'inbound', $5, $6, '+17805550100', 'BF', now())`;
    await pool.query(msg, [randomUUID(), c1, null, "sms", `sms-mine-${tag}`, PHONE1]);
    await pool.query(msg, [randomUUID(), c2, null, "sms", `sms-theirs-${tag}`, PHONE2]);
    await pool.query(msg, [randomUUID(), c1, a1, "portal", `chat-mine-${tag}`, PHONE1]);
    await pool.query(msg, [randomUUID(), c2, a2, "portal", `chat-theirs-${tag}`, PHONE2]);
    const call = `INSERT INTO call_logs (id, crm_contact_id, contact_id, application_id, staff_user_id, direction, status, phone_number, silo, created_at)
                  VALUES ($1, $2, $2, $3, $4, 'outbound', 'completed', $5, 'BF', now())`;
    await pool.query(call, [randomUUID(), c1, a1, S1, PHONE1]);
    await pool.query(call, [randomUUID(), c2, a2, S1, PHONE2]); // S1 dialled S2's contact: still hidden from S1
    const task = `INSERT INTO tasks (id, silo, title, assignee_user_id, contact_id) VALUES ($1, 'BF', $2, $3, $4)`;
    await pool.query(task, [tMine, `task-mine-${tag}`, S2, c1]);
    await pool.query(task, [tTheirs, `task-theirs-${tag}`, S2, c2]);
    await pool.query(task, [tAssignedToMe, `task-assigned-${tag}`, S1, c2]);
    await pool.query(task, [tPlain, `task-plain-${tag}`, S2, null]);
    clearVisibilityCache();
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM tasks WHERE id = ANY($1::uuid[])`, [[tMine, tTheirs, tAssignedToMe, tPlain]]);
    await pool.query(`DELETE FROM call_logs WHERE crm_contact_id = ANY($1::uuid[])`, [[c1, c2]]);
    await pool.query(`DELETE FROM communications_messages WHERE contact_id = ANY($1::uuid[])`, [[c1, c2]]);
    await pool.query(`DELETE FROM applications WHERE id = ANY($1::text[])`, [[a1, a2]]);
    await pool.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [[c1, c2, c5]]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ADMIN, S1, S2]]);
    await pool.query(`DELETE FROM licensee_plan`);
    if (savedPlan) await pool.query(`INSERT INTO licensee_plan (id, plan) VALUES (1, $1)`, [savedPlan.plan]);
    clearPlanCache();
    clearVisibilityCache();
  });

  describe("the assistant", () => {
    const find = (headers: Record<string, string>, body: Record<string, unknown>) =>
      http().post("/api/maya/staff/contact-find").set({ Authorization: svc(), ...headers }).send({ query: `Gap${tag}`, silo: "BF", role: "Staff", ...body });

    it("a restricted user sees only their own records, verified by the signed context", async () => {
      const r = await find({ "X-Maya-Context": ctxFor(S1) }, { staff_user_id: S1 });
      expect(r.status).toBe(200);
      expect(r.body.contacts.map((c: any) => c.id).sort()).toEqual([c1, c5].sort());
      const tasks = await http().post("/api/maya/staff/crm-tasks").set({ Authorization: svc(), "X-Maya-Context": ctxFor(S1) }).send({ contact_id: c2, staff_user_id: S1 });
      expect(tasks.body.tasks.map((t: any) => t.id)).toEqual([tAssignedToMe]); // assigned to them, so it stays
    });

    it("Admin and users who see all records see everything", async () => {
      const admin = await find({ "X-Maya-Context": ctxFor(ADMIN, "Admin") }, { staff_user_id: ADMIN, role: "Admin" });
      expect(admin.body.contacts.map((c: any) => c.id).sort()).toEqual([c1, c2, c5].sort());
      const all = await find({ "X-Maya-Context": ctxFor(S2) }, { staff_user_id: S2 });
      expect(all.body.contacts.length).toBe(3);
    });

    it("a staff_user_id that does not match the signed context is refused", async () => {
      const r = await find({ "X-Maya-Context": ctxFor(S1) }, { staff_user_id: S2 });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("staff_identity_mismatch");
    });

    it("an unsigned staff_user_id never widens what the assistant sees", async () => {
      // Without a valid context the id in the body is ignored: the role decides (Staff sees all here: no role setting).
      await pool.query(`INSERT INTO role_record_visibility (role, visibility) VALUES ('Staff', 'own') ON CONFLICT (role) DO UPDATE SET visibility = 'own'`);
      clearVisibilityCache();
      try {
        const forged = jwt.sign({ kind: "maya_context", audience: "staff", staff: { id: S2 } }, "not-the-secret", { issuer: "bf-server", audience: "agent" });
        for (const headers of [{}, { "X-Maya-Context": forged }]) {
          const r = await find(headers, { staff_user_id: S2 });
          expect(r.status).toBe(200);
          expect(r.body.contacts).toEqual([]);
        }
      } finally {
        await pool.query(`DELETE FROM role_record_visibility WHERE role = 'Staff'`);
        clearVisibilityCache();
      }
    });
  });

  describe("activity lists", () => {
    it("messages: SMS and portal threads, threads by contact and the per-record list", async () => {
      const sms = await http().get(`/api/communications/sms?q=Gap${tag}`).set("Authorization", tok(S1, "Staff"));
      expect(sms.status).toBe(200);
      expect(has(sms.body.conversations, "contact_id", c1)).toBe(true);
      expect(has(sms.body.conversations, "contact_id", c2)).toBe(false);
      const list = await http().get(`/api/communications/messages-list?q=Gap${tag}`).set("Authorization", tok(S1, "Staff"));
      expect(has(list.body.conversations, "contact_id", c1)).toBe(true);
      expect(has(list.body.conversations, "contact_id", c2)).toBe(false);
      const thread = await http().get(`/api/communications/sms/thread?contactId=${c2}`).set("Authorization", tok(S1, "Staff"));
      expect(thread.body.messages).toEqual([]);
      const byApp = await http().get(`/api/messages?applicationId=${a2}`).set("Authorization", tok(S1, "Staff"));
      expect(byApp.body.data).toEqual([]);
      const timeline = await http().get(`/api/communications/timeline?phone=${encodeURIComponent(PHONE2)}`).set("Authorization", tok(S1, "Staff"));
      expect(timeline.body.events).toEqual([]);

      const adminList = await http().get(`/api/communications/messages-list?q=Gap${tag}`).set("Authorization", tok(ADMIN, "Admin"));
      expect(has(adminList.body.conversations, "contact_id", c1) && has(adminList.body.conversations, "contact_id", c2)).toBe(true);
      const adminThread = await http().get(`/api/communications/sms/thread?contactId=${c2}`).set("Authorization", tok(ADMIN, "Admin"));
      expect(adminThread.body.messages.length).toBe(1);
    });

    it("call log: the per-record list and the user's recent calls", async () => {
      const mine = await http().get(`/api/calls?contactId=${c1}`).set("Authorization", tok(S1, "Staff"));
      expect(mine.status).toBe(200);
      expect(mine.body.data.calls.length).toBe(1);
      const theirs = await http().get(`/api/calls?contactId=${c2}`).set("Authorization", tok(S1, "Staff"));
      expect(theirs.body.data.calls).toEqual([]);
      const recent = await http().get(`/api/voice/recent-calls`).set("Authorization", tok(S1, "Staff"));
      expect(has(recent.body.items, "contact_id", c1)).toBe(true);
      expect(has(recent.body.items, "contact_id", c2)).toBe(false);
      const admin = await http().get(`/api/calls?contactId=${c2}`).set("Authorization", tok(ADMIN, "Admin"));
      expect(admin.body.data.calls.length).toBe(1);
    });

    it("tasks: hidden on records the user cannot see, except tasks assigned to them; Admin sees all", async () => {
      const r = await http().get(`/api/tasks?view=all`).set("Authorization", tok(S1, "Staff"));
      expect(r.status).toBe(200);
      const got = r.body.data?.tasks ?? r.body.tasks;
      const ids = got.map((t: any) => t.id);
      expect(ids).toEqual(expect.arrayContaining([tMine, tAssignedToMe, tPlain]));
      expect(ids).not.toContain(tTheirs);
      // A hidden task cannot be changed by id either.
      expect((await http().patch(`/api/tasks/${tTheirs}`).set("Authorization", tok(S1, "Staff")).send({ title: "x" })).status).toBe(404);
      expect((await pool.query(`SELECT title FROM tasks WHERE id = $1`, [tTheirs])).rows[0].title).toBe(`task-theirs-${tag}`);
      const admin = await http().get(`/api/tasks?view=all`).set("Authorization", tok(ADMIN, "Admin"));
      const adminIds = (admin.body.data?.tasks ?? admin.body.tasks).map((t: any) => t.id);
      expect(adminIds).toEqual(expect.arrayContaining([tMine, tTheirs, tAssignedToMe, tPlain]));
    });

    it("the duplicate banner offers only contacts the user may see; Admin sees every candidate", async () => {
      const r = await http().get(`/api/crm/contacts/${c1}/duplicate-candidates`).set("Authorization", tok(S1, "Staff"));
      expect(r.status).toBe(200);
      expect(r.body.data.map((x: any) => x.id)).toEqual([c5]);
      const admin = await http().get(`/api/crm/contacts/${c1}/duplicate-candidates`).set("Authorization", tok(ADMIN, "Admin"));
      expect(admin.body.data.map((x: any) => x.id).sort()).toEqual([c2, c5].sort());
      // Merging still needs a user who sees every record.
      expect((await http().post(`/api/crm/contacts/merge`).set("Authorization", tok(S1, "Staff")).send({ survivorId: c1, loserIds: [c5] })).status).toBe(403);
    });

    it("no scoped views outlive a request", async () => {
      let left = -1;
      for (let i = 0; i < 40 && left !== 0; i++) {
        left = (await pool.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname LIKE 'pg_temp%' AND c.relname IN ('tasks', 'call_logs', 'communications_messages', 'voicemails')`)).rows[0].n;
        if (left) await new Promise((r) => setTimeout(r, 50));
      }
      expect(left).toBe(0);
    });
  });
});
