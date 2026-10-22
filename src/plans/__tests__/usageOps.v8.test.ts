// KS_SERVER_v8_USAGE - usage metering, pooled allowances, the assistant cap, the 80/100% notices, the usage reports
// sent to operations, support tickets and the admin-only connection settings, against a database fake that answers
// by SQL content (not call order).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { queryMock, sendMock } = vi.hoisted(() => ({ queryMock: vi.fn(), sendMock: vi.fn() }));

vi.mock("../../db.js", () => ({ pool: { query: queryMock }, db: { query: queryMock }, runQuery: queryMock }));
vi.mock("../email.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../email.js")>();
  return { ...real, sendPlanMail: sendMock };
});

import planRoutes from "../../routes/plan.js";
import supportRoutes from "../../routes/support.js";
import licenseeRoutes from "../../routes/licensee.js";
import mayaRoutes from "../../routes/maya.js";
import { clearPlanCache } from "../state.js";
import { clearLicenseeCache, setLastLoadedConnections } from "../../licensee/settings.js";
import { googleAdsCustomerIdSetting, mainLineNumberSetting } from "../../licensee/connections.js";
import { warmBrand } from "../../licensee/brand.js";
import { mainLineNumber } from "../../voice/directLines.js";
import {
  licenseeTimeZone, overage, periodBounds, periodOf, pooledAllowances, previousPeriod, recordOutboundText, periodUsage, buildUsageReport,
} from "../usage.js";
import { runUsageNotices, usageNoticeDue } from "../usageNotices.js";
import { runUsageReports } from "../usageReports.js";
import { startUsageReportWorker } from "../../workers/usageReportWorker.js";
import { assistantLimitReply } from "../assistantCap.js";
import { rowToState } from "../state.js";
import { GB } from "../catalogue.js";

type Row = Record<string, any>;
let plan: Row | null;
let seats: number;
let calls: Array<{ started_at: Date; secs: number | null }>;
let texts: Array<{ ref: string; quantity: number; at: Date }>;
let sessions: Array<{ id: string; created_at: Date }>;
let notices: Set<string>;
let posts: Record<string, Row>;
let tickets: Row[];
let licensee: Row;
let clock: Date; // what the fake's now() returns

const inRange = (d: Date, p: unknown[]) => d >= new Date(String(p[0])) && d < new Date(String(p[1]));

