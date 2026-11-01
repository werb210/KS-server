// KS_SERVER_MARKETING_ADDON - the plan limits and add-on gates on the real routes, against a database fake that
// answers by SQL content: text-to-many, sequences, campaign emails, A/B and best-time sends, Google Ads results vs
// tools, the campaign report, the website kit, lead scores and the Marketing-role limit.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const { queryMock, submitKitLead } = vi.hoisted(() => ({ queryMock: vi.fn(), submitKitLead: vi.fn() }));
vi.mock("../../db.js", async (orig) => {
  const real: any = await orig();
  const pool = { query: queryMock, connect: vi.fn() };
  return { ...real, pool, db: pool };
});
vi.mock("../../services/marketingSms.js", async (orig) => {
  const real: any = await orig();
  return { ...real, smsMarketingConfigured: () => true, sendMarketingSms: vi.fn(), lookupLineType: async () => "mobile" };
});
vi.mock("../kitLead.js", () => ({ submitKitLead }));

import marketing from "../../routes/marketing.js";
import leadScores from "../../routes/leadScores.js";
import { websiteKitAdminRoutes, websiteKitPublicRoutes } from "../../routes/websiteKit.js";
import { clearPlanCache } from "../../plans/state.js";
import { assertMarketingRoleChange, MarketingSeatLimitError } from "../../plans/marketingGate.js";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const MKT1 = "22222222-2222-4222-8222-222222222222";
const MKT4 = "44444444-4444-4444-8444-444444444444";
const token = (role: string, sub = ADMIN) => jwt.sign({ sub, id: sub, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET), { expiresIn: "5m" });
const KEY = "a1b2c3d4e5f6a1b2c3d4e5f6";

let plan: Record<string, unknown>;
let campaignEmailsUsed: number;
let seatHolders: string[];
let audience: number;
let activeSequences: number;
let kit: Record<string, unknown>;

function rules(): Parameters<typeof answerBySql>[0] {
  return [
    [/FROM licensee_plan WHERE id = 1/, () => ({ rows: [{ ...plan }] })],
    [/kind = 'campaign_email' AND occurred_at/, () => ({ rows: [{ n: campaignEmailsUsed }] })],
    [/FROM users WHERE role = 'Marketing'[\s\S]*ORDER BY created_at/, () => ({ rows: seatHolders.map((id) => ({ id })) })],
    [/SELECT count\(\*\)::int AS n\s+FROM contacts c/, () => ({ rows: [{ n: audience }] })],
    [/\(SMS_ELIGIBLE|sms_ok/, () => ({ rows: Array.from({ length: audience }, (_, i) => ({ id: `c${i}`, email: null, phone: `+1403555${String(1000 + i)}`, name: "N", company: null, sms_ok: true, marketing_opt_out: false, line_type: "mobile" })) })],
    [/COUNT\(\*\)::int AS n FROM marketing_sequences WHERE status = 'active'/, () => ({ rows: [{ n: activeSequences }] })],
    [/UPDATE marketing_sequences SET status='active'/, { rows: [{ id: "seq-1" }], rowCount: 1 }],
    [/INSERT INTO marketing_send_jobs/, { rows: [{ id: "job-1", not_before: "2026-10-26T18:05:00Z" }] }],
    [/SELECT value FROM brokerage_settings WHERE key = \$1/, (_s: string, p?: unknown[]) => ({ rows: p?.[0] === "website_kit" ? [{ value: kit }] : [] })],
    [/FROM website_kit_forms/, { rows: [{ id: "f0000000-0000-4000-8000-000000000001", name: "Quote", fields: [], button_label: "Send", thank_you: "Thanks!", tag: null, active: true, submissions: 0, created_at: "2026-10-01T00:00:00Z" }] }],
  ];
}

const app = express();
app.use(express.json());
app.use("/api/marketing", marketing);
app.use("/api/lead-scores", leadScores);
app.use("/api/website-kit", websiteKitAdminRoutes);
app.use("/api/kit", websiteKitPublicRoutes);

beforeEach(() => {
  plan = { plan: "starter", trial_started_at: null, trial_ends_at: null, extra_storage_blocks: 0, service_status: "active", addons: {} };
  campaignEmailsUsed = 0;
  seatHolders = [MKT1];
  audience = 10;
  activeSequences = 0;
  kit = { key: KEY, allowed_origins: ["https://prairie.ca"], chat_enabled: false, tracking_enabled: false, consent_banner: true };
  clearPlanCache();
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql(rules()));
  submitKitLead.mockReset();
  process.env.SENDGRID_API_KEY = "SG.test";
  process.env.SENDGRID_FROM = "news@prairie.example";
});

