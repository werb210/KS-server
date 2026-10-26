// KS_SERVER_PHONE_PROVISIONING - buying, assigning and releasing numbers, with a fake Twilio client and a database fake
// that answers by SQL content (not call order).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const h = vi.hoisted(() => ({ query: vi.fn(), mail: vi.fn() }));
vi.mock("../../db.js", () => ({ pool: { query: h.query }, db: { query: h.query } }));
vi.mock("../../plans/email.js", async (orig) => ({ ...(await orig<typeof import("../../plans/email.js")>()), sendPlanMail: h.mail }));

import {
  changeNumber, defaultSearch, keepNumber, limitFor, provisionMainLines, purchaseNumber, reassignDirect, reconcileNumbers, releaseDue, scheduleRelease,
  searchNumbers, setupStatus, webhookUrls, REGULATORY_MESSAGE,
} from "../numbers.js";
import { TwilioNumberError, type AvailableNumber, type PurchaseParams, type TwilioNumbersApi } from "../twilioNumbers.js";
import { clearPlanCache } from "../../plans/state.js";
import { setLastLoadedConnections } from "../../licensee/settings.js";
import phoneNumbersRoutes, { setTwilioNumbersApiForTests } from "../../routes/phoneNumbers.js";
import provisionRoutes, { setProvisionNumbersApiForTests } from "../../routes/provision.js";

type Row = Record<string, any>;
let plan: Row | null;
let numbers: Row[];
let events: Row[];
let users: Row[];
let notifications: Row[];
let settingsWrites: unknown[][];
let seq = 0;

const ENV = {
  TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "tok", KS_SERVER_URL: "https://ks-acme-server.azurewebsites.net",
} as NodeJS.ProcessEnv;
const activeUser = (u: Row) => u.active !== false && !u.deleted_at && ["Admin", "Staff"].includes(u.role);

