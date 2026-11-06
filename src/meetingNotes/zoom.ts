// KS_HUBSPOT_GAPS_1_MEETING_NOTES - Zoom: each staff member connects their own Zoom account (OAuth, user-managed app)
// and the transcripts of their cloud recordings are brought in. Plain fetch, no SDK.
//
// Server settings: ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET (a Zoom "General app", user-managed, from the Zoom App
// Marketplace), ZOOM_TOKEN_ENCRYPTION_KEY (openssl rand -base64 32). Optional ZOOM_REDIRECT_URI (default
// <server>/api/meeting-notes/zoom/callback). Scopes: user:read:user, cloud_recording:read:list_user_recordings,
// cloud_recording:read:recording, meeting:read:list_past_participants. Tokens are stored encrypted; Zoom rotates the
// refresh token on every refresh, so the new one is saved each time. A refused refresh marks the account
// "reauth_required" and the portal asks the person to connect again.
import { createHash } from "node:crypto";
import { serverUrl } from "../licensee/urls.js";
import { redirectUriFor } from "../licensee/oauthBroker.js"; // KS_ZOOM_MEETINGS_v1
import { decryptToken, encryptToken } from "../services/workspace/tokenCrypto.js";

export const ZOOM_AUTHORIZE = "https://zoom.us/oauth/authorize";
export const ZOOM_TOKEN = "https://zoom.us/oauth/token";
export const ZOOM_REVOKE = "https://zoom.us/oauth/revoke";
export const ZOOM_API = "https://api.zoom.us/v2";
const KEY = "ZOOM_TOKEN_ENCRYPTION_KEY" as const;

export type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
export type ZoomConfig = { clientId: string; clientSecret: string; redirectUri: string };
const env = (n: string, e: NodeJS.ProcessEnv) => String(e[n] ?? "").trim();

// KS_ZOOM_MEETINGS_v1 - one Keystone Zoom app for every brokerage (KS_ZOOM_CLIENT_ID / KS_ZOOM_CLIENT_SECRET, shared
// App Service settings), its single redirect on the KS-Ops broker. A brokerage's own ZOOM_CLIENT_ID still wins.
// Without ZOOM_TOKEN_ENCRYPTION_KEY the tokens are sealed with a key derived from JWT_SECRET, so a new brokerage
// needs no extra key. Scopes on the Keystone app add meeting:write:meeting (create Zoom meetings) to the four above.
const clientIdOf = (e: NodeJS.ProcessEnv) => env("ZOOM_CLIENT_ID", e) || env("KS_ZOOM_CLIENT_ID", e);
const clientSecretOf = (e: NodeJS.ProcessEnv) => (env("ZOOM_CLIENT_ID", e) ? env("ZOOM_CLIENT_SECRET", e) : env("KS_ZOOM_CLIENT_SECRET", e));

/** The env tokenCrypto reads: the server's own key, else one derived from JWT_SECRET. */
export function zoomCryptoEnv(e: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (env(KEY, e)) return e;
  const jwt = env("JWT_SECRET", e);
  return jwt ? { [KEY]: `zoom-tokens:${jwt}` } : {};
}

export function zoomConfigProblem(e: NodeJS.ProcessEnv = process.env): string | null {
  const missing: string[] = [];
  if (!clientIdOf(e)) missing.push("KS_ZOOM_CLIENT_ID");
  if (!clientSecretOf(e)) missing.push(env("ZOOM_CLIENT_ID", e) ? "ZOOM_CLIENT_SECRET" : "KS_ZOOM_CLIENT_SECRET");
  if (!env(KEY, zoomCryptoEnv(e))) missing.push(KEY);
  return missing.length ? `Zoom is not set up on this server yet (${missing.join(", ")}).` : null;
}

