// KS_SERVER_v10_DEMO - tells KS-Ops what the prospect does, so sales can follow up.
//
// Every step, click and upload is written to demo_events (the outbox) in the same request, then sent in batches:
//   POST {KS_OPS_URL}/api/demo/sessions/{ops_session_id}/events    { events: [{ type, step, at, data }] }
//   POST {KS_OPS_URL}/api/demo/sessions/{ops_session_id}/complete  { summary, package_pdf_base64, package_filename }
// both with X-KS-Ops-Key = KS_OPS_KEY. KS-Ops sends the two demo emails (the prospect's lender package and the note
// to sales); this server sends no email at all. A failed post is retried by the flusher (every 15 s).
import type pg from "pg";
import type { Q } from "../plans/state.js";
import { demoOpsKey, demoOpsUrl } from "./config.js";

export type DemoEventType =
  | "session_created" | "portal_opened" | "step_viewed" | "step_completed" | "step_skipped" | "tour_skipped" | "tour_resumed"
  | "borrower_joined" | "document_uploaded" | "borrower_submitted" | "assistant_question" | "document_viewed"
  | "document_decision" | "call_rang" | "call_answered" | "call_declined" | "call_completed" | "financials_reviewed"
  | "credit_summary_built" | "lenders_selected" | "submitted" | "package_downloaded" | "heartbeat" | "click";

export const MAX_EVENTS_PER_SESSION = 2000;

export async function recordEvent(
  db: Q,
  sessionId: string,
  type: DemoEventType,
  opts: { step?: string | null; data?: Record<string, unknown> } = {},
): Promise<void> {
  // Bounded per session, so a looping page cannot fill the table.
  await db.query(
    `INSERT INTO demo_events (session_id, type, step, data)
     SELECT $1, $2, $3, $4::jsonb
      WHERE (SELECT count(*) FROM demo_events WHERE session_id = $1) < $5`,
    [sessionId, type, opts.step ?? null, JSON.stringify(opts.data ?? {}), MAX_EVENTS_PER_SESSION],
  );
  await db.query(`UPDATE demo_sessions SET last_activity_at = now() WHERE id = $1`, [sessionId]);
}

export type OpsPoster = (path: string, body: unknown) => Promise<{ ok: boolean; status: number | null; error?: string }>;

/** POST to KS-Ops with the ops key; never throws. */
export const postToKsOps: OpsPoster = async (path, body) => {
  const base = demoOpsUrl();
  const key = demoOpsKey();
  if (!base || !key) return { ok: false, status: null, error: "ops_not_configured" };
  try {
    const r = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-KS-Ops-Key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    return r.ok ? { ok: true, status: r.status } : { ok: false, status: r.status, error: `status_${r.status}` };
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
  }
};

type Pool = Pick<pg.Pool, "connect">;

/** Sends unsent events (oldest first, at most 500 per run), grouped by session. Rows are claimed with SKIP LOCKED so two
 * instances never send the same event. */
export async function flushEvents(pool: Pool, post: OpsPoster = postToKsOps): Promise<{ sent: number; failed: number }> {
  const client = await pool.connect();
  let sent = 0, failed = 0;
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `SELECT e.id, e.session_id, s.ops_session_id, e.type, e.step, e.data, e.created_at
         FROM demo_events e JOIN demo_sessions s ON s.id = e.session_id
        WHERE e.sent_at IS NULL AND e.attempts < 50
        ORDER BY e.id
        LIMIT 500
        FOR UPDATE OF e SKIP LOCKED`,
    );
    const bySession = new Map<string, { ops: string; ids: number[]; events: unknown[] }>();
    for (const row of r.rows) {
      const g: { ops: string; ids: number[]; events: unknown[] } = bySession.get(row.session_id) ?? { ops: String(row.ops_session_id), ids: [], events: [] };
      g.ids.push(Number(row.id));
      g.events.push({ type: row.type, step: row.step, at: new Date(row.created_at).toISOString(), data: row.data ?? {} });
      bySession.set(row.session_id, g);
    }
    for (const g of bySession.values()) {
      const res = await post(`/api/demo/sessions/${encodeURIComponent(g.ops)}/events`, { events: g.events });
      if (res.ok) {
        await client.query(`UPDATE demo_events SET sent_at = now() WHERE id = ANY($1::bigint[])`, [g.ids]);
        sent += g.ids.length;
      } else {
        await client.query(`UPDATE demo_events SET attempts = attempts + 1 WHERE id = ANY($1::bigint[])`, [g.ids]);
        failed += g.ids.length;
        if (res.error !== "ops_not_configured") console.warn(`[demo] progress post failed: ${res.error}`);
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch((e: unknown) => console.warn("[demo] rollback failed", String(e)));
    throw err;
  } finally {
    client.release();
  }
  return { sent, failed };
}

/** Sends the completion (summary + lender package) for submitted sessions KS-Ops has not taken yet. */
export async function flushCompletions(pool: Pool, post: OpsPoster = postToKsOps): Promise<number> {
  const client = await pool.connect();
  let done = 0;
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `SELECT s.id, s.ops_session_id, s.prospect_name, s.prospect_email, s.company, s.used_phone, s.used_screen,
              s.walkthrough, s.created_at, s.completed_at, a.package_pdf, a.selected_lenders
         FROM demo_sessions s JOIN demo_applications a ON a.session_id = s.id
        WHERE s.completed_at IS NOT NULL AND s.complete_sent_at IS NULL AND s.complete_attempts < 50
          AND a.package_pdf IS NOT NULL
        ORDER BY s.completed_at
        LIMIT 10
        FOR UPDATE OF s SKIP LOCKED`,
    );
    for (const row of r.rows) {
      const res = await post(`/api/demo/sessions/${encodeURIComponent(row.ops_session_id)}/complete`, {
        summary: {
          name: row.prospect_name, email: row.prospect_email, company: row.company,
          used_phone: row.used_phone, used_screen: row.used_screen, walkthrough: row.walkthrough,
          started_at: new Date(row.created_at).toISOString(), completed_at: new Date(row.completed_at).toISOString(),
          lenders: row.selected_lenders,
        },
        package_filename: "Lender-Submission-Package-SAMPLE.pdf",
        package_pdf_base64: Buffer.from(row.package_pdf).toString("base64"),
      });
      if (res.ok) {
        await client.query(`UPDATE demo_sessions SET complete_sent_at = now() WHERE id = $1`, [row.id]);
        done++;
      } else {
        await client.query(`UPDATE demo_sessions SET complete_attempts = complete_attempts + 1 WHERE id = $1`, [row.id]);
        if (res.error !== "ops_not_configured") console.warn(`[demo] completion post failed: ${res.error}`);
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch((e: unknown) => console.warn("[demo] rollback failed", String(e)));
    throw err;
  } finally {
    client.release();
  }
  return done;
}
