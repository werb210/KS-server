// KS_SERVER_M365_ONE_CLICK - Keystone's single OAuth redirect address (the "redirect broker" on KS-Ops).
//
// Microsoft allows at most 256 redirect URIs on one app (wildcards are discouraged and not allowed for every account
// type), and Google only accepts redirect URIs on verified domains, which *.azurewebsites.net never is. Every
// licensee server needs three Microsoft and two Google callbacks, so per-licensee redirect URIs do not scale.
// Instead Keystone's apps list ONE redirect URI per provider, on KS-Ops:
//     {KS_OAUTH_BROKER_URL}/microsoft      {KS_OAUTH_BROKER_URL}/google
// This server wraps its own single-use state as
//     ks1.<licensee id>.<flow>.<expiry, unix seconds>.<inner state>.<HMAC-SHA256(KS_OPS_KEY) of everything before>
// KS-Ops checks the HMAC with the licensee's ops key (it keeps it encrypted), the expiry and the flow, and redirects
// the browser to THIS licensee's server address from its own records (never an address taken from the state), with
// every query parameter unchanged. Here the callback unwraps the state again (checking the same HMAC) and goes on
// exactly as before: cookie, single-use row, PKCE. The code is redeemed with the broker address as redirect_uri, which
// is what both providers require.
//
// Without KS_OAUTH_BROKER_URL (or without KS_LICENSEE_ID / KS_OPS_KEY) nothing changes: the redirect URIs are this
// server's own and the state is not wrapped. Boreal's own server and the development copy run that way.
import { createHmac, timingSafeEqual } from "node:crypto";

export type BrokerProvider = "microsoft" | "google";
export type BrokerFlow = "o365" | "consent" | "sso-ms" | "google" | "sso-google";

export const FLOW_PROVIDER: Record<BrokerFlow, BrokerProvider> = {
  o365: "microsoft",
  consent: "microsoft",
  "sso-ms": "microsoft",
  google: "google",
  "sso-google": "google",
};

const env = (name: string, e: NodeJS.ProcessEnv): string => String(e[name] ?? "").trim();

export type BrokerConfig = { base: string; licenseeId: string; key: string };

export function brokerConfig(e: NodeJS.ProcessEnv = process.env): BrokerConfig | null {
  const base = env("KS_OAUTH_BROKER_URL", e).replace(/\/+$/, "");
  const licenseeId = env("KS_LICENSEE_ID", e);
  const key = env("KS_OPS_KEY", e);
  if (!/^https:\/\/[^\s/]+/i.test(base) || !/^[0-9a-f-]{36}$/i.test(licenseeId) || !key) return null;
  return { base, licenseeId, key };
}

/** The redirect URI for a provider: the broker's when it is set up, else this server's own callback. */
export function redirectUriFor(provider: BrokerProvider, ownCallback: string, e: NodeJS.ProcessEnv = process.env): string {
  const b = brokerConfig(e);
  return b ? `${b.base}/${provider}` : ownCallback;
}

function mac(key: string, body: string): string {
  return createHmac("sha256", key).update(body, "utf8").digest("base64url");
}

/** Wraps a state for the broker (unchanged without one). The inner state must be base64url (no dots). */
export function wrapState(flow: BrokerFlow, inner: string, ttlMs: number, e: NodeJS.ProcessEnv = process.env, now = Date.now()): string {
  const b = brokerConfig(e);
  if (!b) return inner;
  const exp = Math.floor((now + ttlMs) / 1000);
  const body = `ks1.${b.licenseeId}.${flow}.${exp}.${inner}`;
  return `${body}.${mac(b.key, body)}`;
}

/**
 * The inner state of a callback's state, or null when it is a wrapped state that is not ours, not for this flow,
 * expired or tampered with. A state that is not wrapped is returned unchanged (servers without the broker, and
 * sign-ins started before the broker was set up); the callbacks' own cookie and single-use checks still apply.
 */
export function unwrapState(flow: BrokerFlow, raw: string, e: NodeJS.ProcessEnv = process.env, now = Date.now()): string | null {
  if (!raw.startsWith("ks1.")) return raw;
  const parts = raw.split(".");
  if (parts.length !== 6) return null;
  const [, licenseeId, gotFlow, expRaw, inner, gotMac] = parts as [string, string, string, string, string, string];
  const b = brokerConfig(e);
  if (!b || licenseeId !== b.licenseeId || gotFlow !== flow) return null;
  const want = Buffer.from(mac(b.key, parts.slice(0, 5).join(".")), "utf8");
  const got = Buffer.from(gotMac, "utf8");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp * 1000 < now) return null;
  return inner || null;
}
