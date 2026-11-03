// KS_SHARED_HOSTING_v1 - how a request finds its brokerage (multi-brokerage mode only):
//   1. the X-KS-Tenant header (KS-Agent, the native apps, server-to-server calls), otherwise
//   2. the Host header (lowercased, port removed) matched against the brokerages' api_hosts;
//   3. no match -> 404 {"error":"unknown_brokerage"}; status cancelled -> 410 {"error":"brokerage_closed"}.
//      A suspended brokerage gets the server's existing suspended behaviour (serviceGate).
// Health checks answer without a brokerage, and so do the ops endpoints (they carry their own service key).
import { createRequire } from "node:module";
import type { NextFunction, Request, Response } from "express";
import { currentTenant, runWithTenant } from "./context.js";
import { checkJwtSecret } from "../startup/jwtSecretPolicy.js";
import { ensureTenantMigrated } from "./migrations.js";
import { contextFor } from "./pools.js";
import { findTenantByCode, findTenantByHost } from "./registry.js";
import type { Tenant, TenantContext } from "./types.js";

export const TENANT_HEADER = "x-ks-tenant";

const NO_TENANT_PATHS = new Set(["/", "/health", "/healthz", "/api/health", "/api/healthz", "/api/_int/health"]);

export function answersWithoutBrokerage(path: string): boolean {
  const p = String(path ?? "").split("?")[0]!.replace(/\/+$/, "") || "/";
  return NO_TENANT_PATHS.has(p) || p === "/api/ops/tenants" || p.startsWith("/api/ops/tenants/");
}

const misconfiguredLogged = new Set<string>();

/**
 * The single-brokerage server refuses to start without a real JWT_SECRET (BF_SERVER_v789_JWT_SECRET_POLICY). The
 * shared server cannot refuse to start for one brokerage, so it refuses to serve that brokerage instead.
 */
export function tenantJwtSecretOk(tenant: Tenant): boolean {
  const r = checkJwtSecret(tenant.env.JWT_SECRET);
  if (!r.ok && !misconfiguredLogged.has(tenant.code)) {
    misconfiguredLogged.add(tenant.code);
    console.error(JSON.stringify({ event: "ks_tenant_jwt_secret_invalid", tenant: tenant.code, message: r.error }));
  }
  return r.ok;
}

export type Resolution =
  | { ok: true; tenant: Tenant }
  | { ok: false; status: 404 | 410 | 503; error: "unknown_brokerage" | "brokerage_closed" | "registry_unavailable" };

/** Find the brokerage for request headers (also used for WebSocket upgrades, which skip Express). */
export async function resolveTenant(headers: Record<string, string | string[] | undefined>): Promise<Resolution> {
  let tenant: Tenant | null;
  try {
    const raw = headers[TENANT_HEADER];
    const code = String(Array.isArray(raw) ? raw[0] : raw ?? "").trim().toLowerCase();
    tenant = code ? await findTenantByCode(code) : await findTenantByHost(String(headers.host ?? ""));
  } catch (err) {
    console.error(JSON.stringify({ event: "ks_tenant_resolve_failed", message: (err as Error)?.message ?? String(err) }));
    return { ok: false, status: 503, error: "registry_unavailable" };
  }
  if (!tenant) return { ok: false, status: 404, error: "unknown_brokerage" };
  if (tenant.status === "cancelled") return { ok: false, status: 410, error: "brokerage_closed" };
  return { ok: true, tenant };
}

const REQ_CTX = Symbol.for("ks.tenantContext");
type WithCtx = Request & { [REQ_CTX]?: TenantContext; ksTenant?: string };

export function tenantMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (answersWithoutBrokerage(req.path)) return next();
    const r = await resolveTenant(req.headers as Record<string, string | string[] | undefined>);
    if (!r.ok) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(r.status).json({ error: r.error });
    }
    if (!tenantJwtSecretOk(r.tenant)) {
      return res.status(503).json({ error: "brokerage_misconfigured" });
    }
    try {
      await ensureTenantMigrated(r.tenant);
    } catch {
      res.setHeader("Retry-After", "60");
      return res.status(503).json({ error: "brokerage_unavailable" });
    }
    const ctx = contextFor(r.tenant);
    (req as WithCtx)[REQ_CTX] = ctx;
    (req as WithCtx).ksTenant = ctx.code;
    return runWithTenant(ctx, () => next());
  };
}

let layerPatched = false;

/**
 * Body parsers and multer call next() from stream callbacks, which run outside the AsyncLocalStorage context the
 * tenant middleware entered. Patching Express's Layer re-enters the request's brokerage before every middleware and
 * handler, so context can never be lost between them. Code that loses it anyway (a raw stream callback inside a
 * handler) gets no_brokerage_context - never another brokerage's database.
 */
export function patchExpressForTenantContext(): void {
  if (layerPatched) return;
  const require = createRequire(import.meta.url);
  const Layer = require("express/lib/router/layer.js") as {
    prototype: { handle_request: (...a: any[]) => unknown; handle_error: (...a: any[]) => unknown };
  };
  const origRequest = Layer.prototype.handle_request;
  const origError = Layer.prototype.handle_error;
  Layer.prototype.handle_request = function (this: unknown, req: WithCtx, res: unknown, next: unknown) {
    const ctx = req?.[REQ_CTX];
    if (ctx && currentTenant() !== ctx) return runWithTenant(ctx, () => origRequest.call(this, req, res, next));
    return origRequest.call(this, req, res, next);
  };
  Layer.prototype.handle_error = function (this: unknown, err: unknown, req: WithCtx, res: unknown, next: unknown) {
    const ctx = req?.[REQ_CTX];
    if (ctx && currentTenant() !== ctx) return runWithTenant(ctx, () => origError.call(this, err, req, res, next));
    return origError.call(this, err, req, res, next);
  };
  layerPatched = true;
}
