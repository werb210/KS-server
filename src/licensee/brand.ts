// KS_SERVER_v4_BRANDING - the licensee's name and contacts, synchronously.
//
// Texts, emails, PDFs, push notifications and AI prompts used to say "Boreal Financial" and "Maya". They now say the
// licensee's own names. getLicenseeSettings() is async and cached for 60 s; many message builders are plain
// functions or string templates that cannot await, so this module hands out the values getLicenseeSettings last
// loaded. startBrandRefresh() loads them at startup and again every cache cycle, and PUT /api/licensee reloads them
// on save (updateLicenseeSettings reads them back). Before the first load, the KS_* settings / neutral defaults apply.
import { envDefaults, getLicenseeSettings, lastLoadedLicensee, type LicenseeSettings } from "./settings.js";
import { hostOf, websiteUrl } from "./urls.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** The licensee settings as last loaded, else the KS_* settings and neutral defaults. */
export function brandSettings(): LicenseeSettings {
  return lastLoadedLicensee() ?? envDefaults();
}

/** The trading name, e.g. "Acme Capital". Never empty. */
export function brandName(): string {
  return brandSettings().company_name || envDefaults().company_name;
}

/** The legal name, falling back to the trading name. */
export function legalName(): string {
  return brandSettings().legal_name || brandName();
}

/** The AI assistant's name, e.g. "Assistant". Never empty. */
export function assistantName(): string {
  return brandSettings().assistant_name || envDefaults().assistant_name;
}

/** The support email address, or "" when the licensee has not set one. */
export function supportEmail(): string {
  return brandSettings().support_email;
}

/** The support phone number as entered, or "" when the licensee has not set one. */
export function supportPhone(): string {
  return brandSettings().support_phone;
}

/** The licensee's website host, e.g. "acme.example" - for "Info: <host>" lines. */
export function websiteHost(): string {
  return hostOf(websiteUrl());
}

/** "email x or call y" / "email x" / "call y" / "" - whichever contacts the licensee has set. */
export function contactLine(): string {
  const email = supportEmail();
  const phone = supportPhone();
  if (email && phone) return `call ${phone} or email ${email}`;
  if (email) return `email ${email}`;
  if (phone) return `call ${phone}`;
  return "";
}

/** Loads the settings now. Never throws: a database error leaves the previous values in place. */
export async function warmBrand(db: Q): Promise<void> {
  try {
    await getLicenseeSettings(db);
  } catch (err) {
    console.warn("[licensee] brand settings not loaded:", err instanceof Error ? err.message : String(err));
  }
}

/** Loads the settings now and every 60 s after. Returns a stop function. */
export function startBrandRefresh(db: Q, everyMs = 60_000): { stop: () => void; ready: Promise<void> } {
  const ready = warmBrand(db);
  const timer = setInterval(() => { void warmBrand(db); }, everyMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), ready };
}

/** The sender address for SignNow invites: SIGNNOW_FROM_EMAIL, else the support email. */
export function signnowFromEmail(): string {
  return String(process.env.SIGNNOW_FROM_EMAIL ?? "").trim() || supportEmail();
}

/** Text pdf-lib's standard (WinAnsi) fonts can draw: smart quotes and dashes simplified, anything else dropped. */
export function winAnsi(s: string): string {
  return String(s ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, "\"")
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E -ÿ]/g, "");
}
