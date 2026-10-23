// KS_SERVER_v12_GOOGLE_WORKSPACE - the Google halves of existing Microsoft 365 routes, kept here so the O365 code
// paths stay exactly as they were. Each one answers in the same shape as its Graph counterpart.
import { pool } from "../../db.js";
import { resolveSiloFromRequest } from "../../middleware/silo.js";
import { brandName } from "../../licensee/brand.js";
import type { GoogleClient } from "./googleAuth.js";
import { GoogleApiError, createGoogleEvent, ensureGoogleClientFolder, listGoogleFolderFiles } from "./google.js";

export function googleErrorDetail(err: unknown): string {
  const e = err as { bodyText?: string; message?: string };
  return String(e?.bodyText || e?.message || "Google request failed").slice(0, 500);
}

/** 401/403 from Google -> the same "reconnect" answer the Graph routes give (412). */
export function sendGoogleFailure(res: any, err: unknown, code: string): void {
  if (err instanceof GoogleApiError && (err.status === 401 || err.status === 403)) {
    res.status(412).json({ error: "google_insufficient_scope", detail: googleErrorDetail(err) });
    return;
  }
  if (err instanceof GoogleApiError && err.status >= 400 && err.status < 500) {
    res.status(err.status).json({ error: code, detail: googleErrorDetail(err) });
    return;
  }
  res.status(502).json({ error: code, detail: googleErrorDetail(err) });
}

/** POST /api/o365/meetings/schedule for a Google user: Calendar event + Google Meet, logged as a CRM meeting. */
export async function scheduleGoogleMeeting(req: any, res: any, g: GoogleClient, userId: string): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const contactId = typeof body.contact_id === "string" ? body.contact_id : null;
  const subject = typeof body.subject === "string" && body.subject.trim() ? body.subject.trim() : `${brandName()} meeting`;
  const startIso = typeof body.start === "string" ? body.start : null;
  const endIso = typeof body.end === "string" ? body.end : null;
  const attendees = Array.isArray(body.attendees) ? (body.attendees as unknown[]).map((a) => String(a)).filter((a) => a.includes("@")) : [];
  if (!contactId) return void res.status(400).json({ error: "contact_id_required" });
  if (!startIso || !endIso) return void res.status(400).json({ error: "start_and_end_required" });
  let created;
  try {
    created = await createGoogleEvent(g, { title: subject, start: startIso, end: endIso, attendees, meet: true });
  } catch (err) {
    return sendGoogleFailure(res, err, "google_event_create_failed");
  }
  const silo = resolveSiloFromRequest(req);
  const row = await pool.query(
    `INSERT INTO crm_meetings
       (title, start_at, end_at, location, attendees_json, reminder_minutes, owner_id, contact_id, silo, google_event_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, 60, $6, $7, $8, $9)
     RETURNING id::text AS id`,
    [subject, startIso, endIso, created.joinUrl, JSON.stringify(attendees.map((address) => ({ address }))), userId, contactId, silo, created.id],
  );
  res.json({ success: true, data: { id: row.rows[0]?.id ?? null, google_event_id: created.id, graph_event_id: null, join_url: created.joinUrl, organizer: g.email || null, provider: "google" } });
}

/** POST /api/o365/contacts/:id/folder for a Google user. */
export async function googleContactFolder(res: any, g: GoogleClient, contactId: string, contactName: string): Promise<void> {
  const existing = await pool.query(`SELECT google_drive_folder_url FROM contacts WHERE id = $1::uuid`, [contactId]);
  const have = existing.rows[0]?.google_drive_folder_url as string | null | undefined;
  if (have) return void res.json({ ok: true, url: have, created: false, provider: "google" });
  const safeName = String(contactName || "Contact").replace(/[<>:"/\\|?*]/g, "-").slice(0, 80);
  const folderName = `${safeName} (${contactId.slice(0, 8)})`;
  const rootName = `${brandName()} CRM`.replace(/[<>:"/\\|?*]/g, "-");
  try {
    const f = await ensureGoogleClientFolder(g, rootName, folderName);
    await pool.query(`UPDATE contacts SET google_drive_folder_id = $2, google_drive_folder_url = $3 WHERE id = $1::uuid`, [contactId, f.id, f.url]);
    res.json({ ok: true, url: f.url, created: true, provider: "google" });
  } catch (err) {
    sendGoogleFailure(res, err, "google_folder_failed");
  }
}

/** GET /api/o365/contacts/:id/folder/files for a Google user. */
export async function googleContactFolderFiles(res: any, g: GoogleClient, contactId: string): Promise<void> {
  const r = await pool.query(`SELECT google_drive_folder_id, google_drive_folder_url FROM contacts WHERE id = $1::uuid`, [contactId]);
  const id = r.rows[0]?.google_drive_folder_id as string | null | undefined;
  if (!id) return void res.json({ hasFolder: false, files: [], provider: "google" });
  try {
    const files = await listGoogleFolderFiles(g, id);
    res.json({ hasFolder: true, url: r.rows[0]?.google_drive_folder_url ?? null, files, provider: "google" });
  } catch (err) {
    sendGoogleFailure(res, err, "google_files_failed");
  }
}
