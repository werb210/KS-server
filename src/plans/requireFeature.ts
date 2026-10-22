// KS_SERVER_v6_PLANS - route gate: 402 when the feature is not in the plan in force.
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { pool } from "../db.js";
import { checkFeature, featureDef } from "./catalogue.js";
import { getPlanState, recordTrialUsage, type Q } from "./state.js";

/**
 * Lets the request through when the copy's plan (or its running trial) includes the feature; otherwise answers
 * 402 { ok:false, error:"feature_not_in_plan", feature, required_plan, trial_available }. A use that is allowed only
 * because of the trial is counted in plan_trial_feature_usage (best effort, logged on failure).
 */
export function requireFeature(key: string, dbOverride?: Q): RequestHandler {
  if (!featureDef(key)) throw new Error(`requireFeature: unknown feature "${key}"`);
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const db: Q = dbOverride ?? (pool as unknown as Q);
      const now = new Date();
      const c = checkFeature(await getPlanState(db, now.getTime()), key, now);
      if (!c.allowed) {
        res.status(402).json({
          ok: false, error: "feature_not_in_plan", feature: key,
          required_plan: c.required_plan, trial_available: c.trial_available,
        });
        return;
      }
      if (c.viaTrial) await recordTrialUsage(db, key);
      next();
    })().catch(next);
  };
}
