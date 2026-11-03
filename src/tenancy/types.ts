// KS_SHARED_HOSTING_v1 - a brokerage as the registry (ks_control.ks_tenants) describes it, decrypted.
import type { Pool } from "pg";

export type TenantStatus = "provisioning" | "trial" | "active" | "past_due" | "suspended" | "cancelled";

export type Tenant = {
  code: string;
  licenseeId: string | null;
  status: TenantStatus | string;
  apiHosts: string[];
  portalHosts: string[];
  clientHosts: string[];
  databaseName: string;
  /** Decrypted connection string for the role ks_<code>_app. */
  databaseUrl: string;
  /** Decrypted per-brokerage env values (JWT_SECRET, TWILIO_*, ...). */
  env: Record<string, string>;
  updatedAt: string | null;
};

/** What AsyncLocalStorage holds for every request and background job of one brokerage. */
export type TenantContext = {
  code: string;
  tenant: Tenant;
  /** The brokerage's env values, with DATABASE_URL set to its own database. */
  env: Record<string, string>;
  /** The brokerage's own pg Pool (created on first use). */
  readonly pool: Pool;
};