function fakeDb(sql: string, p: unknown[] = []): { rows: any[]; rowCount: number } {
  const ok = (rows: any[]) => ({ rows, rowCount: rows.length });
  if (/FROM licensee_plan WHERE id = 1/.test(sql) && /^\s*SELECT/.test(sql)) return ok(plan ? [{ ...plan }] : []);
  if (/FROM plan_trial_feature_usage/.test(sql)) return ok([]);
  if (/AS used_bytes/.test(sql)) return ok([{ used_bytes: String(3 * GB) }]);
  if (/AS seats FROM users/.test(sql)) return ok([{ seats }]);
  if (/SELECT email FROM users WHERE role = 'Admin'/.test(sql)) return ok([{ email: "owner@prairie.example" }]);
  if (/AS minutes/.test(sql) && /FROM call_logs/.test(sql)) {
    const m = calls.filter((c) => inRange(c.started_at, p) && (c.secs ?? 0) > 0).reduce((n, c) => n + Math.ceil((c.secs as number) / 60), 0);
    return ok([{ minutes: String(m) }]);
  }
  if (/AS texts/.test(sql) && /FROM usage_events/.test(sql)) return ok([{ texts: String(texts.filter((t) => inRange(t.at, p)).reduce((n, t) => n + t.quantity, 0)) }]);
  if (/INSERT INTO usage_events/.test(sql)) {
    if (!texts.some((t) => t.ref === p[0])) texts.push({ ref: String(p[0]), quantity: Number(p[1]), at: new Date() });
    return ok([]);
  }
  if (/AS assistant_chats/.test(sql)) return ok([{ assistant_chats: String(sessions.filter((s) => inRange(s.created_at, p)).length) }]);
  if (/SELECT 1 FROM chat_sessions WHERE id/.test(sql)) return ok(sessions.filter((s) => s.id === p[0]).map(() => ({ "?column?": 1 })));
  if (/insert into chat_sessions/i.test(sql)) { sessions.push({ id: String(p[0]), created_at: new Date() }); return ok([]); }
  if (/SELECT level FROM usage_notices/.test(sql)) return ok([...notices].filter((k) => k.startsWith(`${p[0]}|${p[1]}|`)).map((k) => ({ level: Number(k.split("|")[2]) })));
  if (/INSERT INTO usage_notices/.test(sql)) {
    const k = `${p[0]}|${p[1]}|${p[2]}`;
    if (notices.has(k)) return ok([]);
    notices.add(k);
    return ok([{ level: p[2] }]);
  }
  if (/DELETE FROM usage_notices/.test(sql)) { notices.delete(`${p[0]}|${p[1]}|${p[2]}`); return ok([]); }
  if (/FROM usage_report_posts WHERE period/.test(sql)) return ok(posts[String(p[0])] ? [{ ...posts[String(p[0])] }] : []);
  if (/INSERT INTO usage_report_posts/.test(sql)) {
    const r = (posts[String(p[0])] ??= { period: p[0] });
    r.last_attempt_at = clock;
    if (/last_error\) VALUES \(\$1, now\(\), \$2\)/.test(sql)) { r.last_error = p[1]; return ok([]); }
    if (/final_posted_at/.test(sql)) r.final_posted_at = clock; else r.last_posted_at = clock;
    r.last_error = null;
    return ok([]);
  }
  if (/INSERT INTO support_tickets/.test(sql)) {
    const t = { id: `t${tickets.length + 1}`, created_by: p[0], subject: p[1], body: p[2], priority: p[3], status: "open", ops_ticket_id: null, relayed_at: null, relay_error: null, created_at: new Date() };
    tickets.push(t);
    return ok([{ ...t }]);
  }
  if (/UPDATE support_tickets SET ops_ticket_id/.test(sql)) {
    const t = tickets.find((x) => x.id === p[0])!;
    Object.assign(t, { ops_ticket_id: p[1], relayed_at: new Date(), relay_error: null });
    return ok([{ ...t }]);
  }
  if (/UPDATE support_tickets SET relay_error/.test(sql)) {
    const t = tickets.find((x) => x.id === p[0])!;
    t.relay_error = p[1];
    return ok([{ ...t }]);
  }
  if (/FROM support_tickets ORDER BY/.test(sql)) return ok([...tickets].reverse());
  if (/FROM licensee_settings WHERE id = 1/.test(sql)) return ok([{ ...licensee }]);
  if (/INSERT INTO licensee_settings/.test(sql)) {
    const cols = sql.match(/\(id, updated_by, ([^)]*)\)/)![1].split(", ");
    cols.forEach((c, i) => { licensee[c] = p[i + 1]; });
    return ok([]);
  }
  return ok([]);
}

const token = (role: string) => jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", id: "11111111-1111-4111-8111-111111111111", role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/plan", planRoutes);
  a.use("/api/support", supportRoutes);
  a.use("/api/licensee", licenseeRoutes);
  a.use("/api/maya", mayaRoutes);
  return a;
}

const OPS_ENV = { KS_OPS_URL: "https://ops.example/", KS_LICENSEE_ID: "lic-1", KS_OPS_KEY: "k3y" } as NodeJS.ProcessEnv;
const fetchOk = (body: unknown = { ok: true }) => vi.fn(async () => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }));
const fetchFail = () => vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "down" }));

const NOW = new Date("2026-10-22T18:00:00Z"); // Oct 22, noon in Edmonton

