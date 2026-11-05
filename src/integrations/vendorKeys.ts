// KS_SERVER_VENDOR_KEYS - a brokerage's own accounts with paid verification services (bring your own keys).
//
// An Admin pastes the keys from their own Entrust IDV (Onfido), ipinfo and Corporations Canada accounts in
// Settings > Your services. They are stored encrypted (AES-256-GCM) in that brokerage's own database (vendor_keys),
// never shown again (only "set" and the last 4 characters), and read back into a small in-memory cache per brokerage
// (refreshed every minute and right after a save). process.env then answers those names with the brokerage's own
// values (tenancy/envOverlay.ts), so the existing ID-check, IP and registry code uses them unchanged. Keys are never
// shared between brokerages, and Keystone's own settings are never used for a brokerage.
import type { Pool } from "pg";
import { decryptToken, encryptToken, type TokenKeyName } from "../services/workspace/tokenCrypto.js";
import { currentTenantCode } from "../tenancy/context.js";
import { envOverlayInstalled, setVendorKeyLookup } from "../tenancy/envOverlay.js";

export type VendorKeyDef = { key: string; label: string; service: string; secret: boolean; hint?: string };

export const VENDOR_KEYS: readonly VendorKeyDef[] = [
  { key: "ONFIDO_API_TOKEN", service: "id", label: "Entrust IDV (Onfido) API token", secret: true },
  { key: "ONFIDO_WORKFLOW_ID", service: "id", label: "Entrust IDV (Onfido) workflow ID", secret: false },
  { key: "ONFIDO_WEBHOOK_TOKEN", service: "id", label: "Entrust IDV (Onfido) webhook token", secret: true },
  { key: "ONFIDO_REGION", service: "id", label: "Entrust IDV (Onfido) region", secret: false, hint: "ca, us or eu (ca keeps applicant data in Canada)" },
  { key: "IPINFO_TOKEN", service: "ip", label: "ipinfo token", secret: true },
  { key: "CORPORATIONS_CANADA_API_KEY", service: "registry", label: "Corporations Canada API key", secret: true },
];
export const VENDOR_KEY_NAMES: ReadonlySet<string> = new Set(VENDOR_KEYS.map((d) => d.key));

const SINGLE = "__single__";
const cache = new Map<string, Record<string, string>>();
const setBySingleMode = new Set<string>();
const cacheKey = () => currentTenantCode() ?? SINGLE;

/** The brokerage's own value for a vendor key, or undefined when it has none (the overlay then answers undefined). */
export function vendorKeyFor(name: string): string | undefined {
  return cache.get(cacheKey())?.[name];
}
setVendorKeyLookup(vendorKeyFor);

const KEY_NAMES: TokenKeyName[] = ["LENDER_CREDENTIALS_ENCRYPTION_KEY", "GOOGLE_TOKEN_ENCRYPTION_KEY", "QBO_TOKEN_ENCRYPTION_KEY"];
/** The first encryption key this brokerage has (KS-Ops generates them per brokerage). */
export function sealingKey(e: NodeJS.ProcessEnv = process.env): TokenKeyName | null {
  return KEY_NAMES.find((k) => String(e[k] ?? "").trim()) ?? null;
}

type Q = Pick<Pool, "query">;

/** Reads, decrypts and caches this brokerage's keys. Never throws (a broken row is skipped and logged). */
export async function loadVendorKeys(db: Q): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const r = await db.query(`SELECT key, value_enc, key_name FROM vendor_keys`);
    for (const row of r.rows as Array<{ key: string; value_enc: string; key_name: TokenKeyName }>) {
      if (!VENDOR_KEY_NAMES.has(row.key)) continue;
      let v: string | null = null;
      try { v = decryptToken(row.value_enc, process.env, row.key_name); } catch (err) { console.warn("[vendor-keys] could not decrypt", { key: row.key, message: (err as Error)?.message }); }
      if (v) out[row.key] = v;
    }
  } catch (err) {
    console.warn("[vendor-keys] load failed", { message: (err as Error)?.message });
    return cache.get(cacheKey()) ?? {};
  }
  cache.set(cacheKey(), out);
  if (!envOverlayInstalled()) {
    // Single-brokerage server: the process is this brokerage, so its own keys go straight into the environment.
    for (const k of VENDOR_KEY_NAMES) {
      if (out[k]) { process.env[k] = out[k]; setBySingleMode.add(k); }
      else if (setBySingleMode.has(k)) { delete process.env[k]; setBySingleMode.delete(k); }
    }
  }
  return out;
}

export type VendorKeyView = VendorKeyDef & { set: boolean; preview: string | null };

export function viewOf(values: Record<string, string>): VendorKeyView[] {
  return VENDOR_KEYS.map((d) => {
    const v = values[d.key];
    return { ...d, set: Boolean(v), preview: v ? (d.secret ? `••••${v.slice(-4)}` : v) : null };
  });
}

export class VendorKeyError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Saves the given keys (a string sets it, null or "" removes it), then reloads the cache. */
export async function saveVendorKeys(db: Q, changes: Record<string, unknown>, userId: string | null): Promise<Record<string, string>> {
  const keyName = sealingKey();
  for (const [k, raw] of Object.entries(changes)) {
    if (!VENDOR_KEY_NAMES.has(k)) throw new VendorKeyError(`unknown_key:${k}`);
    const v = raw === null || raw === undefined ? "" : String(raw).trim();
    if (v.length > 500) throw new VendorKeyError(`too_long:${k}`);
    if (k === "ONFIDO_REGION" && v && !["ca", "us", "eu"].includes(v.toLowerCase())) throw new VendorKeyError("bad_region");
    if (!v) { await db.query(`DELETE FROM vendor_keys WHERE key = $1`, [k]); continue; }
    if (!keyName) throw new VendorKeyError("no_encryption_key");
    const value = k === "ONFIDO_REGION" ? v.toLowerCase() : v;
    await db.query(
      `INSERT INTO vendor_keys (key, value_enc, key_name, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (key) DO UPDATE SET value_enc = EXCLUDED.value_enc, key_name = EXCLUDED.key_name, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [k, encryptToken(value, process.env, keyName), keyName, userId],
    );
  }
  return loadVendorKeys(db);
}

/** Loads now and every minute (each server instance, each brokerage). */
export function startVendorKeyRefresher(db: Q, everyMs = 60_000): { stop: () => void } {
  void loadVendorKeys(db);
  const t = setInterval(() => { void loadVendorKeys(db); }, everyMs);
  t.unref?.();
  return { stop: () => clearInterval(t) };
}

/** Tests only. */
export function clearVendorKeyCacheForTests(): void {
  cache.clear();
  for (const k of setBySingleMode) delete process.env[k];
  setBySingleMode.clear();
}
