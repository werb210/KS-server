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

export function qboEnvironment(e: NodeJS.ProcessEnv = process.env): QboEnvironment {
  return env("QBO_ENVIRONMENT", e).toLowerCase() === "production" ? "production" : "sandbox";
}

export function qboApiBase(environment: QboEnvironment): string {
  return environment === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com";
}

/** Why QuickBooks cannot be used on this copy, or null when it is fully configured. */
export function qboConfigProblem(e: NodeJS.ProcessEnv = process.env): string | null {
  const missing = ["QBO_CLIENT_ID", "QBO_CLIENT_SECRET", "QBO_TOKEN_ENCRYPTION_KEY"].filter((n) => !env(n, e));
  if (missing.length) return `QuickBooks is not set up on this server yet (${missing.join(", ")}).`;
  return null;
}

export function qboConfig(e: NodeJS.ProcessEnv = process.env): QboConfig | null {
  if (qboConfigProblem(e)) return null;
  const environment = qboEnvironment(e);
  return {
    clientId: env("QBO_CLIENT_ID", e),
    clientSecret: env("QBO_CLIENT_SECRET", e),
    redirectUri: env("QBO_REDIRECT_URI", e) || serverUrl() + "/api/quickbooks/oauth/callback",
    returnUrl: portalUrl() + "/settings/company",
    environment,
    apiBase: qboApiBase(environment),
  };
}
