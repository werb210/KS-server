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
]);

export const PER_BROKERAGE_PREFIXES: readonly string[] = ["QBO_", "TWILIO_", "KS_M365_", "KS_GOOGLE_", "SIGNNOW_"];

export function isPerBrokerageKey(key: string): boolean {
  return PER_BROKERAGE_KEYS.has(key) || PER_BROKERAGE_PREFIXES.some((p) => key.startsWith(p));
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