function fakeDb(sql: string, p: unknown[] = []): { rows: any[]; rowCount: number } {
  const ok = (rows: any[]) => ({ rows, rowCount: rows.length });
  const s = sql.replace(/\s+/g, " ");
  if (/FROM licensee_plan WHERE id = 1/.test(s)) return ok(plan ? [{ ...plan }] : []);
  if (/AS seats FROM users/.test(s)) return ok([{ seats: users.filter(activeUser).length }]);
  if (/SELECT email FROM users WHERE role = 'Admin'/.test(s)) return ok(users.filter((u) => u.role === "Admin" && activeUser(u)).map((u) => ({ email: u.email })));
  if (/SELECT id::text AS id FROM users WHERE role = 'Admin'/.test(s)) return ok(users.filter((u) => u.role === "Admin" && activeUser(u)).map((u) => ({ id: u.id })));
  if (/FROM users WHERE id::text = \$1 AND role IN/.test(s)) {
    return ok(users.filter((u) => u.id === p[0] && activeUser(u)).map((u) => ({ id: u.id, name: u.name, email: u.email, direct_number: u.direct_number ?? null })));
  }
  if (/UPDATE users SET direct_number = NULL WHERE id::text = \$1 AND direct_number = \$2/.test(s)) {
    users.filter((u) => u.id === p[0] && u.direct_number === p[1]).forEach((u) => { u.direct_number = null; });
    return ok([]);
  }
  if (/UPDATE users SET direct_number = \$2 WHERE id::text = \$1/.test(s)) { users.filter((u) => u.id === p[0]).forEach((u) => { u.direct_number = p[1]; }); return ok([]); }
  if (/SELECT count\(\*\)::int AS n FROM phone_numbers WHERE kind = \$1/.test(s)) {
    return ok([{ n: numbers.filter((n) => n.kind === p[0] && ["purchasing", "active"].includes(n.status)).length }]);
  }
  if (/FROM phone_numbers WHERE kind = 'direct' AND assigned_user_id::text = \$1/.test(s)) {
    return ok(numbers.filter((n) => n.kind === "direct" && n.assigned_user_id === p[0] && ["purchasing", "active"].includes(n.status)));
  }
  if (/SELECT phone_number FROM phone_numbers WHERE kind = \$1 AND status IN/.test(s)) {
    return ok(numbers.filter((n) => n.kind === p[0] && ["purchasing", "active"].includes(n.status)));
  }
  if (/^ ?INSERT INTO phone_numbers/.test(s)) {
    if (numbers.some((n) => n.phone_number === p[0] && ["purchasing", "active", "releasing"].includes(n.status))) {
      throw Object.assign(new Error("duplicate"), { code: "23505" });
    }
    const row = { id: `n${++seq}`, phone_number: p[0], kind: p[1], status: "purchasing", assigned_user_id: p[2], purchased_by: p[3], created_at: seq, release_attempts: 0 };
    numbers.push(row);
    return ok([{ ...row }]);
  }
  const byId = (id: unknown) => numbers.find((n) => n.id === id);
  if (/UPDATE phone_numbers SET status = 'failed'/.test(s)) { Object.assign(byId(p[0])!, { status: "failed", last_error: p[1] }); return ok([]); }
  if (/UPDATE phone_numbers SET status = 'active', twilio_sid = \$2/.test(s)) {
    const n = byId(p[0])!; Object.assign(n, { status: "active", twilio_sid: p[1], phone_number: p[2], purchased_at: p[3] }); return ok([{ ...n }]);
  }
  if (/UPDATE phone_numbers SET status = 'releasing'/.test(s)) {
    const n = byId(p[0]);
    if (!n || n.status !== "active") return ok([]);
    Object.assign(n, { status: "releasing", release_after: p[1], release_reason: p[2] }); return ok([{ ...n }]);
  }
  if (/SELECT \* FROM phone_numbers WHERE id::text = \$1 AND status = 'releasing'/.test(s)) return ok(numbers.filter((n) => n.id === p[0] && n.status === "releasing"));
  if (/SELECT \* FROM phone_numbers WHERE id::text = \$1 AND status = 'active' AND kind = 'direct'/.test(s)) return ok(numbers.filter((n) => n.id === p[0] && n.status === "active" && n.kind === "direct"));
  if (/SELECT \* FROM phone_numbers WHERE id::text = \$1 AND status = 'active'$/.test(s.trim())) return ok(numbers.filter((n) => n.id === p[0] && n.status === "active"));
  if (/UPDATE phone_numbers SET status = 'active', release_after = NULL/.test(s)) {
    const n = byId(p[0]);
    if (!n || n.status !== "releasing") return ok([]);
    Object.assign(n, { status: "active", release_after: null, release_reason: null, assigned_user_id: p[1] }); return ok([{ ...n }]);
  }
  if (/UPDATE phone_numbers SET assigned_user_id = \$2/.test(s)) { const n = byId(p[0])!; n.assigned_user_id = p[1]; return ok([{ ...n }]); }
  if (/WHERE status = 'releasing' AND release_after <= \$1/.test(s)) return ok(numbers.filter((n) => n.status === "releasing" && n.release_after <= (p[0] as Date)));
  if (/SET release_attempts = release_attempts \+ 1/.test(s)) { const n = byId(p[0])!; n.release_attempts += 1; n.last_error = p[1]; return ok([]); }
  if (/UPDATE phone_numbers SET status = 'released'/.test(s)) { Object.assign(byId(p[0])!, { status: "released", released_at: p[1] }); return ok([]); }
  if (/SELECT \* FROM phone_numbers WHERE status = 'active'/.test(s)) return ok(numbers.filter((n) => n.status === "active").map((n) => ({ ...n })));
  if (/FROM phone_numbers p LEFT JOIN users u/.test(s)) return ok(numbers.filter((n) => ["purchasing", "active", "releasing"].includes(n.status)));
  if (/INSERT INTO phone_number_events/.test(s)) { events.push({ id: p[0], event: p[1], detail: JSON.parse(String(p[2])), actor: p[3] }); return ok([]); }
  if (/INSERT INTO notifications/.test(s)) { notifications.push({ user_id: p[0], ref_id: p[1], body: p[2] }); return ok([]); }
  if (/INSERT INTO licensee_settings/.test(s)) { settingsWrites.push(p); return ok([]); }
  return ok([]);
}

