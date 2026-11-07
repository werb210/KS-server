// KS_SERVER_v15_PROVISION - calls from KS-Ops automatic provisioning (X-KS-Ops-Key = KS_OPS_KEY, like PUT /api/plan).
//   POST /api/provision/admin           { name, email, phone } - creates this copy's first Admin when no user has that
//                                       email or mobile; an existing user is never changed. 201 { created: true } or
//                                       200 { created: false }.
//   POST /api/provision/users           { users: [{ name, email, phone, role }] } - KS_SERVER_PROVISION_TEAM_USERS_v1:
//                                       the brokerage's team from the sign-up roster. Same key and checks as /admin;
//                                       role Broker (KS's name for Staff), Marketing or Admin. A person already here
//                                       (same email or mobile) is never changed, so a repeat is a no-op.
//                                       200 { ok, results: [{ email, status: created|existing|invalid, user_id?, error? }] }.
//   GET  /api/provision/teardown-check  whether KS-Ops may delete this copy's Azure resources: only when the copy is
//                                       cancelled, the cancellation purge ran, nothing is left in the retention archive
//                                       (KS_SERVER_v14_RETENTION) and no legal hold is open. Never deletes anything.
//   POST /api/provision/phone-numbers   { area_code?, region?, country? } - KS_SERVER_PHONE_PROVISIONING: buys this
//                                       copy's business line (every plan) and toll-free line (growth and up) through
//                                       its own Twilio account, once each. 200 { ok, results: [{ kind, status, number?,
//                                       error?, message? }] }; 503 twilio_not_configured / server_url_not_set.
//                                       KS_SERVER_TEXTING_REGISTRATION: address_sid / bundle_sid (AD... / BU...) that
//                                       KS-Ops registered are kept for every later purchase too.
//   PUT  /api/provision/texting         { registrations: [{ kind, status, phone_number?, reason?, message? }] } -
//                                       KS_SERVER_TEXTING_REGISTRATION: toll-free verification / A2P 10DLC status, for
//                                       Settings > Phone lines and for where texts to US mobiles may go from.
//   POST /api/provision/ported-numbers  { port_request_id, grace_days?, numbers: [{ phone_number, number_type, user_id?,
//                                       temporary_number? }] } - KS_SERVER_NUMBER_PORTING_v1: a transfer finished; each
//                                       number is found in this copy's Twilio account, pointed at this server and given to
//                                       its person (direct line) or made the main / toll-free line; the temporary number
//                                       is released after grace_days (default 7). 200 { ok, results: [{ phone_number,
//                                       status: attached|already_attached|failed, released?, error?, message? }] }.
//   GET  /api/provision/connections     KS_SERVER_M365_ONE_CLICK: whether the brokerage connected Microsoft 365 / Google
//                                       Workspace, for KS-Ops's provisioning page. No names or email addresses.
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { pool } from "../db.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { opsKeyMatches } from "./plan.js";
import { provisionMainLines } from "../phone/numbers.js"; // KS_SERVER_PHONE_PROVISIONING
import { attachPortedNumber } from "../phone/porting.js"; // KS_SERVER_NUMBER_PORTING_v1
import { liveTwilioNumbersApi, type TwilioNumbersApi } from "../phone/twilioNumbers.js";
import { saveCompliance, saveTexting } from "../phone/textingState.js"; // KS_SERVER_TEXTING_REGISTRATION
import { opsConnectionsView } from "../licensee/workspaceConnections.js"; // KS_SERVER_M365_ONE_CLICK

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
const db = () => pool as unknown as Q;

function opsAuthorized(req: any, res: any): boolean {
  if (!String(process.env.KS_OPS_KEY ?? "")) { res.status(403).json({ ok: false, error: "ops_link_disabled" }); return false; }
  if (!opsKeyMatches(req.headers["x-ks-ops-key"])) { res.status(401).json({ ok: false, error: "invalid_ops_key" }); return false; }
  return true;
}

