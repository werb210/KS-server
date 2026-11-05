// KS_META_LEAD_ADS_v1 - Facebook and Instagram lead ads (HubSpot gaps batch 2).
// An Admin connects the brokerage's Facebook Pages (Facebook Login, through Keystone's redirect broker on KS-Ops when
// it is set up). Each Page is subscribed to the "leadgen" webhook. When someone fills in a lead form on an ad, Meta
// posts the lead id; this server fetches the answers with the Page's token and makes a CRM lead through the same path
// as a website form (match or create the contact, lead rotation, timeline, staff notified), tagged "facebook_lead".
//
// Settings (Keystone-wide): META_APP_ID, META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN, META_TOKEN_ENCRYPTION_KEY.
// Meta sends every webhook for the app to ONE address. On Keystone that is KS-Ops, which finds the brokerage by Page
// id and passes the exact request on to this server (the signature is checked again here). Boreal's own server can be
// that address directly.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { decryptToken, encryptToken } from "../services/workspace/tokenCrypto.js";
import { redirectUriFor } from "../licensee/oauthBroker.js";
import { serverUrl, portalUrl } from "../licensee/urls.js";
import type { KitForm, Submission } from "../marketing/websiteKit.js";

export const GRAPH = "https://graph.facebook.com/v21.0";
export const DIALOG = "https://www.facebook.com/v21.0/dialog/oauth";
export const SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_metadata", "leads_retrieval", "business_management"];
export const STATE_TTL_MS = 10 * 60_000;

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

export type MetaConfig = { appId: string; appSecret: string; redirectUri: string; returnUrl: string };

/** Null when any required setting is missing. */
export function metaConfig(e: NodeJS.ProcessEnv = process.env): MetaConfig | null {
  const appId = String(e.META_APP_ID ?? "").trim();
  const appSecret = String(e.META_APP_SECRET ?? "").trim();
  if (!appId || !appSecret || !String(e.META_TOKEN_ENCRYPTION_KEY ?? "").trim()) return null;
  return {
    appId, appSecret,
    redirectUri: redirectUriFor("meta", serverUrl().replace(/\/+$/, "") + "/api/integrations/meta/callback", e),
    returnUrl: portalUrl().replace(/\/+$/, "") + "/settings?tab=integrations",
  };
}

export function missingSettings(e: NodeJS.ProcessEnv = process.env): string[] {
  return ["META_APP_ID", "META_APP_SECRET", "META_TOKEN_ENCRYPTION_KEY", "META_WEBHOOK_VERIFY_TOKEN"].filter((k) => !String(e[k] ?? "").trim());
}

export const newNonce = () => randomBytes(32).toString("base64url");
export const nonceHash = (n: string) => createHash("sha256").update(n).digest("hex");

export function authUrl(cfg: MetaConfig, state: string): string {
  const q = new URLSearchParams({ client_id: cfg.appId, redirect_uri: cfg.redirectUri, state, scope: SCOPES.join(","), response_type: "code" });
  return `${DIALOG}?${q.toString()}`;
}

async function graphJson(f: Fetch, url: string, init?: Parameters<Fetch>[1]): Promise<any> {
  const r = await f(url, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body?.error) {
    const msg = body?.error?.message ? String(body.error.message).slice(0, 200) : `status_${r.status}`;
    throw new Error(`meta_graph_error: ${msg}`);
  }
  return body;
}

export type MetaPage = { id: string; name: string; access_token: string };

