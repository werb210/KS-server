// KS_SHARED_HOSTING_v1 - process.env answers with the current brokerage's values.
//
// Installed once at startup, and only in multi-brokerage mode. Inside a brokerage (a request or a job):
//   - a key the brokerage has in env_enc returns its value (a per-brokerage value overrides a shared one);
//   - a per-brokerage key it does not have returns undefined: never the shared app's or another brokerage's value;
//   - every other key (OPENAI_API_KEY, SENDGRID_API_KEY, AZURE_STORAGE_CONNECTION_STRING, NODE_ENV, PORT, ...)
//     returns the shared App Service setting.
// Outside a brokerage every read is the shared App Service setting. Writes always go to the real environment.
import { currentTenant } from "./context.js";
import { sharedEnv } from "./mode.js";

/** Exactly the values a brokerage's own App Service used to hold (the contract's list, plus what KS-Ops writes). */
export const PER_BROKERAGE_KEYS: ReadonlySet<string> = new Set([
  "DATABASE_URL",
  "JWT_SECRET", "JWT_REFRESH_SECRET", "OTP_HASH_SALT",
  "KS_LICENSEE_ID", "KS_OPS_KEY", "KS_OPS_URL", "KS_PLAN",
  "KS_SERVER_URL", "KS_PORTAL_URL", "KS_CLIENT_URL", "CLIENT_URL", "PUBLIC_BASE_URL", "PUBLIC_SERVER_URL", "MAYA_URL",
  "KS_OAUTH_BROKER_URL", "SENDGRID_FROM", "SENDGRID_REPLY_TO",
  // Generated per licensee by KS-Ops (GENERATED_SERVER_SECRETS).
  "GOOGLE_TOKEN_ENCRYPTION_KEY", "WATCH_PUSH_ENCRYPTION_KEY",
  // KS_SERVER_SIGNNOW_SHARED_v1 - the callback address is the brokerage's own (never the shared server's).
  "SIGNNOW_WEBHOOK_URL",
]);

// KS_SERVER_SIGNNOW_SHARED_v1 - SIGNNOW_ is no longer per brokerage: every brokerage signs through Keystone's own
// SignNow account (the shared SIGNNOW_API_KEY / SIGNNOW_WEBHOOK_SECRET), unless KS-Ops gives a brokerage its own.
export const PER_BROKERAGE_PREFIXES: readonly string[] = ["QBO_", "TWILIO_", "KS_M365_", "KS_GOOGLE_", "ONFIDO_"];

// KS_SERVER_VENDOR_KEYS - a brokerage's own verification-service keys (Settings > Your services), stored in its own
// database. Registered by src/integrations/vendorKeys.ts so this file has no database dependency.
const VENDOR_KEYS_ALSO: ReadonlySet<string> = new Set(["IPINFO_TOKEN", "CORPORATIONS_CANADA_API_KEY", "OPENAI_ADS_API_KEY"]); // KS_SERVER_CHATGPT_ADS_v1 - each brokerage its own ad account
let vendorLookup: ((name: string) => string | undefined) | null = null;
export function setVendorKeyLookup(fn: ((name: string) => string | undefined) | null): void {
  vendorLookup = fn;
}
const isVendorKey = (k: string) => k.startsWith("ONFIDO_") || VENDOR_KEYS_ALSO.has(k);

export function isPerBrokerageKey(key: string): boolean {
  return PER_BROKERAGE_KEYS.has(key) || PER_BROKERAGE_PREFIXES.some((p) => key.startsWith(p)) || VENDOR_KEYS_ALSO.has(key);
}

let installed = false;

export function envOverlayInstalled(): boolean {
  return installed;
}

/** The overlay as a Proxy over the real environment (exported for tests; installEnvOverlay() uses it). */
export function createEnvOverlay(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const tenantEnv = (): Record<string, string> | null => currentTenant()?.env ?? null;
  return new Proxy(base, {
    get(target, key, receiver) {
      if (typeof key === "string") {
        const env = tenantEnv();
        if (env) {
          if (isVendorKey(key) && vendorLookup) { const v = vendorLookup(key); if (v !== undefined) return v; } // KS_SERVER_VENDOR_KEYS
          if (Object.prototype.hasOwnProperty.call(env, key)) return env[key];
          if (isPerBrokerageKey(key)) return undefined;
        }
      }
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      if (typeof key === "string") {
        const env = tenantEnv();
        if (env) {
          if (isVendorKey(key) && vendorLookup && vendorLookup(key) !== undefined) return true; // KS_SERVER_VENDOR_KEYS
          if (Object.prototype.hasOwnProperty.call(env, key)) return true;
          if (isPerBrokerageKey(key)) return false;
        }
      }
      return Reflect.has(target, key);
    },
    ownKeys(target) {
      const env = tenantEnv();
      const keys = Reflect.ownKeys(target);
      if (!env) return keys;
      const out = new Set<string | symbol>(keys.filter((k) => typeof k !== "string" || !isPerBrokerageKey(k)));
      for (const k of Object.keys(env)) out.add(k);
      return [...out];
    },
    getOwnPropertyDescriptor(target, key) {
      if (typeof key === "string") {
        const env = tenantEnv();
        if (env) {
          if (Object.prototype.hasOwnProperty.call(env, key)) {
            return { value: env[key], writable: true, enumerable: true, configurable: true };
          }
          if (isPerBrokerageKey(key)) return undefined;
        }
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    set(target, key, value) {
      return Reflect.set(target, key, value);
    },
    deleteProperty(target, key) {
      return Reflect.deleteProperty(target, key);
    },
  });
}

/** Replace process.env with the overlay. Once; a no-op outside multi-brokerage mode unless forced (tests). */
export function installEnvOverlay(opts: { force?: boolean } = {}): boolean {
  if (installed) return true;
  const base = sharedEnv();
  if (!opts.force && !String(base.KS_CONTROL_DATABASE_URL ?? "").trim()) return false;
  process.env = createEnvOverlay(base);
  installed = true;
  return true;
}

/** Tests: put the real environment back. */
export function uninstallEnvOverlayForTests(): void {
  if (!installed) return;
  process.env = sharedEnv();
  installed = false;
}
