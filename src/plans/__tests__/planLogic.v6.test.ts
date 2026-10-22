// KS_SERVER_v6_PLANS - the pure plan rules: features per plan, the one 14-day trial, allowances, storage.
import { afterEach, describe, expect, it } from "vitest";
import {
  ALLOWANCES, FEATURES, GB, allowancesFor, checkFeature, defaultPlan, effectivePlan, featuresFor, storageNoticeDue,
  storageSummary, trialDaysLeft, trialStatus, type PlanState,
} from "../catalogue.js";
import { rowToState } from "../state.js";

const DAY = 86_400_000;
const t0 = new Date("2026-11-01T12:00:00Z");
const starter = (over: Partial<PlanState> = {}): PlanState =>
  ({ plan: "starter", trial_started_at: null, trial_ends_at: null, extra_storage_blocks: 0, ...over });
const inTrial = () => starter({ trial_started_at: t0, trial_ends_at: new Date(t0.getTime() + 14 * DAY) });

afterEach(() => {
  delete process.env.KS_PLAN;
  delete process.env.KS_TRIAL_BONUS_MINUTES;
  delete process.env.KS_TRIAL_BONUS_TEXTS;
});

describe("plan catalogue", () => {
  it("each plan includes the plans below it", () => {
    const s = featuresFor("starter");
    const g = featuresFor("growth");
    const p = featuresFor("pro");
    expect(s.contacts && s.ai_assistant).toBe(true);
    expect(s.call_recording || s.referrer_portal || s.broker_portal).toBe(false);
    expect(s.lender_portal).toBe(true); // KS_SERVER_v9_PORTAL_PLANS - lender portal on every plan
    expect(g.call_recording && g.templates && g.toll_free_number).toBe(true);
    expect(g.referrer_portal && g.broker_portal).toBe(true);
    expect(g.sso).toBe(false);
    expect(FEATURES.every((f) => p[f.key])).toBe(true);
  });

  it("allowances per plan", () => {
    expect(ALLOWANCES.starter).toEqual({ minutes_per_seat: 50, texts_per_seat: 100, assistant_chats: 200, storage_gb_per_seat: 10 });
    expect(ALLOWANCES.growth).toEqual({ minutes_per_seat: 500, texts_per_seat: 500, assistant_chats: 1000, storage_gb_per_seat: 25 });
    expect(ALLOWANCES.pro).toEqual({ minutes_per_seat: 1500, texts_per_seat: 1500, assistant_chats: null, storage_gb_per_seat: 50 });
  });

  it("default plan is KS_PLAN, else pro; an unknown stored plan falls back to it", () => {
    expect(defaultPlan()).toBe("pro");
    process.env.KS_PLAN = "Growth";
    expect(defaultPlan()).toBe("growth");
    process.env.KS_PLAN = "platinum";
    expect(defaultPlan()).toBe("pro");
    expect(rowToState(null).plan).toBe("pro");
    expect(rowToState({ plan: "bogus" }).plan).toBe("pro");
    expect(rowToState({ plan: "starter", extra_storage_blocks: "2" })).toMatchObject({ plan: "starter", extra_storage_blocks: 2 });
  });
});

