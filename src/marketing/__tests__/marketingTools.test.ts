// KS_SERVER_MARKETING_ADDON - the add-on's tools: subject-line A/B test and best send time (campaign runner), the
// website kit (forms, origins, snippet, script) and lead scoring.
import { describe, expect, it } from "vitest";
import {
  abSampleSize, bestHour, nextHourAt, parseCampaignOptions, pickWinner, stableOrder, needsCampaignRunner,
} from "../campaignRunner.js";
import {
  kitSnippet, liveForms, normalizeFields, normalizeKitSettings, normalizeOrigin, originAllowed, parseFormInput, parseSubmission,
  type KitForm,
} from "../websiteKit.js";
import { kitScript, safeColor } from "../kitScript.js";
import { DEFAULT_SCORING, computeScore, normalizeScoring, type ContactFacts } from "../leadScoring.js";

const TZ = "America/Regina"; // UTC-6 all year (Alberta's computed zone)

describe("A/B subject test and send-time options", () => {
  it("reads and checks the options", () => {
    expect(parseCampaignOptions({}, "Hello")).toEqual({ ok: true, value: {} });
    expect(parseCampaignOptions({ abTest: { subjectB: "Hi there", testPercent: 90, waitHours: 0 } }, "Hello")).toEqual({
      ok: true, value: { ab: { subjectB: "Hi there", testPercent: 50, waitHours: 1, phase: "test" } },
    });
    expect(parseCampaignOptions({ abTest: { subjectB: "" } }, "Hello")).toMatchObject({ ok: false, error: "ab_subject_required" });
    expect(parseCampaignOptions({ abTest: { subjectB: "Hello" } }, "Hello")).toMatchObject({ ok: false, error: "ab_subjects_same" });
    expect(parseCampaignOptions({ sendTime: "best" }, "Hello")).toEqual({ ok: true, value: { sendTime: "best" } });
    expect(parseCampaignOptions({ sendTime: "best", abTest: { subjectB: "B" } }, "A")).toMatchObject({ ok: false, error: "ab_and_best_time" });
    expect(needsCampaignRunner({ ab: { subjectB: "B" } })).toBe(true);
    expect(needsCampaignRunner({ sendTime: "best" })).toBe(true);
    expect(needsCampaignRunner({ subject: "plain" })).toBe(false);
  });

  it("splits the audience the same way every time, and samples at least 2", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}` }));
    expect(stableOrder("job-1", rows)).toEqual(stableOrder("job-1", [...rows].reverse()));
    expect(stableOrder("job-1", rows)).not.toEqual(stableOrder("job-2", rows));
    expect(abSampleSize(1000, 20)).toBe(200);
    expect(abSampleSize(5, 20)).toBe(2);
    expect(abSampleSize(1, 20)).toBe(1);
    expect(abSampleSize(0, 20)).toBe(0);
  });

  it("the winner has the higher open rate, then click rate; a tie keeps A", () => {
    expect(pickWinner({ A: { sent: 100, opened: 20, clicked: 5 }, B: { sent: 100, opened: 30, clicked: 1 } })).toBe("B");
    expect(pickWinner({ A: { sent: 100, opened: 30, clicked: 1 }, B: { sent: 50, opened: 10, clicked: 9 } })).toBe("A");
    expect(pickWinner({ A: { sent: 10, opened: 2, clicked: 0 }, B: { sent: 10, opened: 2, clicked: 1 } })).toBe("B");
    expect(pickWinner({ A: { sent: 0, opened: 0, clicked: 0 }, B: { sent: 0, opened: 0, clicked: 0 } })).toBe("A");
  });

  it("sends at the hour each person usually opens, within the next day", () => {
    const at = (iso: string) => new Date(iso);
    // 08:xx local (14:xx UTC) twice, 20:xx local once.
    expect(bestHour([at("2026-10-01T14:10:00Z"), at("2026-10-02T14:40:00Z"), at("2026-10-03T02:00:00Z")], TZ)).toBe(8);
    expect(bestHour([], TZ)).toBeNull();
    const now = at("2026-10-26T18:30:00Z"); // 12:30 local
    expect(nextHourAt(now, 8, TZ).toISOString()).toBe("2026-10-27T14:00:00.000Z"); // tomorrow 08:00
    expect(nextHourAt(now, 15, TZ).toISOString()).toBe("2026-10-26T21:00:00.000Z"); // today 15:00
  });
});

describe("website kit", () => {
  it("accepts https website addresses only (plain http for localhost)", () => {
    expect(normalizeOrigin("www.prairie.ca/contact")).toBe("https://www.prairie.ca");
    expect(normalizeOrigin("https://Prairie.CA")).toBe("https://prairie.ca");
    expect(normalizeOrigin("http://prairie.ca")).toBeNull();
    expect(normalizeOrigin("http://localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeOrigin("javascript:alert(1)")).toBeNull();
    const s = normalizeKitSettings({ allowed_origins: ["https://prairie.ca", "nope", "https://prairie.ca/x"], chat_enabled: true });
    expect(s).toMatchObject({ allowed_origins: ["https://prairie.ca"], chat_enabled: true, tracking_enabled: false, consent_banner: true, key: "" });
    expect(originAllowed(s, "https://prairie.ca")).toBe(true);
    expect(originAllowed(s, "https://evil.example")).toBe(false);
    expect(originAllowed(s, undefined)).toBe(false);
  });

  it("a form always asks for an email or a phone, and requires one of them", () => {
    expect(normalizeFields([{ key: "full_name", required: true }])).toEqual([
      { key: "full_name", label: "Full name", required: true },
      { key: "email", label: "Email", required: true },
    ]);
    expect(normalizeFields([{ key: "phone", label: "Cell" }]).find((f) => f.key === "phone")!.required).toBe(true);
    expect(normalizeFields([{ key: "evil", required: true }, { key: "email" }]).map((f) => f.key)).toEqual(["email"]);
    expect(parseFormInput({ name: "" })).toEqual({ ok: false, error: "Give the form a name." });
    expect(parseFormInput({ name: "Quote", tag: "Equipment Loans!" })).toMatchObject({ ok: true, value: { tag: "equipment_loans" } });
  });

  const form: KitForm = {
    id: "f1", name: "Quote", fields: normalizeFields(undefined), button_label: "Send", thank_you: "Thanks", tag: null,
    active: true, submissions: 0, created_at: "2026-10-01T00:00:00.000Z",
  };

  it("checks a submission in plain words", () => {
    expect(parseSubmission(form, { fields: { email: "a@b.ca" } })).toMatchObject({ ok: false, field: "full_name" });
    expect(parseSubmission(form, { fields: { full_name: "Ann", email: "nope" } })).toMatchObject({ ok: false, field: "email", error: "Please check the email address." });
    const ok = parseSubmission(form, { fields: { full_name: "Ann Lee", email: "ann@lee.ca", phone: "403 555 0100" }, consent: true, consentText: "Yes", sessionId: "kit-abc123" });
    expect(ok).toMatchObject({ ok: true, value: { values: { full_name: "Ann Lee", email: "ann@lee.ca", phone: "403 555 0100" }, consent: true, sessionId: "kit-abc123" } });
  });

  it("one live form without the add-on (the oldest active one), all with it", () => {
    const f = (id: string, active = true) => ({ ...form, id, active });
    expect(liveForms([f("a"), f("b", false), f("c")], 1).map((x) => x.id)).toEqual(["a"]);
    expect(liveForms([f("a"), f("b", false), f("c")], null).map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("gives the Admin a snippet to copy", () => {
    expect(kitSnippet("https://ks.example/", "abc123abc123abc123abc123", [{ id: "f1", name: "Quote" }])).toEqual({
      script: '<script src="https://ks.example/api/kit/abc123abc123abc123abc123/kit.js" async></script>',
      forms: [{ id: "f1", name: "Quote", html: '<div data-ks-form="f1"></div>' }],
    });
  });

  it("the script never writes HTML from text, cannot be broken out of, and tracks only after consent", () => {
    const js = kitScript({
      base: "https://ks.example", key: "k".repeat(24), brand: "Prairie </script><script>alert(1)</script>", color: "red;}",
      assistant: "Ava", chat: true, tracking: true, banner: true,
      forms: [{ id: "f1", fields: [{ key: "email", label: "</script>", required: true }], button_label: "Send", thank_you: "Thanks" }],
    });
    expect(js).not.toMatch(/innerHTML/);
    expect(js).not.toContain("</script><script>");
    expect(js).toContain('"color":"#1d4ed8"');
    expect(js).toMatch(/if \(started \|\| !C\.tracking \|\| consent !== "granted"\) return;/);
    expect(safeColor("#0B1F3A")).toBe("#0B1F3A");
    expect(() => new Function(js)).not.toThrow();
  });
});

describe("lead scoring", () => {
  const facts = (over: Partial<ContactFacts> = {}): ContactFacts => ({
    id: "c1", phone: null, has_company: false, job_title: null, tags: [], lifecycle_stage: null, lead_status: null,
    requested_amount: null, activity: {}, ...over,
  });

  it("adds rule points and engagement (older activity counts half, each kind capped), 0-100", () => {
    const s = computeScore(facts({
      phone: "403-555-0100", has_company: true, job_title: "Owner", tags: ["website_form"], requested_amount: 75000,
      activity: { email_open: [20, 0], email_click: [1, 2], application_started: [1, 0] },
    }), DEFAULT_SCORING);
    expect(s.rules_points).toBe(10 + 5 + 10 + 10 + 10);
    expect(s.engagement_points).toBe(20 + 10 + 20); // opens capped at 20; clicks 5 + 2 x 2.5
    expect(s.score).toBe(95);
    expect(s.grade).toBe("hot");
    expect(s.breakdown.map((b) => b.label)).toContain("Opened an email (20)");
    expect(computeScore(facts(), DEFAULT_SCORING)).toMatchObject({ score: 0, grade: "cold", breakdown: [] });
    expect(computeScore(facts({ activity: { application_submitted: [5, 5] } }), DEFAULT_SCORING).score).toBe(30);
  });

  it("keeps Admin-edited rules sensible", () => {
    const s = normalizeScoring({
      rules: [{ kind: "tag", value: "vip", points: 500 }, { kind: "tag", points: 5 }, { kind: "bogus", points: 5 }],
      engagement: { email_open: { points: 99, cap: 999 } }, hot: 50, warm: 80,
    });
    expect(s.rules).toEqual([{ kind: "tag", value: "vip", points: 50 }]);
    expect(s.engagement.email_open).toEqual({ points: 50, cap: 100 });
    expect(s.engagement.email_click).toEqual(DEFAULT_SCORING.engagement.email_click);
    expect([s.hot, s.warm]).toEqual([50, 50]);
    expect(computeScore(facts({ tags: ["VIP"] }), s)).toMatchObject({ score: 50, grade: "hot" });
  });
});
