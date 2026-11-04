// KS_SERVER_CUSTOM_ROLES - custom roles against real Postgres: the migration (twice) leaves every existing user exactly
// as they were, the role editor API (plan gate, full-Admin only, clamping to the base, audit rows), assigning a role
// through the user admin route, the matrix enforced by the real staff middleware, and record visibility.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { clearPlanCache, type Q } from "../plans/state.js";
import crmRoutes from "../routes/crm.js";
import usersRoutes from "../routes/users.js";
import rolesRoutes from "../routes/roles.js";
import { clearVisibilityCache, resolveScope } from "../visibility/scope.js";
import { clearStaffUserCache, resetStaffUserLoader, setStaffUserLoader } from "../auth/staffUserState.js";
import { dbStaffUserLoader } from "../auth/staffUserState.js";
import { clearCustomRoleCache } from "../roles/customRoles.js";
import { templateFor } from "../roles/permissions.js";
import { markReady } from "../startupState.js";
import { deps } from "../system/deps.js";

const MIGRATION = "migrations/2026_11_05_ks_custom_roles.sql";
const db = pool as unknown as Q;
const tag = randomUUID().slice(0, 8);
const ADMIN = randomUUID(), S1 = randomUUID(), S2 = randomUUID(), M1 = randomUUID();
const c1 = randomUUID(), c2 = randomUUID();
const tok = (id: string, role: string, tv = 0) => `Bearer ${jwt.sign({ sub: id, id, role, tokenVersion: tv, tv }, String(process.env.JWT_SECRET))}`;
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
  a.use("/api/users", usersRoutes);
  a.use("/api/roles", rolesRoutes);
  return a;
}
const http = () => request(app());
const fresh = () => { clearStaffUserCache(); clearCustomRoleCache(); clearVisibilityCache(); };