describe("the free trial", () => {
  it("is offered to starter only, once", () => {
    expect(trialStatus(starter(), t0)).toBe("available");
    expect(trialStatus({ ...starter(), plan: "growth" }, t0)).toBe("not_offered");
    expect(trialStatus({ ...starter(), plan: "pro" }, t0)).toBe("not_offered");
    expect(trialStatus(inTrial(), t0)).toBe("active");
    expect(trialStatus(inTrial(), new Date(t0.getTime() + 14 * DAY))).toBe("used");
  });

  it("runs 14 days as pro, then falls back to starter", () => {
    const s = inTrial();
    expect(effectivePlan(s, t0)).toBe("pro");
    expect(trialDaysLeft(s, t0)).toBe(14);
    expect(trialDaysLeft(s, new Date(t0.getTime() + 11.5 * DAY))).toBe(3);
    expect(effectivePlan(s, new Date(t0.getTime() + 14 * DAY - 1))).toBe("pro");
    expect(effectivePlan(s, new Date(t0.getTime() + 14 * DAY))).toBe("starter");
    expect(trialDaysLeft(s, new Date(t0.getTime() + 15 * DAY))).toBeNull();
  });

  it("keeps starter calls/texts plus the bonus, but pro chats and storage", () => {
    expect(allowancesFor(inTrial(), t0)).toEqual({
      minutes_per_seat: 150, texts_per_seat: 200, assistant_chats: null, storage_gb_per_seat: 50,
      trial_bonus_minutes: 100, trial_bonus_texts: 100,
    });
    process.env.KS_TRIAL_BONUS_MINUTES = "30";
    process.env.KS_TRIAL_BONUS_TEXTS = "0";
    expect(allowancesFor(inTrial(), t0)).toMatchObject({ minutes_per_seat: 80, texts_per_seat: 100, trial_bonus_minutes: 30, trial_bonus_texts: 0 });
    expect(allowancesFor(starter(), t0)).toMatchObject({ minutes_per_seat: 50, texts_per_seat: 100, trial_bonus_minutes: 0, trial_bonus_texts: 0 });
  });

  it("checkFeature says when a feature is open only because of the trial", () => {
    expect(checkFeature(starter(), "contacts", t0)).toEqual({ allowed: true, viaTrial: false });
    expect(checkFeature(starter(), "sso", t0)).toEqual({ allowed: false, required_plan: "pro", trial_available: true });
    expect(checkFeature({ ...starter(), plan: "growth" }, "sso", t0)).toEqual({ allowed: false, required_plan: "pro", trial_available: false });
    // KS_SERVER_v9_PORTAL_PLANS
    expect(checkFeature(starter(), "lender_portal", t0)).toEqual({ allowed: true, viaTrial: false });
    expect(checkFeature(starter(), "broker_portal", t0)).toEqual({ allowed: false, required_plan: "growth", trial_available: true });
    expect(checkFeature({ ...starter(), plan: "growth" }, "broker_portal", t0)).toEqual({ allowed: true, viaTrial: false });
    expect(checkFeature(inTrial(), "call_recording", t0)).toEqual({ allowed: true, viaTrial: true });
    expect(checkFeature(inTrial(), "contacts", t0)).toEqual({ allowed: true, viaTrial: false });
    const after = new Date(t0.getTime() + 20 * DAY);
    expect(checkFeature(inTrial(), "call_recording", after)).toEqual({ allowed: false, required_plan: "growth", trial_available: false });
  });
});

describe("storage", () => {
  it("pools seats x GB per seat plus 50 GB blocks, with at least one seat", () => {
    expect(storageSummary(5 * GB, 2, 10, 0)).toEqual({ used_bytes: 5 * GB, allowance_bytes: 20 * GB, extra_blocks: 0, seats: 2, percent: 25 });
    expect(storageSummary(0, 0, 25, 1)).toMatchObject({ seats: 1, allowance_bytes: 75 * GB, percent: 0 });
    expect(storageSummary(30 * GB, 1, 10, 0).percent).toBe(300);
  });

  it("sends 80% and 100% once each, and clears a marker once usage drops below it", () => {
    expect(storageNoticeDue(79.9, false, false)).toEqual({ send: null, clear80: false, clear100: false });
    expect(storageNoticeDue(80, false, false).send).toBe(80);
    expect(storageNoticeDue(85, true, false).send).toBeNull();
    expect(storageNoticeDue(100, true, false).send).toBe(100);
    expect(storageNoticeDue(120, false, false).send).toBe(100);
    expect(storageNoticeDue(130, true, true).send).toBeNull();
    expect(storageNoticeDue(90, true, true)).toEqual({ send: null, clear80: false, clear100: true });
    expect(storageNoticeDue(50, true, true)).toEqual({ send: null, clear80: true, clear100: true });
  });
});
