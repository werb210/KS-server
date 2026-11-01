// KS_HUBSPOT_GAPS_1_MEETING_NOTES - brings Zoom and Google Meet transcripts in for every connected person, matches each
// meeting to a contact by its guests' email addresses, and files it in teams_meetings (provider zoom / google_meet) so
// the existing AI summary (runMeetingIntel: summary + follow-up tasks) and the contact timeline pick it up unchanged.
// A meeting with no matching contact is kept; its owner can pick the contact in the portal.
import type { Pool } from "pg";
import { getGoogleForUser } from "../services/workspace/googleAuth.js";
import { meetNotesEnabled } from "../services/workspace/googleConfig.js";
import { runMeetingIntel } from "../services/teams/meetingIntel.js";
import { meetCalendarEvent, meetHasScope, meetRecordsSince, meetTranscriptText } from "./googleMeet.js";
import { zoomConfig, zoomForUser, zoomParticipantEmails, zoomTranscriptMeetings, type Q, type ZoomConfig } from "./zoom.js";

export const PROVIDERS = ["teams", "zoom", "google_meet"] as const;
export const PROVIDER_LABEL: Record<string, string> = { teams: "Teams", zoom: "Zoom", google_meet: "Google Meet" };
const FIRST_SYNC_DAYS = 14;
const OVERLAP_MS = 24 * 3600_000;

/** The contact a meeting is with: the first guest email that is a contact (staff addresses are skipped). */
export async function matchContact(db: Q, emails: string[]): Promise<{ contactId: string; companyId: string | null } | null> {
  const clean = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")))];
  if (!clean.length) return null;
  const r = await db.query(
    `SELECT c.id::text AS id, c.company_id::text AS company_id
       FROM contacts c
      WHERE c.merged_into_id IS NULL
        AND (lower(c.email) = ANY($1::text[]) OR lower(c.secondary_email) = ANY($1::text[]))
        AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(c.email))
      ORDER BY array_position($1::text[], lower(c.email)) NULLS LAST, c.updated_at DESC NULLS LAST
      LIMIT 1`, [clean]);
  const row = r.rows[0];
  return row ? { contactId: String(row.id), companyId: row.company_id ? String(row.company_id) : null } : null;
}

export type ImportInput = {
  provider: "zoom" | "google_meet"; externalId: string; userId: string; subject: string; start: Date; end: Date;
  transcript: string; recordingUrl: string | null; emails: string[];
};

/** Files one meeting (once per provider meeting). Returns the new row id, or null when it was already imported. */
export async function importMeeting(db: Q, m: ImportInput): Promise<string | null> {
  const match = await matchContact(db, m.emails);
  const r = await db.query(
    `INSERT INTO teams_meetings (silo, provider, external_id, organizer_user_id, subject, scheduled_at, scheduled_end_at, started_at, ended_at,
                                 transcript_text, transcript_fetched_at, recording_url, contact_id, company_id, status, match_method)
     VALUES ('BF', $1, $2, $3::uuid, $4, $5, $6, $5, $6, $7, now(), $8, $9::uuid, $10::uuid, 'transcribed', $11)
     ON CONFLICT (provider, external_id) WHERE external_id IS NOT NULL DO NOTHING
     RETURNING id::text AS id`,
    [m.provider, m.externalId, m.userId, m.subject.slice(0, 300), m.start, m.end, m.transcript, m.recordingUrl,
      match?.contactId ?? null, match?.companyId ?? null, match ? "guest_email" : null]);
  return r.rows[0]?.id ?? null;
}

async function alreadyImported(db: Q, provider: string, externalId: string): Promise<boolean> {
  return (await db.query(`SELECT 1 FROM teams_meetings WHERE provider = $1 AND external_id = $2`, [provider, externalId])).rows.length > 0;
}

