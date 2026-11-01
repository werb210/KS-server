// KS_SERVER_MARKETING_ADDON - refreshes lead scores every 30 minutes while the Marketing add-on is in force: contacts
// with activity in the last 2 days first, then those never scored or scored over a day ago (up to 2,000 a tick).
import type { Pool } from "pg";
import { claimedTick } from "./claim.js";
import { getPlanState, type Q } from "../plans/state.js";
import { marketingAddonActive } from "../plans/marketing.js";
import { STALE_CONTACTS_SQL, scoreContacts, scoringSettings } from "../marketing/leadScoring.js";

const TICK_MS = 30 * 60_000;
export const SCORE_BATCH = 2000;

export async function runLeadScoresOnce(db: Q, now: Date = new Date()): Promise<{ scored: number; skipped?: string }> {
  if (!marketingAddonActive(await getPlanState(db, now.getTime()), now)) return { scored: 0, skipped: "no_addon" };
  const r = await db.query(STALE_CONTACTS_SQL, [SCORE_BATCH]);
  const ids = [...new Set(r.rows.map((x: any) => String(x.id)))];
  const settings = await scoringSettings(db);
  let scored = 0;
  for (let i = 0; i < ids.length; i += 500) scored += (await scoreContacts(db, ids.slice(i, i + 500), settings)).length;
  return { scored };
}

export function startLeadScoreWorker(pool: Pool): { stop: () => void } {
  const tick = claimedTick("lead_scores", async () => {
    const out = await runLeadScoresOnce(pool as unknown as Q);
    if (out.scored) console.log("[lead-scores] refreshed", out.scored);
  });
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  const kickoff = setTimeout(() => { void tick(); }, 5 * 60_000);
  return { stop: () => { clearInterval(timer); clearTimeout(kickoff); } };
}
