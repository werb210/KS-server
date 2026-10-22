// KS_SERVER_v10_DEMO - every query the demo makes. Each function that reads or changes a prospect's data takes the
// session id as its first argument and filters on it; the id comes only from a verified demo token (src/demo/tokens.ts).
// Nothing here looks a prospect's row up by its own id alone.
import { randomUUID } from "node:crypto";
import type { Q } from "../plans/state.js";
import { SAMPLE_BUSINESS, SAMPLE_CONTACT, SAMPLE_FINANCIALS, SAMPLE_REQUEST, isDemoStep, type DemoStep } from "./fixture.js";
import { clientCodeFor, codeHash } from "./tokens.js";

export type Walkthrough = {
  current: DemoStep;
  completed: DemoStep[];
  skipped: DemoStep[];
  tour_skipped: boolean;
};

export type SessionRow = {
  id: string; ops_session_id: string; prospect_name: string; prospect_email: string; company: string;
  walkthrough: Partial<Walkthrough>; used_phone: boolean; used_screen: boolean; assistant_questions: number;
  created_at: Date; last_activity_at: Date; expires_at: Date; completed_at: Date | null; complete_sent_at: Date | null;
};

export type DocumentRow = {
  id: string; session_id: string; application_id: string; sample_key: string; category: string; label: string;
  filename: string; mime_type: string; size_bytes: number; uploaded_via: string; status: string;
  reject_reason: string | null; tamper: any; statement_math: any; fraud_status: string | null; decided_at: Date | null;
  created_at: Date;
};

export type ApplicationRow = {
  id: string; session_id: string; status: string; business: any; contact: any; request: any; financials: any;
  financials_reviewed_at: Date | null; credit_summary: any; selected_lenders: string[]; call: any; notes: any[];
  borrower_submitted_at: Date | null; submitted_at: Date | null; has_package: boolean; updated_at: Date;
};

export function walkthroughOf(row: Pick<SessionRow, "walkthrough">): Walkthrough {
  const w = row.walkthrough ?? {};
  return {
    current: isDemoStep(w.current) ? w.current : "welcome",
    completed: (Array.isArray(w.completed) ? w.completed : []).filter(isDemoStep),
    skipped: (Array.isArray(w.skipped) ? w.skipped : []).filter(isDemoStep),
    tour_skipped: w.tour_skipped === true,
  };
}

const SESSION_COLS = `id, ops_session_id, prospect_name, prospect_email, company, walkthrough, used_phone, used_screen,
  assistant_questions, created_at, last_activity_at, expires_at, completed_at, complete_sent_at`;

/** A live (not expired) session by id. */
export async function liveSession(db: Q, sessionId: string): Promise<SessionRow | null> {
  const r = await db.query(`SELECT ${SESSION_COLS} FROM demo_sessions WHERE id = $1 AND expires_at > now()`, [sessionId]);
  return (r.rows[0] as SessionRow) ?? null;
}

export async function sessionByOpsId(db: Q, opsSessionId: string): Promise<SessionRow | null> {
  const r = await db.query(`SELECT ${SESSION_COLS} FROM demo_sessions WHERE ops_session_id = $1`, [opsSessionId]);
  return (r.rows[0] as SessionRow) ?? null;
}

export async function sessionIdByCode(db: Q, code: string): Promise<string | null> {
  const r = await db.query(`SELECT id FROM demo_sessions WHERE client_code_hash = $1 AND expires_at > now()`, [codeHash(code)]);
  return (r.rows[0]?.id as string) ?? null;
}

/** Makes a session and seeds its sample application from the fixture. */
export async function createSession(
  db: Q,
  input: { opsSessionId: string; name: string; email: string; company: string; expiresAt: Date },
): Promise<SessionRow> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO demo_sessions (id, ops_session_id, prospect_name, prospect_email, company, client_code_hash, walkthrough, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [id, input.opsSessionId, input.name, input.email, input.company, codeHash(clientCodeFor(id)),
      JSON.stringify({ current: "welcome", completed: [], skipped: [], tour_skipped: false }), input.expiresAt],
  );
  await db.query(
    `INSERT INTO demo_applications (id, session_id, status, business, contact, request, financials)
     VALUES ($1, $2, 'draft', $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb)`,
    [randomUUID(), id, JSON.stringify(SAMPLE_BUSINESS), JSON.stringify(SAMPLE_CONTACT), JSON.stringify(SAMPLE_REQUEST), JSON.stringify(SAMPLE_FINANCIALS)],
  );
  return (await liveSession(db, id))!;
}