const auth = (role = "Admin", sub = ADMIN) => ({ Authorization: `Bearer ${token(role, sub)}` });

describe("send one text to many", () => {
  it("refuses a text campaign over the plan's people-per-send (50 on Starter)", async () => {
    audience = 51;
    const r = await request(app).post("/api/marketing/sms/send").set(auth()).send({ body: "Hello", tags: ["vip"] });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: { code: "text_to_many_limit" }, limit: 50, total: 51 });
    expect(callsMatching(queryMock, /INSERT INTO marketing_send_jobs/)).toHaveLength(0);
  });

  it("allows 1,000 people per send with the add-on", async () => {
    audience = 600;
    plan.addons = { marketing: true };
    const r = await request(app).post("/api/marketing/sms/send").set(auth()).send({ body: "Hello", tags: ["vip"] });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ queued: true, total: 600 });
  });
});

describe("sequences running at once", () => {
  it("stops a third sequence on Starter, and lets it run with the add-on", async () => {
    activeSequences = 2;
    const r = await request(app).post("/api/marketing/sequences/seq-1/activate").set(auth()).send({});
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: { code: "sequence_limit" }, limit: 2 });
    plan.addons = { marketing: true };
    clearPlanCache();
    const ok = await request(app).post("/api/marketing/sequences/seq-1/activate").set(auth()).send({});
    expect(ok.status).toBe(200);
  });
});

describe("campaign emails", () => {
  it("without the add-on a campaign must fit in what is left of the month", async () => {
    audience = 600;
    campaignEmailsUsed = 100;
    const r = await request(app).post("/api/marketing/email/send").set(auth()).send({ subject: "News", html: "<p>Hi</p>", tags: ["vip"] });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: { code: "campaign_email_limit" }, remaining: 400, allowance: 500, total: 600 });
    expect(r.body.error.message).toMatch(/only 400 of this month's 500 campaign emails are left/);
  });

  it("with the add-on it never stops (extra emails are billed)", async () => {
    audience = 20_000;
    campaignEmailsUsed = 12_000;
    plan.addons = { marketing: true };
    const r = await request(app).post("/api/marketing/email/send").set(auth()).send({ subject: "News", html: "<p>Hi</p>", tags: ["vip"] });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ queued: true, total: 20_000 });
  });

  it("the A/B subject test and best-time sending are add-on tools for Admins and the Marketing seats", async () => {
    const body = { subject: "News", html: "<p>Hi</p>", tags: ["vip"], abTest: { subjectB: "Big news" } };
    const none = await request(app).post("/api/marketing/email/send").set(auth()).send(body);
    expect(none.status).toBe(402);
    expect(none.body).toMatchObject({ error: { code: "marketing_addon_required" }, tool: "ab_test" });

    plan.addons = { marketing: true };
    clearPlanCache();
    const fourth = await request(app).post("/api/marketing/email/send").set(auth("Marketing", MKT4)).send(body);
    expect(fourth.status).toBe(403);
    expect(fourth.body.error.code).toBe("marketing_seat_required");

    const seat = await request(app).post("/api/marketing/email/send").set(auth("Marketing", MKT1)).send({ ...body, abTest: { subjectB: "Big news", testPercent: 30, waitHours: 2 } });
    expect(seat.status).toBe(200);
    const payload = JSON.parse(String(callsMatching(queryMock, /INSERT INTO marketing_send_jobs/).at(-1)![1]![2]));
    expect(payload.ab).toEqual({ subjectB: "Big news", testPercent: 30, waitHours: 2, phase: "test" });

    const best = await request(app).post("/api/marketing/email/send").set(auth()).send({ subject: "News", html: "<p>Hi</p>", tags: ["vip"], sendTime: "best" });
    expect(best.status).toBe(200);
    expect(JSON.parse(String(callsMatching(queryMock, /INSERT INTO marketing_send_jobs/).at(-1)![1]![2])).sendTime).toBe("best");
  });

  it("campaign templates are on every plan (message templates stay Growth and up)", async () => {
    const r = await request(app).get("/api/marketing/templates?channel=email").set(auth());
    expect(r.status).toBe(200);
  });
});