const avail = (phone: string, over: Partial<AvailableNumber> = {}): AvailableNumber => ({
  phone_number: phone, friendly_name: phone, locality: "Calgary", region: "AB", iso_country: "CA",
  address_requirements: "none", capabilities: { voice: true, sms: true }, ...over,
});

function fakeTwilio(over: Partial<TwilioNumbersApi> = {}) {
  const calls = { purchase: [] as PurchaseParams[], release: [] as string[], local: [] as unknown[], tollFree: [] as unknown[] };
  const api: TwilioNumbersApi = {
    searchLocal: async (q) => { calls.local.push(q); return [avail("+14035550111"), avail("+14035550112")]; },
    searchTollFree: async (q) => { calls.tollFree.push(q); return [avail("+18335550123", { locality: null, region: null })]; },
    purchase: async (prm) => { calls.purchase.push(prm); return { sid: `PN${calls.purchase.length}`, phone_number: prm.phoneNumber }; },
    setWebhooks: async () => undefined,
    release: async (sid) => { calls.release.push(sid); },
    ...over,
  };
  return { api, calls };
}

const token = (role: string, id = "u-admin") => jwt.sign({ sub: id, id, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));

beforeEach(() => {
  plan = { plan: "pro", trial_started_at: null, trial_ends_at: null, extra_storage_blocks: 0, service_status: "active" };
  numbers = []; events = []; notifications = []; settingsWrites = []; seq = 0;
  users = [
    { id: "u-admin", role: "Admin", name: "Ana Admin", email: "ana@acme.example" },
    { id: "u-sam", role: "Staff", name: "Sam Staff", email: "sam@acme.example" },
    { id: "u-lee", role: "Staff", name: "Lee Staff", email: "lee@acme.example" },
  ];
  h.query.mockReset().mockImplementation(async (sql: string, p?: unknown[]) => fakeDb(sql, p));
  h.mail.mockReset().mockResolvedValue({ ok: true });
  clearPlanCache();
  setLastLoadedConnections(null);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  setTwilioNumbersApiForTests(null);
  setProvisionNumbersApiForTests(null);
});