/** Deletes a session and (by cascade) everything it made. */
export async function deleteSessionByOpsId(db: Q, opsSessionId: string): Promise<boolean> {
  const r = await db.query(`DELETE FROM demo_sessions WHERE ops_session_id = $1 RETURNING id`, [opsSessionId]);
  return r.rows.length > 0;
}

/** Wipes sessions that expired more than graceMinutes ago (KS-Ops normally wipes them first). */
export async function deleteExpiredSessions(db: Q, graceMinutes = 60): Promise<number> {
  const r = await db.query(
    `DELETE FROM demo_sessions WHERE expires_at < now() - make_interval(mins => $1::int) RETURNING id`,
    [graceMinutes],
  );
  return r.rows.length;
}

export async function setWalkthrough(db: Q, sessionId: string, w: Walkthrough): Promise<void> {
  await db.query(`UPDATE demo_sessions SET walkthrough = $2::jsonb, last_activity_at = now() WHERE id = $1`, [sessionId, JSON.stringify(w)]);
}

export async function markBorrowerDevice(db: Q, sessionId: string, via: "phone" | "screen"): Promise<void> {
  await db.query(
    via === "phone"
      ? `UPDATE demo_sessions SET used_phone = true, last_activity_at = now() WHERE id = $1`
      : `UPDATE demo_sessions SET used_screen = true, last_activity_at = now() WHERE id = $1`,
    [sessionId],
  );
}

/** Counts one assistant question if the session is under the limit; false when the limit is reached. */
export async function takeAssistantQuestion(db: Q, sessionId: string, limit: number): Promise<boolean> {
  const r = await db.query(
    `UPDATE demo_sessions SET assistant_questions = assistant_questions + 1, last_activity_at = now()
      WHERE id = $1 AND assistant_questions < $2 RETURNING assistant_questions`,
    [sessionId, limit],
  );
  return r.rows.length > 0;
}

const APP_COLS = `id, session_id, status, business, contact, request, financials, financials_reviewed_at, credit_summary,
  selected_lenders, call, notes, borrower_submitted_at, submitted_at, (package_pdf IS NOT NULL) AS has_package, updated_at`;

export async function applicationFor(db: Q, sessionId: string): Promise<ApplicationRow | null> {
  const r = await db.query(`SELECT ${APP_COLS} FROM demo_applications WHERE session_id = $1`, [sessionId]);
  return (r.rows[0] as ApplicationRow) ?? null;
}

const APP_FIELDS = ["status", "credit_summary", "selected_lenders", "call", "notes", "financials_reviewed_at", "borrower_submitted_at", "submitted_at", "package_pdf"] as const;
type AppField = (typeof APP_FIELDS)[number];
const JSON_FIELDS = new Set<AppField>(["credit_summary", "selected_lenders", "call", "notes"]);

/** Sets the named columns on the session's application (column names come from the fixed list above). */
export async function updateApplication(db: Q, sessionId: string, fields: Partial<Record<AppField, unknown>>): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [sessionId];
  for (const [k, v] of Object.entries(fields) as Array<[AppField, unknown]>) {
    if (!APP_FIELDS.includes(k)) throw new Error(`demo: column ${String(k)} not allowed`);
    const json = JSON_FIELDS.has(k);
    params.push(json && v !== null ? JSON.stringify(v) : v);
    sets.push(`${k} = $${params.length}${json ? "::jsonb" : ""}`);
  }
  if (!sets.length) return;
  await db.query(`UPDATE demo_applications SET ${sets.join(", ")}, updated_at = now() WHERE session_id = $1`, params);
}

export async function packageFor(db: Q, sessionId: string): Promise<Buffer | null> {
  const r = await db.query(`SELECT package_pdf FROM demo_applications WHERE session_id = $1`, [sessionId]);
  return (r.rows[0]?.package_pdf as Buffer) ?? null;
}

const DOC_COLS = `id, session_id, application_id, sample_key, category, label, filename, mime_type, size_bytes, uploaded_via,
  status, reject_reason, tamper, statement_math, fraud_status, decided_at, created_at`;

export async function documentsFor(db: Q, sessionId: string): Promise<DocumentRow[]> {
  const r = await db.query(`SELECT ${DOC_COLS} FROM demo_documents WHERE session_id = $1 ORDER BY created_at, sample_key`, [sessionId]);
  return r.rows as DocumentRow[];
}

