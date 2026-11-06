// KS_ZOOM_MEETINGS_v1 - which video-meeting app a meeting uses: Microsoft Teams, Google Meet or Zoom.
// Each one shows only when the person has connected it (Microsoft 365, Google, or Zoom under Settings > Meeting notes).
// The default follows what they connected: Teams, then Google Meet, then Zoom. A meeting can pick another one.
// A Zoom meeting goes on the person's own calendar (Outlook or Google) with the Zoom link, so the guests get the
// calendar invitation the same way as for Teams or Meet.
import { pool } from "../../db.js";
import { resolveSiloFromRequest } from "../../middleware/silo.js";
import { brandName } from "../../licensee/brand.js";
import type { GoogleClient } from "../workspace/googleAuth.js";
import { createGoogleEvent } from "../workspace/google.js";
import { createZoomMeeting, zoomConfig, zoomForUser, ZoomError, type ZoomClient } from "../../meetingNotes/zoom.js";

export type MeetingApp = "teams" | "google_meet" | "zoom";
export type Connected = { teams: boolean; google_meet: boolean; zoom: boolean };

export const APP_LABEL: Record<MeetingApp, string> = { teams: "Microsoft Teams", google_meet: "Google Meet", zoom: "Zoom" };

/** Unit-tested: the app a meeting uses, or null when the asked-for (or any) app is not connected. */
export function pickMeetingApp(connected: Connected, requested?: unknown): MeetingApp | null {
  if (requested === "teams" || requested === "google_meet" || requested === "zoom") return connected[requested] ? requested : null;
  if (connected.teams) return "teams";
  if (connected.google_meet) return "google_meet";
  if (connected.zoom) return "zoom";
  return null;
}

export function defaultMeetingApp(connected: Connected): MeetingApp | null { return pickMeetingApp(connected); }

export async function zoomClientFor(userId: string): Promise<ZoomClient | null> {
  const cfg = zoomConfig();
  if (!cfg) return null;
  try {
    return await zoomForUser(pool, cfg, userId);
  } catch (err) {
    console.warn("[meeting-apps] Zoom not usable", { userId, message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function zoomConnected(userId: string): Promise<boolean> {
  if (!zoomConfig()) return false;
  const r = await pool.query(`SELECT status FROM zoom_accounts WHERE user_id = $1::uuid`, [userId]);
  return r.rows[0]?.status === "connected";
}

type GraphLike = { fetch: (path: string, init?: any) => Promise<{ ok: boolean; status?: number; text: () => Promise<string>; json: () => Promise<any> }> };
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

/** POST /api/o365/meetings/schedule with Zoom: the Zoom meeting, the calendar invitation, the CRM meeting. */
export async function scheduleZoomMeeting(req: any, res: any, z: ZoomClient, cal: { graph: GraphLike | null; google: GoogleClient | null }, userId: string): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const contactId = typeof body.contact_id === "string" ? body.contact_id : null;
  const subject = typeof body.subject === "string" && body.subject.trim() ? body.subject.trim() : `${brandName()} meeting`;
  const startIso = typeof body.start === "string" ? body.start : null;
  const endIso = typeof body.end === "string" ? body.end : null;
  const notes = typeof body.notes === "string" ? body.notes : null;
  const attendees = Array.isArray(body.attendees) ? (body.attendees as unknown[]).map((a) => String(a)).filter((a) => a.includes("@")) : [];
  if (!contactId) return void res.status(400).json({ error: "contact_id_required" });
  if (!startIso || !endIso) return void res.status(400).json({ error: "start_and_end_required" });

  let zoom: { id: string; joinUrl: string };
  try {
    zoom = await createZoomMeeting(z, { topic: subject, start: startIso, end: endIso, agenda: notes });
  } catch (err) {
    const status = err instanceof ZoomError ? err.status : 502;
    console.error("[meeting-apps] Zoom meeting create failed", { userId, status, message: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    if (status === 401 || status === 403) return void res.status(412).json({ error: "zoom_reconnect_required", detail: "Reconnect Zoom under Settings > Meeting notes (the Zoom app needs permission to create meetings)." });
    return void res.status(502).json({ error: "zoom_meeting_create_failed" });
  }

  // The invitation goes out from the person's calendar; a calendar failure keeps the Zoom meeting and says so.
  let graphEventId: string | null = null;
  let googleEventId: string | null = null;
  let invited = false;
  const text = [`Join Zoom meeting: ${zoom.joinUrl}`, notes ?? ""].filter(Boolean).join("\n\n");
  try {
    if (cal.graph) {
      const r = await cal.graph.fetch("/me/events", { method: "POST", body: JSON.stringify({
        subject, start: { dateTime: startIso, timeZone: "UTC" }, end: { dateTime: endIso, timeZone: "UTC" },
        location: { displayName: "Zoom", locationUri: zoom.joinUrl },
        body: { contentType: "HTML", content: `<p>Join Zoom meeting: <a href="${escHtml(zoom.joinUrl)}">${escHtml(zoom.joinUrl)}</a></p>${notes ? `<p>${escHtml(notes)}</p>` : ""}` },
        attendees: attendees.map((address) => ({ emailAddress: { address }, type: "required" })),
      }) });
      if (r.ok) { graphEventId = (await r.json().catch(() => ({})))?.id ?? null; invited = true; }
      else console.warn("[meeting-apps] Outlook event for Zoom meeting failed", { userId, status: r.status, detail: (await r.text()).slice(0, 200) });
    } else if (cal.google) {
      const ev = await createGoogleEvent(cal.google, { title: subject, start: startIso, end: endIso, attendees, notes: text, location: zoom.joinUrl, meet: false });
      googleEventId = ev.id; invited = true;
    }
  } catch (err) {
    console.warn("[meeting-apps] calendar event for Zoom meeting failed", { userId, message: err instanceof Error ? err.message.slice(0, 200) : String(err) });
  }

  const silo = resolveSiloFromRequest(req);
  const row = await pool.query(
    `INSERT INTO crm_meetings
       (title, start_at, end_at, location, attendees_json, reminder_minutes, owner_id, contact_id, silo, graph_id, google_event_id, meeting_type, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, 60, $6, $7, $8, $9, $10, 'zoom', 'scheduled')
     RETURNING id::text AS id`,
    [subject, startIso, endIso, zoom.joinUrl, JSON.stringify(attendees.map((address) => ({ address }))), userId, contactId, silo, graphEventId, googleEventId],
  );
  res.json({ success: true, data: { id: row.rows[0]?.id ?? null, zoom_meeting_id: zoom.id, graph_event_id: graphEventId, google_event_id: googleEventId, join_url: zoom.joinUrl, provider: "zoom", invited } });
}