export function zoomConfig(e: NodeJS.ProcessEnv = process.env): ZoomConfig | null {
  if (zoomConfigProblem(e)) return null;
  return { clientId: clientIdOf(e), clientSecret: clientSecretOf(e),
    redirectUri: env("ZOOM_REDIRECT_URI", e) || redirectUriFor("zoom", `${serverUrl().replace(/\/+$/, "")}/api/meeting-notes/zoom/callback`, e) };
}

export const stateHash = (s: string) => createHash("sha256").update(s).digest("hex");

export function zoomAuthorizeUrl(cfg: ZoomConfig, state: string): string {
  return `${ZOOM_AUTHORIZE}?${new URLSearchParams({ response_type: "code", client_id: cfg.clientId, redirect_uri: cfg.redirectUri, state }).toString()}`;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: Fetch = (u, i) => fetch(u, i);
export function setZoomFetchForTests(f: Fetch | null): void { fetchImpl = f ?? ((u, i) => fetch(u, i)); }

export class ZoomError extends Error {
  constructor(public status: number, public code: string | null, message: string) { super(message); this.name = "ZoomError"; }
}

type Tokens = { accessToken: string; refreshToken: string; expiresAt: Date; scopes: string };

async function tokenRequest(cfg: ZoomConfig, body: Record<string, string>): Promise<Tokens> {
  const r = await fetchImpl(ZOOM_TOKEN, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const text = await r.text();
  let j: any = {};
  try { j = text ? JSON.parse(text) : {}; } catch { j = {}; }
  if (!r.ok || !j.access_token) throw new ZoomError(r.status, typeof j.error === "string" ? j.error : null, `zoom_token_${j.error ?? r.status}`);
  return { accessToken: String(j.access_token), refreshToken: String(j.refresh_token ?? ""), expiresAt: new Date(Date.now() + Number(j.expires_in ?? 3600) * 1000), scopes: String(j.scope ?? "") };
}

export const exchangeZoomCode = (cfg: ZoomConfig, code: string) => tokenRequest(cfg, { grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri });

/** The connected Zoom user (id and email) for a fresh access token. */
export async function zoomMe(accessToken: string): Promise<{ id: string; email: string }> {
  const r = await fetchImpl(`${ZOOM_API}/users/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new ZoomError(r.status, null, `zoom_me_${r.status}`);
  const j = (await r.json()) as any;
  return { id: String(j?.id ?? ""), email: String(j?.email ?? "") };
}

export async function saveZoomAccount(db: Q, userId: string, t: Tokens, me: { id: string; email: string }): Promise<void> {
  await db.query(
    `INSERT INTO zoom_accounts (user_id, zoom_user_id, zoom_email, access_token_enc, refresh_token_enc, access_token_expires_at, scopes, status, last_error, connected_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, 'connected', NULL, now(), now())
     ON CONFLICT (user_id) DO UPDATE SET zoom_user_id = EXCLUDED.zoom_user_id, zoom_email = EXCLUDED.zoom_email, access_token_enc = EXCLUDED.access_token_enc,
       refresh_token_enc = EXCLUDED.refresh_token_enc, access_token_expires_at = EXCLUDED.access_token_expires_at, scopes = EXCLUDED.scopes,
       status = 'connected', last_error = NULL, connected_at = now(), updated_at = now()`,
    [userId, me.id, me.email, encryptToken(t.accessToken, zoomCryptoEnv(), KEY), encryptToken(t.refreshToken, zoomCryptoEnv(), KEY), t.expiresAt, t.scopes]);
}

export type ZoomClient = { userId: string; get: <T = any>(path: string) => Promise<T>; download: (url: string) => Promise<string>; token: () => string;
  /** KS_ZOOM_MEETINGS_v1 */ post: <T = any>(path: string, body: unknown) => Promise<T> };

/** The person's Zoom client (refreshing the token when it is about to expire), or null when not connected. */
export async function zoomForUser(db: Q, cfg: ZoomConfig, userId: string): Promise<ZoomClient | null> {
  const row = (await db.query(`SELECT access_token_enc, refresh_token_enc, access_token_expires_at, status FROM zoom_accounts WHERE user_id = $1::uuid`, [userId])).rows[0];
  if (!row || row.status !== "connected") return null;
  let access = decryptToken(row.access_token_enc, zoomCryptoEnv(), KEY);
  const expires = row.access_token_expires_at ? new Date(row.access_token_expires_at).getTime() : 0;
  const refresh = async (): Promise<string | null> => {
    const rt = decryptToken((await db.query(`SELECT refresh_token_enc FROM zoom_accounts WHERE user_id = $1::uuid`, [userId])).rows[0]?.refresh_token_enc, zoomCryptoEnv(), KEY);
    if (!rt) { await markZoomReauth(db, userId, "no_refresh_token"); return null; }
    try {
      const t = await tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: rt });
      await db.query(`UPDATE zoom_accounts SET access_token_enc = $2, refresh_token_enc = $3, access_token_expires_at = $4, updated_at = now() WHERE user_id = $1::uuid`,
        [userId, encryptToken(t.accessToken, zoomCryptoEnv(), KEY), encryptToken(t.refreshToken || rt, zoomCryptoEnv(), KEY), t.expiresAt]);
      return t.accessToken;
    } catch (err) {
      if (err instanceof ZoomError && (err.code === "invalid_grant" || err.status === 400 || err.status === 401)) await markZoomReauth(db, userId, err.message);
      throw err;
    }
  };
  if (!access || expires - Date.now() < 60_000) access = await refresh();
  if (!access) return null;
  let current = access;
  const call = async (url: string, accept = "application/json", body?: unknown): Promise<Response> => {
    const init = (): RequestInit => body === undefined
      ? { headers: { Authorization: `Bearer ${current}`, Accept: accept } }
      : { method: "POST", headers: { Authorization: `Bearer ${current}`, Accept: accept, "Content-Type": "application/json" }, body: JSON.stringify(body) };
    let r = await fetchImpl(url, init());
    if (r.status === 401) { const fresh = await refresh(); if (fresh) { current = fresh; r = await fetchImpl(url, init()); } }
    return r;
  };
  return {
    userId,
    token: () => current,
    async get<T>(path: string): Promise<T> {
      const r = await call(`${ZOOM_API}${path}`);
      const text = await r.text();
      if (!r.ok) throw new ZoomError(r.status, null, `zoom_api_${r.status} ${path.split("?")[0]} ${text.slice(0, 200)}`);
      return (text ? JSON.parse(text) : null) as T;
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      const r = await call(`${ZOOM_API}${path}`, "application/json", body);
      const text = await r.text();
      if (!r.ok) throw new ZoomError(r.status, null, `zoom_api_${r.status} ${path.split("?")[0]} ${text.slice(0, 200)}`);
      return (text ? JSON.parse(text) : null) as T;
    },
    async download(url: string): Promise<string> {
      const r = await call(url, "text/vtt, text/plain, */*");
      if (!r.ok) throw new ZoomError(r.status, null, `zoom_download_${r.status}`);
      return r.text();
    },
  };
}

export async function markZoomReauth(db: Q, userId: string, reason: string): Promise<void> {
  await db.query(`UPDATE zoom_accounts SET status = 'reauth_required', access_token_enc = NULL, last_error = $2, updated_at = now() WHERE user_id = $1::uuid`, [userId, reason.slice(0, 300)]);
  console.warn("[zoom] reconnect needed", { userId, reason: reason.slice(0, 120) });
}

export async function disconnectZoom(db: Q, cfg: ZoomConfig | null, userId: string): Promise<boolean> {
  const row = (await db.query(`SELECT access_token_enc FROM zoom_accounts WHERE user_id = $1::uuid`, [userId])).rows[0];
  let revoked = false;
  const token = row ? decryptToken(row.access_token_enc, zoomCryptoEnv(), KEY) : null;
  if (cfg && token) {
    try {
      const r = await fetchImpl(ZOOM_REVOKE, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
      });
      revoked = r.ok;
    } catch (err) {
      console.warn("[zoom] revoke failed; disconnecting here anyway", { message: err instanceof Error ? err.message : String(err) });
    }
  }
  await db.query(`UPDATE zoom_accounts SET status = 'disconnected', access_token_enc = NULL, refresh_token_enc = NULL, updated_at = now() WHERE user_id = $1::uuid`, [userId]);
  return revoked;
}

/** Zoom meeting UUIDs that start with "/" or contain "//" must be encoded twice in a path. */
export function zoomUuidPath(uuid: string): string {
  const once = encodeURIComponent(uuid);
  return uuid.startsWith("/") || uuid.includes("//") ? encodeURIComponent(once) : once;
}

export type ZoomTranscriptMeeting = { uuid: string; id: string; topic: string; start: Date; end: Date; transcriptUrl: string; shareUrl: string | null };

/** Recorded meetings with a finished transcript between two days (Zoom keeps a 30-day window per request). */
export async function zoomTranscriptMeetings(z: ZoomClient, from: Date, to: Date): Promise<ZoomTranscriptMeeting[]> {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const out: ZoomTranscriptMeeting[] = [];
  let next = "";
  for (let page = 0; page < 10; page++) {
    const r = await z.get<any>(`/users/me/recordings?page_size=100&from=${day(from)}&to=${day(to)}${next ? `&next_page_token=${encodeURIComponent(next)}` : ""}`);
    for (const m of r?.meetings ?? []) {
      const t = (m.recording_files ?? []).find((f: any) => (f.file_type === "TRANSCRIPT" || f.recording_type === "audio_transcript") && (f.status ?? "completed") === "completed" && f.download_url);
      if (!t) continue;
      const start = new Date(m.start_time);
      out.push({ uuid: String(m.uuid), id: String(m.id), topic: String(m.topic ?? "Zoom meeting"), start, end: new Date(start.getTime() + Number(m.duration ?? 0) * 60_000), transcriptUrl: String(t.download_url), shareUrl: m.share_url ? String(m.share_url) : null });
    }
    next = String(r?.next_page_token ?? "");
    if (!next) break;
  }
  return out;
}

/** Participant emails (only people signed in to Zoom show one). Empty when the account cannot list participants. */
export async function zoomParticipantEmails(z: ZoomClient, uuid: string): Promise<string[]> {
  try {
    const r = await z.get<any>(`/past_meetings/${zoomUuidPath(uuid)}/participants?page_size=300`);
    return [...new Set((r?.participants ?? []).map((p: any) => String(p.user_email ?? "").trim().toLowerCase()).filter((e: string) => e.includes("@")))] as string[];
  } catch (err) {
    console.warn("[zoom] participants not available", { message: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

// KS_ZOOM_MEETINGS_v1 - a scheduled Zoom meeting on the person's own Zoom account. Cloud recording is asked for so the
// transcript comes back into the CRM (Settings > Meeting notes); Zoom ignores it on plans without cloud recording.
export async function createZoomMeeting(z: ZoomClient, input: { topic: string; start: string; end: string; agenda?: string | null }): Promise<{ id: string; joinUrl: string }> {
  const minutes = Math.max(15, Math.round((new Date(input.end).getTime() - new Date(input.start).getTime()) / 60_000) || 30);
  const m = await z.post<any>("/users/me/meetings", {
    topic: input.topic.slice(0, 200), type: 2, start_time: new Date(input.start).toISOString().replace(/\.\d{3}Z$/, "Z"), timezone: "UTC", duration: minutes,
    agenda: input.agenda ? String(input.agenda).slice(0, 2000) : undefined,
    settings: { join_before_host: false, waiting_room: true, auto_recording: "cloud" },
  });
  if (!m?.join_url) throw new ZoomError(502, null, "zoom_meeting_no_join_url");
  return { id: String(m.id), joinUrl: String(m.join_url) };
}
