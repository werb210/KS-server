// KS_SERVER_TEAM_IMPORT_v1
import { describe, expect, it, vi } from "vitest";
import { importTeam, previewImport, sendInvites } from "../teamImport.js";

function fakeDb(existingEmails: string[] = []) {
  const users: Array<{ id: string; email: string; role: string; first_name: string; last_name: string; invited_at: Date | null }> = [];
  const query = vi.fn(async (sql: string, p: any[] = []) => {
    if (/COUNT\(\*\)::int AS seats/.test(sql)) return { rows: [{ seats: 2 + users.length }] };
    if (/SELECT id, role FROM users/.test(sql)) {
      if (existingEmails.includes(p[0])) return { rows: [{ id: "old-" + p[0], role: "Staff" }] };
      return { rows: users.filter((u) => u.email === p[0]).map((u) => ({ id: u.id, role: u.role })) };
    }
    if (/^\s*INSERT INTO users/.test(sql)) {
      users.push({ id: p[0], email: p[1], role: p[3], first_name: p[4], last_name: p[5], invited_at: null });
      return { rows: [{ id: p[0] }] };
    }
    if (/FROM users WHERE id::text = ANY/.test(sql)) {
      return { rows: users.filter((u) => p[0].includes(u.id)).map((u) => ({ id: u.id, email: u.email, role: u.role, name: `${u.first_name} ${u.last_name ?? ""}`.trim() })) };
    }
    if (/UPDATE users SET invited_at/.test(sql)) {
      for (const u of users) if (p[0].includes(u.id)) u.invited_at = new Date();
      return { rows: [] };
    }
    throw new Error("unexpected SQL: " + sql);
  });
  return { query, users };
}
const env = { KS_OPS_URL: "https://ops.example", KS_LICENSEE_ID: "lic-1", KS_OPS_KEY: "k" } as any;
const opsOk = vi.fn(async (_url: string, init: any) => {
  const people = JSON.parse(init.body).people as Array<{ email: string }>;
  return { ok: true, status: 200, json: async () => ({ ok: true, results: people.map((x) => ({ email: x.email, sent: true })) }), text: async () => "" };
});
const rows = [
  { name: "Bea Broker", email: "bea@prairie.example", phone: "587-555-0101", role: "Broker" },
  { name: "Mo Marketer", email: "MO@prairie.example", phone: "587-555-0102", role: "Marketing" },
  { name: "Mo Again", email: "mo@prairie.example", phone: "587-555-0103", role: "Broker" },
  { name: "Old Hand", email: "old@prairie.example", phone: "587-555-0104", role: "Admin" },
  { name: "No Phone", email: "nophone@prairie.example", phone: "", role: "Broker" },
];

describe("team import", () => {
  it("previews each row and the seats without creating anyone", async () => {
    const db = fakeDb(["old@prairie.example"]);
    const p = await previewImport(db, rows);
    expect(p.rows.map((r) => r.status)).toEqual(["new", "new", "invalid", "existing", "invalid"]);
    expect(p.rows[2].error).toBe("duplicate_in_list");
    expect(p.rows[4].error).toBe("invalid_phone");
    expect(p).toMatchObject({ seats_before: 2, seats_after: 4 });
    expect(db.users).toHaveLength(0);
  });

  it("adds people without inviting them, then invites them later", async () => {
    const db = fakeDb();
    const r = await importTeam(db, rows.slice(0, 2), false, { env, fetchImpl: opsOk as any });
    expect(r.results.map((x) => x.status)).toEqual(["created", "created"]);
    expect(db.users.every((u) => u.invited_at === null)).toBe(true);
    expect(opsOk).not.toHaveBeenCalled();
    const s = await sendInvites(db, db.users.map((u) => u.id), { env, fetchImpl: opsOk as any });
    expect(s).toMatchObject({ ok: true, failed: [] });
    expect(opsOk.mock.calls[0][0]).toBe("https://ops.example/api/licensees/lic-1/team/invite");
    expect(JSON.parse(opsOk.mock.calls[0][1].body).people).toEqual([
      { full_name: "Bea Broker", email: "bea@prairie.example", role: "Broker" },
      { full_name: "Mo Marketer", email: "mo@prairie.example", role: "Marketing" },
    ]);
    expect(db.users.every((u) => u.invited_at)).toBe(true);
  });

  it("invites straight away when asked, and says when the link to Keystone operations is missing", async () => {
    const db = fakeDb();
    const r = await importTeam(db, rows.slice(0, 1), true, { env, fetchImpl: opsOk as any });
    expect(r.results[0]).toMatchObject({ status: "created", invited: true });
    const db2 = fakeDb();
    const r2 = await importTeam(db2, rows.slice(0, 1), true, { env: {} as any });
    expect(r2.invite_error).toBe("ops_not_configured");
    expect(db2.users[0].invited_at).toBeNull();
  });
});
