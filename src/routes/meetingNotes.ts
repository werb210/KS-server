// KS_HUBSPOT_GAPS_1_MEETING_NOTES - /api/meeting-notes: Zoom and Google Meet meeting notes (every plan with office
// sync). Each person connects their own Zoom; Google Meet uses their Google connection.
//   GET  /status                       staff: Zoom and Google Meet connection for me, and why either is off
//   POST /zoom/connect                 staff: { url } of Zoom's consent screen
//   GET  /zoom/callback                public: Zoom sends the person back here; then on to Settings > Meeting notes
//   POST /zoom/disconnect              staff
//   POST /sync                         staff: bring my new transcripts in now
//   GET  /meetings?unmatched=1         staff: my Zoom / Google Meet meetings (with the contact each was matched to)
//   PUT  /meetings/:id/contact         staff: { contact_id } file one of my meetings under a contact I may see
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { randomBytes } from "node:crypto";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { requireFeature } from "../plans/requireFeature.js";
import { pool } from "../db.js";
import { portalUrl } from "../licensee/urls.js";
import { actorId, auditFor } from "../settingsPack/common.js";
import { canSeeRecord, scopeForRequest } from "../visibility/scope.js";
import { getGoogleForUser } from "../services/workspace/googleAuth.js";
import { googleConfigProblem, meetNotesEnabled } from "../services/workspace/googleConfig.js";
import { meetHasScope } from "../meetingNotes/googleMeet.js";
import { PROVIDER_LABEL, runMeetingNotesSync } from "../meetingNotes/sync.js";
import {
  ZoomError, disconnectZoom, exchangeZoomCode, saveZoomAccount, stateHash, zoomAuthorizeUrl, zoomConfig, zoomConfigProblem, zoomMe, type Q,
} from "../meetingNotes/zoom.js";
import { unwrapState, wrapState } from "../licensee/oauthBroker.js"; // KS_ZOOM_MEETINGS_v1

