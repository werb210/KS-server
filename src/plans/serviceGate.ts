// KS_SERVER_v8_SERVICE_STATUS - when Keystone operations has suspended or cancelled this licensee, every service
// stops. Staff can still sign in and see why: the auth routes, the Plan page (billing), the branding the apps need
// for the "service suspended" screen, and Help (support tickets) stay open. Everything else under /api - the client
// app and application wizard, calls, texts, email, the assistant, inbound webhooks - answers 423 service_suspended
// with a polite message. A cancelled licensee's admins can also export their data (GET /api/export).
import type { NextFunction, Request, Response } from "express";
import { brandName, contactLine } from "../licensee/brand.js";
import { serviceBlocked, type ServiceStatus } from "./catalogue.js";
import { getPlanState, type Q } from "./state.js";

/** Paths (under /api) that stay open while the service is stopped. */
const OPEN_WHILE_BLOCKED = [/^\/auth(\/|$)/, /^\/webauthn\/login(\/|$)/, /^\/health(\/|$)/, /^\/_int(\/|$)/, /^\/plan(\/|$)/, /^\/licensee\/?$/, /^\/licensee\/admin\/?$/, /^\/support\/tickets\/?$/];
const OPEN_WHEN_CANCELLED = [/^\/export(\/|$)/];

export function openWhileBlocked(path: string, status: ServiceStatus): boolean {
  if (OPEN_WHILE_BLOCKED.some((re) => re.test(path))) return true;
  return status === "cancelled" && OPEN_WHEN_CANCELLED.some((re) => re.test(path));
}

export function suspendedMessage(): string {
  const contact = contactLine();
  return `${brandName()} is temporarily unavailable. Please try again later${contact ? ` or ${contact}` : ""}.`;
}

export function suspendedBody(status: ServiceStatus) {
  return {
    ok: false,
    error: "service_suspended",
    service_status: status,
    message: suspendedMessage(),
    staff_message: status === "cancelled"
      ? "This service has been cancelled. Admins can export the company's data from the Plan page. Contact support with any questions."
      : "This service is suspended. Contact support to restore it; admins can see the details on the Plan page.",
  };
}

/** Express middleware for the /api router. Reads the plan state (cached 30 s); a read error never blocks.
 *  Under NODE_ENV=test it is skipped (hundreds of app tests answer the database in a fixed order) unless
 *  KS_SERVICE_GATE_IN_TESTS=1; the gate's own tests call it directly. */
export function serviceGate(getDb: () => Q | Promise<Q>, opts: { always?: boolean } = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!opts.always && process.env.NODE_ENV === "test" && process.env.KS_SERVICE_GATE_IN_TESTS !== "1") return next();
    try {
      const state = await getPlanState(await getDb());
      const status = state.service_status ?? "active";
      if (!serviceBlocked(status) || openWhileBlocked(req.path, status)) return next();
      res.setHeader("Cache-Control", "no-store");
      return res.status(423).json(suspendedBody(status));
    } catch (err) {
      console.warn("[service-gate] status check failed; letting the request through", (err as Error)?.message ?? String(err));
      return next();
    }
  };
}

/** For background work: is the service stopped right now? */
export async function serviceStoppedNow(db: Q): Promise<boolean> {
  return serviceBlocked((await getPlanState(db)).service_status);
}
