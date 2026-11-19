// KS_SERVER_TEAM_LIST_v1 - the owner made at set-up is on the Team list, and Add user keeps the name typed in.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", () => ({ pool: { query: queryMock }, db: { query: queryMock } }));

import { createFirstAdmin, createTeamUser } from "../provision.js";

describe("people made at set-up get the brokerage's one silo", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) =>
      /^\s*INSERT INTO users/.test(sql) ? { rows: [{ id: (params ?? [])[0] }], rowCount: 1 } : { rows: [], rowCount: 0 });
  });

  it("the owner and the sign-up team are inserted with silo BF", async () => {
    await createFirstAdmin({ query: queryMock }, { name: "Ana Acme", email: "ana@acme.example", phone: "4035550123" });
    await createTeamUser({ query: queryMock } as never, { name: "Bo Broker", email: "bo@acme.example", phone: "4035550124", role: "broker" } as never);
    const inserts = queryMock.mock.calls.map((c) => String(c[0])).filter((s) => /INSERT INTO users/.test(s));
    expect(inserts.length).toBeGreaterThanOrEqual(1);
    for (const sql of inserts) expect(sql).toMatch(/silo, silos\)[\s\S]*'BF', ARRAY\['BF'\]::text\[\]/);
  });
});

describe("Team and roles list and Add user (source)", () => {
  const src = readFileSync(new URL("../../services/users.service.ts", import.meta.url), "utf8");
  it("lists Admins and people without a silo", () => {
    expect(src).toContain("OR silo IS NULL OR role = 'Admin'");
  });
  it("Add user stores the first and last name", () => {
    const create = src.slice(src.indexOf("const createUserSchema"), src.indexOf("type UserRecord"));
    expect(create).toContain("first_name: z.string()");
    expect(src).toContain("first_name = COALESCE($4, first_name), last_name = COALESCE($5, last_name)");
  });
  it("a migration gives existing people the BF silo", () => {
    const sql = readFileSync(new URL("../../../migrations/2026_12_10_users_default_silo.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/UPDATE users SET silo = 'BF' WHERE silo IS NULL/);
  });
});
