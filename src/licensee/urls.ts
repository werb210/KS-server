// KS_SERVER_v1_LICENSEE - the web addresses of this copy of Keystone.
//
// KS-server was copied from BF-Server, which wrote Boreal's addresses (server/client/staff/www.boreal.financial) into
// links, CORS, webhooks and callbacks. Each Keystone copy has its own, set in its App Service settings. When a
// setting is missing, the development copy's address is used - never Boreal's.
const DEV = {
  server: "https://ks-server-dev-chb5htbwaue2hygk.canadacentral-01.azurewebsites.net",
  portal: "https://thankful-wave-04964490f.2.azurestaticapps.net",
  client: "https://wonderful-island-0b68ae310.5.azurestaticapps.net",
};

function first(...names: string[]): string {
  for (const name of names) {
    const v = String(process.env[name] ?? "").trim();
    if (/^https?:\/\/[^\s/]+/i.test(v)) return v.replace(/\/+$/, "");
  }
  return "";
}

/** This copy's server, e.g. for Twilio, SignNow and Microsoft callbacks and links to files. */
export function serverUrl(): string {
  return first("KS_SERVER_URL", "PUBLIC_BASE_URL", "PUBLIC_SERVER_URL", "SERVER_PUBLIC_URL", "SERVER_URL") || DEV.server;
}

/** This copy's client app (application wizard and client portal). */
export function clientUrl(): string {
  return first("KS_CLIENT_URL", "CLIENT_URL", "CLIENT_BASE_URL", "CLIENT_APP_URL", "CLIENT_PORTAL_URL") || DEV.client;
}

/** This copy's staff portal. */
export function portalUrl(): string {
  return first("KS_PORTAL_URL", "PORTAL_URL") || DEV.portal;
}

/** The licensee's public website; their client app until they give one. */
export function websiteUrl(): string {
  return first("KS_WEBSITE_URL", "WEBSITE_URL", "BF_WEBSITE_URL") || clientUrl();
}

/** Host name only, e.g. for "Sign in at <host>" in messages. */
export function hostOf(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
}

/** Origins the browser apps of this copy are served from (CORS and CSP). */
export function licenseeOrigins(): string[] {
  return Array.from(new Set([portalUrl(), clientUrl(), websiteUrl()]));
}