beforeEach(() => {
  clock = new Date("2026-10-22T18:00:00Z");
  plan = { plan: "starter", trial_started_at: null, trial_ends_at: null, extra_storage_blocks: 0 };
  seats = 2;
  calls = [];
  texts = [];
  sessions = [];
  notices = new Set();
  posts = {};
  tickets = [];
  licensee = { company_name: "Prairie Capital", assistant_name: "Sky", time_zone: "America/Edmonton" };
  clearPlanCache();
  clearLicenseeCache();
  setLastLoadedConnections(null);
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: unknown, params?: unknown[]) => fakeDb(String(sql), params ?? []));
  sendMock.mockReset();
  sendMock.mockResolvedValue({ ok: true });
  for (const k of ["KS_OPS_KEY", "KS_OPS_URL", "KS_LICENSEE_ID", "KS_PLAN", "MAYA_URL", "MAYA_SERVICE_URL"]) delete process.env[k];
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("periods in the licensee's time zone", () => {
  it("a month is the local calendar month", () => {
    const tz = licenseeTimeZone(); // the default licensee zone: Alberta, UTC-6 all year
    expect(licenseeTimeZone("Europe/London")).toBe("Europe/London");
    expect(licenseeTimeZone("Not/AZone")).toBe(tz);
    expect(periodOf(new Date("2026-11-01T05:00:00Z"), tz)).toBe("2026-10"); // Oct 31, 11 pm local
    expect(periodOf(new Date("2026-11-01T07:00:00Z"), tz)).toBe("2026-11");
    const { start, end } = periodBounds("2026-10", tz);
    expect(start.toISOString()).toBe("2026-10-01T06:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-01T06:00:00.000Z");
    expect(periodBounds("2026-12", tz).end.toISOString()).toBe("2027-01-01T06:00:00.000Z"); // no clock change
    expect(periodBounds("2026-07", "Europe/London").start.toISOString()).toBe("2026-06-30T23:00:00.000Z"); // BST
    expect(previousPeriod("2026-01")).toBe("2025-12");
  });
});

describe("pooled allowances and overage", () => {
  it("per-seat allowance x seats, plus the trial bonus during a trial; assistant chats unlimited on pro and trial", () => {
    const starter = rowToState({ plan: "starter" });
    expect(pooledAllowances(starter, 3, NOW)).toEqual({ minutes: 150, texts: 300, assistant_chats: 200, storage_bytes: 30 * GB });
    expect(pooledAllowances(rowToState({ plan: "growth" }), 2, NOW)).toMatchObject({ minutes: 1000, texts: 1000, assistant_chats: 1000 });
    expect(pooledAllowances(rowToState({ plan: "pro", extra_storage_blocks: 1 }), 2, NOW))
      .toEqual({ minutes: 3000, texts: 3000, assistant_chats: null, storage_bytes: 100 * GB + 50 * GB });
    const trial = rowToState({ plan: "starter", trial_started_at: "2026-10-20T00:00:00Z", trial_ends_at: "2026-11-03T00:00:00Z" });
    expect(pooledAllowances(trial, 3, NOW)).toEqual({ minutes: 450, texts: 600, assistant_chats: null, storage_bytes: 150 * GB });
    expect(pooledAllowances(starter, 0, NOW).minutes).toBe(50); // at least one seat
    expect(overage(120, 100)).toBe(20);
    expect(overage(80, 100)).toBe(0);
  });

  it("counts this month's calls (rounded up per call), texts (segments) and new assistant conversations", async () => {
    calls = [
      { started_at: new Date("2026-10-05T15:00:00Z"), secs: 61 }, // 2
      { started_at: new Date("2026-10-06T15:00:00Z"), secs: 30 }, // 1
      { started_at: new Date("2026-10-06T16:00:00Z"), secs: 0 }, // unanswered: 0
      { started_at: new Date("2026-10-01T05:00:00Z"), secs: 600 }, // Sep 30 local: not this month
      { started_at: new Date("2026-10-21T15:00:00Z"), secs: 6000 }, // 100
    ];
    texts = [
      { ref: "SM1", quantity: 2, at: new Date("2026-10-10T15:00:00Z") },
      { ref: "SM2", quantity: 1, at: new Date("2026-10-11T15:00:00Z") },
      { ref: "SM0", quantity: 5, at: new Date("2026-09-11T15:00:00Z") },
    ];
    sessions = [{ id: "a", created_at: new Date("2026-10-02T15:00:00Z") }, { id: "b", created_at: new Date("2026-09-02T15:00:00Z") }];
    const u = await periodUsage({ query: queryMock }, "2026-10", NOW);
    expect(u).toMatchObject({
      period: "2026-10", minutes: 103, texts: 3, assistant_chats: 1, storage_bytes: 3 * GB, seats: 2,
      allowances: { minutes: 100, texts: 200, assistant_chats: 200 },
      overage: { minutes: 3, texts: 0 },
    });
  });

  it("records each outbound text once per message SID, with its segments", async () => {
    const db = { query: queryMock };
    await recordOutboundText(db, { sid: "SMx", numSegments: "3" });
    await recordOutboundText(db, { sid: "SMx", numSegments: "3" });
    await recordOutboundText(db, { sid: "SMy" });
    await recordOutboundText(db, null);
    expect(texts.map((t) => [t.ref, t.quantity])).toEqual([["SMx", 3], ["SMy", 1]]);
    queryMock.mockRejectedValueOnce(new Error("db down"));
    await expect(recordOutboundText(db, { sid: "SMz" })).resolves.toBeUndefined(); // never throws
  });
});

