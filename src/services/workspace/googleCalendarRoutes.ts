// KS_SERVER_v12_GOOGLE_WORKSPACE - /api/calendar for a staff member on Google Calendar (calendar.events).
// Same request and response shapes as the Graph branch in routes/calendar.ts, so the portal grid, the Add Event
// form and Find-a-time work unchanged. Events created as online meetings get a Google Meet link (where Graph
// would create a Teams meeting) and are logged to crm_meetings for every attendee who is a CRM contact.
import { pool } from "../../db.js";
import { getGoogleForUser } from "./googleAuth.js";
import {
  availabilityView, cancelGoogleEvent, createGoogleEvent, googleBusyTimes, listGoogleEvents, updateGoogleEvent,
  type GoogleApiError,
} from "./google.js";
import type { GoogleClient } from "./googleAuth.js";
import { googleErrorDetail } from "./googleFeatures.js";

function attendeeEmails(raw: unknown): string[] {
  let list: string[] = [];
  if (Array.isArray(raw)) list = raw.map((a: any) => (typeof a === "string" ? a : (a?.emailAddress?.address ?? a?.email ?? a?.address ?? "")));
  else if (typeof raw === "string") list = raw.split(/[\s,;]+/);
  const seen = new Set<string>();
  return list.map((x) => String(x ?? "").trim()).filter((x) => {
    const k = x.toLowerCase();
    if (!x.includes("@") || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function relay(res: any, err: unknown): void {
  const status = (err as GoogleApiError)?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    res.status(status === 401 || status === 403 ? 412 : status).json({ status: "error", code: status === 401 || status === 403 ? "google_insufficient_scope" : "google_client_error", message: (err as Error).message, details: googleErrorDetail(err) });
    return;
  }
  res.status(502).json({ status: "error", code: "google_calendar_failed", message: googleErrorDetail(err) });
}

export const googleCalendar = {
  async summary(_req: any, res: any, g: GoogleClient, win: { start: string; end: string }) {
    try {
      const items = await listGoogleEvents(g, win.start, win.end);
      res.status(200).json({ status: "ok", data: { items, connected: true, provider: "google" } });
    } catch (err) {
      console.warn("google_calendar_list_failed", { message: (err as Error)?.message });
      res.status(200).json({ status: "ok", data: { items: [], connected: true, provider: "google", error: "google_fetch_failed" } });
    }
  },

  async list(_req: any, res: any, g: GoogleClient, win: { start: string; end: string }) {
    try {
      res.status(200).json({ status: "ok", data: await listGoogleEvents(g, win.start, win.end) });
    } catch (err) {
      console.warn("google_calendar_list_failed", { message: (err as Error)?.message });
      res.status(200).json({ status: "ok", data: [] });
    }
  },

  async create(req: any, res: any, g: GoogleClient, getSilo: (res: any) => string) {
    const body = req.body ?? {};
    const title = body.title ?? body.subject ?? "Untitled Event";
    const start = body.start ?? body.startDateTime ?? new Date().toISOString();
    const end = body.end ?? body.endDateTime ?? new Date(Date.now() + 3600000).toISOString();
    const emails = attendeeEmails(body.attendees);
    const meet = body.online === true || body.meet === true || body.isOnlineMeeting === true || body.meeting_type === "teams" || body.meeting_type === "video";
    let created;
    try {
      created = await createGoogleEvent(g, { title, start, end, notes: body.notes ?? body.description ?? null, location: body.location ?? null, attendees: emails, meet });
    } catch (err) {
      return relay(res, err);
    }
    // Same channel-level meeting logging as the Graph branch (BF_SERVER_BLOCK_v734).
    try {
      let silo = "BF";
      try { silo = getSilo(res); } catch { silo = "BF"; }
      const lower = emails.map((e) => e.toLowerCase());
      if (lower.length) {
        const m = await pool.query(`SELECT id FROM contacts WHERE silo = $1 AND lower(email) = ANY($2::text[])`, [silo, lower]);
        for (const row of m.rows) {
          await pool.query(
            `INSERT INTO crm_meetings
               (title,attendee_description,internal_note,start_at,end_at,location,
                attendees_json,reminder_minutes,owner_id,contact_id,company_id,google_event_id,silo)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)`,
            [title, lower.join(", "), null, start, end, created.joinUrl ?? body.location ?? null, JSON.stringify(body.attendees ?? []), 60, req.user?.userId ?? null, row.id, null, created.id, silo],
          );
        }
      }
    } catch (err) {
      console.warn("google_calendar_meeting_log_failed", { message: (err as Error)?.message });
    }
    res.status(201).json({ status: "ok", data: created.event });
  },

  async update(req: any, res: any, g: GoogleClient, id: string) {
    const body = req.body ?? {};
    try {
      const ev = await updateGoogleEvent(g, id, {
        title: body.title ?? body.subject, start: body.start ?? body.startDateTime, end: body.end ?? body.endDateTime,
        notes: body.description ?? body.notes, location: body.location,
      });
      res.status(200).json({ status: "ok", data: ev });
    } catch (err) {
      relay(res, err);
    }
  },

  async cancel(_req: any, res: any, g: GoogleClient, id: string) {
    try {
      await cancelGoogleEvent(g, id);
      res.status(200).json({ status: "ok", data: null });
    } catch (err) {
      relay(res, err);
    }
  },

  /** Find-a-time: each teammate's busy blocks from their own Google connection, as Graph-style availabilityView. */
  async schedule(req: any, res: any) {
    const emails = String(req.query.emails ?? "").split(",").map((e: string) => e.trim()).filter(Boolean).slice(0, 20);
    if (!emails.length) return res.status(400).json({ status: "error", error: "emails required" });
    const nowD = new Date();
    const dayStart = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate(), 0, 0, 0));
    const from = new Date(typeof req.query.start === "string" ? req.query.start : dayStart.toISOString());
    const to = new Date(typeof req.query.end === "string" ? req.query.end : new Date(dayStart.getTime() + 86_400_000).toISOString());
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return res.status(400).json({ status: "error", error: "invalid window" });
    const owners = await pool.query(
      `SELECT g.user_id::text AS user_id, lower(COALESCE(g.google_email, '')) AS google_email, lower(COALESCE(u.email, '')) AS email
         FROM google_workspace_accounts g JOIN users u ON u.id = g.user_id
        WHERE g.status = 'connected' AND (lower(g.google_email) = ANY($1::text[]) OR lower(u.email) = ANY($1::text[]))`,
      [emails.map((e) => e.toLowerCase())],
    );
    const schedules = [];
    for (const email of emails) {
      const k = email.toLowerCase();
      const owner = owners.rows.find((r: any) => r.google_email === k || r.email === k);
      if (!owner) { schedules.push({ scheduleId: email, availabilityView: "", error: { message: "This person has not connected Google Calendar." } }); continue; }
      try {
        const client = await getGoogleForUser(pool, owner.user_id);
        if (!client) { schedules.push({ scheduleId: email, availabilityView: "", error: { message: "This person needs to reconnect Google." } }); continue; }
        const busy = await googleBusyTimes(client, from, to);
        schedules.push({ scheduleId: email, availabilityView: availabilityView(busy, from, to, 30), scheduleItems: busy.map((b) => ({ status: "busy", start: { dateTime: b.start.toISOString().slice(0, 19), timeZone: "UTC" }, end: { dateTime: b.end.toISOString().slice(0, 19), timeZone: "UTC" } })) });
      } catch (err) {
        schedules.push({ scheduleId: email, availabilityView: "", error: { message: googleErrorDetail(err).slice(0, 200) } });
      }
    }
    res.status(200).json({ status: "ok", data: { schedules, connected: true, provider: "google" } });
  },
};