describe("limits and setup", () => {
  it("plan limits: one business line on every plan, toll-free on growth+, direct lines on pro (one per seat)", () => {
    expect([limitFor("starter", "main", 3), limitFor("starter", "toll_free", 3), limitFor("starter", "direct", 3)]).toEqual([1, 0, 0]);
    expect([limitFor("growth", "main", 3), limitFor("growth", "toll_free", 3), limitFor("growth", "direct", 3)]).toEqual([1, 1, 0]);
    expect([limitFor("pro", "toll_free", 3), limitFor("pro", "direct", 3)]).toEqual([2, 3]);
  });

  it("webhooks point at this copy's own server; the dev fallback is never used", () => {
    expect(webhookUrls("https://ks-acme-server.azurewebsites.net")).toEqual({
      voiceUrl: "https://ks-acme-server.azurewebsites.net/api/webhooks/twilio/voice/twiml",
      statusCallback: "https://ks-acme-server.azurewebsites.net/api/webhooks/twilio/voice",
      smsUrl: "https://ks-acme-server.azurewebsites.net/api/webhooks/twilio/sms-inbound",
    });
    const s = setupStatus({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t" } as NodeJS.ProcessEnv);
    expect(s.ready).toBe(false);
    expect(s.messages[0]).toMatch(/KS_SERVER_URL/);
    expect(setupStatus({} as NodeJS.ProcessEnv).messages[0]).toMatch(/TWILIO_ACCOUNT_SID/);
  });
});

describe("search", () => {
  it("local numbers by area code and province; toll-free separately; numbers needing an address are flagged", async () => {
    const { api, calls } = fakeTwilio({ searchLocal: async () => [avail("+14035550111", { address_requirements: "local" })] });
    const r = await searchNumbers(api, { kind: "direct", country: "ca", area_code: "403", region: "ab" }, ENV);
    expect(r).toMatchObject({ ok: true, numbers: [{ phone_number: "+14035550111", needs_address: true }] });
    const t = await searchNumbers(fakeTwilio().api, { kind: "toll_free" }, ENV);
    expect(t.ok && t.numbers[0].phone_number).toBe("+18335550123");
    expect(calls.tollFree).toEqual([]);
    expect(await searchNumbers(api, { area_code: "40" }, ENV)).toMatchObject({ ok: false, status: 400, error: "invalid_area_code" });
    expect(await searchNumbers(api, {}, {} as NodeJS.ProcessEnv)).toMatchObject({ ok: false, status: 503, error: "twilio_not_configured" });
  });

  it("a Twilio search failure is logged and reported, never swallowed", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { api } = fakeTwilio({ searchLocal: async () => { throw new TwilioNumberError("boom", 20003, 401); } });
    expect(await searchNumbers(api, { kind: "main" }, ENV)).toMatchObject({ ok: false, status: 502, error: "twilio_error" });
    expect(err).toHaveBeenCalledWith("[phone-numbers] twilio search failed", expect.objectContaining({ code: 20003 }));
  });
});

describe("purchase", () => {
  it("buys a direct line with this server's webhooks, stores it and gives it to the person", async () => {
    const { api, calls } = fakeTwilio();
    const r = await purchaseNumber(h as any, api, { kind: "direct", phone_number: "+14035550111", user_id: "u-sam", actor: "ana" }, ENV);
    expect(r).toMatchObject({ ok: true, number: { status: "active", twilio_sid: "PN1", assigned_user_id: "u-sam" } });
    expect(calls.purchase[0]).toMatchObject({
      phoneNumber: "+14035550111",
      voiceUrl: "https://ks-acme-server.azurewebsites.net/api/webhooks/twilio/voice/twiml",
      smsUrl: "https://ks-acme-server.azurewebsites.net/api/webhooks/twilio/sms-inbound",
    });
    expect(users.find((u) => u.id === "u-sam")!.direct_number).toBe("+14035550111");
    expect(events.map((e) => e.event)).toEqual(["purchased"]);
    expect(settingsWrites).toEqual([]); // a direct line never becomes the main line
    // one direct line per person
    expect(await purchaseNumber(h as any, api, { kind: "direct", phone_number: "+14035550112", user_id: "u-sam", actor: "ana" }, ENV))
      .toMatchObject({ ok: false, status: 409, error: "already_has_line" });
  });

  it("the first business line becomes the main line", async () => {
    const r = await purchaseNumber(h as any, fakeTwilio().api, { kind: "main", phone_number: "+14035550111", actor: "ops" }, ENV);
    expect(r.ok).toBe(true);
    expect(settingsWrites[0]).toEqual(["ops", "+14035550111"]);
  });

  it("refuses kinds the plan does not include (402, like requireFeature) and enforces limits", async () => {
    plan!.plan = "starter";
    const { api, calls } = fakeTwilio();
    expect(await purchaseNumber(h as any, api, { kind: "toll_free", phone_number: "+18335550123", actor: "ana" }, ENV))
      .toMatchObject({ ok: false, status: 402, error: "feature_not_in_plan", feature: "toll_free_number", required_plan: "growth", trial_available: true });
    expect(await purchaseNumber(h as any, api, { kind: "direct", phone_number: "+14035550111", user_id: "u-sam", actor: "ana" }, ENV))
      .toMatchObject({ ok: false, status: 402, feature: "multiple_lines", required_plan: "pro" });
    expect((await purchaseNumber(h as any, api, { kind: "main", phone_number: "+14035550111", actor: "ana" }, ENV)).ok).toBe(true);
    expect(await purchaseNumber(h as any, api, { kind: "main", phone_number: "+14035550112", actor: "ana" }, ENV))
      .toMatchObject({ ok: false, status: 409, error: "limit_reached", limit: 1 });
    expect(calls.purchase).toHaveLength(1);
  });

  it("a Pro trial may buy direct lines", async () => {
    plan = { ...plan, plan: "starter", trial_started_at: new Date(Date.now() - 86_400_000), trial_ends_at: new Date(Date.now() + 5 * 86_400_000) };
    expect((await purchaseNumber(h as any, fakeTwilio().api, { kind: "direct", phone_number: "+14035550111", user_id: "u-lee", actor: "ana" }, ENV)).ok).toBe(true);
  });

  it("a regulatory refusal (address or bundle) is logged, recorded and explained to the admin", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { api } = fakeTwilio({ purchase: async () => { throw new TwilioNumberError("Phone Number Requires an Address but the 'AddressSid' parameter was empty.", 21631, 400); } });
    const r = await purchaseNumber(h as any, api, { kind: "main", phone_number: "+14035550111", actor: "ana" }, ENV);
    expect(r).toMatchObject({ ok: false, status: 409, error: "regulatory_requirement", message: REGULATORY_MESSAGE });
    expect(numbers[0]).toMatchObject({ status: "failed", last_error: REGULATORY_MESSAGE });
    expect(events.map((e) => e.event)).toEqual(["purchase_failed"]);
    expect(err).toHaveBeenCalledWith("[phone-numbers] twilio purchase failed", expect.objectContaining({ code: 21631 }));
    // A number already known to need an address is refused before Twilio is called.
    const second = fakeTwilio();
    expect(await purchaseNumber(h as any, second.api, { kind: "main", phone_number: "+14035550112", actor: "ana", address_requirements: "local" }, ENV))
      .toMatchObject({ ok: false, error: "regulatory_requirement" });
    expect(second.calls.purchase).toHaveLength(0);
    // With TWILIO_ADDRESS_SID set, the address goes with the purchase.
    const third = fakeTwilio();
    await purchaseNumber(h as any, third.api, { kind: "main", phone_number: "+14035550113", actor: "ana", address_requirements: "local" }, { ...ENV, TWILIO_ADDRESS_SID: "AD1" });
    expect(third.calls.purchase[0].addressSid).toBe("AD1");
  });

  it("refuses when Twilio or the server address is not set up", async () => {
    const { api } = fakeTwilio();
    expect(await purchaseNumber(h as any, api, { kind: "main", phone_number: "+14035550111", actor: "a" }, {} as NodeJS.ProcessEnv))
      .toMatchObject({ status: 503, error: "twilio_not_configured" });
    expect(await purchaseNumber(h as any, api, { kind: "main", phone_number: "+14035550111", actor: "a" }, { TWILIO_ACCOUNT_SID: "x", TWILIO_AUTH_TOKEN: "y", KS_SERVER_URL: "http://insecure" } as NodeJS.ProcessEnv))
      .toMatchObject({ status: 503, error: "server_url_not_set" });
  });
});

