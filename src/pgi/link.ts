// KS_SERVER_v11_PGI - the stored link to the insurance partner, calls to it, and checking the partner's callbacks.
//
// Calls to the partner: {bi_server_url}/api/v1/bi/ks/..., Authorization: Bearer <API key>.
// Callbacks from the partner (POST /api/pgi/bi-events) carry X-BI-Referral-Source, X-BI-Timestamp (unix seconds)
// and X-BI-Signature = "v1=" + hex HMAC-SHA256(callback secret, timestamp + "." + raw body). Accepted within five
// minutes of our clock; compared in constant time.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Q } from "../plans/state.js";
import { allowedPartnerUrl, openSecret, sealSecret } from "./partner.js";

export type PartnerLink = { url: string; referralSourceId: string; apiKey: string; callbackSecret: string };

export async function getPartnerLink(db: Q): Promise<PartnerLink | null> {
  const r = await db.query(
    `SELECT bi_server_url, referral_source_id, api_key_enc, callback_secret_enc FROM pgi_partner_link WHERE id = 1`,
  );
  const row = r.rows[0];
  if (!row) return null;
  try {
    return {
      url: String(row.bi_server_url),
      referralSourceId: String(row.referral_source_id),
      apiKey: openSecret(String(row.api_key_enc)),
      callbackSecret: openSecret(String(row.callback_secret_enc)),
    };
  } catch (err) {
    console.warn("[pgi] stored partner link could not be read", (err as Error)?.message ?? String(err));
    return null;
  }
}

export type LinkInput = { bi_server_url?: unknown; referral_source_id?: unknown; api_key?: unknown; callback_secret?: unknown };

export function validateLink(b: LinkInput): { ok: true; value: { url: string; referralSourceId: string; apiKey: string; callbackSecret: string } } | { ok: false; error: string } {
  const url = allowedPartnerUrl(b.bi_server_url);
  if (!url) return { ok: false, error: "bi_server_url_not_allowed" };
  const referralSourceId = String(b.referral_source_id ?? "").trim();
  const apiKey = String(b.api_key ?? "").trim();
  const callbackSecret = String(b.callback_secret ?? "").trim();
  if (!referralSourceId || referralSourceId.length > 100) return { ok: false, error: "referral_source_id_required" };
  if (apiKey.length < 20 || apiKey.length > 200) return { ok: false, error: "api_key_invalid" };
  if (callbackSecret.length < 32 || callbackSecret.length > 200) return { ok: false, error: "callback_secret_invalid" };
  return { ok: true, value: { url, referralSourceId, apiKey, callbackSecret } };
}

export async function savePartnerLink(db: Q, v: { url: string; referralSourceId: string; apiKey: string; callbackSecret: string }, by: string): Promise<void> {
  await db.query(
    `INSERT INTO pgi_partner_link (id, bi_server_url, referral_source_id, api_key_enc, callback_secret_enc, updated_at, updated_by)
     VALUES (1, $1, $2, $3, $4, now(), $5)
     ON CONFLICT (id) DO UPDATE SET bi_server_url = EXCLUDED.bi_server_url, referral_source_id = EXCLUDED.referral_source_id,
       api_key_enc = EXCLUDED.api_key_enc, callback_secret_enc = EXCLUDED.callback_secret_enc, updated_at = now(),
       updated_by = EXCLUDED.updated_by`,
    [v.url, v.referralSourceId, sealSecret(v.apiKey), sealSecret(v.callbackSecret), by],
  );
}

export type PartnerFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string | FormData; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }>;

export type PartnerResult = { ok: true; status: number; body: any } | { ok: false; status: number | null; error: string; body?: any };

export const PARTNER_TIMEOUT_MS = 20_000;

/** One call to the partner. Never throws. */
export async function partnerCall(
  link: PartnerLink,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown> | FormData,
  fetchImpl?: PartnerFetch,
): Promise<PartnerResult> {
  const doFetch: PartnerFetch = fetchImpl ?? (globalThis.fetch as unknown as PartnerFetch);
  const headers: Record<string, string> = { Authorization: `Bearer ${link.apiKey}` };
  let payload: string | FormData | undefined;
  if (body instanceof FormData) payload = body;
  else if (body) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PARTNER_TIMEOUT_MS);
  try {
    const r = await doFetch(`${link.url}/api/v1/bi/ks${path}`, { method, headers, body: payload, signal: ctrl.signal });
    let parsed: any = null;
    try { parsed = await r.json(); } catch (err) { parsed = { parse_error: String(err).slice(0, 120) }; }
    if (!r.ok) return { ok: false, status: r.status, error: String(parsed?.error ?? `status_${r.status}`), body: parsed };
    return { ok: true, status: r.status, body: parsed };
  } catch (err) {
    return { ok: false, status: null, error: (err as { message?: string })?.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export const CALLBACK_WINDOW_SECONDS = 300;

export function signCallback(secret: string, ts: number, raw: string | Buffer): string {
  return "v1=" + createHmac("sha256", secret).update(`${ts}.`).update(raw).digest("hex");
}

/** Checks a partner callback. */
export function verifyCallback(input: {
  secret: string; referralSourceId: string; sourceHeader: unknown; tsHeader: unknown; sigHeader: unknown; raw: Buffer | string; nowSec?: number;
}): { ok: true } | { ok: false; reason: "wrong_source" | "stale" | "bad_signature" } {
  if (String(input.sourceHeader ?? "") !== input.referralSourceId) return { ok: false, reason: "wrong_source" };
  const ts = Number(input.tsHeader);
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > CALLBACK_WINDOW_SECONDS) return { ok: false, reason: "stale" };
  const want = Buffer.from(signCallback(input.secret, ts, input.raw));
  const got = Buffer.from(String(input.sigHeader ?? ""));
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}
