// KS_SERVER_PHONE_PROVISIONING - Settings > Phone lines (Admins only): see this copy's numbers, search Twilio for new
// ones, buy a business line, the toll-free line (growth and up) or a person's direct line (pro), and release or keep.
//   GET  /api/phone-numbers                          numbers, plan limits, grace period, setup messages
//   GET  /api/phone-numbers/available?kind=&country=&area_code=&region=&contains=
//   POST /api/phone-numbers            { kind, phone_number, user_id?, address_requirements?, locality?, region?, iso_country? }
//   POST /api/phone-numbers/:id/release   schedules the release after the grace period (admins are told)
//   POST /api/phone-numbers/:id/keep      { user_id? } cancels a scheduled release
//   PUT  /api/phone-numbers/:id/assign    { user_id } gives a direct line to someone else
//   POST /api/phone-numbers/:id/change    { phone_number, ... } buys a new number of the same kind for the same person;
//                                         the old one goes into the grace period (kept if the purchase fails)
// Plan refusals answer 402 feature_not_in_plan (same body as requireFeature), limits 409 limit_reached.
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import type { Q } from "../plans/state.js";
import { changeNumber, keepNumber, listNumbers, purchaseNumber, reassignDirect, scheduleRelease, searchNumbers, type Refusal } from "../phone/numbers.js";
import { liveTwilioNumbersApi, type TwilioNumbersApi } from "../phone/twilioNumbers.js";

const db = () => pool as unknown as Q;
let apiFactory: () => TwilioNumbersApi = () => liveTwilioNumbersApi();

/** Tests swap the Twilio client for a fake. */
export function setTwilioNumbersApiForTests(f: (() => TwilioNumbersApi) | null): void {
  apiFactory = f ?? (() => liveTwilioNumbersApi());
}

const actorOf = (req: any) => String(req.user?.email || req.user?.userId || req.user?.id || req.user?.sub || "admin").slice(0, 120);
const send = (res: any, r: Refusal) => {
  const { status, ...body } = r;
  return res.status(status).json(body);
};

const router = Router();
router.use(auth, requireAuthorization({ roles: [ROLES.ADMIN] }));

router.get("/", safeHandler(async (_req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, ...(await listNumbers(db())) });
}));

router.get("/available", safeHandler(async (req: any, res: any) => {
  const r = await searchNumbers(apiFactory(), req.query ?? {});
  return r.ok ? res.json(r) : send(res, r);
}));

router.post("/", safeHandler(async (req: any, res: any) => {
  const b = req.body ?? {};
  const r = await purchaseNumber(db(), apiFactory(), {
    kind: b.kind, phone_number: b.phone_number, user_id: b.user_id, actor: actorOf(req),
    address_requirements: b.address_requirements, locality: b.locality, region: b.region, iso_country: b.iso_country,
  });
  return r.ok ? res.status(201).json(r) : send(res, r);
}));

router.post("/:id/release", safeHandler(async (req: any, res: any) => {
  const reason = String(req.body?.reason ?? "").trim().slice(0, 200) || "an admin asked for it";
  const r = await scheduleRelease(db(), String(req.params.id), { reason, actor: actorOf(req) });
  return r.ok ? res.json(r) : send(res, r);
}));

router.post("/:id/keep", safeHandler(async (req: any, res: any) => {
  const r = await keepNumber(db(), String(req.params.id), { user_id: req.body?.user_id, actor: actorOf(req) });
  return r.ok ? res.json(r) : send(res, r);
}));

router.put("/:id/assign", safeHandler(async (req: any, res: any) => {
  const r = await reassignDirect(db(), String(req.params.id), { user_id: req.body?.user_id, actor: actorOf(req) });
  return r.ok ? res.json(r) : send(res, r);
}));

router.post("/:id/change", safeHandler(async (req: any, res: any) => {
  const b = req.body ?? {};
  const r = await changeNumber(db(), apiFactory(), String(req.params.id), {
    phone_number: b.phone_number, actor: actorOf(req), address_requirements: b.address_requirements, locality: b.locality, region: b.region, iso_country: b.iso_country,
  });
  return r.ok ? res.json(r) : send(res, r);
}));

export default router;
