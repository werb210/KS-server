// KS_SERVER_PLAN_FIXES (Todd, Oct 26) - snippets, templates and automations are growth and up (a running trial gets
// them); calls are recorded on every plan but playback is growth and up; the iPad app is on every plan and the Apple
// Watch app growth and up; inbox sync is Outlook only; lenders do not review files in the lender portal.
import { describe, expect, it } from "vitest";
import { FEATURES, checkFeature, featureDef, type PlanState } from "../catalogue.js";
import { clearPlanCache } from "../state.js";
import { automationsInPlan } from "../../modules/automation/automationEngine.js";

const planOf = (key: string) => featureDef(key)?.plan;

describe("catalogue", () => {
  it("plan levels", () => {
    expect(Object.fromEntries(["templates", "automations", "call_recording", "call_recording_playback", "ipad_app", "watch_app", "pgi_referrals", "lender_portal"].map((k) => [k, planOf(k)]))).toEqual({
      templates: "growth", automations: "growth", call_recording: "starter", call_recording_playback: "growth",
      ipad_app: "starter", watch_app: "growth", pgi_referrals: "starter", lender_portal: "starter",
    });
    expect(featureDef("watch_ipad_apps")).toBeUndefined();
    expect(FEATURES.filter((f) => /^fraud_\d+$/.test(f.key))).toHaveLength(15);
  });

  it("wording", () => {
    expect(featureDef("templates")!.label).toMatch(/snippets/i);
    expect(featureDef("call_recording")!.label).toMatch(/every plan/i);
    expect(featureDef("call_recording")!.label).toMatch(/playback on Growth and Pro/);
    expect(featureDef("office_sync")!.label).toMatch(/Outlook \(Microsoft 365\)/);
    expect(featureDef("office_sync")!.label).toMatch(/Gmail sends only/);
    const lender = featureDef("lender_portal")!.label;
    expect(lender).not.toMatch(/review|see files|files you send/i);
    expect(lender).toMatch(/can't place/);
  });

  it("the in-app trial opens automations and templates on starter", () => {
    const now = new Date();
    const trial: PlanState = { plan: "starter", trial_started_at: new Date(now.getTime() - 1000), trial_ends_at: new Date(now.getTime() + 86_400_000), extra_storage_blocks: 0 };
    expect(checkFeature(trial, "automations", now)).toEqual({ allowed: true, viaTrial: true });
    expect(checkFeature(trial, "templates", now)).toEqual({ allowed: true, viaTrial: true });
    expect(checkFeature({ ...trial, trial_started_at: null, trial_ends_at: null }, "automations", now)).toMatchObject({ allowed: false, required_plan: "growth" });
  });
});

describe("automation engine follows the plan", () => {
  const db = (plan: string) => ({ query: async (sql: string) => ({ rows: /FROM licensee_plan/.test(sql) ? [{ plan }] : [] }) });
  it("starter runs no automations; growth and pro do", async () => {
    // An hour apart, so the 30 s plan cache never answers for the previous plan.
    const at = (h: number) => new Date(Date.UTC(2030, 0, 1, h));
    expect(await automationsInPlan(db("starter"), at(1))).toBe(false);
    expect(await automationsInPlan(db("growth"), at(2))).toBe(true);
    expect(await automationsInPlan(db("pro"), at(3))).toBe(true);
    clearPlanCache();
  });
});
