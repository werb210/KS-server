// KS_SERVER_v4_BRANDING - the licensee's name and contacts, synchronously.
//
// Texts, emails, PDFs, push notifications and AI prompts used to say "Boreal Financial" and "Maya". They now say the
// licensee's own names. getLicenseeSettings() is async and cached for 60 s; many message builders are plain
// functions or string templates that cannot await, so this module hands out the values getLicenseeSettings last
// loaded. startBrandRefresh() loads them at startup and again every cache cycle, and PUT /api/licensee reloads them
// on save (updateLicenseeSettings reads them back). Before the first load, the KS_* settings / neutral defaults apply.
import { envDefaults, getLicenseeConnections, getLicenseeSettings, lastLoadedLicensee, type LicenseeSettings } from "./settings.js";
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

/** KS_SERVER_v5_MAILING_ADDRESS - the licensee's mailing address on one line, or "" when not set. */
export function mailingAddress(): string {
  return String(brandSettings().mailing_address ?? "").replace(/\s*\n\s*/g, ", ").trim();
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
  // KS_SERVER_v8_CONNECTIONS - the licensee's own main line / Google Ads id (src/licensee/connections.ts).
  try {
    await getLicenseeConnections(db);
  } catch (err) {
    console.warn("[licensee] connection settings not loaded:", err instanceof Error ? err.message : String(err));
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

// ---- KS_SERVER_v14_BRAND_FONT - the licensee's colours and font on the pages this server shows to its clients ----
// (share links, file requests, meeting join pages). Every colour pairing is checked so text stays readable: a brand
// colour too light for white text gets dark text, and one too light to read on white is not used for text.

const HEX = /^#[0-9a-f]{6}$/i;
const INK = "#0F172A";
const WHITE = "#FFFFFF";

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two #RRGGBB colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/** White or dark ink, whichever reads better on `bg`. */
export function textOn(bg: string): string {
  return contrastRatio(bg, WHITE) >= contrastRatio(bg, INK) ? WHITE : INK;
}

/** Fonts every device already has: no web font is loaded for these. */
const SYSTEM_FONTS = new Set(["arial", "helvetica", "georgia", "verdana", "tahoma", "trebuchet ms", "times new roman", "courier new", "system-ui", "segoe ui"]);

export type BrandTheme = {
  primary: string;
  primaryText: string;
  /** The brand colour for text on white, or dark ink when the brand colour is too light to read there. */
  brandText: string;
  background: string;
  fontStack: string;
  /** A Google Fonts <link> for the licensee's font, or "". */
  fontLink: string;
};

export function brandTheme(s = brandSettings()): BrandTheme {
  const primary = HEX.test(s.primary_color) ? s.primary_color.toUpperCase() : "#0B1F3A";
  const background = HEX.test(String(s.background_color ?? "")) ? String(s.background_color).toUpperCase() : "#F1F5F9";
  const family = String(s.font_family ?? "").trim();
  const safeFamily = /^[A-Za-z0-9][A-Za-z0-9 -]{0,59}$/.test(family) ? family : "";
  const system = "-apple-system, Segoe UI, Roboto, Arial, sans-serif";
  return {
    primary,
    primaryText: textOn(primary),
    brandText: contrastRatio(primary, WHITE) >= 4.5 ? primary : INK,
    background,
    fontStack: safeFamily ? `"${safeFamily}", ${system}` : system,
    fontLink:
      safeFamily && !SYSTEM_FONTS.has(safeFamily.toLowerCase())
        ? `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${safeFamily.replace(/ /g, "+")}:wght@400;600;700&amp;display=swap">`
        : "",
  };
}
