// KS_EMAIL_SUBSCRIPTION_TYPES_v1 - email types, the signed preferences link and page, and campaign audiences.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import {
  campaignType, contactFromToken, notOptedOutSql, preferencesToken, saveChoices, withPreferencesLink,
} from "../marketing/subscriptionTypes.js";
import { renderPreferencesPage } from "../routes/emailPreferences.js";
import { emailRecipients } from "../services/marketingSendRunner.js";

const C = "11111111-1111-4111-8111-111111111111";
const T1 = "22222222-2222-4222-8222-222222222222";
const T2 = "33333333-3333-4333-8333-333333333333";

beforeAll(() => { process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-preferences"; });

describe("preferences link", () => {
  it("round-trips a signed token and refuses a tampered one", () => {
    const t = preferencesToken(C);
    expect(contactFromToken(t)).toBe(C);
    expect(contactFromToken(t.slice(0, -1) + (t.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(contactFromToken("44444444-4444-4444-8444-444444444444." + t.split(".")[1])).toBeNull();
    expect(contactFromToken("junk")).toBeNull();
  });
  it("fills {{preferences_url}} or adds a footer link", () => {
    expect(withPreferencesLink("<a href='{{preferences_url}}'>x</a>", C)).toContain(`/api/public/email-preferences/${preferencesToken(C)}`);
    const h = withPreferencesLink("<html><body><p>Hi</p></body></html>", C);
    expect(h).toMatch(/Choose which emails you get, or unsubscribe<\/a><\/p><\/body>/);
  });
});

describe("campaign type", () => {
  it("accepts an active type of this silo and refuses anything else", async () => {
    const db = { query: vi.fn(answerBySql([[/FROM email_subscription_types WHERE id/, (_s: string, p?: unknown[]) => ({ rows: p![0] === T1 ? [{ id: T1 }] : [] })]])) };
    expect(await campaignType(db, "BF", "")).toBeNull();
    expect(await campaignType(db, "BF", T1)).toBe(T1);
    await expect(campaignType(db, "BF", T2)).rejects.toMatchObject({ code: "bad_subscription_type" });
    await expect(campaignType(db, "BF", "x")).rejects.toMatchObject({ code: "bad_subscription_type" });
  });
  it("campaign audiences skip people who opted out of the type", async () => {
    expect(notOptedOutSql(5)).toContain("contact_subscription_optouts");
    const query = vi.fn(answerBySql([[/FROM contacts c/, { rows: [] }]]));
    await emailRecipients({ query } as any, { silo: "BF", tag: "x", subject: "s", html: "h", subscriptionTypeId: T1 });
    const call = callsMatching(query, /FROM contacts c/)[0];
    expect(String(call[0])).toContain("contact_subscription_optouts");
    expect(call[1]).toEqual(["BF", "x", null, null, T1]);
  });
});

describe("saving choices", () => {
  const rules = (optOut = false) => [
    [/FROM contacts WHERE id/, { rows: [{ id: C, silo: "BF", email: "pat@example.com", first_name: "Pat", opt_out: optOut }] }],
    [/FROM email_subscription_types/, { rows: [
      { id: T1, key: "newsletter", name: "Newsletter", description: null, active: true, sort_order: 10 },
      { id: T2, key: "offers", name: "Offers", description: null, active: true, sort_order: 20 },
    ] }],
  ] as any;
  it("opts out of unticked types and keeps marketing on", async () => {
    const db = { query: vi.fn(answerBySql(rules())) };
    await saveChoices(db, C, { subscribed: [T1] });
    expect(callsMatching(db.query, /UPDATE contacts SET marketing_opt_out/)[0][1]).toEqual([C, false]);
    expect(callsMatching(db.query, /INSERT INTO contact_subscription_optouts/).map((c) => (c[1] as unknown[])[1])).toEqual([T2]);
    expect(callsMatching(db.query, /DELETE FROM contact_subscription_optouts/).map((c) => (c[1] as unknown[])[1])).toEqual([T1]);
    expect(callsMatching(db.query, /email_preferences_updated/)).toHaveLength(1);
  });
  it("unsubscribe from all sets the marketing opt-out", async () => {
    const db = { query: vi.fn(answerBySql(rules())) };
    await saveChoices(db, C, { all_off: "1" });
    expect(callsMatching(db.query, /UPDATE contacts SET marketing_opt_out/)[0][1]).toEqual([C, true]);
  });
});

describe("page", () => {
  it("escapes names and shows the expired message for a bad link", () => {
    const html = renderPreferencesPage({
      contact: { id: C, silo: "BF", email: "pat@example.com", first_name: "<b>Pat</b>" }, allOff: false,
      types: [{ id: T1, key: "n", name: "News & tips", description: null, active: true, sort_order: 1, subscribed: true }],
    }, { brand: "Sample Capital", saved: true });
    expect(html).toContain("Hi &lt;b&gt;Pat&lt;/b&gt;");
    expect(html).toContain("News &amp; tips");
    expect(html).toContain(`value="${T1}" checked`);
    expect(html).toContain("Saved.");
    expect(renderPreferencesPage(null, { brand: "Sample Capital" })).toContain("This link has expired");
  });
});