/** One document of THIS session (null when the id belongs to another session or does not exist). */
export async function documentFor(db: Q, sessionId: string, documentId: string): Promise<DocumentRow | null> {
  const r = await db.query(`SELECT ${DOC_COLS} FROM demo_documents WHERE session_id = $1 AND id = $2`, [sessionId, documentId]);
  return (r.rows[0] as DocumentRow) ?? null;
}

export async function documentContent(db: Q, sessionId: string, documentId: string): Promise<{ content: Buffer; mime_type: string; filename: string } | null> {
  const r = await db.query(`SELECT content, mime_type, filename FROM demo_documents WHERE session_id = $1 AND id = $2`, [sessionId, documentId]);
  return (r.rows[0] as { content: Buffer; mime_type: string; filename: string }) ?? null;
}

/** Accepted documents' files, for the lender package. */
export async function acceptedDocumentFiles(db: Q, sessionId: string): Promise<Array<{ label: string; content: Buffer; mime_type: string }>> {
  const r = await db.query(
    `SELECT label, content, mime_type FROM demo_documents WHERE session_id = $1 AND status = 'accepted' ORDER BY created_at, sample_key`,
    [sessionId],
  );
  return r.rows as Array<{ label: string; content: Buffer; mime_type: string }>;
}

/** Stores (or replaces) the upload of one sample; a re-upload goes back to pending. */
export async function upsertDocument(
  db: Q,
  sessionId: string,
  d: { applicationId: string; sampleKey: string; category: string; label: string; filename: string; mime: string; content: Buffer; via: string; tamper: unknown; statementMath: unknown; fraudStatus: string },
): Promise<DocumentRow> {
  const r = await db.query(
    `INSERT INTO demo_documents (id, session_id, application_id, sample_key, category, label, filename, mime_type, size_bytes, content,
       uploaded_via, status, tamper, statement_math, fraud_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12::jsonb, $13::jsonb, $14)
     ON CONFLICT (session_id, sample_key) DO UPDATE SET content = EXCLUDED.content, size_bytes = EXCLUDED.size_bytes,
       uploaded_via = EXCLUDED.uploaded_via, status = 'pending', reject_reason = NULL, decided_at = NULL,
       tamper = EXCLUDED.tamper, statement_math = EXCLUDED.statement_math, fraud_status = EXCLUDED.fraud_status,
       created_at = now()
     RETURNING ${DOC_COLS}`,
    [randomUUID(), sessionId, d.applicationId, d.sampleKey, d.category, d.label, d.filename, d.mime, d.content.length, d.content,
      d.via, JSON.stringify(d.tamper), d.statementMath === null ? null : JSON.stringify(d.statementMath), d.fraudStatus],
  );
  return r.rows[0] as DocumentRow;
}

export async function decideDocument(db: Q, sessionId: string, documentId: string, status: "accepted" | "rejected", reason: string | null): Promise<DocumentRow | null> {
  const r = await db.query(
    `UPDATE demo_documents SET status = $3, reject_reason = $4, decided_at = now()
      WHERE session_id = $1 AND id = $2 RETURNING ${DOC_COLS}`,
    [sessionId, documentId, status, reason],
  );
  return (r.rows[0] as DocumentRow) ?? null;
}

export async function messagesFor(db: Q, sessionId: string): Promise<Array<{ role: string; body: string; created_at: Date }>> {
  const r = await db.query(`SELECT role, body, created_at FROM demo_messages WHERE session_id = $1 ORDER BY id`, [sessionId]);
  return r.rows as Array<{ role: string; body: string; created_at: Date }>;
}

export async function addMessage(db: Q, sessionId: string, role: "borrower" | "assistant", body: string): Promise<void> {
  await db.query(`INSERT INTO demo_messages (session_id, role, body) VALUES ($1, $2, $3)`, [sessionId, role, body]);
}

export async function markCompleted(db: Q, sessionId: string): Promise<void> {
  await db.query(`UPDATE demo_sessions SET completed_at = COALESCE(completed_at, now()), last_activity_at = now() WHERE id = $1`, [sessionId]);
}

export async function countEvents(db: Q, sessionId: string): Promise<number> {
  const r = await db.query(`SELECT count(*)::int AS n FROM demo_events WHERE session_id = $1`, [sessionId]);
  return Number(r.rows[0]?.n ?? 0);
}
