// KS_SERVER_v12_GOOGLE_WORKSPACE - Google Workspace operations over plain fetch (no SDK):
// Gmail send, Calendar events (+ Google Meet), own-calendar busy times, Google Tasks, Drive client folders.
// Every call goes through a GoogleClient (googleAuth.ts), which refreshes the token and marks the account for
// reconnection on invalid_grant.
import type { GoogleClient } from "./googleAuth.js";
import { buildMimeMessage, toGmailRaw, type MimeMessageInput } from "./gmailMime.js";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_UPLOAD = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media";
const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary";
const TASKS = "https://tasks.googleapis.com/tasks/v1/lists/@default/tasks";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export class GoogleApiError extends Error {
  constructor(public status: number, public bodyText: string, public path: string) {
    super(`google_api_${status} ${path.split("?")[0]}`);
    this.name = "GoogleApiError";
  }
}

async function call<T = any>(g: GoogleClient, url: string, init: RequestInit = {}): Promise<T> {
  const resp = await g.fetch(url, init);
  if (!resp.ok) {
    const text = await resp.text().catch((err: unknown) => { console.warn("google_api_body_unreadable", { message: (err as Error)?.message }); return ""; });
    throw new GoogleApiError(resp.status, text.slice(0, 1000), url.replace(/^https:\/\/[^/]+/, ""));
  }
  if (resp.status === 204) return null as T;
  const text = await resp.text();
  return (text ? JSON.parse(text) : null) as T;
}

const json = (body: unknown): RequestInit => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// ---------------- Gmail (gmail.send) ----------------

/** Gmail's JSON send takes ~5 MB; bigger messages (up to 35 MB) go through the media upload endpoint. */
export const GMAIL_JSON_LIMIT = 4 * 1024 * 1024;

export async function sendGmail(g: GoogleClient, input: MimeMessageInput, opts: { threadId?: string | null } = {}): Promise<{ id: string | null; threadId: string | null }> {
  const mime = buildMimeMessage({ ...input, from: input.from || g.email || null });
  let r: { id?: string; threadId?: string } | null;
  if (Buffer.byteLength(mime, "utf8") <= GMAIL_JSON_LIMIT) {
    r = await call(g, `${GMAIL}/messages/send`, { method: "POST", ...json({ raw: toGmailRaw(mime), ...(opts.threadId ? { threadId: opts.threadId } : {}) }) });
  } else {
    r = await call(g, GMAIL_UPLOAD, { method: "POST", headers: { "Content-Type": "message/rfc822" }, body: mime });
  }
  return { id: r?.id ?? null, threadId: r?.threadId ?? null };
}

// ---------------- Calendar (calendar.events) ----------------

export type FlatEvent = {
  id?: string; title?: string; start?: string; end?: string; location?: string; attendees?: string[];
  notes?: string; teamsLink?: string | null; meetLink?: string | null; webLink?: string | null; provider: "google";
};

function whenOf(v: any): string | undefined {
  return v?.dateTime ?? (v?.date ? `${v.date}T00:00:00` : undefined);
}

/** A Google event in the flat shape the portal calendar grid reads (same keys as the Graph mapping). */
export function normalizeGoogleEvent(ev: any): FlatEvent {
  const meet = ev?.hangoutLink ?? (Array.isArray(ev?.conferenceData?.entryPoints) ? ev.conferenceData.entryPoints.find((p: any) => p?.entryPointType === "video")?.uri : null) ?? null;
  return {
    id: ev?.id,
    title: ev?.summary ?? "Untitled",
    start: whenOf(ev?.start),
    end: whenOf(ev?.end),
    location: ev?.location ?? "",
    attendees: (Array.isArray(ev?.attendees) ? ev.attendees : []).map((a: any) => String(a?.email ?? "")).filter(Boolean),
    notes: ev?.description ?? "",
    // The portal shows `teamsLink` as the meeting's join button; for Google it carries the Meet link.
    teamsLink: meet,
    meetLink: meet,
    webLink: ev?.htmlLink ?? null,
    provider: "google",
  };
}

export type EventInput = {
  title: string;
  start: string;
  end: string;
  notes?: string | null;
  location?: string | null;
  attendees?: Array<string | { email: string; name?: string | null; optional?: boolean }>;
  /** create a Google Meet link (where Microsoft would create a Teams meeting) */
  meet?: boolean;
  reminderMinutes?: number | null;
  /** used as the Meet createRequest id so a retried create never makes two conferences */
  requestId?: string;
};

const iso = (v: string): string => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
};

