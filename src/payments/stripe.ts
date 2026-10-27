// KS_HUBSPOT_GAPS_1_PAYMENTS - Stripe over plain fetch (no SDK), for Stripe Connect Standard.
//
// Keystone is the Connect *platform*; each brokerage connects its own Stripe account with Stripe's OAuth screen and is
// the merchant of record. Every charge is a direct charge made on the brokerage's account (Stripe-Account header). No
// application fee is taken. Platform settings (server environment):
//   STRIPE_SECRET_KEY              the platform's secret key (sk_live_... / sk_test_...)
//   STRIPE_CONNECT_CLIENT_ID       the platform's Connect client id (ca_...), from Connect > Settings > OAuth
//   STRIPE_CONNECT_WEBHOOK_SECRET  signing secret (whsec_...) of the Connect webhook endpoint
//                                  <server>/api/payments/stripe/webhook ("Events on connected accounts")
import { createHmac, timingSafeEqual } from "node:crypto";

export const STRIPE_API = "https://api.stripe.com/v1";
export const STRIPE_CONNECT_AUTHORIZE = "https://connect.stripe.com/oauth/authorize";
export const STRIPE_CONNECT_TOKEN = "https://connect.stripe.com/oauth/token";
export const STRIPE_CONNECT_DEAUTHORIZE = "https://connect.stripe.com/oauth/deauthorize";
export const WEBHOOK_TOLERANCE_SECONDS = 300;

const env = (name: string, e: NodeJS.ProcessEnv) => String(e[name] ?? "").trim();

export type StripeConfig = { secretKey: string; clientId: string; webhookSecret: string };

/** Why payments cannot be used on this server, or null when the platform is fully set up. */
export function stripeConfigProblem(e: NodeJS.ProcessEnv = process.env): string | null {
  const missing = ["STRIPE_SECRET_KEY", "STRIPE_CONNECT_CLIENT_ID", "STRIPE_CONNECT_WEBHOOK_SECRET"].filter((n) => !env(n, e));
  return missing.length ? `Online payments are not set up on this server yet (${missing.join(", ")}).` : null;
}

export function stripeConfig(e: NodeJS.ProcessEnv = process.env): StripeConfig | null {
  if (stripeConfigProblem(e)) return null;
  return { secretKey: env("STRIPE_SECRET_KEY", e), clientId: env("STRIPE_CONNECT_CLIENT_ID", e), webhookSecret: env("STRIPE_CONNECT_WEBHOOK_SECRET", e) };
}

export class StripeError extends Error {
  constructor(public status: number, public code: string | null, message: string, public type: string | null = null) {
    super(message);
    this.name = "StripeError";
  }
}

/** Stripe's form encoding: nested objects as a[b][c]=v, arrays as a[0]=v. Null/undefined are left out. */
export function formEncode(params: Record<string, unknown>): string {
  const out: string[] = [];
  const add = (key: string, v: unknown) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) { v.forEach((x, i) => add(`${key}[${i}]`, x)); return; }
    if (typeof v === "object") { for (const [k, x] of Object.entries(v as Record<string, unknown>)) add(`${key}[${k}]`, x); return; }
    out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return out.join("&");
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: Fetch = (url, init) => fetch(url, init);
/** Test seam. */
export function setStripeFetchForTests(f: Fetch | null): void {
  fetchImpl = f ?? ((url, init) => fetch(url, init));
}

async function parse(resp: Response): Promise<any> {
  const text = await resp.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: { message: text.slice(0, 300) } }; }
  if (!resp.ok) {
    const e = json?.error ?? {};
    const code = typeof e === "string" ? e : (e.code ?? null);
    const message = typeof e === "string" ? String(json.error_description ?? e) : String(e.message ?? `stripe_${resp.status}`);
    throw new StripeError(resp.status, code, message, typeof e === "object" ? (e.type ?? null) : null);
  }
  return json;
}

/** One Stripe API call with the platform key; `account` makes it a call on the connected account. */
export async function stripeRequest<T = any>(cfg: StripeConfig, method: "GET" | "POST" | "DELETE", path: string,
  params: Record<string, unknown> = {}, opts: { account?: string | null; idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${cfg.secretKey}`, "Stripe-Version": "2024-06-20" };
  if (opts.account) headers["Stripe-Account"] = opts.account;
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  const body = formEncode(params);
  let url = `${STRIPE_API}${path}`;
  const init: RequestInit = { method, headers };
  if (method === "GET") { if (body) url += `?${body}`; }
  else { headers["Content-Type"] = "application/x-www-form-urlencoded"; init.body = body; }
  return parse(await fetchImpl(url, init)) as Promise<T>;
}

/** The OAuth screen the Admin is sent to (Standard accounts: an existing Stripe account, or a new one). */
export function connectAuthorizeUrl(cfg: StripeConfig, state: string, redirectUri: string, opts: { email?: string | null; businessName?: string | null } = {}): string {
  const p = new URLSearchParams({ response_type: "code", client_id: cfg.clientId, scope: "read_write", state, redirect_uri: redirectUri });
  if (opts.email) p.set("stripe_user[email]", opts.email);
  if (opts.businessName) p.set("stripe_user[business_name]", opts.businessName);
  p.set("stripe_user[country]", "CA");
  return `${STRIPE_CONNECT_AUTHORIZE}?${p.toString()}`;
}

/** Redeems the OAuth code; only the connected account id is kept (charges use the platform key + Stripe-Account). */
export async function exchangeConnectCode(cfg: StripeConfig, code: string): Promise<{ accountId: string; livemode: boolean }> {
  const resp = await fetchImpl(STRIPE_CONNECT_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formEncode({ grant_type: "authorization_code", code, client_secret: cfg.secretKey }),
  });
  const json = await parse(resp);
  const accountId = String(json.stripe_user_id ?? "");
  if (!/^acct_[A-Za-z0-9]+$/.test(accountId)) throw new StripeError(502, "no_account", "Stripe did not return an account.");
  return { accountId, livemode: json.livemode === true };
}

/** Disconnects the account from the platform (Stripe stops sending its events). */
export async function deauthorizeAccount(cfg: StripeConfig, accountId: string): Promise<void> {
  const resp = await fetchImpl(STRIPE_CONNECT_DEAUTHORIZE, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${cfg.secretKey}` },
    body: formEncode({ client_id: cfg.clientId, stripe_user_id: accountId }),
  });
  await parse(resp);
}

/** Stripe-Signature check: t=<unix>,v1=<hex hmac of "t.payload">. Rejects stale timestamps. */
export function verifyStripeSignature(rawBody: Buffer | string, header: string | undefined, secret: string,
  nowSeconds = Math.floor(Date.now() / 1000), tolerance = WEBHOOK_TOLERANCE_SECONDS): boolean {
  if (!header || !secret) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => String(v ?? ""));
  if (!Number.isFinite(t) || !sigs.length) return false;
  if (Math.abs(nowSeconds - t) > tolerance) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")}`).digest("hex");
  const exp = Buffer.from(expected, "hex");
  return sigs.some((s) => {
    const got = /^[0-9a-f]+$/i.test(s) ? Buffer.from(s, "hex") : Buffer.alloc(0);
    return got.length === exp.length && timingSafeEqual(got, exp);
  });
}

/** Builds a Stripe-Signature header (tests, and the "send test event" check). */
export function signStripePayload(payload: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
}