describe("release (never silent)", () => {
  async function buyDirect(userId = "u-sam", phone = "+14035550111") {
    const r = await purchaseNumber(h as any, fakeTwilio().api, { kind: "direct", phone_number: phone, user_id: userId, actor: "ana" }, ENV);
    if (!r.ok) throw new Error(r.message);
    return r.number;
  }

  it("schedules the release after the grace period, tells the admins and frees the person's line", async () => {
    const n = await buyDirect();
    const now = new Date("2026-11-01T12:00:00Z");
    const r = await scheduleRelease(h as any, n.id, { reason: "an admin asked for it", actor: "ana", now, env: { KS_NUMBER_RELEASE_GRACE_DAYS: "10" } as NodeJS.ProcessEnv });
    expect(r).toMatchObject({ ok: true, number: { status: "releasing" } });
    expect(numbers[0].release_after.toISOString()).toBe("2026-11-11T12:00:00.000Z");
    expect(users.find((u) => u.id === "u-sam")!.direct_number).toBeNull();
    expect(h.mail).toHaveBeenCalledWith(expect.objectContaining({ to: ["ana@acme.example"], subject: expect.stringContaining("will be released on 2026-11-11") }));
    expect(notifications).toEqual([expect.objectContaining({ user_id: "u-admin", ref_id: n.id })]);
    // Nothing is given back before the date.
    const { api, calls } = fakeTwilio();
    expect(await releaseDue(h as any, api, new Date("2026-11-10T12:00:00Z"))).toEqual({ released: [], failed: [] });
    expect(calls.release).toEqual([]);
    expect(await releaseDue(h as any, api, new Date("2026-11-11T12:00:01Z"))).toEqual({ released: ["+14035550111"], failed: [] });
    expect(calls.release).toEqual(["PN1"]);
    expect(numbers[0].status).toBe("released");
    expect(events.map((e) => e.event)).toEqual(["purchased", "release_scheduled", "released"]);
  });

  it("Keep cancels a scheduled release; a direct line can go to someone else", async () => {
    const n = await buyDirect();
    await scheduleRelease(h as any, n.id, { reason: "test", actor: "ana" });
    expect(await keepNumber(h as any, n.id, { user_id: "u-lee", actor: "ana" })).toMatchObject({ ok: true, number: { status: "active", assigned_user_id: "u-lee" } });
    expect(users.find((u) => u.id === "u-lee")!.direct_number).toBe("+14035550111");
    expect(await reassignDirect(h as any, n.id, { user_id: "u-sam", actor: "ana" })).toMatchObject({ ok: true, number: { assigned_user_id: "u-sam" } });
    expect(users.find((u) => u.id === "u-lee")!.direct_number).toBeNull();
    expect(users.find((u) => u.id === "u-sam")!.direct_number).toBe("+14035550111");
  });

  it("a failed Twilio release is logged and retried; a number already gone is marked released", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const n = await buyDirect();
    await scheduleRelease(h as any, n.id, { reason: "test", actor: "ana", now: new Date("2026-01-01T00:00:00Z") });
    const failing = fakeTwilio({ release: async () => { throw new TwilioNumberError("Twilio down", 20500, 500); } });
    expect(await releaseDue(h as any, failing.api, new Date("2026-03-01T00:00:00Z"))).toEqual({ released: [], failed: ["+14035550111"] });
    expect(numbers[0]).toMatchObject({ status: "releasing", release_attempts: 1, last_error: "Twilio down" });
    expect(err).toHaveBeenCalledWith("[phone-numbers] twilio release failed", expect.objectContaining({ code: 20500 }));
    const gone = fakeTwilio({ release: async () => { throw new TwilioNumberError("not found", 20404, 404); } });
    expect(await releaseDue(h as any, gone.api, new Date("2026-03-01T00:00:00Z"))).toEqual({ released: ["+14035550111"], failed: [] });
  });

  it("reconcile: a removed seat, a downgrade or a cancellation schedules releases (with notice), never an immediate one", async () => {
    const sam = await buyDirect("u-sam", "+14035550111");
    await buyDirect("u-lee", "+14035550112");
    await purchaseNumber(h as any, fakeTwilio().api, { kind: "toll_free", phone_number: "+18335550123", actor: "ana" }, ENV);
    users.find((u) => u.id === "u-lee")!.active = false; // seat removed
    expect(await reconcileNumbers(h as any)).toEqual(["+14035550112"]);
    plan!.plan = "growth"; // downgrade: direct lines go, the toll-free line stays
    expect(await reconcileNumbers(h as any)).toEqual(["+14035550111"]);
    expect(numbers.find((n) => n.id === sam.id)!.status).toBe("releasing");
    plan!.service_status = "cancelled";
    expect(await reconcileNumbers(h as any)).toEqual(["+18335550123"]);
    expect(numbers.every((n) => n.status === "releasing")).toBe(true);
    expect(h.mail).toHaveBeenCalledTimes(3);
  });

  it("reconcile never touches plan-based releases when the plan cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await purchaseNumber(h as any, fakeTwilio().api, { kind: "toll_free", phone_number: "+18335550123", actor: "ana" }, ENV);
    const base = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql: string, p?: unknown[]) => {
      if (/FROM licensee_plan/.test(sql)) throw new Error("db down");
      return base(sql, p);
    });
    expect(await reconcileNumbers(h as any)).toEqual([]);
    expect(numbers[0].status).toBe("active");
  });
});

