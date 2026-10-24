// KS_SERVER_BETA_v1 - beta features (Labs). Keystone operations (KS-Ops) owns the catalogue; this copy stores its own
// view of it (see src/beta/flags.ts).
//   GET  /api/beta/flags                       public: { enabled: [keys] } - for the client and portal to gate code
//   GET  /api/beta/features                    any signed-in staff: { features, enabled }
//   POST /api/beta/features/:key/join          Admin: join a public beta (KS-Ops approves an open one at once)
//   POST /api/beta/features/:key/leave         Admin: leave a beta
//   POST /api/beta/features/:key/feedback      Admin or staff: { message, rating? } - sent to KS-Ops
// Join and leave are forwarded to KS-Ops; its answer carries the new list, which is stored straight away.
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { postToOps, opsConfig } from "../plans/opsLink.js";
import {
  BETA_KEY_RE, enabledKeys, getBetaFeatures, normaliseFeatures, setBetaFeatures, type Q,
} from "../beta/flags.js";

const router = Router();
const db = () => pool as unknown as Q;
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF, ROLES.OPS, ROLES.MARKETING] })];
const adminOnly = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const who = (req: any) => String(req.user?.email ?? req.user?.userId ?? req.user?.id ?? req.user?.sub ?? "").slice(0, 200);

const OPS_DOWN = { ok: false, error: "ops_unavailable", message: "Beta features cannot be changed right now. Please try again in a few minutes." };
const NOT_FOUND = { ok: false, error: "not_found", message: "That beta feature is not available." };

router.get("/flags", safeHandler(async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ enabled: enabledKeys(await getBetaFeatures(db())) });
}));

router.get("/features", ...staff, safeHandler(async (_req, res) => {
  const features = await getBetaFeatures(db());
  res.setHeader("Cache-Control", "no-store");
  res.json({ features, enabled: enabledKeys(features) });
}));

async function changeEnrolment(req: any, res: any, action: "join" | "leave") {
  const key = String(req.params.key ?? "").toLowerCase();
  if (!BETA_KEY_RE.test(key)) return res.status(404).json(NOT_FOUND);
  const current = await getBetaFeatures(db());
  const f = current.find((x) => x.key === key);
  if (!f) return res.status(404).json(NOT_FOUND);
  if (action === "join" && !f.can_join && !f.enrolled) return res.status(409).json({ ok: false, error: "not_joinable", message: "This beta is not open to join right now." });
  if (action === "leave" && !f.can_leave) return res.status(409).json({ ok: false, error: "not_leavable", message: "This feature cannot be switched off." });
  if (!opsConfig()) return res.status(503).json(OPS_DOWN);
  const r = await postToOps("beta/enrolment", { feature_key: key, action, requested_by: who(req) });
  const body = r.ok ? r.body : null;
  // KS-Ops answers refusals (403/404/409) with a message and the current list too; only an unreachable KS-Ops is 503.
  if (!r.ok) {
    console.warn("[beta] enrolment change failed", action, key, r.error);
    if (r.status && r.status >= 400 && r.status < 500 && r.status !== 401) {
      return res.status(409).json({ ok: false, error: "refused", message: "This change was not accepted. Refresh the page and try again." });
    }
    return res.status(503).json(OPS_DOWN);
  }
  const features = Array.isArray(body?.beta_features) ? await setBetaFeatures(db(), normaliseFeatures(body.beta_features)) : current;
  return res.json({
    ok: true,
    status: String(body?.status ?? (action === "join" ? "joined" : "left")),
    message: typeof body?.message === "string" ? body.message : undefined,
    features,
    enabled: enabledKeys(features),
  });
}

router.post("/features/:key/join", ...adminOnly, safeHandler((req, res) => changeEnrolment(req, res, "join")));
router.post("/features/:key/leave", ...adminOnly, safeHandler((req, res) => changeEnrolment(req, res, "leave")));

router.post("/features/:key/feedback", ...staff, safeHandler(async (req: any, res) => {
  const key = String(req.params.key ?? "").toLowerCase();
  if (!BETA_KEY_RE.test(key) || !(await getBetaFeatures(db())).some((f) => f.key === key)) return res.status(404).json(NOT_FOUND);
  const message = String(req.body?.message ?? "").trim();
  if (!message) return res.status(400).json({ ok: false, error: "message_required", message: "Write your feedback first." });
  if (message.length > 5000) return res.status(400).json({ ok: false, error: "message_too_long", message: "Keep it under 5,000 characters." });
  const rawRating = req.body?.rating;
  const rating = rawRating === undefined || rawRating === null || rawRating === "" ? null : Number(rawRating);
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) return res.status(400).json({ ok: false, error: "invalid_rating" });
  if (!opsConfig()) return res.status(503).json(OPS_DOWN);
  const name = [req.user?.first_name, req.user?.last_name].filter(Boolean).join(" ").trim() || null;
  const r = await postToOps("beta/feedback", {
    feature_key: key, message, rating, author_name: name, author_email: typeof req.user?.email === "string" ? req.user.email : null,
  });
  if (!r.ok) {
    console.warn("[beta] feedback relay failed", key, r.error);
    return res.status(503).json({ ok: false, error: "ops_unavailable", message: "Your feedback could not be sent. Please try again in a few minutes." });
  }
  return res.status(201).json({ ok: true });
}));

export default router;
