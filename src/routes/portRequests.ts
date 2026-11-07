// KS_SERVER_NUMBER_PORTING_v1 - "Keep your existing phone number" (Admins only). The set-up wizard's "Your phone
// numbers" step and Settings > Phone lines use these. Keystone operations (KS-Ops) keeps the requests: this router adds
// who is asking and each person's temporary Keystone number, and relays (POST {KS_OPS_URL}/api/licensees/{id}/...,
// X-KS-Ops-Key) - the same link as support tickets. Request bodies carry the carrier account number and PIN: they are
// never logged here and never stored in this copy's database.
//   GET  /api/port-requests                  { requests, people, main_line, ops_ready } - people = everyone with the
//                                            Keystone number calls to them go to now (their direct line or the main line)
//   POST /api/port-requests                  { carrier, carrier_other?, account_number, pin?, account_name,
//                                              service_address: { line1, line2?, city, region, postal_code, country },
//                                              numbers: [{ phone_number, number_type, user_id? }], bill: { filename,
//                                              content_type, data_base64 } } -> 201 { request, loa }
//   GET  /api/port-requests/:id/loa          the letter of authorization to sign (text, html, sha256, version)
//   POST /api/port-requests/:id/sign         { signer_name, signer_title, agree: true, sha256 } - click to sign
//   POST /api/port-requests/:id/forwarding   { phone_number, tested } - "I called my old number and it rang here"
//   POST /api/port-requests/:id/cancel       cancels a request that has not been submitted to the carrier
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { clientIpFromRequest } from "../middleware/clientIp.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import type { Q } from "../plans/state.js";
import { opsConfig, postToOps, type OpsFetch } from "../plans/opsLink.js";
import { brandName } from "../licensee/brand.js";
import { toE164 } from "../phone/numbers.js";
import { portingPeople } from "../phone/porting.js";

const db = () => pool as unknown as Q;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_BILL_BYTES = 7 * 1024 * 1024;
export const NOT_LINKED = "This server is not linked to Keystone operations yet (KS_OPS_URL, KS_LICENSEE_ID, KS_OPS_KEY), so number transfers cannot be requested. Ask Keystone support.";

let fetchImpl: OpsFetch | undefined;
/** Tests replace the call to KS-Ops. */
export function setPortRequestsFetchForTests(f: OpsFetch | null): void {
  fetchImpl = f ?? undefined;
}

async function whoIs(req: any): Promise<{ id: string; name: string; email: string | null }> {
  const u = req.user ?? {};
  const id = String(u.userId ?? u.id ?? u.sub ?? "");
  try {
    const r = await db().query(
      `SELECT trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) AS name, email FROM users WHERE id::text = $1 LIMIT 1`, [id]);
    const row = r.rows[0];
    return { id, name: String(row?.name || u.name || row?.email || u.email || "An admin"), email: (row?.email ?? u.email ?? null) as string | null };
  } catch (err) {
    console.error("[port-requests] requester not read", { message: (err as Error)?.message ?? String(err) });
    return { id, name: String(u.name || u.email || "An admin"), email: u.email ?? null };
  }
}

/** Relays one call to KS-Ops and answers with KS-Ops's own reply (its plain-English errors included). */
async function relay(res: any, path: Parameters<typeof postToOps>[0], body: unknown, okStatus = 200) {
  if (!opsConfig()) return res.status(503).json({ ok: false, error: "ops_not_configured", message: NOT_LINKED });
  const r = await postToOps(path, body, { fetchImpl });
  if (r.ok) return res.status(okStatus).json(r.body ?? { ok: true });
  // Only the path and status are logged: the body may hold the account number.
  console.error("[port-requests] keystone operations refused", { path: path.replace(/[0-9a-f-]{36}/gi, ":id"), status: r.status });
  if (r.status && r.status < 500 && r.body && typeof r.body === "object") return res.status(r.status).json(r.body);
  return res.status(502).json({ ok: false, error: "ops_unavailable", message: "Keystone operations could not be reached. Please try again in a few minutes." });
}