/** events.insert body. With meet=true it carries conferenceData.createRequest (hangoutsMeet). */
export function googleEventBody(input: EventInput): Record<string, unknown> {
  const attendees = (input.attendees ?? [])
    .map((a) => (typeof a === "string" ? { email: a.trim() } : { email: String(a.email ?? "").trim(), ...(a.name ? { displayName: a.name } : {}), ...(a.optional ? { optional: true } : {}) }))
    .filter((a) => a.email.includes("@"));
  const body: Record<string, unknown> = {
    summary: input.title,
    start: { dateTime: iso(input.start), timeZone: "UTC" },
    end: { dateTime: iso(input.end), timeZone: "UTC" },
  };
  if (input.notes) body.description = input.notes;
  if (input.location) body.location = input.location;
  if (attendees.length) body.attendees = attendees;
  if (typeof input.reminderMinutes === "number") body.reminders = { useDefault: false, overrides: [{ method: "popup", minutes: input.reminderMinutes }] };
  if (input.meet) {
    body.conferenceData = {
      createRequest: {
        requestId: input.requestId || `ks-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }
  return body;
}

export async function listGoogleEvents(g: GoogleClient, start: string, end: string): Promise<FlatEvent[]> {
  const q = new URLSearchParams({ timeMin: iso(start), timeMax: iso(end), singleEvents: "true", orderBy: "startTime", maxResults: "250" });
  const r = await call<{ items?: any[] }>(g, `${CAL}/events?${q.toString()}`);
  return (r?.items ?? []).filter((e) => e?.status !== "cancelled").map(normalizeGoogleEvent);
}

export async function createGoogleEvent(g: GoogleClient, input: EventInput): Promise<{ id: string | null; joinUrl: string | null; event: FlatEvent }> {
  // sendUpdates=all: attendees get Google's invitation, as Outlook sends one for a Graph event.
  const q = new URLSearchParams({ sendUpdates: "all", ...(input.meet ? { conferenceDataVersion: "1" } : {}) });
  const ev = await call(g, `${CAL}/events?${q.toString()}`, { method: "POST", ...json(googleEventBody(input)) });
  const flat = normalizeGoogleEvent(ev);
  return { id: flat.id ?? null, joinUrl: flat.meetLink ?? null, event: flat };
}

export async function updateGoogleEvent(g: GoogleClient, id: string, patch: Partial<EventInput>): Promise<FlatEvent> {
  const body: Record<string, unknown> = {};
  if (patch.title) body.summary = patch.title;
  if (patch.start) body.start = { dateTime: iso(patch.start), timeZone: "UTC" };
  if (patch.end) body.end = { dateTime: iso(patch.end), timeZone: "UTC" };
  if (patch.notes) body.description = patch.notes;
  if (patch.location) body.location = patch.location;
  const ev = await call(g, `${CAL}/events/${encodeURIComponent(id)}?sendUpdates=all`, { method: "PATCH", ...json(body) });
  return normalizeGoogleEvent(ev);
}

export async function cancelGoogleEvent(g: GoogleClient, id: string): Promise<void> {
  try {
    await call(g, `${CAL}/events/${encodeURIComponent(id)}?sendUpdates=all`, { method: "DELETE" });
  } catch (err) {
    // 410 Gone: already deleted - cancelling twice is not an error.
    if (!(err instanceof GoogleApiError && (err.status === 410 || err.status === 404))) throw err;
  }
}

/** Busy blocks on the user's own primary calendar (events.list - no extra free/busy scope needed). */
export async function googleBusyTimes(g: GoogleClient, from: Date, to: Date): Promise<Array<{ start: Date; end: Date }>> {
  const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "250" });
  const r = await call<{ items?: any[] }>(g, `${CAL}/events?${q.toString()}`);
  const out: Array<{ start: Date; end: Date }> = [];
  for (const e of r?.items ?? []) {
    if (e?.status === "cancelled" || e?.transparency === "transparent") continue;
    const mine = (Array.isArray(e?.attendees) ? e.attendees : []).find((a: any) => a?.self);
    if (mine?.responseStatus === "declined") continue;
    const s = whenOf(e?.start);
    const en = whenOf(e?.end);
    if (!s || !en) continue;
    const start = new Date(e?.start?.dateTime ? s : `${s}Z`);
    const end = new Date(e?.end?.dateTime ? en : `${en}Z`);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) out.push({ start, end });
  }
  return out;
}

/** Graph-style availabilityView ("0" free, "2" busy per interval) so the Find-a-time grid renders Google too. */
export function availabilityView(busy: Array<{ start: Date; end: Date }>, from: Date, to: Date, intervalMin = 30): string {
  let view = "";
  for (let t = from.getTime(); t < to.getTime(); t += intervalMin * 60_000) {
    const e = t + intervalMin * 60_000;
    view += busy.some((b) => b.start.getTime() < e && b.end.getTime() > t) ? "2" : "0";
  }
  return view;
}

// ---------------- Tasks (tasks) ----------------

export type GoogleTaskInput = { title: string; notes?: string | null; due?: string | Date | null; completed?: boolean };

/** Google Tasks keeps only a due DATE (RFC 3339, time ignored). */
export function googleTaskBody(t: GoogleTaskInput): Record<string, unknown> {
  const body: Record<string, unknown> = { title: t.title || "Task", notes: t.notes ?? "", status: t.completed ? "completed" : "needsAction" };
  if (t.due) {
    const d = new Date(t.due);
    if (!Number.isNaN(d.getTime())) body.due = `${d.toISOString().slice(0, 10)}T00:00:00.000Z`;
  } else {
    body.due = null;
  }
  if (!t.completed) body.completed = null;
  return body;
}

export async function createGoogleTask(g: GoogleClient, t: GoogleTaskInput): Promise<string | null> {
  const r = await call<{ id?: string }>(g, TASKS, { method: "POST", ...json(googleTaskBody(t)) });
  return r?.id ?? null;
}

export async function updateGoogleTask(g: GoogleClient, id: string, t: GoogleTaskInput): Promise<void> {
  await call(g, `${TASKS}/${encodeURIComponent(id)}`, { method: "PATCH", ...json(googleTaskBody(t)) });
}

export async function deleteGoogleTask(g: GoogleClient, id: string): Promise<void> {
  try {
    await call(g, `${TASKS}/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (err) {
    if (!(err instanceof GoogleApiError && (err.status === 404 || err.status === 410))) throw err;
  }
}

/** Ids of tasks ticked off in Google Tasks (for the pull half of the sync). */
export async function completedGoogleTaskIds(g: GoogleClient): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ showCompleted: "true", showHidden: "true", maxResults: "100", ...(pageToken ? { pageToken } : {}) });
    const r: { items?: Array<{ id?: string; status?: string }>; nextPageToken?: string } = await call(g, `${TASKS}?${q.toString()}`);
    for (const it of r?.items ?? []) if (it?.id && it.status === "completed") ids.push(it.id);
    pageToken = r?.nextPageToken ?? null;
    if (!pageToken) break;
  }
  return ids;
}

