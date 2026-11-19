// KS_SERVER_TEAM_LIST_v1 - the owner made at set-up is on the Team list, and Add user keeps the name typed in.
import { describe, expect, it, vi, beforeEach } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", () => ({ pool: { query: queryMock }, db: { query: queryMock } }));
vi.mock("../../modules/auth/auth.service.js", () => ({ createUserAccount: vi.fn(async () => ({ id: "u-new" })) }));
vi.mock("../../staffDirectory/sync.js", () => ({ requestStaffDirectorySync: vi.fn() }));
vi.mock("../../middleware/silo.js", () => ({ getSilo: () => "BF" }));

import { createFirstAdmin } from "../provision.js";
import { createUser, listUsers } from "../../services/users.service.js";

function fakeRes() {
  const res: any = { locals: {}, statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}
const sqls = () => queryMock.mock.calls.map((c) => [String(c[0]), (c[1] ?? []) as unknown[]] as const);

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string, params?: unknown[]) =>
    /^\s*INSERT INTO users/.test(sql) ? { rows: [{ id: (params ?? [])[0] }], rowCount: 1 } : { rows: [], rowCount: 0 });
});

describe("Team and roles", () => {
  it("the owner made at set-up is given the BF silo", async () => {
    await createFirstAdmin({ query: queryMock }, { name: "Ana Acme", email: "ana@acme.example", phone: "4035550123" });
    const insert = sqls().find(([s]) => /INSERT INTO users/.test(s))!;
    expect(insert[0]).toMatch(/silo, silos\)[\s\S]*'BF', ARRAY\['BF'\]::text\[\]/);
  });

  it("the list includes Admins and people with no silo", async () => {
    const res = fakeRes();
    await listUsers({ query: {} } as never, res);
    const list = sqls().find(([s]) => /FROM users/.test(s))!;
    expect(list[0]).toContain("OR silo IS NULL OR role = 'Admin'");
    expect(res.body).toEqual({ users: [] });
  });

  it("Add user stores the first and last name", async () => {
    const res = fakeRes();
    await createUser({ body: { first_name: "Test", last_name: "Broker", email: "t@example.com", phone: "4035550143", role: "Staff" }, get: () => undefined, user: { userId: "admin" } } as never, res);
    expect(res.statusCode).toBe(201);
    const upd = sqls().find(([s]) => /UPDATE users SET silo/.test(s))!;
    expect(upd[0]).toContain("first_name = COALESCE($4, first_name)");
    expect(upd[1].slice(2)).toEqual(["u-new", "Test", "Broker"]);
  });
});