describe("KS custom roles (real Postgres)", () => {
  beforeAll(async () => {
    markReady();
    deps.db.client = pool;
    deps.db.ready = true;
    // The real users-row loader (the unit suite's default synthesizes users from token claims).
    setStaffUserLoader(dbStaffUserLoader, { cache: false });
    savedPlan = (await pool.query(`SELECT * FROM licensee_plan WHERE id = 1`)).rows[0] ?? null;
    for (const [id, role, first] of [[ADMIN, "Admin", "Ada"], [S1, "Staff", "Sam"], [S2, "Staff", "Sue"], [M1, "Marketing", "Mo"]]) {
      await pool.query(
        `INSERT INTO users (id, email, active, is_active, status, role, first_name, last_name, silo, silos)
         VALUES ($1, $2, true, true, 'ACTIVE', $3, $4, 'Roles', 'BF', ARRAY['BF'])`,
        [id, `${first.toLowerCase()}-${tag}@example.com`, role, first],
      );
    }
    await pool.query(`INSERT INTO contacts (id, name, email, owner_id, silo) VALUES ($1, $2, $3, $4, 'BF'), ($5, $6, $7, $8, 'BF')`,
      [c1, `Role${tag} One`, `r1-${tag}@example.com`, S1, c2, `Role${tag} Two`, `r2-${tag}@example.com`, S2]);
  });

  afterAll(async () => {
    await pool.query(`UPDATE users SET custom_role_id = NULL WHERE id = ANY($1::uuid[])`, [[ADMIN, S1, S2, M1]]);
    await pool.query(`DELETE FROM custom_roles WHERE name LIKE $1`, [`%${tag}%`]);
    await pool.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [[c1, c2]]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ADMIN, S1, S2, M1]]);
    await pool.query(`DELETE FROM licensee_plan`);
    if (savedPlan) await pool.query(`INSERT INTO licensee_plan (id, plan) VALUES (1, $1)`, [savedPlan.plan]);
    clearPlanCache();
    resetStaffUserLoader();
  });

  it("the migration runs twice and changes nobody's role, visibility or access", async () => {
    const before = (await pool.query(`SELECT id::text, role, record_visibility, token_version FROM users ORDER BY id`)).rows;
    await pool.query(readFileSync(MIGRATION, "utf8"));
    await pool.query(readFileSync(MIGRATION, "utf8"));
    const after = (await pool.query(`SELECT id::text, role, record_visibility, token_version FROM users ORDER BY id`)).rows;
    expect(after).toEqual(before);
    expect((await pool.query(`SELECT count(*)::int AS n FROM users WHERE custom_role_id IS NOT NULL AND id = ANY($1::uuid[])`, [[ADMIN, S1, S2, M1]])).rows[0].n).toBe(0);
  });

  it("built-in users: same access and same visibility as before", async () => {
    await setPlan("pro");
    fresh();
    for (const [id, role] of [[ADMIN, "Admin"], [S1, "Staff"], [M1, "Marketing"]]) {
      const res = await http().get(`/api/crm/contacts/${c1}`).set("Authorization", tok(id, role));
      expect(res.status, role).toBe(200);
      const me = await http().get("/api/roles/me").set("Authorization", tok(id, role));
      expect(me.body).toMatchObject({ ok: true, role, custom_role: null, full_admin: role === "Admin" });
      expect(me.body.permissions).toEqual(templateFor(role as any));
    }
    expect((await resolveScope(db, S1, "Staff")).mode).toBe("all");
  });

  let roleId = "";
  it("only full Admins create roles, on Pro; permissions beyond the base are dropped and audited", async () => {
    await setPlan("growth");
    const body = {
      name: `Viewer ${tag}`, base_role: "Staff", record_visibility: "own",
      permissions: { contacts: { view: true, edit: true }, companies: { view: true }, users: { view: true, edit: true } },
    };
    const locked = await http().post("/api/roles").set("Authorization", tok(ADMIN, "Admin")).send(body);
    expect(locked.status).toBe(402);
    await setPlan("pro");
    expect((await http().post("/api/roles").set("Authorization", tok(S1, "Staff")).send(body)).status).toBe(403);
    const made = await http().post("/api/roles").set("Authorization", tok(ADMIN, "Admin")).send(body);
    expect(made.status).toBe(201);
    expect(made.body.dropped).toEqual(["users.view", "users.edit"]);
    expect(made.body.role.permissions.contacts).toMatchObject({ view: true, edit: true, delete: false });
    expect(made.body.role.permissions.users.view).toBe(false);
    roleId = made.body.role.id;
    const dup = await http().post("/api/roles").set("Authorization", tok(ADMIN, "Admin")).send(body);
    expect(dup.status).toBe(409);
    const audit = await pool.query(`SELECT event_type, event_action, metadata FROM audit_events WHERE target_id = $1 ORDER BY created_at`, [roleId]);
    expect(audit.rows[0]).toMatchObject({ event_type: "custom_role", event_action: "created" });
    const list = await http().get("/api/roles").set("Authorization", tok(ADMIN, "Admin"));
    // KS_SETUP_WIZARD - the Staff role reads as "Broker"; its stored base role stays "Staff".
    expect(list.body.templates.map((t: any) => t.name)).toEqual(["Admin", "Ops", "Broker", "Marketing"]);
    expect(list.body.templates.map((t: any) => t.base_role)).toEqual(["Admin", "Ops", "Staff", "Marketing"]);
    expect(list.body.templates.every((t: any) => t.read_only)).toBe(true);
    expect(list.body.roles.some((r: any) => r.id === roleId)).toBe(true);
  });

  it("assigning the role through the user admin route sets the base role, audits it, and the server enforces the matrix", async () => {
    const res = await http().patch(`/api/users/${S1}`).set("Authorization", tok(ADMIN, "Admin")).send({ custom_role_id: roleId });
    expect(res.status).toBe(200);
    expect(res.body.custom_role_id).toBe(roleId);
    const row = (await pool.query(`SELECT role, custom_role_id::text AS custom_role_id FROM users WHERE id = $1`, [S1])).rows[0];
    expect(row).toEqual({ role: "Staff", custom_role_id: roleId });
    const audit = await pool.query(`SELECT metadata FROM audit_events WHERE target_id = $1 AND event_type = 'custom_role' AND event_action = 'assigned'`, [S1]);
    expect(audit.rows[0].metadata.after).toMatchObject({ role: "Staff", custom_role_id: roleId });
    fresh();
    // own visibility: their contact yes, Sue's no.
    expect((await http().get(`/api/crm/contacts/${c1}`).set("Authorization", tok(S1, "Staff"))).status).toBe(200);
    expect((await http().get(`/api/crm/contacts/${c2}`).set("Authorization", tok(S1, "Staff"))).status).toBe(404);
    const del = await http().delete(`/api/crm/contacts/${c1}`).set("Authorization", tok(S1, "Staff"));
    expect(del.status).toBe(403);
    expect(del.body.error).toBe("permission_denied");
    const me = await http().get("/api/roles/me").set("Authorization", tok(S1, "Staff"));
    expect(me.body).toMatchObject({ custom_role: { id: roleId }, record_visibility: "own", full_admin: false });
    // Sue, still on built-in Staff, is untouched.
    expect((await http().get(`/api/crm/contacts/${c2}`).set("Authorization", tok(S2, "Staff"))).status).toBe(200);
    expect((await http().get(`/api/crm/contacts/${c1}`).set("Authorization", tok(S2, "Staff"))).status).toBe(200);
  });

  it("an archived role cannot be assigned; a role in use cannot be archived; moving back to a built-in role clears it", async () => {
    const busy = await http().post(`/api/roles/${roleId}/archive`).set("Authorization", tok(ADMIN, "Admin"));
    expect(busy.status).toBe(409);
    const back = await http().patch(`/api/users/${S1}`).set("Authorization", tok(ADMIN, "Admin")).send({ role: "Staff" });
    expect(back.status).toBe(200);
    expect((await pool.query(`SELECT custom_role_id FROM users WHERE id = $1`, [S1])).rows[0].custom_role_id).toBeNull();
    fresh();
    expect((await http().get(`/api/crm/contacts/${c2}`).set("Authorization", tok(S1, "Staff"))).status).toBe(200);
    expect((await http().post(`/api/roles/${roleId}/archive`).set("Authorization", tok(ADMIN, "Admin"))).status).toBe(200);
    const again = await http().patch(`/api/users/${S2}`).set("Authorization", tok(ADMIN, "Admin")).send({ custom_role_id: roleId });
    expect(again.status).toBe(409);
  });

  it("a Marketing-based role keeps the person a Marketing user (so the Marketing seats count them)", async () => {
    const made = await http().post("/api/roles").set("Authorization", tok(ADMIN, "Admin"))
      .send({ name: `Campaigns ${tag}`, base_role: "Marketing", permissions: templateFor("Marketing"), record_visibility: "all" });
    expect(made.status).toBe(201);
    const res = await http().patch(`/api/users/${S2}`).set("Authorization", tok(ADMIN, "Admin")).send({ custom_role_id: made.body.role.id });
    expect(res.status).toBe(200);
    const row = (await pool.query(`SELECT role, token_version FROM users WHERE id = $1`, [S2])).rows[0];
    expect(row.role).toBe("Marketing");
    // A change of built-in role signs the person out, as it always has.
    expect((await http().get("/api/roles/me").set("Authorization", tok(S2, "Staff"))).status).toBe(401);
  });

  it("a downgrade keeps restrictions in force but stops new custom roles", async () => {
    await setPlan("growth");
    fresh();
    const p = templateFor("Staff");
    p.contacts.delete = false;
    await pool.query(`UPDATE custom_roles SET permissions = $2::jsonb WHERE name = $1`, [`Campaigns ${tag}`, JSON.stringify(p)]);
    clearCustomRoleCache();
    const tv = Number((await pool.query(`SELECT token_version FROM users WHERE id = $1`, [S2])).rows[0].token_version);
    expect((await http().delete(`/api/crm/contacts/${c2}`).set("Authorization", tok(S2, "Marketing", tv))).status).toBe(403);
    expect((await http().get(`/api/crm/contacts/${c2}`).set("Authorization", tok(S2, "Marketing", tv))).status).toBe(200);
    expect((await http().post("/api/roles").set("Authorization", tok(ADMIN, "Admin")).send({ name: `Later ${tag}`, base_role: "Staff" })).status).toBe(402);
    await setPlan("pro");
  });
});
