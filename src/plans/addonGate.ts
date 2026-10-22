// KS_SERVER_BANK_CONNECT_ADDON - database-backed add-on checks and the route gate (see ./addons.ts).
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { pool } from "../db.js";
import { hasAddon, type AddonKey } from "./addons.js";
import { getPlanState, type Q } from "./state.js";

/** Is the add-on on for this copy now? (Plan state is cached for 30 s; a read failure means off.) */
export async function addonEnabled(db: Q, key: AddonKey): Promise<boolean> {
  return hasAddon(await getPlanState(db), key);
}

export async function bankConnectEnabled(db: Q = pool as unknown as Q): Promise<boolean> {
  return addonEnabled(db, "bank_connect");
}

/** Route gate: 404 { ok:false, error:"not_found" } unless the add-on is on - an off add-on does not exist. */
export function requireAddon(key: AddonKey, dbOverride?: Q): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const db: Q = dbOverride ?? (pool as unknown as Q);
      if (!(await addonEnabled(db, key))) {
        res.status(404).json({ ok: false, error: "not_found" });
        return;
      }
      next();
    })().catch(next);
  };
}