export async function syncZoomUser(db: Q, cfg: ZoomConfig, userId: string, now = new Date()): Promise<number> {
  const z = await zoomForUser(db, cfg, userId);
  if (!z) return 0;
  const last = (await db.query(`SELECT last_synced_at FROM zoom_accounts WHERE user_id = $1::uuid`, [userId])).rows[0]?.last_synced_at;
  const from = last ? new Date(new Date(last).getTime() - OVERLAP_MS) : new Date(now.getTime() - FIRST_SYNC_DAYS * 86_400_000);
  let n = 0;
  try {
    for (const m of await zoomTranscriptMeetings(z, from, now)) {
      if (await alreadyImported(db, "zoom", m.uuid)) continue;
      const vtt = await z.download(m.transcriptUrl);
      if (!vtt.trim()) continue;
      const emails = await zoomParticipantEmails(z, m.uuid);
      if (await importMeeting(db, { provider: "zoom", externalId: m.uuid, userId, subject: m.topic, start: m.start, end: m.end, transcript: vtt, recordingUrl: m.shareUrl, emails })) n++;
    }
    await db.query(`UPDATE zoom_accounts SET last_synced_at = $2, last_error = NULL, updated_at = now() WHERE user_id = $1::uuid`, [userId, now]);
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    console.error("[meeting-notes] Zoom sync failed", { userId, message });
    await db.query(`UPDATE zoom_accounts SET last_error = $2, updated_at = now() WHERE user_id = $1::uuid`, [userId, message]);
  }
  return n;
}

export async function syncGoogleMeetUser(db: Q, userId: string, now = new Date()): Promise<number> {
  const g = await getGoogleForUser(db, userId);
  if (!g || !meetHasScope(g)) return 0;
  const last = (await db.query(`SELECT last_synced_at FROM google_meet_sync WHERE user_id = $1::uuid`, [userId])).rows[0]?.last_synced_at;
  const since = last ? new Date(new Date(last).getTime() - OVERLAP_MS) : new Date(now.getTime() - FIRST_SYNC_DAYS * 86_400_000);
  let n = 0;
  let error: string | null = null;
  try {
    for (const rec of await meetRecordsSince(g, since)) {
      if (await alreadyImported(db, "google_meet", rec.name)) continue;
      const t = await meetTranscriptText(g, rec.name);
      if (!t) continue; // no transcript, or Google is still writing it: looked at again next time (the overlap)
      const ev = await meetCalendarEvent(g, rec);
      const emails = ev.attendees.filter((e) => e !== g.email.toLowerCase());
      if (await importMeeting(db, { provider: "google_meet", externalId: rec.name, userId, subject: ev.title ?? "Google Meet", start: rec.start, end: rec.end, transcript: t.text, recordingUrl: t.docUrl, emails })) n++;
    }
  } catch (err) {
    error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    console.error("[meeting-notes] Google Meet sync failed", { userId, message: error });
  }
  await db.query(
    `INSERT INTO google_meet_sync (user_id, last_synced_at, last_error, updated_at) VALUES ($1::uuid, CASE WHEN $3::text IS NULL THEN $2::timestamptz END, $3, now())
     ON CONFLICT (user_id) DO UPDATE SET last_synced_at = CASE WHEN $3::text IS NULL THEN $2::timestamptz ELSE google_meet_sync.last_synced_at END, last_error = $3, updated_at = now()`,
    [userId, now, error]);
  return n;
}

/** One pass for everyone connected (or one person), then the AI summary for anything new. */
export async function runMeetingNotesSync(pool: Pool, opts: { userId?: string; now?: Date } = {}): Promise<{ zoom: number; google_meet: number }> {
  const db = pool as unknown as Q;
  const out = { zoom: 0, google_meet: 0 };
  const cfg = zoomConfig();
  if (cfg) {
    const users = (await db.query(`SELECT user_id::text AS id FROM zoom_accounts WHERE status = 'connected' AND ($1::uuid IS NULL OR user_id = $1::uuid)`, [opts.userId ?? null])).rows;
    for (const u of users) out.zoom += await syncZoomUser(db, cfg, String(u.id), opts.now);
  }
  if (meetNotesEnabled()) {
    const users = (await db.query(`SELECT user_id::text AS id FROM google_workspace_accounts WHERE status = 'connected' AND ($1::uuid IS NULL OR user_id = $1::uuid)`, [opts.userId ?? null])).rows;
    for (const u of users) out.google_meet += await syncGoogleMeetUser(db, String(u.id), opts.now);
  }
  if (out.zoom || out.google_meet) await runMeetingIntel(pool);
  return out;
}