/** Code -> long-lived user token -> the Pages the person manages (Page tokens from a long-lived user token do not expire). */
export async function exchangeForPages(cfg: MetaConfig, code: string, f: Fetch = globalThis.fetch as unknown as Fetch): Promise<MetaPage[]> {
  const short = await graphJson(f, `${GRAPH}/oauth/access_token?${new URLSearchParams({
    client_id: cfg.appId, client_secret: cfg.appSecret, redirect_uri: cfg.redirectUri, code,
  })}`);
  const long = await graphJson(f, `${GRAPH}/oauth/access_token?${new URLSearchParams({
    grant_type: "fb_exchange_token", client_id: cfg.appId, client_secret: cfg.appSecret, fb_exchange_token: String(short.access_token ?? ""),
  })}`);
  const pages = await graphJson(f, `${GRAPH}/me/accounts?${new URLSearchParams({ fields: "id,name,access_token", limit: "100", access_token: String(long.access_token ?? "") })}`);
  return (Array.isArray(pages.data) ? pages.data : [])
    .filter((p: any) => /^\d{5,25}$/.test(String(p?.id ?? "")) && p?.access_token)
    .map((p: any) => ({ id: String(p.id), name: String(p.name ?? "Facebook Page").slice(0, 200), access_token: String(p.access_token) }));
}

/** Subscribes this app to the Page's lead events. */
export async function subscribePage(pageId: string, pageToken: string, f: Fetch = globalThis.fetch as unknown as Fetch): Promise<void> {
  await graphJson(f, `${GRAPH}/${pageId}/subscribed_apps`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ subscribed_fields: "leadgen", access_token: pageToken }).toString(),
  });
}

export async function savePages(db: Q, pages: MetaPage[], userId: string | null): Promise<void> {
  for (const p of pages) {
    await db.query(
      `INSERT INTO meta_lead_pages (page_id, page_name, page_token_enc, active, connected_by, connected_at)
       VALUES ($1, $2, $3, true, $4::uuid, now())
       ON CONFLICT (page_id) DO UPDATE SET page_name = EXCLUDED.page_name, page_token_enc = EXCLUDED.page_token_enc,
         connected_by = EXCLUDED.connected_by, connected_at = now(), disconnected_at = NULL`,
      [p.id, p.name, encryptToken(p.access_token, process.env, "META_TOKEN_ENCRYPTION_KEY"), userId],
    );
  }
}

// ---- Webhook ----------------------------------------------------------------------------------------------

/** Meta signs the raw body: X-Hub-Signature-256: sha256=<hex HMAC with the app secret>. */
export function signatureValid(raw: Buffer | string | undefined, header: unknown, appSecret: string): boolean {
  if (!raw || typeof header !== "string" || !header.startsWith("sha256=") || !appSecret) return false;
  const want = Buffer.from(createHmac("sha256", appSecret).update(raw).digest("hex"));
  const got = Buffer.from(header.slice(7));
  return want.length === got.length && timingSafeEqual(want, got);
}

export type LeadEvent = { leadgenId: string; pageId: string; formId: string | null; adId: string | null };

/** The lead events in a webhook body (field "leadgen" on Page objects). */
export function leadEvents(body: any): LeadEvent[] {
  if (body?.object !== "page" || !Array.isArray(body.entry)) return [];
  const out: LeadEvent[] = [];
  for (const entry of body.entry) {
    for (const ch of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (ch?.field !== "leadgen") continue;
      const v = ch.value ?? {};
      const leadgenId = String(v.leadgen_id ?? "");
      const pageId = String(v.page_id ?? entry.id ?? "");
      if (!/^\d{5,25}$/.test(leadgenId) || !/^\d{5,25}$/.test(pageId)) continue;
      out.push({ leadgenId, pageId, formId: v.form_id ? String(v.form_id) : null, adId: v.ad_id ? String(v.ad_id) : null });
    }
  }
  return out;
}

const FIELD_ALIASES: Record<string, keyof Submission["values"]> = {
  full_name: "full_name", name: "full_name", email: "email", work_email: "email", phone_number: "phone", phone: "phone",
  work_phone_number: "phone", company_name: "company", company: "company", business_name: "company",
};

/** Maps Meta's field_data to the website-form values; other questions go in the message. */
export function leadValues(fieldData: unknown): Submission["values"] {
  const values: Submission["values"] = {};
  const extra: string[] = [];
  let first = "", last = "";
  for (const f of Array.isArray(fieldData) ? fieldData : []) {
    const name = String(f?.name ?? "").toLowerCase();
    const val = String(Array.isArray(f?.values) ? f.values[0] ?? "" : "").trim().slice(0, 500);
    if (!val) continue;
    if (name === "first_name") { first = val; continue; }
    if (name === "last_name") { last = val; continue; }
    const key = FIELD_ALIASES[name];
    if (key && !values[key]) values[key] = val.slice(0, 200);
    else extra.push(`${name.replace(/_/g, " ")}: ${val}`);
  }
  if (!values.full_name && (first || last)) values.full_name = `${first} ${last}`.trim();
  if (values.email) values.email = values.email.toLowerCase();
  if (extra.length) values.message = extra.join("\n").slice(0, 2000);
  return values;
}

