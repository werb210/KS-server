// KS_SERVER_TEAM_IMPORT_v1 - Settings > Users: bring in a whole team at once (a CSV, or rows pasted from Excel), and
// invite people now, later, or a few at a time. People are created exactly as the sign-up roster is
// (createTeamUser: a person already here by email or mobile is never changed), and the invite email itself is sent by
// Keystone operations (POST /api/licensees/:id/team/invite), the same invite and quick guide as at sign-up.
import { createTeamUser, MAX_TEAM_USERS } from "../routes/provision.js";
import { SEATS_SQL } from "../plans/storage.js";
import { postToOps, type OpsFetch } from "../plans/opsLink.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
export const MAX_IMPORT = MAX_TEAM_USERS;

export type ImportRow = { name?: unknown; email?: unknown; phone?: unknown; role?: unknown };
export type ImportResult = { email: string; status: "created" | "existing" | "invalid"; user_id?: string; error?: string; invited?: boolean };
type Opts = { fetchImpl?: OpsFetch; env?: NodeJS.ProcessEnv };

const OPS_ROLE: Record<string, "Broker" | "Marketing" | "Admin"> = { Staff: "Broker", Marketing: "Marketing", Admin: "Admin" };

async function seats(db: Q): Promise<number> {
  return Number((await db.query(SEATS_SQL)).rows[0]?.seats ?? 0) || 0;
}

/** Asks Keystone operations to email each person their invite; marks the ones sent. */
export async function sendInvites(db: Q, userIds: string[], opts: Opts = {}):
  Promise<{ ok: true; sent: string[]; failed: Array<{ user_id: string; error: string }> } | { ok: false; error: string }> {
  if (!userIds.length) return { ok: true, sent: [], failed: [] };
  const { rows } = await db.query(
    `SELECT id::text AS id, email, role, trim(concat_ws(' ', first_name, last_name)) AS name
       FROM users WHERE id::text = ANY($1::text[]) AND deleted_at IS NULL`,
    [userIds],
  );
  const failed: Array<{ user_id: string; error: string }> = [];
  const people: Array<{ user_id: string; full_name: string; email: string; role: "Broker" | "Marketing" | "Admin" }> = [];
  for (const id of userIds) {
    const u = rows.find((r) => r.id === id);
    if (!u) { failed.push({ user_id: id, error: "not_found" }); continue; }
    if (!u.email) { failed.push({ user_id: id, error: "no_email" }); continue; }
    people.push({ user_id: id, full_name: u.name || String(u.email).split("@")[0], email: String(u.email).toLowerCase(), role: OPS_ROLE[String(u.role)] ?? "Broker" });
  }
  if (!people.length) return { ok: true, sent: [], failed };
  const sent: string[] = [];
  for (let i = 0; i < people.length; i += 100) {
    const chunk = people.slice(i, i + 100);
    const r = await postToOps("team/invite", { people: chunk.map(({ full_name, email, role }) => ({ full_name, email, role })) }, opts);
    if (!r.ok) {
      console.error("[team-import] invites not sent", { error: r.error, people: chunk.length });
      if (r.error === "ops_not_configured") return { ok: false, error: "ops_not_configured" };
      for (const p of chunk) failed.push({ user_id: p.user_id, error: "invite_failed" });
      continue;
    }
    const results: Array<{ email: string; sent: boolean }> = Array.isArray(r.body?.results) ? r.body.results : [];
    for (const p of chunk) {
      if (results.find((x) => String(x.email).toLowerCase() === p.email)?.sent) sent.push(p.user_id);
      else failed.push({ user_id: p.user_id, error: "invite_failed" });
    }
  }
  if (sent.length) await db.query(`UPDATE users SET invited_at = now() WHERE id::text = ANY($1::text[])`, [sent]);
  return { ok: true, sent, failed };
}

/** Checks a list without creating anyone: what would happen to each row, and the seats before and after. */
export async function previewImport(db: Q, rows: ImportRow[]) {
  const before = await seats(db);
  const dry: Q = { query: async (sql, p) => (/^\s*INSERT/i.test(sql) ? { rows: [{ id: "preview" }] } : db.query(sql, p)) };
  const out: Array<{ email: string; status: "new" | "existing" | "invalid"; error?: string }> = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const email = String(r.email ?? "").trim().toLowerCase();
    if (email && seen.has(email)) { out.push({ email, status: "invalid", error: "duplicate_in_list" }); continue; }
    seen.add(email);
    const v = await createTeamUser(dry, r);
    out.push(v.status === "created" ? { email, status: "new" } : v.status === "existing" ? { email, status: "existing" } : { email, status: "invalid", error: v.error });
  }
  const added = out.filter((x) => x.status === "new").length;
  return { rows: out, seats_before: before, seats_after: before + added };
}

export async function importTeam(db: Q, rows: ImportRow[], invite: boolean, opts: Opts = {}) {
  const before = await seats(db);
  const results: ImportResult[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const email = String(r.email ?? "").trim().toLowerCase();
    if (email && seen.has(email)) { results.push({ email, status: "invalid", error: "duplicate_in_list" }); continue; }
    seen.add(email);
    results.push(await createTeamUser(db, r));
  }
  const created = results.filter((x) => x.status === "created" && x.user_id).map((x) => x.user_id!);
  let inviteError: string | null = null;
  if (invite && created.length) {
    const s = await sendInvites(db, created, opts);
    if (!s.ok) inviteError = s.error;
    else for (const x of results) if (x.user_id && s.sent.includes(x.user_id)) x.invited = true;
  }
  return { results, seats_before: before, seats_after: await seats(db), invite_error: inviteError };
}
