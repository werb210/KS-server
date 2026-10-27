// KS_SERVER_v20_TEAMS - who may see which contacts, companies and applications.
//
// Each staff user sees All records, their Team's records, or their Own records only:
//   effective = users.record_visibility (per-user override) ?? role_record_visibility[role] ?? "all".
// Admins always see everything. When the plan in force does not include "teams" (Starter), everyone sees everything,
// whatever is stored, so a downgrade never hides data.
//   own:  contacts.owner_id / companies.owner_id / applications.owner_user_id (the assigned staff) is the user.
//   team: that owner is the user or anyone who shares an (unarchived) team with the user.
// Records with no owner are visible only to users who see all records.
//
// Every server path that returns contacts, companies or applications to staff applies this (see
// src/visibility/README in the KS_SERVER_v20 report for the list): list and search SQL take ownerFilterSql(), single
// records go through canSeeRecord() / recordGuard(), reports and the dashboard run inside runScoped() (temp views),
// and the assistant's staff tools resolve the acting user from staff_user_id.
import type { Request } from "express";
import { checkFeature } from "../plans/catalogue.js";
import { getPlanState, type Q } from "../plans/state.js";

export const VISIBILITIES = ["all", "team", "own"] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const CONFIGURABLE_ROLES = ["Staff", "Ops", "Marketing"] as const;

export type RecordKind = "contact" | "company" | "application";

export type RecordScope =
  | { mode: "all"; visibility: "all"; userId: string | null }
  | { mode: "restricted"; visibility: "team" | "own"; userId: string | null; ownerIds: string[]; teamFilter?: boolean };

export const ALL_SCOPE: RecordScope = { mode: "all", visibility: "all", userId: null };
/** Fail-closed scope: an acting user we cannot identify while restrictions apply sees nothing. */
export const NOTHING_SCOPE: RecordScope = { mode: "restricted", visibility: "own", userId: null, ownerIds: [] };

export function isVisibility(v: unknown): v is Visibility {
  return typeof v === "string" && (VISIBILITIES as readonly string[]).includes(v);
}

const OWNER_COLUMN: Record<RecordKind, string> = { contact: "owner_id", company: "owner_id", application: "owner_user_id" };
const TABLE: Record<RecordKind, { table: string; idCast: string }> = {
  contact: { table: "contacts", idCast: "uuid" },
  company: { table: "companies", idCast: "uuid" },
  application: { table: "applications", idCast: "text" },
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function roleOf(role: unknown): string {
  const r = String(role ?? "").trim().toLowerCase();
  return r ? r[0].toUpperCase() + r.slice(1) : "";
}

function isMissingRelation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42P01" || code === "42703";
}

const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; scope: RecordScope }>();
/** Called after any change to teams, members or visibility settings. Other instances catch up within 15 s. */
export function clearVisibilityCache(): void {
  cache.clear();
}

/** Does the plan in force include teams? (false -> every user sees every record) */
export async function teamsInPlan(db: Q): Promise<boolean> {
  return checkFeature(await getPlanState(db), "teams").allowed;
}