export type LeadDeps = {
  fetch?: Fetch;
  submit?: (pool: Pool, form: KitForm, sub: Submission) => Promise<{ contactId: string; created: boolean }>;
};

/**
 * Handles one lead: skips a lead already handled, a Page that is not connected or is switched off, then fetches the
 * answers and makes the CRM lead. Returns what happened (for the log).
 */
export async function handleLead(pool: Pool, ev: LeadEvent, deps: LeadDeps = {}): Promise<"created" | "updated" | "duplicate" | "unknown_page" | "paused" | "no_contact_details"> {
  const db = pool as unknown as Q;
  const page = (await db.query(
    `SELECT page_id, page_name, page_token_enc, active, tag FROM meta_lead_pages WHERE page_id = $1 AND disconnected_at IS NULL`, [ev.pageId],
  )).rows[0];
  if (!page) return "unknown_page";
  if (!page.active) return "paused";
  const claimed = await db.query(
    `INSERT INTO meta_leads (leadgen_id, page_id, form_id, ad_id) VALUES ($1, $2, $3, $4) ON CONFLICT (leadgen_id) DO NOTHING RETURNING leadgen_id`,
    [ev.leadgenId, ev.pageId, ev.formId, ev.adId],
  );
  if (!claimed.rows[0]) return "duplicate";
  try {
    const token = decryptToken(page.page_token_enc, process.env, "META_TOKEN_ENCRYPTION_KEY");
    if (!token) throw new Error("meta_page_token_unreadable");
    const f = deps.fetch ?? (globalThis.fetch as unknown as Fetch);
    const lead = await graphJson(f, `${GRAPH}/${ev.leadgenId}?${new URLSearchParams({ fields: "created_time,field_data,form_id,ad_name,campaign_name", access_token: token })}`);
    const values = leadValues(lead.field_data);
    if (!values.email && !values.phone) {
      await db.query(`UPDATE meta_leads SET outcome = 'no_contact_details', handled_at = now() WHERE leadgen_id = $1`, [ev.leadgenId]);
      return "no_contact_details";
    }
    const where = [lead.campaign_name, lead.ad_name].filter(Boolean).join(" / ");
    const form: KitForm = {
      id: `meta:${ev.formId ?? "form"}`, name: `Facebook lead ad${where ? `: ${String(where).slice(0, 120)}` : ` (${page.page_name})`}`,
      fields: [], button_label: "", thank_you: "", tag: page.tag || "facebook_lead", active: true, submissions: 0, created_at: "",
    };
    const submit = deps.submit ?? (await import("../marketing/kitLead.js")).submitKitLead;
    const r = await submit(pool, form, { values, consent: false, consentText: null, sessionId: null, page: `facebook:${ev.pageId}` });
    await db.query(
      `UPDATE meta_leads SET contact_id = $2::uuid, outcome = $3, handled_at = now() WHERE leadgen_id = $1`,
      [ev.leadgenId, r.contactId, r.created ? "created" : "updated"],
    );
    await db.query(`UPDATE meta_lead_pages SET leads = leads + 1, last_lead_at = now() WHERE page_id = $1`, [ev.pageId]);
    return r.created ? "created" : "updated";
  } catch (err) {
    // Let Meta's retry (or the next delivery) try again: release the claim.
    await db.query(`DELETE FROM meta_leads WHERE leadgen_id = $1 AND contact_id IS NULL`, [ev.leadgenId])
      .catch((e: unknown) => console.warn("[meta-leads] release failed", String((e as Error)?.message ?? e)));
    throw err;
  }
}