describe("Google Ads", () => {
  it("Starter sees the results; the tools need Pro or the add-on", async () => {
    expect((await request(app).get("/api/marketing/google-ads").set(auth())).status).not.toBe(402);
    expect((await request(app).get("/api/marketing/google-ads/history").set(auth())).status).toBe(200);
    const tools = await request(app).get("/api/marketing/google-ads/suggestions").set(auth());
    expect(tools.status).toBe(402);
    expect(tools.body.tool).toBe("google_ads_full");
    expect((await request(app).get("/api/marketing/ad-waste").set(auth())).status).toBe(402);
    plan.plan = "pro";
    clearPlanCache();
    expect((await request(app).get("/api/marketing/google-ads/suggestions").set(auth())).status).not.toBe(402);
  });

  it("session replay (Clarity) is Growth and up, or the add-on", async () => {
    expect((await request(app).get("/api/marketing/clarity").set(auth())).status).toBe(402);
    plan.plan = "growth";
    clearPlanCache();
    expect((await request(app).get("/api/marketing/clarity").set(auth())).status).not.toBe(402);
  });
});

describe("campaign report", () => {
  it("adds applications and funded deals with the add-on only", async () => {
    const basic = await request(app).get("/api/marketing/campaign-report").set(auth());
    expect(basic.status).toBe(200);
    expect(basic.body).toMatchObject({ ok: true, funded_included: false, campaigns: [] });
    plan.addons = { marketing: true };
    clearPlanCache();
    const full = await request(app).get("/api/marketing/campaign-report").set(auth());
    expect(full.body.funded_included).toBe(true);
  });
});

