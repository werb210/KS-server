// KS_HUBSPOT_GAPS_1_MEETING_NOTES - Google Meet transcripts through the person's existing Google connection.
//
// Google Meet saves a transcript (a Google Doc in the organizer's Drive, "Meet Recordings") when transcription is on.
// The Meet REST API (meetings.space.readonly) lists the person's conference records and returns the same transcript
// as speaker-attributed entries, so no Drive-wide read access is needed. The meeting is matched to a contact from the
// Google Calendar event that carried the Meet link (its guests), read with the calendar access already granted.
// The scope is only requested when GOOGLE_MEET_NOTES_ENABLED=true (see googleConfig.ts); people who connected Google
// before that reconnect once.
import type { GoogleClient } from "../services/workspace/googleAuth.js";
import { SCOPE_MEET_READONLY, hasScope } from "../services/workspace/googleConfig.js";
import { listGoogleEvents } from "../services/workspace/google.js";

export { SCOPE_MEET_READONLY };
const MEET = "https://meet.googleapis.com/v2";

export const meetHasScope = (g: Pick<GoogleClient, "scopes">) => hasScope(g.scopes, SCOPE_MEET_READONLY);

async function get<T = any>(g: GoogleClient, url: string): Promise<T> {
  const r = await g.fetch(url);
  const text = await r.text();
  if (!r.ok) throw new Error(`google_meet_${r.status} ${url.replace(MEET, "").split("?")[0]} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export type MeetRecord = { name: string; start: Date; end: Date; space: string; meetingCode: string | null };

/** Conference records that ended after `since` (newest first, at most 50). */
export async function meetRecordsSince(g: GoogleClient, since: Date): Promise<MeetRecord[]> {
  const filter = `end_time>="${since.toISOString()}"`;
  const r = await get<any>(g, `${MEET}/conferenceRecords?pageSize=50&filter=${encodeURIComponent(filter)}`);
  const out: MeetRecord[] = [];
  for (const c of r?.conferenceRecords ?? []) {
    if (!c?.name || !c?.endTime) continue; // still running
    let meetingCode: string | null = null;
    if (c.space) {
      try { meetingCode = (await get<any>(g, `${MEET}/${c.space}`))?.meetingCode ?? null; } catch (err) {
        console.warn("[google-meet] space not readable", { message: err instanceof Error ? err.message : String(err) });
      }
    }
    out.push({ name: String(c.name), start: new Date(c.startTime), end: new Date(c.endTime), space: String(c.space ?? ""), meetingCode });
  }
  return out;
}

/** The finished transcript as "Speaker: words" lines, or null when there is none (yet). */
export async function meetTranscriptText(g: GoogleClient, record: string): Promise<{ text: string; docUrl: string | null } | null> {
  const t = await get<any>(g, `${MEET}/${record}/transcripts`);
  const done = (t?.transcripts ?? []).find((x: any) => x?.state === "FILE_GENERATED");
  if (!done?.name) return null;
  const people = new Map<string, string>();
  let pageToken = "";
  for (let i = 0; i < 5; i++) {
    const p = await get<any>(g, `${MEET}/${record}/participants?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
    for (const x of p?.participants ?? []) {
      const nm = x?.signedinUser?.displayName ?? x?.anonymousUser?.displayName ?? x?.phoneUser?.displayName ?? "Guest";
      people.set(String(x.name), String(nm));
    }
    pageToken = String(p?.nextPageToken ?? "");
    if (!pageToken) break;
  }
  const lines: string[] = [];
  pageToken = "";
  for (let i = 0; i < 40; i++) {
    const e = await get<any>(g, `${MEET}/${done.name}/entries?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
    for (const x of e?.transcriptEntries ?? []) {
      const words = String(x?.text ?? "").trim();
      if (words) lines.push(`${people.get(String(x.participant)) ?? "Speaker"}: ${words}`);
    }
    pageToken = String(e?.nextPageToken ?? "");
    if (!pageToken) break;
  }
  if (!lines.length) return null;
  return { text: lines.join("\n"), docUrl: done?.docsDestination?.exportUri ?? null };
}

/** The calendar event that held the Meet link: its title and guest emails. */
export async function meetCalendarEvent(g: GoogleClient, rec: MeetRecord): Promise<{ title: string | null; attendees: string[] }> {
  if (!rec.meetingCode) return { title: null, attendees: [] };
  const from = new Date(rec.start.getTime() - 2 * 3600_000).toISOString();
  const to = new Date(rec.end.getTime() + 2 * 3600_000).toISOString();
  try {
    const events = await listGoogleEvents(g, from, to);
    const code = rec.meetingCode.toLowerCase();
    const ev = events.find((e) => String(e.meetLink ?? "").toLowerCase().includes(code));
    return { title: ev?.title ?? null, attendees: (ev?.attendees ?? []).map((a) => a.toLowerCase()) };
  } catch (err) {
    console.warn("[google-meet] calendar lookup failed", { message: err instanceof Error ? err.message : String(err) });
    return { title: null, attendees: [] };
  }
}
