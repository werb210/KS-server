// KS_SHARED_HOSTING_v1 - background work in multi-brokerage mode: once per brokerage, each inside that brokerage's
// context, one brokerage at a time. A failing brokerage is logged and the others still run.
import { currentTenant, runWithTenant } from "./context.js";
import { isMultiBrokerage } from "./mode.js";
import { contextFor } from "./pools.js";
import { jobsRunFor, listTenants } from "./registry.js";
import type { Tenant } from "./types.js";

export type ForEachTenantResult = { ran: string[]; failed: Array<{ code: string; message: string }> };

export type ForEachTenantOptions = {
  /** Name used in the per-brokerage error log. */
  job?: string;
  /** Which brokerages to include (default: every one whose jobs run - not cancelled, not provisioning). */
  include?: (t: Tenant) => boolean;
  /** Tests: the brokerages to use instead of the registry. */
  tenants?: Tenant[];
};

/**
 * Run fn once per brokerage. In single-brokerage mode (or already inside a brokerage's context) fn runs once, as
 * it always has.
 */
export async function forEachTenant(fn: () => Promise<unknown> | unknown, opts: ForEachTenantOptions = {}): Promise<ForEachTenantResult> {
  const result: ForEachTenantResult = { ran: [], failed: [] };
  if (!opts.tenants && (!isMultiBrokerage() || currentTenant())) {
    await fn();
    return result;
  }
  let tenants: Tenant[];
  try {
    tenants = opts.tenants ?? (await listTenants());
  } catch (err) {
    console.error(JSON.stringify({ event: "tenant_job_registry_failed", job: opts.job ?? "job", message: (err as Error)?.message ?? String(err) }));
    return result;
  }
  const include = opts.include ?? ((t: Tenant) => jobsRunFor(String(t.status)));
  for (const t of tenants) {
    if (!include(t)) continue;
    try {
      await runWithTenant(contextFor(t), async () => { await fn(); });
      result.ran.push(t.code);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      result.failed.push({ code: t.code, message });
      console.error(JSON.stringify({ event: "tenant_job_failed", job: opts.job ?? "job", tenant: t.code, message }));
    }
  }
  return result;
}

const chains = new Map<string, Promise<unknown>>();

/**
 * Serialise one job's runs across brokerages: in multi-brokerage mode, runs of `name` for different brokerages wait
 * for each other ("one brokerage at a time"). Single-brokerage mode runs fn straight away.
 */
export function serialAcrossTenants<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!isMultiBrokerage() || !currentTenant()) return fn();
  const prev = chains.get(name) ?? Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  const tail = run.then(() => undefined, () => undefined);
  chains.set(name, tail);
  void tail.then(() => { if (chains.get(name) === tail) chains.delete(name); });
  return run;
}