/** A North American mobile number as +1XXXXXXXXXX, or any other number already in E.164; null when unusable. */
export function e164(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (s.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function createFirstAdmin(q: Q, input: { name?: unknown; email?: unknown; phone?: unknown })
  : Promise<{ ok: true; created: boolean; user_id: string; role: string | null } | { ok: false; error: string }> {
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return { ok: false, error: "invalid_email" };
  const phone = e164(input.phone);
  if (!phone) return { ok: false, error: "invalid_phone" };
  const parts = String(input.name ?? "").trim().split(/\s+/).filter(Boolean);
  const first = (parts[0] ?? "").slice(0, 100);
  const last = parts.slice(1).join(" ").slice(0, 100);
  const digits = phone.replace(/\D/g, "").slice(-10);
  const existing = await q.query(
    `SELECT id, role FROM users
      WHERE lower(email) = $1
         OR right(regexp_replace(coalesce(phone_number, ''), '[^0-9]', '', 'g'), 10) = $2
         OR right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = $2
      ORDER BY (lower(email) = $1) DESC LIMIT 1`,
    [email, digits],
  );
  if (existing.rows[0]) return { ok: true, created: false, user_id: String(existing.rows[0].id), role: existing.rows[0].role ?? null };
  const id = randomUUID();
  const inserted = await q.query(
    `INSERT INTO users (id, email, phone_number, phone, role, active, is_active, disabled, phone_verified, status, first_name, last_name)
     VALUES ($1, $2, $3, $3, $4, true, true, false, false, 'ACTIVE', $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [id, email, phone, ROLES.ADMIN, first || null, last || null],
  );
  if (!inserted.rows[0]) return { ok: false, error: "user_conflict" };
  return { ok: true, created: true, user_id: id, role: ROLES.ADMIN };
}

// KS_SERVER_PROVISION_TEAM_USERS_v1 - the roster roles KS-Ops sends. "Broker" is what Keystone calls the Staff role.
const TEAM_ROLES: Record<string, string> = {
  broker: ROLES.STAFF,
  staff: ROLES.STAFF,
  marketing: ROLES.MARKETING,
  admin: ROLES.ADMIN,
};
export const MAX_TEAM_USERS = 200;

export function teamRole(raw: unknown): string | null {
  return TEAM_ROLES[String(raw ?? "").trim().toLowerCase()] ?? null;
}

type TeamResult = { email: string; status: "created" | "existing" | "invalid"; user_id?: string; role?: string | null; error?: string };

/** Creates one roster member when nobody here has that email or mobile; an existing user is never changed. */
export async function createTeamUser(q: Q, input: { name?: unknown; email?: unknown; phone?: unknown; role?: unknown }): Promise<TeamResult> {
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return { email, status: "invalid", error: "invalid_email" };
  const phone = e164(input.phone);
  if (!phone) return { email, status: "invalid", error: "invalid_phone" };
  const role = teamRole(input.role);
  if (!role) return { email, status: "invalid", error: "invalid_role" };
  const parts = String(input.name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { email, status: "invalid", error: "invalid_name" };
  const first = (parts[0] ?? "").slice(0, 100);
  const last = parts.slice(1).join(" ").slice(0, 100);
  const digits = phone.replace(/\D/g, "").slice(-10);
  const existing = await q.query(
    `SELECT id, role FROM users
      WHERE lower(email) = $1
         OR right(regexp_replace(coalesce(phone_number, ''), '[^0-9]', '', 'g'), 10) = $2
         OR right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = $2
      ORDER BY (lower(email) = $1) DESC LIMIT 1`,
    [email, digits],
  );
  if (existing.rows[0]) return { email, status: "existing", user_id: String(existing.rows[0].id), role: existing.rows[0].role ?? null };
  const id = randomUUID();
  const inserted = await q.query(
    `INSERT INTO users (id, email, phone_number, phone, role, active, is_active, disabled, phone_verified, status, first_name, last_name)
     VALUES ($1, $2, $3, $3, $4, true, true, false, false, 'ACTIVE', $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [id, email, phone, role, first || null, last || null],
  );
  if (!inserted.rows[0]) return { email, status: "invalid", error: "user_conflict" };
  return { email, status: "created", user_id: id, role };
}

export async function createTeamUsers(q: Q, raw: unknown): Promise<{ ok: true; results: TeamResult[] } | { ok: false; error: string }> {
  const list = (raw as { users?: unknown })?.users;
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: "users_required" };
  if (list.length > MAX_TEAM_USERS) return { ok: false, error: "too_many_users" };
  const results: TeamResult[] = [];
  // One at a time, so two rows with the same email or mobile make one user.
  for (const u of list) results.push(await createTeamUser(q, (u ?? {}) as Record<string, unknown>));
  return { ok: true, results };
}

export async function teardownCheck(q: Q) {
  const plan = (await q.query(
    `SELECT service_status, purged_at, retention_archived_at, retention_released_at, retention_archive FROM licensee_plan WHERE id = 1`,
  )).rows[0] ?? null;
  const holdsTable = (await q.query(`SELECT to_regclass('public.legal_holds') IS NOT NULL AS present`)).rows[0]?.present === true;
  const holds = holdsTable ? Number((await q.query(`SELECT count(*)::int AS n FROM legal_holds WHERE released_at IS NULL`)).rows[0]?.n ?? 0) : 0;
  const archive = (await q.query(`SELECT to_regnamespace('retention_archive') IS NOT NULL AS present`)).rows[0]?.present === true;
  const keptUntil = plan?.retention_archive && typeof plan.retention_archive === "object" ? plan.retention_archive.kept_until ?? null : null;
  const status = String(plan?.service_status ?? "");
  let reason = "";
  if (status !== "cancelled") reason = `the service is ${status || "not set up"}, not cancelled`;
  else if (!plan?.purged_at) reason = "the cancellation purge has not run";
  else if (holds > 0) reason = `${holds} legal hold${holds === 1 ? " is" : "s are"} open`;
  else if (archive || (plan?.retention_archived_at && !plan?.retention_released_at)) reason = "records are still kept in the retention archive";
  return {
    ok: true,
    deletable: reason === "",
    reason: reason || "nothing is kept: the copy can be deleted",
    service_status: status || null,
    purged_at: plan?.purged_at ?? null,
    legal_holds: holds,
    retention_archive: archive,
    kept_until: reason ? keptUntil : null,
  };
}

const router = Router();

router.post("/admin", safeHandler(async (req: any, res) => {
  if (!opsAuthorized(req, res)) return;
  const r = await createFirstAdmin(db(), req.body ?? {});
  if (!r.ok) return res.status(r.error === "user_conflict" ? 409 : 400).json({ ok: false, error: r.error });
  console.log(`[provision] first admin ${r.created ? "created" : "already present"} (by ${String(req.headers["x-ks-ops-user"] ?? "ops").slice(0, 80)})`);
  return res.status(r.created ? 201 : 200).json(r);
}));

// KS_SERVER_PROVISION_TEAM_USERS_v1 - the sign-up roster (KS-Ops step team_users).
router.post("/users", safeHandler(async (req: any, res) => {
  if (!opsAuthorized(req, res)) return;
  const r = await createTeamUsers(db(), req.body ?? {});
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  const count = (s: string) => r.results.filter((x) => x.status === s).length;
  console.log(`[provision] team users: ${count("created")} created, ${count("existing")} already present, ${count("invalid")} refused (by ${String(req.headers["x-ks-ops-user"] ?? "ops").slice(0, 80)})`);
  return res.json(r);
}));

// KS_SERVER_PHONE_PROVISIONING - tests swap the Twilio client for a fake.
let numbersApi: () => TwilioNumbersApi = () => liveTwilioNumbersApi();
export function setProvisionNumbersApiForTests(f: (() => TwilioNumbersApi) | null): void {
  numbersApi = f ?? (() => liveTwilioNumbersApi());
}

router.post("/phone-numbers", safeHandler(async (req: any, res) => {
  if (!opsAuthorized(req, res)) return;
  const b = req.body ?? {};
  const actor = `ks-ops ${String(req.headers["x-ks-ops-user"] ?? "provisioning").slice(0, 80)}`;
  const comp = await saveCompliance(db(), { address_sid: b.address_sid, bundle_sid: b.bundle_sid }, actor);
  if (!comp.ok) return res.status(400).json({ ok: false, error: comp.error });
  const r = await provisionMainLines(db(), numbersApi(), { area_code: b.area_code, region: b.region, country: b.country, actor });
  if (!r.ok) {
    console.error("[provision] phone numbers not set up", { error: r.error, message: r.message });
    const { status, ...body } = r;
    return res.status(status).json(body);
  }
  for (const x of r.results.filter((y) => y.status === "failed")) console.error("[provision] phone number not bought", x);
  return res.json(r);
}));

// KS_SERVER_NUMBER_PORTING_v1 - KS-Ops marks a transfer complete.
router.post("/ported-numbers", safeHandler(async (req: any, res) => {
  if (!opsAuthorized(req, res)) return;
  const b = req.body ?? {};
  const list = Array.isArray(b.numbers) ? b.numbers.slice(0, 20) : [];
  if (!list.length) return res.status(400).json({ ok: false, error: "numbers_required" });
  const actor = `ks-ops ${String(req.headers["x-ks-ops-user"] ?? "porting").slice(0, 80)}`;
  const results: Array<Record<string, unknown>> = [];
  for (const n of list) {
    const r = await attachPortedNumber(db(), numbersApi(), {
      phone_number: n?.phone_number, number_type: n?.number_type, user_id: n?.user_id, temporary_number: n?.temporary_number,
      port_request_id: b.port_request_id, grace_days: b.grace_days, actor,
    });
    if (r.ok) results.push({ phone_number: r.number.phone_number, status: r.status, kind: r.number.kind, released: r.released, release_after: r.release_after });
    else {
      console.error("[provision] transferred number not attached", { phone_number: n?.phone_number, error: r.error, message: r.message });
      results.push({ phone_number: n?.phone_number ?? null, status: "failed", error: r.error, message: r.message });
    }
  }
  return res.json({ ok: true, results });
}));

router.put("/texting", safeHandler(async (req: any, res) => {
  if (!opsAuthorized(req, res)) return;
  const actor = `ks-ops ${String(req.headers["x-ks-ops-user"] ?? "texting").slice(0, 80)}`;
  const r = await saveTexting(db(), req.body ?? {}, actor);
  if (!r.ok) {
    console.error("[provision] texting status refused", { error: r.error });
    return res.status(400).json(r);
  }
  return res.json(r);
}));

router.get("/teardown-check", safeHandler(async (req: any, res) => {
  if (!opsAuthorized(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  return res.json(await teardownCheck(db()));
}));

// KS_SERVER_M365_ONE_CLICK - Microsoft 365 / Google Workspace connection state for KS-Ops.
router.get("/connections", safeHandler(async (req: any, res: any) => {
  if (!opsAuthorized(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, ...(await opsConnectionsView(pool)) });
}));

export default router;