const router = Router();
const db = (): Q => pool as unknown as Q;
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF, ROLES.MARKETING, ROLES.OPS] }), requireFeature("office_sync")];
const publicLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKeyFromRequest });
const syncLimiter = rateLimit({ windowMs: 60_000, limit: 3, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKeyFromRequest });
const STATE_TTL_MINUTES = 10;
const back = (result: string) => `${portalUrl().replace(/\/+$/, "")}/settings/meeting-notes?zoom=${encodeURIComponent(result)}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/status", ...staff, safeHandler(async (req: any, res: any) => {
  const me = actorId(req);
  const zoom = me ? (await db().query(`SELECT zoom_email, status, last_synced_at, last_error FROM zoom_accounts WHERE user_id = $1::uuid`, [me])).rows[0] : null;
  let google: Record<string, unknown> = { enabled: meetNotesEnabled(), problem: googleConfigProblem(), connected: false, has_scope: false };
  if (me && meetNotesEnabled() && !googleConfigProblem()) {
    const g = await getGoogleForUser(db() as any, me);
    const sync = (await db().query(`SELECT last_synced_at, last_error FROM google_meet_sync WHERE user_id = $1::uuid`, [me])).rows[0];
    google = { ...google, connected: Boolean(g), email: g?.email ?? null, has_scope: g ? meetHasScope(g) : false, last_synced_at: sync?.last_synced_at ?? null, last_error: sync?.last_error ?? null };
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    zoom: { problem: zoomConfigProblem(), connected: zoom?.status === "connected", status: zoom?.status ?? "disconnected", email: zoom?.zoom_email ?? null, last_synced_at: zoom?.last_synced_at ?? null, last_error: zoom?.last_error ?? null },
    google_meet: google,
  });
}));

router.post("/zoom/connect", ...staff, safeHandler(async (req: any, res: any) => {
  const cfg = zoomConfig();
  if (!cfg) return res.status(503).json({ ok: false, error: "not_configured", message: zoomConfigProblem() });
  const me = actorId(req);
  if (!me) return res.status(400).json({ ok: false, error: "no_user" });
  const state = randomBytes(24).toString("base64url");
  await db().query(`DELETE FROM zoom_oauth_states WHERE created_at < now() - make_interval(mins => $1::int)`, [STATE_TTL_MINUTES]);
  await db().query(`INSERT INTO zoom_oauth_states (state_hash, user_id) VALUES ($1, $2::uuid)`, [stateHash(state), me]);
  res.json({ ok: true, url: zoomAuthorizeUrl(cfg, wrapState("zoom", state, STATE_TTL_MINUTES * 60_000)) }); // KS_ZOOM_MEETINGS_v1
}));

router.get("/zoom/callback", publicLimiter, safeHandler(async (req: any, res: any) => {
  const cfg = zoomConfig();
  const state = unwrapState("zoom", String(req.query?.state ?? "")) ?? ""; // KS_ZOOM_MEETINGS_v1 - via the KS-Ops broker
  const claimed = state ? (await db().query(
    `DELETE FROM zoom_oauth_states WHERE state_hash = $1 AND created_at > now() - make_interval(mins => $2::int) RETURNING user_id::text AS user_id`,
    [stateHash(state), STATE_TTL_MINUTES])).rows[0] : null;
  if (!cfg || !claimed) return res.redirect(303, back("expired"));
  if (req.query?.error || !req.query?.code) return res.redirect(303, back("declined"));
  try {
    const t = await exchangeZoomCode(cfg, String(req.query.code));
    const me = await zoomMe(t.accessToken);
    await saveZoomAccount(db(), claimed.user_id, t, me);
    await auditFor({ user: { userId: claimed.user_id }, headers: req.headers }, "meeting_notes.zoom_connected", { zoom_email: me.email || null }, { type: "zoom_account", id: claimed.user_id });
    return res.redirect(303, back("connected"));
  } catch (err) {
    console.error("[meeting-notes] Zoom connect failed", { message: err instanceof ZoomError ? `${err.status} ${err.code}` : err instanceof Error ? err.message : String(err) });
    return res.redirect(303, back("error"));
  }
}));

router.post("/zoom/disconnect", ...staff, safeHandler(async (req: any, res: any) => {
  const me = actorId(req);
  if (!me) return res.status(400).json({ ok: false, error: "no_user" });
  const revoked = await disconnectZoom(db(), zoomConfig(), me);
  await auditFor(req, "meeting_notes.zoom_disconnected", { revoked }, { type: "zoom_account", id: me });
  res.json({ ok: true, revoked });
}));

router.post("/sync", ...staff, syncLimiter, safeHandler(async (req: any, res: any) => {
  const me = actorId(req);
  if (!me) return res.status(400).json({ ok: false, error: "no_user" });
  const r = await runMeetingNotesSync(pool, { userId: me });
  res.json({ ok: true, imported: r });
}));

router.get("/meetings", ...staff, safeHandler(async (req: any, res: any) => {
  const me = actorId(req);
  const unmatched = ["1", "true"].includes(String(req.query?.unmatched ?? ""));
  const r = await db().query(
    `SELECT tm.id::text AS id, tm.provider, tm.subject, tm.started_at, tm.ended_at, tm.contact_id::text AS contact_id, tm.status,
            tm.maya_summary, tm.recording_url, tm.match_method, COALESCE(NULLIF(btrim(c.name), ''), c.email) AS contact_name
       FROM teams_meetings tm LEFT JOIN contacts c ON c.id = tm.contact_id
      WHERE tm.organizer_user_id = $1::uuid AND tm.provider IN ('zoom', 'google_meet') AND ($2::boolean = false OR tm.contact_id IS NULL)
      ORDER BY COALESCE(tm.ended_at, tm.created_at) DESC LIMIT 100`, [me, unmatched]);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, meetings: r.rows.map((m: any) => ({ ...m, provider_label: PROVIDER_LABEL[m.provider] ?? m.provider })) });
}));

router.put("/meetings/:id/contact", ...staff, safeHandler(async (req: any, res: any) => {
  const me = actorId(req);
  const id = String(req.params.id ?? "");
  const contactId = String(req.body?.contact_id ?? "").trim();
  if (!UUID.test(id) || !UUID.test(contactId)) return res.status(400).json({ ok: false, error: "validation_error", message: "Choose a contact." });
  const m = (await db().query(`SELECT id FROM teams_meetings WHERE id = $1::uuid AND organizer_user_id = $2::uuid AND provider IN ('zoom', 'google_meet')`, [id, me])).rows[0];
  if (!m) return res.status(404).json({ ok: false, error: "not_found" });
  const scope = await scopeForRequest(req, db() as any);
  if (!(await canSeeRecord(db() as any, scope, "contact", contactId))) return res.status(404).json({ ok: false, error: "not_found", message: "Contact not found" });
  await db().query(
    `UPDATE teams_meetings SET contact_id = $2::uuid, company_id = (SELECT company_id FROM contacts WHERE id = $2::uuid), match_method = 'manual', updated_at = now() WHERE id = $1::uuid`,
    [id, contactId]);
  await auditFor(req, "meeting_notes.contact_set", { meeting_id: id, contact_id: contactId }, { type: "meeting", id });
  res.json({ ok: true });
}));

export default router;