describe("GET /api/plan usage and GET /api/plan/usage-report", () => {
  it("adds this month's usage to the plan", async () => {
    calls = [{ started_at: new Date(), secs: 125 }];
    const r = await request(app()).get("/api/plan").set("Authorization", `Bearer ${token("Staff")}`);
    expect(r.status).toBe(200);
    expect(r.body.usage).toMatchObject({
      minutes: 3, texts: 0, assistant_chats: 0, storage_bytes: 3 * GB,
      allowances: { minutes: 100, texts: 200, assistant_chats: 200, storage_bytes: 20 * GB },
      overage: { minutes: 0, texts: 0 },
    });
    expect(r.body.usage.period).toMatch(/^\d{4}-\d{2}$/);
  });

  it("is ops-key only and returns the contract's UsageReport", async () => {
    expect((await request(app()).get("/api/plan/usage-report?period=2026-10")).status).toBe(403);
    process.env.KS_OPS_KEY = "secret";
    process.env.KS_LICENSEE_ID = "lic-9";
    expect((await request(app()).get("/api/plan/usage-report").set("X-KS-Ops-Key", "nope")).status).toBe(401);
    expect((await request(app()).get("/api/plan/usage-report?period=2026-13").set("X-KS-Ops-Key", "secret")).status).toBe(400);
    texts = [{ ref: "SM1", quantity: 250, at: new Date("2026-09-15T15:00:00Z") }];
    const r = await request(app()).get("/api/plan/usage-report?period=2026-09").set("X-KS-Ops-Key", "secret");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      licensee_id: "lic-9", period: "2026-09", plan: "starter", effective_plan: "starter",
      trial: { status: "available", started_at: null, ends_at: null }, seats: 2,
      minutes: 0, texts: 250, assistant_chats: 0, storage_bytes: 3 * GB,
      allowances: { minutes: 100, texts: 200, assistant_chats: 200, storage_bytes: 20 * GB },
      overage: { minutes: 0, texts: 50 }, extra_storage_blocks: 0,
    });
    expect(Object.keys(r.body).sort()).toEqual([
      "allowances", "assistant_chats", "effective_plan", "extra_storage_blocks", "generated_at", "licensee_id", "minutes",
      "overage", "period", "plan", "seats", "storage_bytes", "texts", "trial",
    ]);
  });
});

