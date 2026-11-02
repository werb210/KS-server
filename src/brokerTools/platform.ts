// KS_BROKER_TOOLS - the few things that differ between Keystone and Boreal's own server: the plan gate, record
// visibility, the brand name and the client app's address. Everything else in src/brokerTools is identical in both.
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { pool } from "../db.js";
import { requireFeature } from "../plans/requireFeature.js";
import { scopeForRequest, canSeeRecord } from "../visibility/scope.js";
import { brandName } from "../licensee/brand.js";
import { clientUrl, portalUrl } from "../licensee/urls.js";
import type { Q } from "./common.js";

export const PLATFORM = "keystone" as const;

/** The plan features of the broker tools (KS-server src/plans/catalogue.ts). */
export type BrokerFeature =
  | "funding_conditions" | "sales_tax"
  | "invoice_reading" | "credit_lines" | "rate_cards" | "credit_scorecards" | "contract_templates" | "vendor_portal" | "credit_bureau";

/** 402 feature_not_in_plan unless the plan (or trial) includes the feature. */
export function gate(feature: BrokerFeature): RequestHandler {
  return requireFeature(feature);
}

/** May this staff member see the application (teams and record visibility)? */
export async function canSeeApplication(req: Request, applicationId: string): Promise<boolean> {
  const db = pool as unknown as Q;
  return canSeeRecord(db, await scopeForRequest(req, db), "application", applicationId);
}

export function brand(): string {
  return brandName();
}

export function clientAppUrl(): string {
  return clientUrl();
}

export function staffPortalUrl(): string {
  return portalUrl();
}

/** Is the feature in the plan right now (for work that runs outside a request, e.g. the reminders worker)? */
export async function featureOn(feature: BrokerFeature): Promise<boolean> {
  try {
    const { checkFeature } = await import("../plans/catalogue.js");
    const { getPlanState } = await import("../plans/state.js");
    return checkFeature(await getPlanState(pool as any), feature).allowed;
  } catch (err) {
    console.warn("[broker-tools] plan check failed", { feature, message: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Counts one billable use (e.g. a credit bureau pull) for Keystone operations: one usage event per kind and ref.
 *  Never throws - the work has already happened. */
export async function recordUsage(kind: string, ref: string): Promise<void> {
  try {
    await pool.query(`INSERT INTO usage_events (kind, ref, quantity) VALUES ($1, $2, 1) ON CONFLICT (kind, ref) DO NOTHING`, [kind, ref.slice(0, 300)]);
  } catch (err) {
    console.error("[broker-tools] usage event not recorded", { kind, ref, message: err instanceof Error ? err.message : String(err) });
  }
}

export function passThrough(_req: Request, _res: Response, next: NextFunction): void {
  next();
}
