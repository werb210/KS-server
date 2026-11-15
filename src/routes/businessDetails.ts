// KS_SERVER_SETUP_BUSINESS_DETAILS_v1 - the set-up form for what the short sign-up skipped: the business address, the
// business number, the kind of business and the owner's job title (Admins only; Settings > Phone lines and the set-up
// wizard's "Get your phone number" step). Keystone operations keeps these and registers the address for the phone
// lines; this router relays with the ops key, the same link as number transfers.
//   GET /api/business-details   { ok, ops_ready, details }
//   PUT /api/business-details   the form -> { ok, message, details } or 400 { errors } in plain words
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { opsConfig, postToOps, type OpsFetch } from "../plans/opsLink.js";

export const NOT_LINKED = "This server is not linked to Keystone operations yet, so these details cannot be saved here. Ask Keystone support.";
const UNREACHABLE = "Keystone operations could not be reached. Please try again in a few minutes.";

let fetchImpl: OpsFetch | undefined;
/** Tests replace the call to KS-Ops. */
export function setBusinessDetailsFetchForTests(f: OpsFetch | null): void {
  fetchImpl = f ?? undefined;
}

async function savedBy(req: any): Promise<string> {
  const u = req.user ?? {};
  const id = String(u.userId ?? u.id ?? u.sub ?? "");
  try {
    const r = await pool.query(
      `SELECT trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) AS name, email FROM users WHERE id::text = $1 LIMIT 1`, [id]);
    return String(r.rows[0]?.name || r.rows[0]?.email || u.email || "An admin");
  } catch (err) {
    console.error("[business-details] person not read", { message: (err as Error)?.message ?? String(err) });
    return String(u.email || "An admin");
  }
}

const router = Router();
router.use(auth, requireAuthorization({ roles: [ROLES.ADMIN] }));

router.get("/", safeHandler(async (_req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  if (!opsConfig()) return res.json({ ok: true, ops_ready: false, message: NOT_LINKED, details: null });
  const r = await postToOps("business-details", {}, { fetchImpl });
  if (!r.ok) {
    console.error("[business-details] not read from keystone operations", { status: r.status });
    return res.json({ ok: true, ops_ready: true, details: null, message: UNREACHABLE });
  }
  return res.json({ ok: true, ops_ready: true, details: r.body?.details ?? null });
}));

router.put("/", safeHandler(async (req: any, res: any) => {
  if (!opsConfig()) return res.status(503).json({ ok: false, error: "ops_not_configured", message: NOT_LINKED });
  const b = req.body ?? {};
  const r = await postToOps("business-details/save", {
    legal_name: b.legal_name, address_line1: b.address_line1, address_line2: b.address_line2, city: b.city,
    province_state: b.province_state, postal_code: b.postal_code, country: b.country,
    business_number: b.business_number, business_type: b.business_type, contact_title: b.contact_title,
    saved_by: await savedBy(req),
  }, { fetchImpl });
  if (r.ok) return res.json(r.body ?? { ok: true });
  console.error("[business-details] keystone operations refused", { status: r.status });
  if (r.status && r.status < 500 && r.body && typeof r.body === "object") return res.status(r.status).json(r.body);
  return res.status(502).json({ ok: false, error: "ops_unavailable", message: UNREACHABLE });
}));

export default router;