describe("website kit", () => {
  it("serves the script with the key, the brokerage's forms and cross-origin loading", async () => {
    const r = await request(app).get(`/api/kit/${KEY}/kit.js`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/javascript/);
    expect(r.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(r.text).toContain('"forms":[{"id":"f0000000-0000-4000-8000-000000000001"');
    expect(r.text).toContain('"chat":false');
    expect((await request(app).get("/api/kit/wrongkeywrongkeywrongkey/kit.js")).status).toBe(404);
  });

  it("takes a form only from the listed website, and turns it into a lead", async () => {
    submitKitLead.mockResolvedValue({ contactId: "c1", created: true });
    const body = JSON.stringify({ fields: { full_name: "Ann Lee", email: "ann@lee.ca" }, consent: true });
    const other = await request(app).post(`/api/kit/${KEY}/forms/f0000000-0000-4000-8000-000000000001`).set("Origin", "https://evil.example").set("Content-Type", "text/plain").send(body);
    expect(other.status).toBe(403);
    expect(submitKitLead).not.toHaveBeenCalled();
    const ok = await request(app).post(`/api/kit/${KEY}/forms/f0000000-0000-4000-8000-000000000001`).set("Origin", "https://prairie.ca").set("Content-Type", "text/plain").send(body);
    expect(ok.status).toBe(200);
    expect(ok.headers["access-control-allow-origin"]).toBe("https://prairie.ca");
    expect(ok.body).toMatchObject({ ok: true, message: "Thanks!" });
    expect(submitKitLead.mock.calls[0][2]).toMatchObject({ values: { full_name: "Ann Lee", email: "ann@lee.ca" }, consent: true });
    const missing = await request(app).post(`/api/kit/${KEY}/forms/f0000000-0000-4000-8000-000000000001`).set("Origin", "https://prairie.ca").set("Content-Type", "text/plain").send(JSON.stringify({ fields: { email: "ann@lee.ca" } }));
    expect(missing.status).toBe(400);
    expect(missing.body.message).toBe("Please fill in full name.");
  });

  it("the chat widget and tracking script are add-on tools", async () => {
    const chat = await request(app).post(`/api/kit/${KEY}/chat`).set("Origin", "https://prairie.ca").set("Content-Type", "text/plain").send(JSON.stringify({ message: "Hi" }));
    expect(chat.status).toBe(404);
    const on = await request(app).put("/api/website-kit/settings").set(auth()).send({ chat_enabled: true });
    expect(on.status).toBe(402);
    plan.addons = { marketing: true };
    clearPlanCache();
    const ok = await request(app).put("/api/website-kit/settings").set(auth()).send({ chat_enabled: true, allowed_origins: ["https://prairie.ca"] });
    expect(ok.status).toBe(200);
    const bad = await request(app).put("/api/website-kit/settings").set(auth()).send({ allowed_origins: ["http://prairie.ca"] });
    expect(bad.status).toBe(400);
  });

  it("a second lead form needs the add-on", async () => {
    const r = await request(app).post("/api/website-kit/forms").set(auth()).send({ name: "Second" });
    expect(r.status).toBe(402);
    expect(r.body.message).toMatch(/includes 1 website lead form/);
  });
});

describe("lead scores", () => {
  it("are off without the add-on", async () => {
    const r = await request(app).post("/api/lead-scores/lookup").set(auth("Staff")).send({ contact_ids: ["c0000000-0000-4000-8000-000000000001"] });
    expect(r.body).toEqual({ ok: true, enabled: false, scores: {} });
    expect((await request(app).get("/api/lead-scores/settings").set(auth())).status).toBe(402);
  });
});

describe("Marketing role limit in User Management", () => {
  const db = (marketingUsers: number, target: { role: string; active: boolean } | null) => ({
    query: vi.fn(answerBySql([
      [/FROM licensee_plan WHERE id = 1/, () => ({ rows: [{ ...plan }] })],
      [/SELECT role, \(/, () => ({ rows: target ? [target] : [] })],
      [/SELECT COUNT\(\*\)::int AS n FROM users WHERE role = 'Marketing'/, () => ({ rows: [{ n: marketingUsers }] })],
    ])) as any,
  });

  it("with the add-on on, a 4th active Marketing user is refused; without it any number is fine", async () => {
    plan.addons = { marketing: true };
    clearPlanCache();
    await expect(assertMarketingRoleChange(db(3, { role: "Staff", active: true }), MKT4, { role: "Marketing" })).rejects.toBeInstanceOf(MarketingSeatLimitError);
    await expect(assertMarketingRoleChange(db(3, null), null, { role: "Marketing", active: true })).rejects.toBeInstanceOf(MarketingSeatLimitError);
    await expect(assertMarketingRoleChange(db(3, { role: "Marketing", active: false }), MKT4, { active: true })).rejects.toBeInstanceOf(MarketingSeatLimitError);
    await expect(assertMarketingRoleChange(db(2, { role: "Staff", active: true }), MKT4, { role: "Marketing" })).resolves.toBeUndefined();
    await expect(assertMarketingRoleChange(db(3, { role: "Marketing", active: true }), MKT1, { role: "Marketing" })).resolves.toBeUndefined();
    await expect(assertMarketingRoleChange(db(3, { role: "Staff", active: true }), MKT4, { role: "Admin" })).resolves.toBeUndefined();
    plan.addons = {};
    clearPlanCache();
    await expect(assertMarketingRoleChange(db(9, { role: "Staff", active: true }), MKT4, { role: "Marketing" })).resolves.toBeUndefined();
  });
});
