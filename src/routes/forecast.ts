// KS_SERVER_v23_FORECAST - revenue (commission) forecast. Growth and up (feature "forecasting").
//   GET /api/forecast?granularity=month|quarter&from=YYYY-MM&periods=N&team_id=&user_id=
//        per rep and team: closed / commit / best case / pipeline / weighted, next to the Goals targets.
//        Admins see everyone; everyone else sees their own files only.
//   GET /api/forecast/stages                 the chance each lending stage funds
//   PUT /api/forecast/stages                 Admin: { stages: { "Offer": 70, ... } }
//   GET /api/forecast/applications/:id       one file: expected close date, category, chance
//   PUT /api/forecast/applications/:id       staff: { expected_close_date?: "YYYY-MM-DD" | null, forecast_category?: ... | null }
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { requireFeature } from "../plans/requireFeature.js";
import { actorId, auditRequest } from "../lib/auditRequest.js";
import { normalizeRole } from "../services/reports/catalog.js";
import { OPEN_STAGES, fileForecast, forecast, loadProbabilities, saveProbabilities, setFileForecast, type Db } from "../forecast/forecast.js";

const router = Router();
const db = () => pool as unknown as Db;
router.use(auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }), requireFeature("forecasting"));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const viewer = (req: any) => ({ role: normalizeRole(req.user?.role), userId: String(req.user?.userId ?? req.user?.id ?? "") });

router.get("/", safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, ...(await forecast(req.query ?? {}, viewer(req), db())) });
}));

router.get("/stages", safeHandler(async (_req: any, res: any) => {
  const p = await loadProbabilities(db());
  return res.json({ ok: true, stages: OPEN_STAGES.map((stage) => ({ stage, probability: p[stage] ?? 0 })) });
}));

router.put("/stages", safeHandler(async (req: any, res: any) => {
  if (normalizeRole(req.user?.role) !== "Admin") return res.status(403).json({ ok: false, error: "admin_only" });
  const r = await saveProbabilities(db(), req.body?.stages ?? {}, actorId(req));
  if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
  await auditRequest(req, "forecast", "stage_probabilities", "forecast_stage_probabilities", null, { stages: req.body?.stages ?? {} });
  const p = await loadProbabilities(db());
  return res.json({ ok: true, stages: OPEN_STAGES.map((stage) => ({ stage, probability: p[stage] ?? 0 })) });
}));

router.get("/applications/:id", safeHandler(async (req: any, res: any) => {
  if (!UUID.test(String(req.params.id))) return res.status(400).json({ ok: false, error: "invalid_id" });
  const f = await fileForecast(db(), String(req.params.id));
  if (!f) return res.status(404).json({ ok: false, error: "not_found" });
  return res.json({ ok: true, ...f });
}));

router.put("/applications/:id", safeHandler(async (req: any, res: any) => {
  if (!UUID.test(String(req.params.id))) return res.status(400).json({ ok: false, error: "invalid_id" });
  const r = await setFileForecast(db(), String(req.params.id), req.body ?? {});
  if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error });
  return res.json({ ok: true, ...(await fileForecast(db(), String(req.params.id))) });
}));

export default router;
