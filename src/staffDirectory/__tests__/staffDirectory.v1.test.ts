// KS_STAFF_DIRECTORY_v1 - the staff list (hashes only) sent to Keystone operations so the apps find this server from a
// staff member's email or mobile number. The database fake answers by SQL content, not call order.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectStaffEntries, normalizeStaffEmail, requestStaffDirectorySync, NUDGE_DELAY_MS, normalizeStaffPhone, resetStaffDirectoryState, staffHash, syncStaffDirectory,
  REFRESH_MS, STAFF_DIRECTORY_ROLES,
} from "../sync.js";

vi.mock("../../db.js", () => ({
  pool: { query: async (sql: string) => (/FROM users/.test(sql) ? { rows: [{ email: "nora@northwind.example", phone: null, phone_number: null }] } : { rows: [] }) },
}));

const ENV = { KS_OPS_URL: "https://ops.example.test/", KS_LICENSEE_ID: "22222222-2222-4222-8222-222222222222", KS_OPS_KEY: "ksops_key" } as NodeJS.ProcessEnv;

function fakeDb(rows: any[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (/FROM users/.test(sql)) return { rows };
      return { rows: [] };
    },
  };
}

function fakeFetch(status = 200) {
  return vi.fn(async (_url: string, _init: { method: string; headers: Record<string, string>; body: string }) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ ok: true }),
    text: async () => "",
  }));
}

beforeEach(() => resetStaffDirectoryState());
afterEach(() => vi.restoreAllMocks());

describe("hashes", () => {
  it("match the fixed contract values KS-Ops computes", () => {
    expect(staffHash("email", "nora@northwind.example")).toBe("d2f1c3c7ce6f2c79187ee4bb29fcf12488246d279737c63da990bc1ec52e0908");
    expect(staffHash("phone", "+14035550199")).toBe("93e9f54d950427884c886309172cba9014f563a4da87ff8b1529d8fef6610766");
  });

  it("normalise emails and North American numbers", () => {
    expect(normalizeStaffEmail(" Nora@NorthWind.Example ")).toBe("nora@northwind.example");
    expect(normalizeStaffEmail("nope")).toBeNull();
    expect(normalizeStaffPhone("(403) 555-0199")).toBe("+14035550199");
    expect(normalizeStaffPhone("+1 403 555 0199")).toBe("+14035550199");
    expect(normalizeStaffPhone("555-0199")).toBeNull();
  });
});

describe("collectStaffEntries", () => {
  it("takes active staff only, both phone columns, without repeats", async () => {
    const db = fakeDb([
      { email: "Nora@northwind.example", phone: "4035550199", phone_number: "+14035550199" },
      { email: "nora@northwind.example", phone: null, phone_number: null },
      { email: "bad", phone: "123", phone_number: null },
    ]);
    const entries = await collectStaffEntries(db);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.kind).sort()).toEqual(["email", "phone"]);
    const sql = db.calls[0]!.sql;
    expect(sql).toMatch(/COALESCE\(active, true\) = true/);
    expect(sql).toMatch(/COALESCE\(disabled, false\) = false/);
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(db.calls[0]!.params[0]).toEqual(STAFF_DIRECTORY_ROLES);
    expect(STAFF_DIRECTORY_ROLES).not.toContain("Lender");
    expect(STAFF_DIRECTORY_ROLES).not.toContain("Referrer");
  });
});

describe("syncStaffDirectory", () => {
  const rows = [{ email: "nora@northwind.example", phone: "4035550199", phone_number: null }];

  it("does nothing without the operations link", async () => {
    const f = fakeFetch();
    expect(await syncStaffDirectory(fakeDb(rows), { env: {} as NodeJS.ProcessEnv, fetchImpl: f as any })).toEqual({ pushed: false, reason: "ops_not_configured" });
    expect(f).not.toHaveBeenCalled();
  });

  it("sends hashes only, with the ops key, and skips an unchanged list until the refresh time", async () => {
    const f = fakeFetch();
    const db = fakeDb(rows);
    const r1 = await syncStaffDirectory(db, { env: ENV, fetchImpl: f as any, now: 1_000 });
    expect(r1).toEqual({ pushed: true, count: 2 });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`https://ops.example.test/api/licensees/${ENV.KS_LICENSEE_ID}/staff-directory`);
    expect(init.headers["X-KS-Ops-Key"]).toBe("ksops_key");
    expect(init.body).not.toMatch(/northwind|4035550199/);
    expect(JSON.parse(init.body).entries).toContainEqual({ kind: "email", hash: staffHash("email", "nora@northwind.example") });

    expect(await syncStaffDirectory(db, { env: ENV, fetchImpl: f as any, now: 2_000 })).toEqual({ pushed: false, reason: "unchanged", count: 2 });
    expect((await syncStaffDirectory(db, { env: ENV, fetchImpl: f as any, now: 1_000 + REFRESH_MS })).pushed).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("sends again as soon as the list changes", async () => {
    const f = fakeFetch();
    await syncStaffDirectory(fakeDb(rows), { env: ENV, fetchImpl: f as any, now: 1_000 });
    const r = await syncStaffDirectory(fakeDb([...rows, { email: "new@northwind.example", phone: null, phone_number: null }]), { env: ENV, fetchImpl: f as any, now: 2_000 });
    expect(r).toEqual({ pushed: true, count: 3 });
  });

  it("reports a failed push and tries again next time", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = fakeDb(rows);
    const r = await syncStaffDirectory(db, { env: ENV, fetchImpl: fakeFetch(503) as any, now: 1_000 });
    expect(r).toMatchObject({ pushed: false, reason: "failed" });
    expect((await syncStaffDirectory(db, { env: ENV, fetchImpl: fakeFetch() as any, now: 2_000 })).pushed).toBe(true);
  });
});

describe("requestStaffDirectorySync", () => {
  it("turns a burst of user changes into one push a few seconds later", async () => {
    vi.useFakeTimers();
    const f = fakeFetch();
    vi.stubGlobal("fetch", f);
    try {
      requestStaffDirectorySync(ENV);
      requestStaffDirectorySync(ENV);
      requestStaffDirectorySync(ENV);
      expect(f).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(NUDGE_DELAY_MS + 50);
      await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1));
      expect(String(f.mock.calls[0]![0])).toMatch(/\/staff-directory$/);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("does nothing without the operations link", () => {
    vi.useFakeTimers();
    try {
      requestStaffDirectorySync({} as NodeJS.ProcessEnv);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