describe("assistant monthly limit", () => {
  const capApp = () => app();
  beforeEach(() => { process.env.MAYA_URL = "https://agent.example"; });

  it("over the limit, a NEW conversation gets a polite reply and the agent is not called", async () => {
    const f = fetchOk({ reply: "hi" });
    vi.stubGlobal("fetch", f);
    const start = periodBounds(periodOf(new Date(), licenseeTimeZone()), licenseeTimeZone()).start;
    sessions = Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, created_at: new Date(start.getTime() + 1000) }));
    const r = await request(capApp()).post("/api/maya/message").send({ message: "hello", sessionId: "11111111-2222-4333-8444-555555555555" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ limit_reached: true, reason: "assistant_monthly_limit" });
    expect(r.body.reply).toBe(assistantLimitReply());
    expect(r.body.reply).toMatch(/monthly limit/);
    expect(f).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(200); // not counted as a conversation
  });

  it("an existing conversation can finish, and under the limit or on pro the agent answers", async () => {
    const f = fetchOk({ reply: "hi" });
    vi.stubGlobal("fetch", f);
    const start = periodBounds(periodOf(new Date(), licenseeTimeZone()), licenseeTimeZone()).start;
    const existing = "11111111-2222-4333-8444-555555555555";
    sessions = Array.from({ length: 199 }, (_, i) => ({ id: `s${i}`, created_at: new Date(start.getTime() + 1000) }));
    sessions.push({ id: existing, created_at: new Date(start.getTime() + 2000) });
    const cont = await request(capApp()).post("/api/maya/message").send({ message: "and?", sessionId: existing });
    expect(cont.body).toEqual({ reply: "hi" });
    expect(f).toHaveBeenCalledTimes(1);

    plan = { plan: "pro", extra_storage_blocks: 0 };
    clearPlanCache();
    sessions.push({ id: "x", created_at: new Date(start.getTime() + 3000) });
    const r = await request(capApp()).post("/api/maya/chat").send({ message: "hello", sessionId: "web-abc" });
    expect(r.body).toEqual({ reply: "hi" });
  });
});

describe("80% / 100% minutes and texts notices", () => {
  it("sends each threshold once per month to admins and support, mentioning overage rates", async () => {
    licensee.support_email = "help@prairie.example";
    clearLicenseeCache();
    await warmBrand({ query: queryMock });
    const db = { query: queryMock };
    calls = [{ started_at: new Date("2026-10-10T15:00:00Z"), secs: 85 * 60 }]; // 85 of 100
    let r = await runUsageNotices(db, NOW);
    expect(r.sent).toEqual(["2026-10:minutes:80"]);
    const mail = sendMock.mock.calls[0][0];
    expect(mail.to).toEqual(["owner@prairie.example", "help@prairie.example"]);
    expect(mail.text).toMatch(/\$0\.04 a minute/);
    expect(mail.text).toMatch(/never cut off/);
    expect((await runUsageNotices(db, NOW)).sent).toEqual([]); // once

    calls.push({ started_at: new Date("2026-10-11T15:00:00Z"), secs: 20 * 60 });
    texts = [{ ref: "SM1", quantity: 230, at: new Date("2026-10-12T15:00:00Z") }]; // over 200 straight away
    r = await runUsageNotices(db, NOW);
    expect(r.sent).toEqual(["2026-10:minutes:100", "2026-10:texts:100"]);
    expect(sendMock.mock.calls[2][0].text).toMatch(/\$0\.03 a text/);
    expect((await runUsageNotices(db, NOW)).sent).toEqual([]); // no 80% texts email after the 100% one

    // next month starts afresh
    calls.push({ started_at: new Date("2026-11-10T15:00:00Z"), secs: 90 * 60 });
    r = await runUsageNotices(db, new Date("2026-11-12T18:00:00Z"));
    expect(r.sent).toEqual(["2026-11:minutes:80"]);
  });

  it("a failed send is retried on the next run", async () => {
    const db = { query: queryMock };
    calls = [{ started_at: new Date("2026-10-10T15:00:00Z"), secs: 100 * 60 }];
    sendMock.mockResolvedValueOnce({ ok: false, error: "smtp" });
    expect((await runUsageNotices(db, NOW)).failed).toEqual(["2026-10:minutes:100"]);
    expect(notices.size).toBe(0);
    expect((await runUsageNotices(db, NOW)).sent).toEqual(["2026-10:minutes:100"]);
  });

  it("due levels", () => {
    expect(usageNoticeDue(79, 100, new Set())).toBeNull();
    expect(usageNoticeDue(80, 100, new Set())).toBe(80);
    expect(usageNoticeDue(80, 100, new Set([80]))).toBeNull();
    expect(usageNoticeDue(100, 100, new Set([80]))).toBe(100);
    expect(usageNoticeDue(90, 100, new Set([100]))).toBeNull();
  });
});