describe("change number and the default search", () => {
  it("Change number buys the new one for the same person; the old one waits out the grace period", async () => {
    const first = await purchaseNumber(h as any, fakeTwilio().api, { kind: "direct", phone_number: "+14035550111", user_id: "u-sam", actor: "ana" }, ENV);
    if (!first.ok) throw new Error(first.message);
    const r = await changeNumber(h as any, fakeTwilio().api, first.number.id, { phone_number: "+14035550112", actor: "ana" }, ENV);
    expect(r).toMatchObject({ ok: true, replaced: "+14035550111", number: { phone_number: "+14035550112", assigned_user_id: "u-sam", status: "active" } });
    expect(numbers.find((n) => n.id === first.number.id)).toMatchObject({ status: "releasing", release_reason: "replaced by +14035550112" });
    expect(users.find((u) => u.id === "u-sam")!.direct_number).toBe("+14035550112");
  });

  it("if Twilio will not sell the new number, the old one is kept", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const first = await purchaseNumber(h as any, fakeTwilio().api, { kind: "direct", phone_number: "+14035550111", user_id: "u-sam", actor: "ana" }, ENV);
    if (!first.ok) throw new Error(first.message);
    const failing = fakeTwilio({ purchase: async () => { throw new TwilioNumberError("Requires an Address", 21631, 400); } });
    expect(await changeNumber(h as any, failing.api, first.number.id, { phone_number: "+14035550112", actor: "ana" }, ENV)).toMatchObject({ ok: false, error: "regulatory_requirement" });
    expect(numbers.find((n) => n.id === first.number.id)).toMatchObject({ status: "active", assigned_user_id: "u-sam" });
    expect(users.find((u) => u.id === "u-sam")!.direct_number).toBe("+14035550111");
  });

  it("searches near the brokerage first", () => {
    expect(defaultSearch({ country: "CA", mailing_address: "450 Main St SW, Calgary AB T2P 1J9" }, null)).toEqual({ country: "CA", area_code: "", region: "AB" });
    expect(defaultSearch({ country: "CA", mailing_address: "1 Rue X, Montreal H2X 1Y4", support_phone: "(514) 555-0100" }, null)).toEqual({ country: "CA", area_code: "514", region: "QC" });
    expect(defaultSearch({ country: "US", mailing_address: "1 Main St, Austin, TX 78701" }, "+15125550100")).toEqual({ country: "US", area_code: "512", region: "TX" });
    expect(defaultSearch({ country: "CA", support_phone: "1-888-555-0100" }, null)).toEqual({ country: "CA", area_code: "", region: "" });
  });
});

