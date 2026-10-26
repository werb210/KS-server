// KS_SERVER_v15_PROVISION - calls from KS-Ops automatic provisioning (X-KS-Ops-Key = KS_OPS_KEY, like PUT /api/plan).
//   POST /api/provision/admin           { name, email, phone } - creates this copy's first Admin when no user has that
//                                       email or mobile; an existing user is never changed. 201 { created: true } or
//                                       200 { created: false }.
//   GET  /api/provision/teardown-check  whether KS-Ops may delete this copy's Azure resources: only when the copy is
//                                       cancelled, the cancellation purge ran, nothing is left in the retention archive
//                                       (KS_SERVER_v14_RETENTION) and no legal hold is open. Never deletes anything.
//   POST /api/provision/phone-numbers   { area_code?, region?, country? } - KS_SERVER_PHONE_PROVISIONING: buys this
//                                       copy's business line (every plan) and toll-free line (growth and up) through
//                                       its own Twilio account, once each. 200 { ok, results: [{ kind, status, number?,
//                                       error?, message? }] }; 503 twilio_not_configured / server_url_not_set.
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { pool } from "../db.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { opsKeyMatches } from "./plan.js";
import { provisionMainLines } from "../phone/numbers.js"; // KS_SERVER_PHONE_PROVISIONING
import { liveTwilioNumbersApi, type TwilioNumbersApi } from "../phone/twilioNumbers.js";

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

// KS_SERVER_PHONE_PROVISIONING - tests swap the Twilio client for a fake.
let numbersApi: () => TwilioNumbersApi = () => liveTwilioNumbersApi();
export function setProvisionNumbersApiForTests(f: (() => TwilioNumbersApi) | null): void {
  numbersApi = f ?? (() => liveTwilioNumbersApi());
}

router.post("/phone-numbers", safeHandler(async (req: any, res) => {
  if (!opsAuthorized(req, res)) return;
  const b = req.body ?? {};
  const actor = `ks-ops ${String(req.headers["x-ks-ops-user"] ?? "provisioning").slice(0, 80)}`;
  const r = await provisionMainLines(db(), numbersApi(), { area_code: b.area_code, region: b.region, country: b.country, actor });
  if (!r.ok) {
    console.error("[provision] phone numbers not set up", { error: r.error, message: r.message });
    const { status, ...body } = r;
    return res.status(status).json(body);
  }
  for (const x of r.results.filter((y) => y.status === "failed")) console.error("[provision] phone number not bought", x);
  return res.json(r);
}));

router.get("/teardown-check", safeHandler(async (req: any, res) => {
  if (!opsAuthorized(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  return res.json(await teardownCheck(db()));
}));

export default router;
