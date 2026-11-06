import express from "express";
import { pool } from "../../db.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { respondOk } from "../../utils/respondOk.js";
import { getGraphForUser } from "../../modules/o365/graphClient.js";
// BF_SERVER_BLOCK_BI_ROUND5_CRM_SILO_RESOLVE_v1
import { resolveSiloFromRequest } from "../../middleware/silo.js";
import { enableAutoRecording } from "../../services/teams/autoRecord.js"; // BF_SERVER_TEAMS_AUTO_RECORD_v1
import { getGoogleForUser } from "../../services/workspace/googleAuth.js"; // KS_SERVER_v12_GOOGLE_WORKSPACE
import { createGoogleEvent } from "../../services/workspace/google.js"; // KS_SERVER_v12_GOOGLE_WORKSPACE
import { pickMeetingApp, zoomClientFor, zoomConnected } from "../../services/meetings/meetingApps.js"; // KS_ZOOM_MEETINGS_v1
import { createZoomMeeting } from "../../meetingNotes/zoom.js"; // KS_ZOOM_MEETINGS_v1

const router = express.Router({ mergeParams: true });

router.get("/", safeHandler(async (req: any, res: any) => {
  const { contactId, companyId } = resolveScope(req);
  const silo = resolveSiloFromRequest(req);
  const where: string[] = ["silo = $1"]; const params: unknown[] = [silo];
  if (contactId) { params.push(contactId); where.push(`contact_id = $${params.length}`); }
  if (companyId) { params.push(companyId); where.push(`company_id = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT * FROM crm_meetings WHERE ${where.join(" AND ")}
     ORDER BY start_at DESC LIMIT 200`,
    params,
  );
  respondOk(res, rows);
}));

router.post("/", safeHandler(async (req: any, res: any) => {
  const { contactId, companyId } = resolveScope(req);
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });

  const b = req.body ?? {};
  const title = (b.title ?? "").toString().trim();
  if (!title || !b.start_at || !b.end_at)
    return res.status(400).json({ error: "title, start_at, end_at required" });

  let graphId: string | null = null;
  // BF_SERVER_BLOCK_v336_TEAMS_MEETING_v1 — create a real Teams online meeting + capture link
  let joinUrl: string | null = null;
  let organizerUpn: string | null = null; // BF_SERVER_TEAMS_MEETING_LINK_v1
  const wantsOnline = b.online === true || b.meeting_type === "teams";
  const graph = await getGraphForUser(pool, userId);
  // BF_SERVER_TEAMS_MEETING_GRAPH_DIAG_v1 - a null graph client means the user
  // has no usable o365 delegated token. Previously this silently produced a
  // local-only meeting with no Teams link and no teams_meetings row.
  // KS_ZOOM_MEETINGS_v1 - an online meeting is Teams, Google Meet or Zoom: b.meeting_app picks one; left out, the
  // default for what this person connected (Teams, then Meet, then Zoom). Meet needs Google, Zoom needs Zoom connected.
  const google = wantsOnline || !graph ? await getGoogleForUser(pool, userId) : null;
  const app = wantsOnline
    ? pickMeetingApp({ teams: Boolean(graph), google_meet: Boolean(google), zoom: await zoomConnected(String(userId)) }, b.meeting_app)
    : null;
  if (wantsOnline && b.meeting_app && !app) {
    return res.status(412).json({ error: `${String(b.meeting_app)}_not_connected`, message: "Connect it first (Settings), or pick another meeting app." });
  }
  const teamsOnline = app === "teams";
  const useGraph = Boolean(graph) && app !== "google_meet";
  let zoomJoin: string | null = null;
  if (app === "zoom") {
    const z = await zoomClientFor(String(userId));
    try {
      if (!z) throw new Error("zoom_not_connected");
      zoomJoin = (await createZoomMeeting(z, { topic: title, start: new Date(b.start_at).toISOString(), end: new Date(b.end_at).toISOString(), agenda: b.attendee_description ?? null })).joinUrl;
    } catch (e: any) {
      console.error("zoom_meeting_create_failed", { user_id: userId, message: String(e?.message ?? e).slice(0, 200) });
      return res.status(502).json({ error: "zoom_meeting_create_failed", message: "Zoom did not create the meeting. Reconnect Zoom under Settings > Meeting notes and try again." });
    }
  }
  const zoomHtml = zoomJoin ? `<p>Join Zoom meeting: <a href="${zoomJoin}">${zoomJoin}</a></p>` : "";
  if (!graph && wantsOnline && !app) {
    console.error("teams_meeting_no_graph_client", { user_id: userId });
  }
  if (graph && useGraph) {
    try {
      const create = await graph.fetch("/me/events", {
        method: "POST",
        body: JSON.stringify({
          subject: title,
          body: { contentType: "HTML", content: zoomHtml + (b.attendee_description ?? "") },
          start: { dateTime: new Date(b.start_at).toISOString(), timeZone: "UTC" },
          end: { dateTime: new Date(b.end_at).toISOString(), timeZone: "UTC" },
          location: zoomJoin ? { displayName: "Zoom", locationUri: zoomJoin } : b.location ? { displayName: b.location } : undefined,
          attendees: (b.attendees ?? []).map((a: any) => ({
            emailAddress: { address: a.address, name: a.name ?? a.address },
            type: a.optional ? "optional" : "required",
          })),
          reminderMinutesBeforeStart: b.reminder_minutes ?? 60,
          ...(teamsOnline ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
        }),
      });
      if (create.ok) {
        const j: any = await create.json();
        graphId = j.id ?? null;
        joinUrl = j.onlineMeeting?.joinUrl ?? null;
        // BF_SERVER_TEAMS_MEETING_GRAPH_DIAG_v1 - the event can be created while
        // Teams declines to attach an online meeting (licensing / policy). The
        // event id alone is useless without a joinWebUrl to resolve later.
        if (teamsOnline && !joinUrl) {
          console.error("teams_meeting_no_join_url", { graph_event_id: graphId });
        }
      } else {
        // BF_SERVER_TEAMS_MEETING_GRAPH_DIAG_v1 - there was no else branch here.
        // A 4xx from Graph left graphId null and the request carried on as if
        // nothing had happened, so nothing was registered in teams_meetings and
        // no trace was left in the logs.
        const detail = await create.text().catch(() => "");
        console.error("teams_meeting_event_create_failed", {
          status: create.status,
          detail: detail.slice(0, 600),
        });
      }
    } catch (e: any) {
      // BF_SERVER_TEAMS_MEETING_GRAPH_DIAG_v1 - was a bare `catch {}`.
      console.error("teams_meeting_event_create_threw", { message: e?.message });
      graphId = null;
    }
    // BF_SERVER_TEAMS_MEETING_LINK_v1 - the Graph transcript + recording
    // endpoints are addressed as /users/{organizerId}/onlineMeetings/... , so
    // knowing the event id alone is not enough: we must also know WHO organised
    // it. crm_meetings stores neither pairing, so capture the organiser's UPN
    // here while we still hold their delegated Graph client.
    if (teamsOnline && graphId) {
      try {
        const meRes = await graph.fetch("/me?$select=userPrincipalName");
        if (meRes.ok) {
          const meJson: any = await meRes.json();
          organizerUpn = meJson?.userPrincipalName ?? null;
        }
      } catch {
        organizerUpn = null;
      }
    }
  }
  // KS_SERVER_v12_GOOGLE_WORKSPACE - no Microsoft 365: the event goes on the user's Google Calendar, and an
  // online meeting gets a Google Meet link where Teams would have been used.
  let googleEventId: string | null = null;
  if (!useGraph) {
    if (google) {
      try {
        const created = await createGoogleEvent(google, {
          title,
          start: new Date(b.start_at).toISOString(),
          end: new Date(b.end_at).toISOString(),
          notes: [zoomJoin ? `Join Zoom meeting: ${zoomJoin}` : "", b.attendee_description ?? ""].filter(Boolean).join("\n\n") || null,
          location: zoomJoin ?? b.location ?? null,
          attendees: (b.attendees ?? []).map((a: any) => ({ email: String(a?.address ?? ""), name: a?.name ?? null, optional: a?.optional === true })),
          reminderMinutes: b.reminder_minutes ?? 60,
          meet: app === "google_meet",
        });
        googleEventId = created.id;
        joinUrl = created.joinUrl ?? joinUrl;
      } catch (e: any) {
        console.error("google_meeting_event_create_failed", { message: e?.message, detail: String(e?.bodyText ?? "").slice(0, 300) });
      }
    }
  }

  const silo = resolveSiloFromRequest(req);
  const { rows } = await pool.query(
    `INSERT INTO crm_meetings
      (title,attendee_description,internal_note,start_at,end_at,location,
       attendees_json,reminder_minutes,owner_id,contact_id,company_id,graph_id,silo)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      title,
      b.attendee_description ?? null,
      b.internal_note ?? null,
      b.start_at,
      b.end_at,
      zoomJoin ?? joinUrl ?? b.location ?? null, // BF_SERVER_BLOCK_v336_TEAMS_MEETING_v1; KS_ZOOM_MEETINGS_v1
      JSON.stringify(b.attendees ?? []),
      b.reminder_minutes ?? 60,
      userId,
      contactId,
      companyId,
      graphId,
      silo,
    ],
  );
  // BF_SERVER_TEAMS_MEETING_LINK_v1 - register the online meeting so the
  // transcript/recording poller can find it after it ends and attach the
  // artifacts (recording link, transcript, Maya summary) to this contact's CRM
  // timeline. Best-effort: a failure here must never break scheduling.
  if (teamsOnline && graphId) {
    try {
      await pool.query(
        `INSERT INTO teams_meetings
           (silo, contact_id, company_id, crm_meeting_id, organizer_user_id, organizer_upn,
            subject, graph_event_id, join_url, scheduled_at, scheduled_end_at, status)
         VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10, $11, 'scheduled')
         ON CONFLICT (graph_event_id) DO UPDATE
           SET subject = EXCLUDED.subject,
               join_url = EXCLUDED.join_url,
               scheduled_at = EXCLUDED.scheduled_at,
               scheduled_end_at = EXCLUDED.scheduled_end_at,
               organizer_upn = COALESCE(EXCLUDED.organizer_upn, teams_meetings.organizer_upn),
               updated_at = now()`,
        [
          silo,
          contactId,
          companyId,
          rows[0]?.id ?? null,
          userId,
          organizerUpn,
          title,
          graphId,
          joinUrl,
          b.start_at,
          b.end_at,
        ],
      );
    } catch (e: any) {
      // BF_SERVER_TEAMS_MEETINGS_UPSERT_FIX_v1 - this used to be a bare
      // `catch {}`. The upsert was failing on every call (partial-index
      // inference) and the silent catch meant teams_meetings stayed empty with
      // no trace in the logs. Scheduling still must not break, but the failure
      // has to be VISIBLE.
      console.error("teams_meeting_register_failed", {
        message: e?.message,
        graph_event_id: graphId,
      });
    }
  }

  // BF_SERVER_TEAMS_AUTO_RECORD_v1 - turn on "record and transcribe automatically" on
  // the meeting itself, so a transcript exists without anyone remembering to press
  // Record. Fire-and-forget: Teams needs a moment to provision the onlineMeeting, and
  // scheduling must not wait on it or fail because of it.
  if (teamsOnline && graphId && organizerUpn && joinUrl) {
    void enableAutoRecording(pool, graphId, organizerUpn, joinUrl);
  }
  if (googleEventId && rows[0]?.id) {
    await pool.query(`UPDATE crm_meetings SET google_event_id = $2 WHERE id = $1`, [rows[0].id, googleEventId]);
    rows[0].google_event_id = googleEventId; // KS_SERVER_v12_GOOGLE_WORKSPACE
  }

  res.status(201).json({ ok: true, data: { ...rows[0], meeting_app: app } }); // KS_ZOOM_MEETINGS_v1
}));

function resolveScope(req: any): { contactId: string | null; companyId: string | null } {
  const isContact = req.baseUrl?.includes("/contacts/");
  const id = req.params.id;
  return isContact ? { contactId: id, companyId: req.body?.companyId ?? null }
    : { companyId: id, contactId: req.body?.contactId ?? null };
}

export default router;
