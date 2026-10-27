// KS_SERVER_v12_GOOGLE_WORKSPACE - Google OAuth settings and the scopes this copy asks for.
//
// The default scope set is Google's "sensitive" tier only (standard app verification, free):
//   openid email profile + gmail.send + calendar.events + tasks + drive.file
// Reading mail (gmail.readonly) is a RESTRICTED scope: it needs Google's yearly third-party security assessment
// (CASA). It is requested only when GOOGLE_GMAIL_READ_ENABLED is "true"; until then it never appears in a consent
// request and the Gmail sync never runs. See docs/GOOGLE_WORKSPACE.md.
import { portalUrl, serverUrl } from "../../licensee/urls.js";
import { redirectUriFor } from "../../licensee/oauthBroker.js";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export const SCOPE_GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
export const SCOPE_CALENDAR_EVENTS = "https://www.googleapis.com/auth/calendar.events";
export const SCOPE_TASKS = "https://www.googleapis.com/auth/tasks";
export const SCOPE_DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
/** RESTRICTED - only with GOOGLE_GMAIL_READ_ENABLED=true (after the CASA assessment). */
export const SCOPE_GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";

export const BASE_SCOPES: readonly string[] = [
  "openid",
  "email",
  "profile",
  SCOPE_GMAIL_SEND,
  SCOPE_CALENDAR_EVENTS,
  SCOPE_TASKS,
  SCOPE_DRIVE_FILE,
];

/** Restricted Gmail scopes. None of these may be requested while the read switch is off. */
export const RESTRICTED_SCOPES: readonly string[] = [
  SCOPE_GMAIL_READONLY,
  "https://www.googleapis.com/auth/gmail.modify",
  "https://mail.google.com/",
];

const env = (name: string, e: NodeJS.ProcessEnv): string => String(e[name] ?? "").trim();

/** True only for an explicit "true"/"1"/"yes"/"on". Anything else (unset included) is off. */
export function gmailReadEnabled(e: NodeJS.ProcessEnv = process.env): boolean {
  return /^(true|1|yes|on)$/i.test(env("GOOGLE_GMAIL_READ_ENABLED", e));
}

/** The scopes the consent screen asks for. gmail.readonly is added only when the read switch is on. */
export function requestedScopes(e: NodeJS.ProcessEnv = process.env): string[] {
  return gmailReadEnabled(e) ? [...BASE_SCOPES, SCOPE_GMAIL_READONLY] : [...BASE_SCOPES];
}

export type GoogleOAuthConfig = { clientId: string; clientSecret: string; redirectUri: string; returnUrl: string };

/** KS_SERVER_M365_ONE_CLICK - the Google OAuth client: this server's own (GOOGLE_OAUTH_CLIENT_ID / _SECRET) when set,
 *  else Keystone's single client, which KS-Ops writes to every licensee server (KS_GOOGLE_OAUTH_CLIENT_ID / _SECRET). */
export function googleClientCredentials(e: NodeJS.ProcessEnv = process.env): { clientId: string; clientSecret: string; source: "own" | "keystone" } | null {
  const ownId = env("GOOGLE_OAUTH_CLIENT_ID", e);
  const ownSecret = env("GOOGLE_OAUTH_CLIENT_SECRET", e);
  if (ownId && ownSecret) return { clientId: ownId, clientSecret: ownSecret, source: "own" };
  const ksId = env("KS_GOOGLE_OAUTH_CLIENT_ID", e);
  const ksSecret = env("KS_GOOGLE_OAUTH_CLIENT_SECRET", e);
  if (ksId && ksSecret) return { clientId: ksId, clientSecret: ksSecret, source: "keystone" };
  return null;
}

/** Why Google cannot be used on this copy, or null when it is fully configured. */
export function googleConfigProblem(e: NodeJS.ProcessEnv = process.env): string | null {
  if (!googleClientCredentials(e)) {
    return "Google Workspace is not available on this server yet. Keystone sets it up for you; contact Keystone support if it stays like this.";
  }
  if (!env("GOOGLE_TOKEN_ENCRYPTION_KEY", e)) {
    return "Google Workspace is not available on this server yet (its token key is missing). Contact Keystone support.";
  }
  return null;
}

export function googleOAuthConfig(e: NodeJS.ProcessEnv = process.env): GoogleOAuthConfig | null {
  if (googleConfigProblem(e)) return null;
  const creds = googleClientCredentials(e)!;
  return {
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    // With Keystone's redirect broker (KS_OAUTH_BROKER_URL) Google sends everyone to one verified address on KS-Ops.
    redirectUri: env("GOOGLE_OAUTH_REDIRECT_URI", e) || redirectUriFor("google", serverUrl() + "/api/google/oauth/callback", e),
    returnUrl: env("GOOGLE_OAUTH_RETURN_URL", e) || portalUrl() + "/settings/profile",
  };
}

/** Scope string Google returned -> list. */
export function parseScopes(raw: unknown): string[] {
  return String(raw ?? "").split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

export function hasScope(granted: string | string[] | null | undefined, scope: string): boolean {
  const list = Array.isArray(granted) ? granted : parseScopes(granted);
  return list.includes(scope);
}
