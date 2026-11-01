// KS_HUBSPOT_GAPS_1_MEETING_NOTES - every 15 minutes, one instance per tick: Zoom and Google Meet transcripts for every
// connected person, then the AI summary and follow-up tasks for meetings that have a transcript but no summary yet.
// Idle when neither Zoom nor Google Meet notes are set up on this server.
import type { Pool } from "pg";
import { claimedTick } from "./claim.js";
import { runMeetingNotesSync } from "../meetingNotes/sync.js";
import { zoomConfig } from "../meetingNotes/zoom.js";
import { meetNotesEnabled } from "../services/workspace/googleConfig.js";
import { runMeetingIntel } from "../services/teams/meetingIntel.js";

const TICK_MS = 15 * 60 * 1000;
const KICKOFF_MS = 40 * 1000;

export function startMeetingNotesWorker(pool: Pool): { stop: () => void } {
  const tick = claimedTick("meeting_notes", async () => {
    if (!zoomConfig() && !meetNotesEnabled()) return;
    try {
      const r = await runMeetingNotesSync(pool);
      if (r.zoom || r.google_meet) console.log(JSON.stringify({ event: "meeting_notes_imported", ...r }));
      const pending = await pool.query(
        `SELECT 1 FROM teams_meetings WHERE provider IN ('zoom', 'google_meet') AND transcript_text IS NOT NULL AND maya_summary IS NULL LIMIT 1`);
      if (pending.rows.length) await runMeetingIntel(pool);
    } catch (e) {
      console.error("[meeting-notes-worker] tick failed", e instanceof Error ? e.message : e);
    }
  });
  const kickoff = setTimeout(() => { void tick(); }, KICKOFF_MS);
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  return { stop: () => { clearTimeout(kickoff); clearInterval(timer); } };
}
