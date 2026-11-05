// KS_SERVER_v13_QUICKBOOKS - QuickBooks Online (Intuit OAuth 2.0) settings for this licensee's copy.
//
//   QBO_CLIENT_ID / QBO_CLIENT_SECRET   the Intuit developer app's keys (required)
//   QBO_TOKEN_ENCRYPTION_KEY            32 random bytes, base64 or hex (openssl rand -base64 32) (required)
//   QBO_REDIRECT_URI                    default {KS_SERVER_URL}/api/quickbooks/oauth/callback
//   QBO_ENVIRONMENT                     sandbox (default) | production
//
// Without the three required values the feature is off: nothing is queued, the worker does nothing, and the portal
// shows the Settings card greyed out with the reason from qboConfigProblem().
import { portalUrl, serverUrl } from "../../licensee/urls.js";
import { redirectUriFor } from "../../licensee/oauthBroker.js"; // KS_BROKERAGE_QBO

export const QBO_AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
export const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const QBO_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
export const QBO_SCOPE = "com.intuit.quickbooks.accounting";
export const QBO_MINOR_VERSION = "75";

export type QboEnvironment = "sandbox" | "production";
export type QboConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  returnUrl: string;
  environment: QboEnvironment;
  apiBase: string;
};

const env = (name: string, e: NodeJS.ProcessEnv): string => String(e[name] ?? "").trim();

// KS_BROKERAGE_QBO - every brokerage connects its own QuickBooks company through KEYSTONE'S one Intuit app:
//   KS_INTUIT_CLIENT_ID / KS_INTUIT_CLIENT_SECRET   Keystone's Intuit app (shared App Service settings)
//   KS_INTUIT_ENVIRONMENT                           production | sandbox for that app (default sandbox)
// A brokerage's own QBO_CLIENT_ID / QBO_CLIENT_SECRET (its own Intuit app) still win when set. With Keystone's
// redirect broker (KS_OAUTH_BROKER_URL) Intuit sends everyone to one address on KS-Ops: {broker}/intuit.
const usesKeystoneApp = (e: NodeJS.ProcessEnv): boolean => !env("QBO_CLIENT_ID", e) && Boolean(env("KS_INTUIT_CLIENT_ID", e));
const clientIdOf = (e: NodeJS.ProcessEnv): string => env("QBO_CLIENT_ID", e) || env("KS_INTUIT_CLIENT_ID", e);
const clientSecretOf = (e: NodeJS.ProcessEnv): string => (env("QBO_CLIENT_ID", e) ? env("QBO_CLIENT_SECRET", e) : env("KS_INTUIT_CLIENT_SECRET", e));

export function qboEnvironment(e: NodeJS.ProcessEnv = process.env): QboEnvironment {
  const raw = usesKeystoneApp(e) ? env("KS_INTUIT_ENVIRONMENT", e) : env("QBO_ENVIRONMENT", e);
  return raw.toLowerCase() === "production" ? "production" : "sandbox";
}

export function qboApiBase(environment: QboEnvironment): string {
  return environment === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com";
}

/** Why QuickBooks cannot be used on this copy, or null when it is fully configured. */
export function qboConfigProblem(e: NodeJS.ProcessEnv = process.env): string | null {
  const missing: string[] = [];
  if (!clientIdOf(e)) missing.push("KS_INTUIT_CLIENT_ID");
  if (!clientSecretOf(e)) missing.push(env("QBO_CLIENT_ID", e) ? "QBO_CLIENT_SECRET" : "KS_INTUIT_CLIENT_SECRET");
  if (!env("QBO_TOKEN_ENCRYPTION_KEY", e)) missing.push("QBO_TOKEN_ENCRYPTION_KEY");
  if (missing.length) return `QuickBooks is not set up on this server yet (${missing.join(", ")}).`;
  return null;
}

export function qboConfig(e: NodeJS.ProcessEnv = process.env): QboConfig | null {
  if (qboConfigProblem(e)) return null;
  const environment = qboEnvironment(e);
  return {
    clientId: clientIdOf(e),
    clientSecret: clientSecretOf(e),
    redirectUri: env("QBO_REDIRECT_URI", e) || redirectUriFor("intuit", serverUrl() + "/api/quickbooks/oauth/callback", e), // KS_BROKERAGE_QBO
    returnUrl: portalUrl() + "/settings/company",
    environment,
    apiBase: qboApiBase(environment),
  };
}