const router = Router();
router.use(auth, requireAuthorization({ roles: [ROLES.ADMIN] }));

router.get("/", safeHandler(async (_req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  const { people, main_line } = await portingPeople(db());
  if (!opsConfig()) return res.json({ ok: true, ops_ready: false, message: NOT_LINKED, requests: [], people, main_line });
  const r = await postToOps("port-requests/list", {}, { fetchImpl });
  if (!r.ok) {
    console.error("[port-requests] list not read from keystone operations", { status: r.status });
    return res.json({ ok: true, ops_ready: true, requests: [], people, main_line, message: "Your number transfers could not be loaded right now. Please try again in a few minutes." });
  }
  return res.json({ ok: true, ops_ready: true, requests: Array.isArray(r.body?.requests) ? r.body.requests : [], people, main_line });
}));

router.post("/", safeHandler(async (req: any, res: any) => {
  const b = req.body ?? {};
  const raw = Array.isArray(b.numbers) ? b.numbers.slice(0, 20) : [];
  if (!raw.length) return res.status(400).json({ ok: false, errors: { numbers: "Add the number you want to keep." } });
  const bill = b.bill ?? {};
  const billBytes = Math.floor(String(bill.data_base64 ?? "").length * 3 / 4);
  if (billBytes > MAX_BILL_BYTES) return res.status(413).json({ ok: false, errors: { bill: "The bill must be 7 MB or smaller. Upload a PDF or a photo of the first page." } });
  const { people, main_line } = await portingPeople(db());
  const errors: Record<string, string> = {};
  const numbers = raw.map((n: any, i: number) => {
    const userId = String(n?.user_id ?? "").trim();
    const person = userId ? people.find((p) => p.id === userId) : null;
    if (userId && !person) errors[`numbers.${i}.user_id`] = "Choose someone on your team, or the main line.";
    const phone = toE164(n?.phone_number);
    return {
      phone_number: phone ?? String(n?.phone_number ?? ""),
      number_type: n?.number_type,
      user_id: person?.id ?? null,
      assignee_name: person ? person.name : "Main line (the whole brokerage)",
      // Calls are forwarded here while the transfer runs; worked out here, never taken from the browser.
      temporary_number: person?.temporary_number ?? main_line,
    };
  });
  if (Object.keys(errors).length) return res.status(400).json({ ok: false, errors });
  const by = await whoIs(req);
  return relay(res, "port-requests", {
    company_name: brandName(),
    carrier: b.carrier, carrier_other: b.carrier_other, account_number: b.account_number, pin: b.pin,
    account_name: b.account_name, service_address: b.service_address, numbers, bill,
    forwarding_tested: b.forwarding_tested === true,
    requested_by: { id: by.id || null, name: by.name, email: by.email },
  }, 201);
}));

router.get("/:id/loa", safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  const id = String(req.params.id);
  if (!ID_RE.test(id)) return res.status(404).json({ ok: false, error: "not_found" });
  return relay(res, `port-requests/${id}/loa`, {});
}));

router.post("/:id/sign", safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!ID_RE.test(id)) return res.status(404).json({ ok: false, error: "not_found" });
  const b = req.body ?? {};
  const by = await whoIs(req);
  return relay(res, `port-requests/${id}/sign`, {
    signer_name: b.signer_name, signer_title: b.signer_title, agree: b.agree, sha256: b.sha256,
    signer_email: by.email, signer_user_id: by.id || null,
    ip: clientIpFromRequest(req), user_agent: String(req.get?.("user-agent") ?? "").slice(0, 500),
  });
}));

router.post("/:id/forwarding", safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!ID_RE.test(id)) return res.status(404).json({ ok: false, error: "not_found" });
  return relay(res, `port-requests/${id}/forwarding`, { phone_number: toE164(req.body?.phone_number), tested: req.body?.tested === true });
}));

router.post("/:id/cancel", safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!ID_RE.test(id)) return res.status(404).json({ ok: false, error: "not_found" });
  const by = await whoIs(req);
  return relay(res, `port-requests/${id}/cancel`, { by: by.name });
}));

export default router;
