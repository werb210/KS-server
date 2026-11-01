// KS_SERVER_MARKETING_ADDON - plan marketing limits, the Marketing add-on (bought or in either trial), who may use the
// advanced tools, the campaign email / signing / bonus text overage, the signing meter and the Plan page block.
import { describe, expect, it } from "vitest";
import { planIncludes } from "../catalogue.js";
import {
  MARKETING_LIMITS, SIGNINGS, bonusTextsApplied, campaignEmailOverage, marketingAddonActive, marketingLimitsFor,
  signingOverage, toolAccess, toolViaPlan,
} from "../marketing.js";
import { rowToState } from "../state.js";
import { overageOf } from "../usage.js";
import { signingRefs } from "../meters.js";
import { marketingBlock } from "../overview.js";
import { parseAddonPatch } from "../addons.js";

const NOW = new Date("2026-10-26T18:00:00Z");
const st = (row: Record<string, unknown>) => rowToState(row);
const trialRow = { trial_started_at: "2026-10-20T00:00:00Z", trial_ends_at: "2026-11-03T00:00:00Z" };

describe("marketing limits by plan", () => {
  it("are Todd's numbers (Oct 26)", () => {
    expect(MARKETING_LIMITS).toEqual({
      starter: { campaign_emails: 500, text_to_many: 50, sequences: 2, visitor_history_days: 30, lead_forms: 1 },
      growth: { campaign_emails: 1000, text_to_many: 250, sequences: 5, visitor_history_days: 90, lead_forms: 1 },
      pro: { campaign_emails: 2500, text_to_many: 500, sequences: 10, visitor_history_days: 365, lead_forms: 1 },
    });
    expect(SIGNINGS).toEqual({ included: 4, overage_price: 2.5 });
  });

  it("the add-on raises them on any plan: +10,000 emails, 1,000 per text, unlimited sequences, forms and history", () => {
    for (const plan of ["starter", "growth", "pro"] as const) {
      const l = marketingLimitsFor(st({ plan, addons: { marketing: true } }), NOW);
      expect(l).toMatchObject({
        addon: true, campaign_emails: MARKETING_LIMITS[plan].campaign_emails + 10_000, plan_campaign_emails: MARKETING_LIMITS[plan].campaign_emails,
        text_to_many: 1000, sequences: null, visitor_history_days: null, lead_forms: null, bonus_marketing_texts: 1000,
      });
    }
    expect(marketingLimitsFor(st({ plan: "pro" }), NOW)).toMatchObject({ addon: false, campaign_emails: 2500, bonus_marketing_texts: 0 });
  });

  it("Pro does not include the add-on; both trials do", () => {
    expect(marketingAddonActive(st({ plan: "pro" }), NOW)).toBe(false);
    expect(marketingAddonActive(st({ plan: "starter", ...trialRow }), NOW)).toBe(true); // in-app Pro trial
    expect(marketingAddonActive(st({ plan: "starter", service_status: "trial" }), NOW)).toBe(true); // staff free trial
    expect(marketingAddonActive(st({ plan: "starter", ...trialRow }), new Date("2026-11-04T00:00:00Z"))).toBe(false);
  });

  it("is switched on by operations like the other add-ons", () => {
    expect(parseAddonPatch({ marketing: true })).toEqual({ ok: true, value: { marketing: true } });
    expect(parseAddonPatch({ marketing: "yes" })).toEqual({ ok: false });
  });
});

describe("plan catalogue", () => {
  it("marketing, ads results and visitor tracking on every plan; session replay Growth; full Google Ads Pro; templates stay Growth", () => {
    expect(planIncludes("starter", "marketing")).toBe(true);
    expect(planIncludes("starter", "ads_results")).toBe(true);
    expect(planIncludes("starter", "visitor_tracking")).toBe(true);
    expect(planIncludes("starter", "session_replay")).toBe(false);
    expect(planIncludes("growth", "session_replay")).toBe(true);
    expect(planIncludes("growth", "ad_attribution")).toBe(false);
    expect(planIncludes("pro", "ad_attribution")).toBe(true);
    expect(planIncludes("starter", "templates")).toBe(false);
  });
});