describe("usage reports to operations", () => {
  it("skips when not configured, and the worker says so once without starting", async () => {
    const f = fetchOk();
    expect(await runUsageReports({ query: queryMock }, NOW, { env: {}, fetchImpl: f as any })).toEqual({ skipped: true });
    expect(f).not.toHaveBeenCalled();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const w = startUsageReportWorker({} as any, {} as NodeJS.ProcessEnv);
    expect(w.started).toBe(false);
    expect(info).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });

  it("posts last month's final report once and this month's report once a day, with the ops key", async () => {
    const f = fetchOk();
    const db = { query: queryMock };
    const r = await runUsageReports(db, NOW, { env: OPS_ENV, fetchImpl: f as any });
    expect(r).toEqual({ skipped: false, posted: ["2026-09:final", "2026-10:daily"], failed: [] });
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://ops.example/api/licensees/lic-1/usage-reports");
    expect(init.headers["X-KS-Ops-Key"]).toBe("k3y");
    expect(JSON.parse(init.body)).toMatchObject({ period: "2026-09", plan: "starter" });
    expect(JSON.parse((f.mock.calls[1] as any)[1].body).period).toBe("2026-10");

    // same day: nothing more
    expect((await runUsageReports(db, new Date(NOW.getTime() + 3600_000), { env: OPS_ENV, fetchImpl: f as any })).posted).toEqual([]);
    const next = await runUsageReports(db, new Date(NOW.getTime() + 86_400_000), { env: OPS_ENV, fetchImpl: f as any });
    expect(next.posted).toEqual(["2026-10:daily"]);
  });

  it("a failed post is recorded, logged and retried on the next run", async () => {
    const db = { query: queryMock };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bad = fetchFail();
    const r = await runUsageReports(db, NOW, { env: OPS_ENV, fetchImpl: bad as any });
    expect(r).toMatchObject({ posted: [], failed: ["2026-09:final", "2026-10:daily"] });
    expect(posts["2026-09"].last_error).toMatch(/status_503/);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    const good = fetchOk();
    expect((await runUsageReports(db, NOW, { env: OPS_ENV, fetchImpl: good as any })).posted).toEqual(["2026-09:final", "2026-10:daily"]);
  });

  it("the report for a period carries the trial bonus while a trial runs", async () => {
    plan = { plan: "starter", trial_started_at: new Date("2026-10-20T00:00:00Z"), trial_ends_at: new Date("2026-11-03T00:00:00Z"), extra_storage_blocks: 0 };
    const rep = await buildUsageReport({ query: queryMock }, "2026-10", NOW);
    expect(rep).toMatchObject({ effective_plan: "pro", trial: { status: "active" }, allowances: { minutes: 300, texts: 400, assistant_chats: null } });
  });
});

describe("support tickets", () => {
  it("Admin and Staff only; stores the ticket and relays it to operations", async () => {
    const f = fetchOk({ id: "ops-77" });
    vi.stubGlobal("fetch", f);
    Object.assign(process.env, OPS_ENV);
    expect((await request(app()).post("/api/support/tickets").send({ subject: "a", body: "b" })).status).toBe(401);
    expect((await request(app()).post("/api/support/tickets").set("Authorization", `Bearer ${token("Lender")}`).send({ subject: "a", body: "b" })).status).toBe(403);
    const bad = await request(app()).post("/api/support/tickets").set("Authorization", `Bearer ${token("Staff")}`).send({ subject: "", body: "x", priority: "panic" });
    expect(bad.status).toBe(400);
    expect(bad.body.errors).toMatchObject({ subject: "required", priority: "normal or urgent" });

    const r = await request(app()).post("/api/support/tickets").set("Authorization", `Bearer ${token("Staff")}`)
      .send({ subject: "Dialler down", body: "No calls since 9", priority: "urgent" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ ok: true, relayed: true, ticket: { subject: "Dialler down", priority: "urgent", ops_ticket_id: "ops-77" } });
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://ops.example/api/licensees/lic-1/tickets");
    expect(init.headers["X-KS-Ops-Key"]).toBe("k3y");
    expect(JSON.parse(init.body)).toMatchObject({ subject: "Dialler down", body: "No calls since 9", priority: "urgent", local_ticket_id: "t1" });

    const list = await request(app()).get("/api/support/tickets").set("Authorization", `Bearer ${token("Admin")}`);
    expect(list.body.tickets).toHaveLength(1);
  });

  it("keeps the ticket when the relay fails", async () => {
    vi.stubGlobal("fetch", fetchFail());
    Object.assign(process.env, OPS_ENV);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await request(app()).post("/api/support/tickets").set("Authorization", `Bearer ${token("Admin")}`).send({ subject: "s", body: "b" });
    warn.mockRestore();
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ relayed: false, ticket: { priority: "normal", ops_ticket_id: null } });
    expect(tickets[0].relay_error).toMatch(/status_503/);
  });
});