describe("routes", () => {
  const app = () => {
    const a = express();
    a.use(express.json());
    a.use("/api/phone-numbers", phoneNumbersRoutes);
    a.use("/api/provision", provisionRoutes);
    return a;
  };

  it("Admins only; search, buy and release through the API", async () => {
    const fake = fakeTwilio();
    setTwilioNumbersApiForTests(() => fake.api);
    Object.assign(process.env, ENV);
    try {
      expect((await request(app()).get("/api/phone-numbers").set("Authorization", `Bearer ${token("Staff", "u-sam")}`)).status).toBe(403);
      const list = await request(app()).get("/api/phone-numbers").set("Authorization", `Bearer ${token("Admin")}`);
      expect(list.status).toBe(200);
      expect(list.body).toMatchObject({ ok: true, numbers: [], limits: { main: 5, toll_free: 2, direct: 3 }, allowed: { main: true, toll_free: true, direct: true } });
      const found = await request(app()).get("/api/phone-numbers/available?kind=direct&area_code=403").set("Authorization", `Bearer ${token("Admin")}`);
      expect(found.body.numbers).toHaveLength(2);
      const bought = await request(app()).post("/api/phone-numbers").set("Authorization", `Bearer ${token("Admin")}`)
        .send({ kind: "direct", phone_number: "+14035550111", user_id: "u-sam" });
      expect(bought.status).toBe(201);
      const rel = await request(app()).post(`/api/phone-numbers/${bought.body.number.id}/release`).set("Authorization", `Bearer ${token("Admin")}`).send({});
      expect(rel.body).toMatchObject({ ok: true, number: { status: "releasing" } });
      plan!.plan = "starter";
      clearPlanCache();
      const refused = await request(app()).post("/api/phone-numbers").set("Authorization", `Bearer ${token("Admin")}`)
        .send({ kind: "toll_free", phone_number: "+18335550123" });
      expect(refused.status).toBe(402);
      expect(refused.body).toMatchObject({ ok: false, error: "feature_not_in_plan", feature: "toll_free_number" });
    } finally {
      for (const k of Object.keys(ENV)) delete process.env[k];
    }
  });

  it("KS-Ops provisioning buys the business line by area code and the toll-free line on growth, once", async () => {
    const fake = fakeTwilio();
    setProvisionNumbersApiForTests(() => fake.api);
    Object.assign(process.env, ENV, { KS_OPS_KEY: "ops-key-1234567890" });
    plan!.plan = "growth";
    try {
      expect((await request(app()).post("/api/provision/phone-numbers").send({})).status).toBe(401);
      const r = await request(app()).post("/api/provision/phone-numbers").set("X-KS-Ops-Key", "ops-key-1234567890").send({ area_code: "403", region: "AB", country: "CA" });
      expect(r.status).toBe(200);
      expect(r.body.results).toEqual([
        { kind: "main", status: "bought", number: "+14035550111" },
        { kind: "toll_free", status: "bought", number: "+18335550123" },
      ]);
      expect(fake.calls.local[0]).toMatchObject({ country: "CA", areaCode: "403" });
      const again = await request(app()).post("/api/provision/phone-numbers").set("X-KS-Ops-Key", "ops-key-1234567890").send({ area_code: "403" });
      expect(again.body.results.map((x: Row) => x.status)).toEqual(["already_had", "already_had"]);
      expect(fake.calls.purchase).toHaveLength(2);
    } finally {
      for (const k of [...Object.keys(ENV), "KS_OPS_KEY"]) delete process.env[k];
    }
  });

  it("starter: business line only; a regulatory block is reported, not hidden", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    plan!.plan = "starter";
    const r = await provisionMainLines(h as any, fakeTwilio({ searchLocal: async () => [avail("+14035550111", { address_requirements: "local" })] }).api, { area_code: "403", actor: "ops" }, ENV);
    expect(r).toMatchObject({ ok: true, results: [
      { kind: "main", status: "failed", error: "regulatory_requirement" },
      { kind: "toll_free", status: "not_in_plan" },
    ] });
  });
});