describe("who may use an advanced tool", () => {
  const admin = { role: "Admin", marketingSeat: false };
  const seat = { role: "Marketing", marketingSeat: true };
  const fourth = { role: "Marketing", marketingSeat: false };
  const staff = { role: "Staff", marketingSeat: false };

  it("needs the add-on unless the plan already has it", () => {
    expect(toolAccess("lead_scoring", st({ plan: "pro" }), admin, NOW)).toEqual({ allowed: false, reason: "addon_required" });
    expect(toolAccess("google_ads_full", st({ plan: "pro" }), staff, NOW)).toEqual({ allowed: true, via: "plan" });
    expect(toolAccess("session_replay", st({ plan: "growth" }), staff, NOW)).toEqual({ allowed: true, via: "plan" });
    expect(toolViaPlan("session_replay", st({ plan: "starter" }), NOW)).toBe(false);
  });

  it("with the add-on: Admins and up to 3 Marketing users", () => {
    const s = st({ plan: "starter", addons: { marketing: true } });
    expect(toolAccess("ab_test", s, admin, NOW)).toEqual({ allowed: true, via: "addon" });
    expect(toolAccess("ab_test", s, seat, NOW)).toEqual({ allowed: true, via: "addon" });
    expect(toolAccess("ab_test", s, fourth, NOW)).toEqual({ allowed: false, reason: "seat_required" });
    expect(toolAccess("ab_test", s, staff, NOW)).toEqual({ allowed: false, reason: "seat_required" });
    expect(toolAccess("google_ads_full", s, seat, NOW)).toEqual({ allowed: true, via: "addon" });
  });
});

describe("overage", () => {
  it("campaign emails: only with the add-on, $10 per started 10,000", () => {
    expect(campaignEmailOverage(20_000, 10_500, false)).toEqual({ emails: 0, blocks: 0, amount: 0 });
    expect(campaignEmailOverage(10_501, 10_500, true)).toEqual({ emails: 1, blocks: 1, amount: 10 });
    expect(campaignEmailOverage(30_501, 10_500, true)).toEqual({ emails: 20_001, blocks: 3, amount: 30 });
  });

  it("signings: 4 included on every plan, then $2.50 each", () => {
    expect(signingOverage(4)).toEqual({ signings: 0, amount: 0 });
    expect(signingOverage(8)).toEqual({ signings: 4, amount: 10 });
    expect(signingOverage(60)).toEqual({ signings: 56, amount: 140 }); // the guide's growing team
  });

  it("the add-on's 1,000 bonus marketing texts cover marketing texts only", () => {
    expect(bonusTextsApplied(1500, true)).toBe(1000);
    expect(bonusTextsApplied(300, true)).toBe(300);
    expect(bonusTextsApplied(1500, false)).toBe(0);
    const allowances = { minutes: 100, texts: 200, assistant_chats: 200, storage_bytes: 0, campaign_emails: 10_500, signings: 4, bonus_marketing_texts: 1000 };
    const counts = { minutes: 0, texts: 700, assistant_chats: 0, campaign_emails: 10_600, marketing_texts: 400, signings: 6 };
    expect(overageOf(counts, allowances, true)).toEqual({ minutes: 0, texts: 100, campaign_emails: 100, campaign_email_blocks: 1, signings: 2 });
    expect(overageOf(counts, { ...allowances, campaign_emails: 500, bonus_marketing_texts: 0 }, false))
      .toEqual({ minutes: 0, texts: 500, campaign_emails: 0, campaign_email_blocks: 0, signings: 2 });
  });
});

describe("signing meter", () => {
  it("one signing per signer and document; re-sends and new links are not counted again", () => {
    expect(signingRefs([
      { document: "grp1", email: "Owner@Ex.com", role: "Owner 1" },
      { document: "grp1", email: "owner@ex.com", role: "Owner 1" },
      { document: "grp1", email: "owner@ex.com", role: "Owner 2" }, // co-owners sharing an inbox sign twice
      { document: "grp2", email: "owner@ex.com", role: "Owner 1" },
      { document: "", email: "x@ex.com" },
    ])).toEqual(["grp1:owner@ex.com:owner 1", "grp1:owner@ex.com:owner 2", "grp2:owner@ex.com:owner 1"]);
  });
});

describe("Plan page block", () => {
  it("shows the add-on, how it is in force and which tools come from the plan or the add-on", () => {
    const b = marketingBlock(st({ plan: "growth" }), NOW);
    expect(b.addon).toMatchObject({ key: "marketing", price: 49, active: false, purchased: false, via: null, marketing_seats: 3 });
    expect(b.addon.adds).toHaveLength(10);
    expect(b.tools).toMatchObject({ session_replay: "plan", google_ads_full: null, lead_scoring: null });
    const t = marketingBlock(st({ plan: "starter", service_status: "trial" }), NOW);
    expect(t.addon).toMatchObject({ active: true, purchased: false, via: "trial" });
    expect(t.tools).toMatchObject({ lead_scoring: "addon", google_ads_full: "addon" });
    expect(marketingBlock(st({ plan: "pro", addons: { marketing: true } }), NOW).addon.via).toBe("purchase");
  });
});