/** The scope for a staff user by id and role. Unknown users (service principals) see everything. */
export async function resolveScope(db: Q, userId: string | null | undefined, role: unknown): Promise<RecordScope> {
  const r = roleOf(role);
  if (r === "Admin") return { ...ALL_SCOPE, userId: userId ?? null };
  if (!(await teamsInPlan(db))) return { ...ALL_SCOPE, userId: userId ?? null };
  if (!userId || !UUID_RE.test(userId)) return resolveRoleOnlyScope(db, r);
  const key = `${userId}|${r}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.scope;
  let scope: RecordScope;
  try {
    const row = (await db.query(
      `SELECT u.record_visibility, (SELECT visibility FROM role_record_visibility WHERE role = $2) AS role_visibility, u.id IS NOT NULL AS found
         FROM (SELECT $1::uuid AS want) w LEFT JOIN users u ON u.id = w.want`,
      [userId, r],
    ))?.rows?.[0];
    const v: Visibility = isVisibility(row?.record_visibility) ? row.record_visibility
      : isVisibility(row?.role_visibility) ? row.role_visibility : "all";
    if (v === "all") scope = { mode: "all", visibility: "all", userId };
    else if (v === "own") scope = { mode: "restricted", visibility: "own", userId, ownerIds: [userId] };
    else {
      const members = await db.query(
        `SELECT DISTINCT m2.user_id::text AS id
           FROM sales_team_members m1
           JOIN sales_teams t ON t.id = m1.team_id AND t.archived_at IS NULL
           JOIN sales_team_members m2 ON m2.team_id = m1.team_id
          WHERE m1.user_id = $1`,
        [userId],
      );
      const ids = new Set<string>([userId, ...(members?.rows ?? []).map((x: any) => String(x.id))]);
      scope = { mode: "restricted", visibility: "team", userId, ownerIds: [...ids] };
    }
  } catch (err) {
    // Before the migration ran nothing can be restricted. Any other failure is a real error: never fail open.
    if (!isMissingRelation(err)) throw err;
    scope = { mode: "all", visibility: "all", userId };
  }
  cache.set(key, { at: Date.now(), scope });
  return scope;
}

/** A caller that names a role but no user (the assistant without staff_user_id): all if the role sees all, else nothing. */
export async function resolveRoleOnlyScope(db: Q, role: unknown): Promise<RecordScope> {
  const r = roleOf(role);
  if (r === "Admin") return ALL_SCOPE;
  if (!(await teamsInPlan(db))) return ALL_SCOPE;
  try {
    const row = (await db.query(`SELECT visibility FROM role_record_visibility WHERE role = $1`, [r]))?.rows?.[0];
    const anyUserOverride = (await db.query(
      `SELECT EXISTS (SELECT 1 FROM users WHERE record_visibility IN ('team', 'own') AND lower(COALESCE(role, '')) = lower($1)) AS x`, [r],
    ))?.rows?.[0]?.x === true;
    const v = isVisibility(row?.visibility) ? row.visibility : "all";
    return v === "all" && !anyUserOverride ? ALL_SCOPE : NOTHING_SCOPE;
  } catch (err) {
    if (!isMissingRelation(err)) throw err;
    return ALL_SCOPE;
  }
}

/**
 * The scope of the request's user, cached on the request. Service principals (no users row) see everything; the
 * assistant's staff routes resolve their acting user with scopeForActingUser instead.
 */
export async function scopeForRequest(req: Request, db: Q): Promise<RecordScope> {
  const anyReq = req as any;
  if (anyReq.__recordScope) return anyReq.__recordScope as RecordScope;
  const u = anyReq.user ?? {};
  let scope: RecordScope;
  if (u.isServicePrincipal || u.actorResolved === false) scope = ALL_SCOPE;
  else scope = await resolveScope(db, String(u.userId ?? u.id ?? u.sub ?? "") || null, u.role);
  anyReq.__recordScope = scope;
  return scope;
}

/** The assistant acting for a staff member: by staff_user_id when given, else by the (verified) role it stamps. */
export async function scopeForActingUser(db: Q, body: any): Promise<RecordScope> {
  const id = typeof body?.staff_user_id === "string" ? body.staff_user_id.trim() : typeof body?.user_id === "string" ? body.user_id.trim() : "";
  if (id && UUID_RE.test(id)) {
    const row = (await db.query(`SELECT role FROM users WHERE id = $1`, [id]).catch((err: unknown) => {
      if (isMissingRelation(err)) return { rows: [] };
      throw err;
    })).rows[0];
    if (row) return resolveScope(db, id, row.role);
  }
  return resolveRoleOnlyScope(db, body?.role ?? "Staff");
}

/**
 * SQL condition limiting `alias` (a contacts / companies / applications row) to the scope. Appends its parameter.
 * "TRUE" when the scope sees everything.
 */
export function ownerFilterSql(scope: RecordScope, kind: RecordKind, alias: string, params: unknown[]): string {
  if (scope.mode === "all") return "TRUE";
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error("bad alias");
  if (!scope.ownerIds.length) return "FALSE";
  params.push(scope.ownerIds);
  return `${alias}.${OWNER_COLUMN[kind]} = ANY($${params.length}::uuid[])`;
}

/** Owner ids of a team's members (for the team filter in reports and the pipeline). [] for an unknown team. */
export async function teamOwnerIds(db: Q, teamId: string): Promise<string[]> {
  if (!UUID_RE.test(teamId)) return [];
  const r = await db.query(
    `SELECT m.user_id::text AS id FROM sales_team_members m JOIN sales_teams t ON t.id = m.team_id WHERE m.team_id = $1`, [teamId],
  );
  return r.rows.map((x: any) => String(x.id));
}

/** The scope narrowed to a team's members (a filter, so it can only ever hide more). */
export function narrowToOwners(scope: RecordScope, ownerIds: string[]): RecordScope {
  const set = new Set(ownerIds);
  if (scope.mode === "all") return { mode: "restricted", visibility: "team", userId: scope.userId, ownerIds: [...set], teamFilter: true };
  return { ...scope, ownerIds: scope.ownerIds.filter((id) => set.has(id)), teamFilter: true };
}

/** Is one record visible? Records that do not exist are "not visible" (the caller answers 404 either way). */
export async function canSeeRecord(db: Q, scope: RecordScope, kind: RecordKind, id: string): Promise<boolean> {
  if (scope.mode === "all") return true;
  const { table, idCast } = TABLE[kind];
  if (idCast === "uuid" && !UUID_RE.test(id)) return false;
  const params: unknown[] = [id];
  const cond = ownerFilterSql(scope, kind, "r", params);
  const r = await db.query(`SELECT 1 FROM ${table} r WHERE r.id = $1::${idCast} AND ${cond} LIMIT 1`, params);
  return r.rows.length > 0;
}

/** The ids among `ids` this scope may see (keeps order). */
export async function visibleIds(db: Q, scope: RecordScope, kind: RecordKind, ids: string[]): Promise<Set<string>> {
  const clean = [...new Set(ids.filter(Boolean).map(String))];
  if (scope.mode === "all") return new Set(clean);
  if (!clean.length) return new Set();
  const { table, idCast } = TABLE[kind];
  const usable = idCast === "uuid" ? clean.filter((x) => UUID_RE.test(x)) : clean;
  if (!usable.length) return new Set();
  const params: unknown[] = [usable];
  const cond = ownerFilterSql(scope, kind, "r", params);
  const r = await db.query(`SELECT r.id::text AS id FROM ${table} r WHERE r.id::text = ANY($1::text[]) AND ${cond}`, params);
  return new Set(r.rows.map((x: any) => String(x.id)));
}
