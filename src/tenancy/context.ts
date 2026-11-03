// KS_SHARED_HOSTING_v1 - the current brokerage, carried by AsyncLocalStorage through every request and job.
import { AsyncLocalStorage } from "node:async_hooks";
import { isMultiBrokerage } from "./mode.js";
import type { TenantContext } from "./types.js";

const storage = new AsyncLocalStorage<TenantContext>();

export class NoBrokerageContextError extends Error {
  readonly code = "no_brokerage_context";
  constructor(what = "database") {
    super(`no_brokerage_context: ${what} used outside a brokerage's request or job`);
    this.name = "NoBrokerageContextError";
  }
}

export function currentTenant(): TenantContext | undefined {
  return storage.getStore();
}

export function requireTenant(what?: string): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) throw new NoBrokerageContextError(what);
  return ctx;
}

/** The current brokerage's code, or null (single-brokerage mode, or no brokerage). */
export function currentTenantCode(): string | null {
  return storage.getStore()?.code ?? null;
}

export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * A cache or rate-limit key that cannot mix brokerages: "<code>:<key>" inside a brokerage, the key unchanged
 * otherwise (single-brokerage mode keeps its exact keys).
 */
export function tenantKey(key: string): string {
  const code = storage.getStore()?.code;
  return code ? `${code}:${key}` : key;
}

export type TenantLocal<T> = { value: T; reset(): void; resetAll(): void; all(): T[] };

/**
 * A module-level variable with one value per brokerage. In single-brokerage mode (and outside any brokerage) it is
 * one ordinary value, so existing behaviour is unchanged.
 */
export function tenantLocal<T>(initial: () => T): TenantLocal<T> {
  let single: T = initial();
  const byTenant = new Map<string, T>();
  const code = () => (isMultiBrokerage() ? storage.getStore()?.code ?? null : null);
  return {
    get value(): T {
      const c = code();
      if (c === null) return single;
      if (!byTenant.has(c)) byTenant.set(c, initial());
      return byTenant.get(c) as T;
    },
    set value(v: T) {
      const c = code();
      if (c === null) single = v;
      else byTenant.set(c, v);
    },
    reset(): void {
      const c = code();
      if (c === null) single = initial();
      else byTenant.delete(c);
    },
    resetAll(): void {
      single = initial();
      byTenant.clear();
    },
    all(): T[] {
      return [single, ...byTenant.values()];
    },
  };
}
