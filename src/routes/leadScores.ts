// KS_SERVER_MARKETING_ADDON - lead scoring (Marketing add-on; src/marketing/leadScoring.ts).
//   POST /api/lead-scores/lookup { contact_ids }   staff: scores for the contacts on screen (refreshed now);
//                                                   { enabled: false } without the add-on
//   GET  /api/lead-scores/top?limit=50             staff: the highest scores
//   GET  /api/lead-scores/settings                 Admins and Marketing seats: the rules and points
//   PUT  /api/lead-scores/settings { settings }    Admins and Marketing seats (audited)
// Every signed-in staff member sees the scores; changing how they are worked out is an add-on tool (Admins and up to
// 3 Marketing users).
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { actorId, auditFor, type Q } from "../settingsPack/common.js";
import { getPlanState } from "../plans/state.js";
import { marketingAddonActive } from "../plans/marketing.js";
import { requireMarketingTool } from "../plans/marketingGate.js";
import {
  DEFAULT_SCORING, ENGAGEMENT_LABELS, RULE_KINDS, normalizeScoring, saveScoringSettings, scoreContacts, scoringSettings,
} from "../marketing/leadScoring.js";

const router = Router();
const db = (): Q => pool as unknown as Q;
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF, ROLES.OPS, ROLES.MARKETING] })];
const editors = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.MARKETING] }), requireMarketingTool("lead_scoring")];

async function enabled(): Promise<boolean> {
  return marketingAddonActive(await getPlanState(db()));
}

router.post("/lookup", ...staff, safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  if (!(await enabled())) return res.json({ ok: true, enabled: false, scores: {} });
  const ids = Array.isArray(req.body?.contact_ids) ? req.body.contact_ids.map(String).slice(0, 500) : [];
  const settings = await scoringSettings(db());
  const scores = await scoreContacts(db(), ids, settings);
  return res.json({ ok: true, enabled: true, hot: settings.hot, warm: settings.warm, scores: Object.fromEntries(scores.map((s) => [s.contact_id, s])) });
}));

router.get("/top", ...staff, safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  if (!(await enabled())) return res.json({ ok: true, enabled: false, contacts: [] });
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const r = await pool.query(
    `SELECT ls.contact_id::text AS contact_id, ls.score, ls.computed_at, c.name, c.email, c.phone, c.company_name
       FROM lead_scores ls JOIN contacts c ON c.id = ls.contact_id
      WHERE c.merged_into_id IS NULL ORDER BY ls.score DESC, ls.computed_at DESC LIMIT $1`,
    [limit],
  );
  const s = await scoringSettings(db());
  return res.json({ ok: true, enabled: true, hot: s.hot, warm: s.warm, contacts: r.rows });
}));

router.get("/settings", ...editors, safeHandler(async (_req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, settings: await scoringSettings(db()), defaults: DEFAULT_SCORING, rule_kinds: RULE_KINDS, engagement_labels: ENGAGEMENT_LABELS });
}));

router.put("/settings", ...editors, safeHandler(async (req: any, res: any) => {
  const settings = normalizeScoring(req.body?.settings);
  await saveScoringSettings(db(), settings, actorId(req));
  await auditFor(req, "lead_scoring_saved", { rules: settings.rules.length, hot: settings.hot, warm: settings.warm });
  return res.json({ ok: true, settings });
}));

export default router;