// ---------------- Drive (drive.file - only files and folders this app created) ----------------

export type DriveFile = { id: string; name: string; webUrl: string | null; isFolder: boolean };

const driveName = (v: string): string => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/'/g, "’").trim().slice(0, 120) || "Folder";

async function findFolder(g: GoogleClient, name: string, parentId: string): Promise<{ id: string; webViewLink?: string } | null> {
  const q = `mimeType = '${FOLDER_MIME}' and name = '${driveName(name).replace(/\\/g, "\\\\")}' and '${parentId}' in parents and trashed = false`;
  const r = await call<{ files?: Array<{ id: string; webViewLink?: string }> }>(g, `${DRIVE}?${new URLSearchParams({ q, fields: "files(id,webViewLink)", pageSize: "1", spaces: "drive" }).toString()}`);
  return r?.files?.[0] ?? null;
}

async function createFolder(g: GoogleClient, name: string, parentId: string): Promise<{ id: string; webViewLink?: string }> {
  return call(g, `${DRIVE}?fields=id,webViewLink`, { method: "POST", ...json({ name: driveName(name), mimeType: FOLDER_MIME, parents: [parentId] }) });
}

/** The domain to share with: the user's Google Workspace domain, or null for a consumer @gmail.com account. */
export function workspaceDomain(email: string): string | null {
  const domain = String(email ?? "").split("@")[1]?.toLowerCase() ?? "";
  if (!domain || domain === "gmail.com" || domain === "googlemail.com") return null;
  return domain;
}

/**
 * "<brand> CRM/<contact folder>" in the user's My Drive, created when missing, shared (edit) with the user's
 * Workspace domain - the Google equivalent of the OneDrive organization edit link.
 */
export async function ensureGoogleClientFolder(g: GoogleClient, rootName: string, folderName: string): Promise<{ id: string; url: string | null }> {
  const root = (await findFolder(g, rootName, "root")) ?? (await createFolder(g, rootName, "root"));
  const folder = await createFolder(g, folderName, root.id);
  const domain = workspaceDomain(g.email);
  if (domain) {
    try {
      await call(g, `${DRIVE}/${encodeURIComponent(folder.id)}/permissions?sendNotificationEmail=false`, { method: "POST", ...json({ type: "domain", role: "writer", domain }) });
    } catch (err) {
      console.warn("google_drive_share_failed", { message: (err as Error)?.message });
    }
  }
  return { id: folder.id, url: folder.webViewLink ?? `https://drive.google.com/drive/folders/${folder.id}` };
}

export async function listGoogleFolderFiles(g: GoogleClient, folderId: string): Promise<DriveFile[]> {
  const q = `'${String(folderId).replace(/'/g, "")}' in parents and trashed = false`;
  const r = await call<{ files?: Array<{ id: string; name: string; webViewLink?: string; mimeType?: string }> }>(g, `${DRIVE}?${new URLSearchParams({ q, fields: "files(id,name,webViewLink,mimeType)", pageSize: "100", orderBy: "folder,name" }).toString()}`);
  return (r?.files ?? []).map((f) => ({ id: f.id, name: f.name, webUrl: f.webViewLink ?? null, isFolder: f.mimeType === FOLDER_MIME }));
}
