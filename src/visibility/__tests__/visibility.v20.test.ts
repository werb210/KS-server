// KS_SERVER_v20_TEAMS - who sees which records: resolution (role, per-user override, team, admin, plan) and the SQL.
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { clearPlanCache } from "../../plans/state.js";
import {
  ALL_SCOPE, canSeeRecord, clearVisibilityCache, narrowToOwners, ownerFilterSql, resolveRoleOnlyScope, resolveScope, scopeForActingUser,
} from "../scope.js";
import { recordGuard, CRM_RULES, APPLICATIONS_RULES } from "../recordGuard.js";
import { viewSql } from "../scopedDb.js";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";

type Opts = { plan?: string; userVis?: string | null; roleVis?: string | null; team?: string[]; visible?: string[]; roleFor?: string };
function fakeDb(o: Opts = {}) {
  const sqls: string[] = [];
  return {
    sqls,
    query: async (sql: string, params: unknown[] = []) => {
      sqls.push(sql);
      if (/FROM licensee_plan/.test(sql)) return { rows: [{ plan: o.plan ?? "growth" }] };
      if (/record_visibility, \(SELECT visibility FROM role_record_visibility/.test(sql)) return { rows: [{ record_visibility: o.userVis ?? null, role_visibility: o.roleVis ?? null, found: true }] };
      if (/FROM role_record_visibility WHERE role/.test(sql)) return { rows: o.roleVis ? [{ visibility: o.roleVis }] : [] };
      if (/record_visibility IN \('team', 'own'\)/.test(sql)) return { rows: [{ x: false }] };
      if (/FROM sales_team_members m1/.test(sql)) return { rows: (o.team ?? []).map((id) => ({ id })) };
      if (/SELECT role FROM users WHERE id/.test(sql)) return { rows: o.roleFor ? [{ role: o.roleFor }] : [] };
      if (/SELECT 1 FROM (contacts|companies|applications) r WHERE r.id/.test(sql)) {
        const owners = params[1] as string[];
        return { rows: (o.visible ?? []).includes(String(params[0])) && owners.length ? [{ "?column?": 1 }] : [] };
      }
      return { rows: [] };
    },
  };
}

afterEach(() => {
  clearVisibilityCache();
  clearPlanCache();
});

describe("resolveScope", () => {
  it("is All by default, so nothing changes for existing brokerages", async () => {
    expect(await resolveScope(fakeDb(), U1, "Staff")).toEqual({ mode: "all", visibility: "all", userId: U1 });
  });

  it("follows the role setting, and a per-user setting beats it", async () => {
    expect(await resolveScope(fakeDb({ roleVis: "own" }), U1, "Staff")).toEqual({ mode: "restricted", visibility: "own", userId: U1, ownerIds: [U1] });
    clearVisibilityCache();
    expect((await resolveScope(fakeDb({ roleVis: "own", userVis: "all" }), U1, "Staff")).mode).toBe("all");
  });

  it("team: the user and everyone sharing one of their teams", async () => {
    const s = await resolveScope(fakeDb({ roleVis: "team", team: [U1, U2] }), U1, "Staff");
    expect(s).toMatchObject({ mode: "restricted", visibility: "team" });
    expect((s as any).ownerIds.sort()).toEqual([U1, U2].sort());
  });

  it("admins always see everything", async () => {
    const db = fakeDb({ roleVis: "own", userVis: "own" });
    expect((await resolveScope(db, U1, "Admin")).mode).toBe("all");
    expect(db.sqls).toEqual([]);
  });

  it("starter (no teams in the plan): everyone sees everything whatever is stored", async () => {
    expect((await resolveScope(fakeDb({ plan: "starter", userVis: "own" }), U1, "Staff")).mode).toBe("all");
  });

  it("the assistant without an acting user: all only when the role sees all, else nothing", async () => {
    expect(await resolveRoleOnlyScope(fakeDb(), "Staff")).toBe(ALL_SCOPE);
    expect(await resolveRoleOnlyScope(fakeDb({ roleVis: "own" }), "Staff")).toMatchObject({ mode: "restricted", ownerIds: [] });
    expect(await scopeForActingUser(fakeDb({ roleVis: "own", roleFor: "Staff" }), { staff_user_id: U3 })).toMatchObject({ mode: "restricted", ownerIds: [U3] });
  });
});

describe("SQL", () => {
  it("adds one owner condition per record type, or nothing for All", () => {
    const params: unknown[] = ["BF"];
    const own = { mode: "restricted", visibility: "own", userId: U1, ownerIds: [U1] } as const;
    expect(ownerFilterSql(own, "contact", "c", params)).toBe("c.owner_id = ANY($2::uuid[])");
    expect(ownerFilterSql(own, "application", "a", params)).toBe("a.owner_user_id = ANY($3::uuid[])");
    expect(params).toEqual(["BF", [U1], [U1]]);
    expect(ownerFilterSql(ALL_SCOPE, "company", "co", params)).toBe("TRUE");
    expect(ownerFilterSql({ ...own, ownerIds: [] }, "company", "co", [])).toBe("FALSE");
    expect(() => ownerFilterSql(own, "contact", "c;--", [])).toThrow();
  });

  it("the team filter only ever narrows", () => {
    expect(narrowToOwners(ALL_SCOPE, [U2])).toMatchObject({ mode: "restricted", ownerIds: [U2] });
    expect(narrowToOwners({ mode: "restricted", visibility: "team", userId: U1, ownerIds: [U1, U2] }, [U2, U3])).toMatchObject({ ownerIds: [U2] });
  });

  it("report views filter the three tables by owner and never inline anything but uuids", () => {
    const v = viewSql([U1, "x'); DROP TABLE users; --"]);
    expect(v[0]).toBe(`CREATE OR REPLACE TEMP VIEW applications AS SELECT * FROM public.applications WHERE owner_user_id = ANY(ARRAY['${U1}']::uuid[])`);
    expect(v.join(" ")).not.toContain("DROP TABLE");
    expect(viewSql([])[1]).toContain("ARRAY[]::uuid[]");
  });

  it("canSeeRecord reads nothing for All and checks the owner otherwise", async () => {
    const db = fakeDb({ visible: [U3] });
    expect(await canSeeRecord(db, ALL_SCOPE, "contact", "whatever")).toBe(true);
    expect(db.sqls).toEqual([]);
    const own = { mode: "restricted", visibility: "own", userId: U1, ownerIds: [U1] } as const;
    expect(await canSeeRecord(db, own, "contact", U3)).toBe(true);
    expect(await canSeeRecord(db, own, "contact", U2)).toBe(false);
    expect(await canSeeRecord(db, own, "contact", "not-a-uuid")).toBe(false);
  });
});

describe("recordGuard", () => {
  function app(opts: Opts) {
    const a = express();
    a.use((req, _res, next) => { (req as any).user = { userId: U1, id: U1, role: "Staff" }; next(); });
    const crm = express.Router();
    crm.use(recordGuard(CRM_RULES, { db: fakeDb(opts) as any }));
    crm.get("/contacts/:id", (req, res) => res.json({ id: req.params.id }));
    crm.get("/contacts/:id/notes", (req, res) => res.json({ notes: [] }));
    crm.post("/contacts/bulk-tag", (_req, res) => res.json({ ok: true }));
    a.use("/api/crm", crm);
    const apps = express.Router();
    apps.use(recordGuard(APPLICATIONS_RULES, { db: fakeDb(opts) as any }));
    apps.get("/:id", (req, res) => res.json({ id: req.params.id }));
    apps.get("/:publicId/required-documents", (_req, res) => res.json({ public: true }));
    apps.get("/rejection-reasons", (_req, res) => res.json({ reasons: [] }));
    a.use("/api/applications", apps);
    return a;
  }

  it("answers 404 for a record the user may not see, on the record and everything under it", async () => {
    const a = app({ roleVis: "own", visible: [U3] });
    expect((await request(a).get(`/api/crm/contacts/${U3}`)).status).toBe(200);
    expect((await request(a).get(`/api/crm/contacts/${U2}`)).status).toBe(404);
    expect((await request(a).get(`/api/crm/contacts/${U2}/notes`)).status).toBe(404);
    expect((await request(a).get(`/api/applications/${U2}`)).status).toBe(404);
  });

  it("leaves list paths, named sub-paths and public routes alone", async () => {
    const a = app({ roleVis: "own", visible: [] });
    expect((await request(a).post(`/api/crm/contacts/bulk-tag`)).status).toBe(200);
    expect((await request(a).get(`/api/applications/rejection-reasons`)).status).toBe(200);
    expect((await request(a).get(`/api/applications/abc/required-documents`)).status).toBe(200);
  });

  it("changes nothing while everyone sees everything", async () => {
    const a = app({});
    expect((await request(a).get(`/api/crm/contacts/${U2}`)).status).toBe(200);
  });
});