describe("upgrade requests are copied to operations", () => {
  it("posts the request to KS-Ops as well as emailing sales", async () => {
    const f = fetchOk();
    vi.stubGlobal("fetch", f);
    Object.assign(process.env, OPS_ENV);
    const r = await request(app()).post("/api/plan/upgrade-request").set("Authorization", `Bearer ${token("Admin")}`).send({ plan: "growth" });
    expect(r.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://ops.example/api/licensees/lic-1/requests");
    expect(JSON.parse(init.body)).toMatchObject({ current_plan: "starter", requested_plan: "growth" });

    // the sales email failing does not lose a request operations already has
    sendMock.mockResolvedValueOnce({ ok: false, error: "smtp" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r2 = await request(app()).post("/api/plan/upgrade-request").set("Authorization", `Bearer ${token("Admin")}`).send({ plan: "pro" });
    warn.mockRestore();
    expect(r2.status).toBe(200);
  });
});

describe("licensee connection settings", () => {
  it("are admin-only: not in the public GET, shown by GET /admin, saved by PUT", async () => {
    licensee.twilio_main_number = "+15875550100";
    const pub = await request(app()).get("/api/licensee");
    expect(pub.status).toBe(200);
    expect(pub.body.licensee.company_name).toBe("Prairie Capital");
    for (const k of ["twilio_main_number", "google_ads_customer_id", "office365_tenant_id"]) expect(pub.body.licensee).not.toHaveProperty(k);

    expect((await request(app()).get("/api/licensee/admin")).status).toBe(401);
    expect((await request(app()).get("/api/licensee/admin").set("Authorization", `Bearer ${token("Staff")}`)).status).toBe(403);
    const adm = await request(app()).get("/api/licensee/admin").set("Authorization", `Bearer ${token("Admin")}`);
    expect(adm.body.licensee).toMatchObject({ company_name: "Prairie Capital", twilio_main_number: "+15875550100", google_ads_customer_id: "" });

    const bad = await request(app()).put("/api/licensee").set("Authorization", `Bearer ${token("Admin")}`).send({ google_ads_customer_id: "12" });
    expect(bad.status).toBe(400);
    const put = await request(app()).put("/api/licensee").set("Authorization", `Bearer ${token("Admin")}`)
      .send({ google_ads_customer_id: "1234567890", office365_tenant_id: "prairie.onmicrosoft.com" });
    expect(put.status).toBe(200);
    expect(put.body.licensee).toMatchObject({ google_ads_customer_id: "123-456-7890", office365_tenant_id: "prairie.onmicrosoft.com" });
  });

  it("the server prefers the licensee setting, then the App Service setting", () => {
    expect(googleAdsCustomerIdSetting({ GOOGLE_ADS_CUSTOMER_ID: "111-111-1111" } as any)).toBe("111-111-1111");
    setLastLoadedConnections({ twilio_main_number: "+15875550100", google_ads_customer_id: "222-222-2222", office365_tenant_id: "" });
    expect(googleAdsCustomerIdSetting({ GOOGLE_ADS_CUSTOMER_ID: "111-111-1111" } as any)).toBe("222-222-2222");
    expect(mainLineNumberSetting({ TWILIO_MAIN_LINE_NUMBER: "+18005550000" } as any)).toBe("+15875550100");
    expect(mainLineNumber()).toBe("+15875550100");
    setLastLoadedConnections(null);
    expect(mainLineNumber()).toBe(process.env.TWILIO_MAIN_LINE_NUMBER);
  });
});
