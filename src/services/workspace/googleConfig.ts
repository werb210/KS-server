// KS_SERVER_v12_GOOGLE_WORKSPACE - Google OAuth settings and the scopes this copy asks for.
//
// The default scope set is Google's "sensitive" tier only (standard app verification, free):
//   openid email profile + gmail.send + calendar.events + tasks + drive.file
// Reading mail (gmail.readonly) is a RESTRICTED scope: it needs Google's yearly third-party security assessment
// (CASA). It is requested only when GOOGLE_GMAIL_READ_ENABLED is "true"; until then it never appears in a consent
// request and the Gmail sync never runs. See docs/GOOGLE_WORKSPACE.md.
import { portalUrl, serverUrl } from "../../licensee/urls.js";

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

/** Why Google cannot be used on this copy, or null when it is fully configured. */
export function googleConfigProblem(e: NodeJS.ProcessEnv = process.env): string | null {
  if (!env("GOOGLE_OAUTH_CLIENT_ID", e) || !env("GOOGLE_OAUTH_CLIENT_SECRET", e)) {
    return "Google Workspace is not set up on this server yet (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET).";
  }
  if (!env("GOOGLE_TOKEN_ENCRYPTION_KEY", e)) {
    return "Google Workspace is not set up on this server yet (GOOGLE_TOKEN_ENCRYPTION_KEY).";
  }
  return null;
}

export function googleOAuthConfig(e: NodeJS.ProcessEnv = process.env): GoogleOAuthConfig | null {
  if (googleConfigProblem(e)) return null;
  return {
    clientId: env("GOOGLE_OAUTH_CLIENT_ID", e),
    clientSecret: env("GOOGLE_OAUTH_CLIENT_SECRET", e),
    redirectUri: env("GOOGLE_OAUTH_REDIRECT_URI", e) || serverUrl() + "/api/google/oauth/callback",
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
