// KS_SERVER_NUMBER_PORTING_v1 - "Keep your existing phone number": attaching a transferred number, the temporary
// number's release, and the Admin routes that relay to Keystone operations. The database fake answers by SQL content
// (not call order); Twilio and KS-Ops are fakes. Numbers are 555 test numbers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const h = vi.hoisted(() => ({ query: vi.fn(), mail: vi.fn() }));
vi.mock("../../db.js", () => ({ pool: { query: h.query }, db: { query: h.query } }));
vi.mock("../../plans/email.js", async (orig) => ({ ...(await orig<typeof import("../../plans/email.js")>()), sendPlanMail: h.mail }));

import { attachPortedNumber, forwardingOffNote, portingPeople } from "../porting.js";
import { reconcileNumbers } from "../numbers.js";
import type { TwilioNumbersApi } from "../twilioNumbers.js";
import { clearPlanCache } from "../../plans/state.js";
import { setLastLoadedConnections } from "../../licensee/settings.js";
import provisionRoutes, { setProvisionNumbersApiForTests } from "../../routes/provision.js";
import portRequestsRoutes, { setPortRequestsFetchForTests } from "../../routes/portRequests.js";

type Row = Record<string, any>;
let numbers: Row[];
let users: Row[];
let events: Row[];
let settingsWrites: unknown[][];
let plan: Row;
let seq = 0;

const ENV = { TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "tok", KS_SERVER_URL: "https://ks-acme-server.azurewebsites.net" } as NodeJS.ProcessEnv;
const LIVE = ["purchasing", "active", "releasing"];
const activeUser = (u: Row) => u.active !== false && ["Admin", "Staff", "Marketing"].includes(u.role);

function fakeDb(sql: string, p: unknown[] = []) {
  const ok = (rows: any[]) => ({ rows, rowCount: rows.length });
  const s = sql.replace(/\s+/g, " ").trim();
  if (/FROM licensee_plan WHERE id = 1/.test(s)) return ok([{ ...plan }]);
  if (/AS seats FROM users/.test(s)) return ok([{ seats: users.filter(activeUser).length }]);
  if (/SELECT email FROM users WHERE role = 'Admin'/.test(s)) return ok(users.filter((u) => u.role === "Admin").map((u) => ({ email: u.email })));
  if (/SELECT id::text AS id FROM users WHERE role = 'Admin'/.test(s)) return ok(users.filter((u) => u.role === "Admin").map((u) => ({ id: u.id })));
  if (/FROM users WHERE id::text = \$1 AND role IN/.test(s)) {
    return ok(users.filter((u) => u.id === p[0] && activeUser(u)).map((u) => ({ id: u.id, name: u.name, email: u.email, direct_number: u.direct_number ?? null })));
  }
  if (/AS name, email, role, direct_number FROM users WHERE role IN/.test(s)) {
    return ok(users.filter(activeUser).map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, direct_number: u.direct_number ?? null })));
  }
  if (/AS name, email FROM users WHERE id::text = \$1/.test(s)) return ok(users.filter((u) => u.id === p[0]).map((u) => ({ name: u.name, email: u.email })));
  if (/UPDATE users SET direct_number = NULL WHERE id::text = \$1 AND direct_number = \$2/.test(s)) {
    users.filter((u) => u.id === p[0] && u.direct_number === p[1]).forEach((u) => { u.direct_number = null; });
    return ok([]);
  }
  if (/UPDATE users SET direct_number = \$2 WHERE id::text = \$1/.test(s)) { users.filter((u) => u.id === p[0]).forEach((u) => { u.direct_number = p[1]; }); return ok([]); }
  if (/SELECT \* FROM phone_numbers WHERE phone_number = \$1 AND status IN/.test(s)) return ok(numbers.filter((n) => n.phone_number === p[0] && LIVE.includes(n.status)));
  if (/SELECT \* FROM phone_numbers WHERE kind = 'direct' AND assigned_user_id::text = \$1 AND status = 'active'/.test(s)) {
    return ok(numbers.filter((n) => n.kind === "direct" && n.assigned_user_id === p[0] && n.status === "active"));
  }
  if (/SELECT \* FROM phone_numbers WHERE phone_number = \$1 AND kind = \$2 AND status = 'active'/.test(s)) {
    return ok(numbers.filter((n) => n.phone_number === p[0] && n.kind === p[1] && n.status === "active"));
  }
  if (/UPDATE phone_numbers SET status = 'releasing'/.test(s)) {
    const n = numbers.find((x) => x.id === p[0]);
    if (!n || n.status !== "active") return ok([]);
    Object.assign(n, { status: "releasing", release_after: p[1], release_reason: p[2] });
    return ok([{ ...n }]);
  }
  if (/^INSERT INTO phone_numbers/.test(s)) {
    if (numbers.some((n) => n.phone_number === p[0] && LIVE.includes(n.status))) throw Object.assign(new Error("duplicate"), { code: "23505" });
    if (p[1] === "direct" && numbers.some((n) => n.kind === "direct" && n.assigned_user_id === p[2] && ["purchasing", "active"].includes(n.status))) {
      throw Object.assign(new Error("duplicate direct"), { code: "23505" });
    }
    const row = { id: `n${++seq}`, phone_number: p[0], kind: p[1], status: "active", assigned_user_id: p[2], purchased_by: p[3], twilio_sid: p[4], ported: true, port_request_id: p[6] };
    numbers.push(row);
    return ok([{ ...row }]);
  }
  if (/SELECT \* FROM phone_numbers WHERE status = 'active'/.test(s)) return ok(numbers.filter((n) => n.status === "active").map((n) => ({ ...n })));
  if (/INSERT INTO phone_number_events/.test(s)) { events.push({ id: p[0], event: p[1], detail: JSON.parse(String(p[2])) }); return ok([]); }
  if (/INSERT INTO licensee_settings/.test(s)) { settingsWrites.push(p); return ok([]); }
  return ok([]);
}

function fakeTwilio(owned: Record<string, string> = { "+14035550188": "PNOWN1" }) {
  const calls = { webhooks: [] as Array<{ sid: string; voiceUrl: string; smsUrl: string }>, find: [] as string[] };
  const api: TwilioNumbersApi = {
    searchLocal: async () => [], searchTollFree: async () => [],
    purchase: async () => { throw new Error("not used"); },
    setWebhooks: async (sid, prm) => { calls.webhooks.push({ sid, voiceUrl: prm.voiceUrl, smsUrl: prm.smsUrl }); },
    release: async () => undefined,
    findOwned: async (phone) => { calls.find.push(phone); return owned[phone] ? { sid: owned[phone], phone_number: phone } : null; },
  };
  return { api, calls };
}

const token = (role: string, id = "u-admin") => jwt.sign({ sub: id, id, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));

beforeEach(() => {
  plan = { plan: "growth", trial_started_at: null, trial_ends_at: null, extra_storage_blocks: 0, service_status: "active" };
  seq = 0; events = []; settingsWrites = [];
  users = [
    { id: "u-admin", role: "Admin", name: "Ana Admin", email: "ana@acme.example" },
    { id: "u-sam", role: "Staff", name: "Sam Staff", email: "sam@acme.example", direct_number: "+14035550111" },
    { id: "u-lee", role: "Staff", name: "Lee Staff", email: "lee@acme.example" },
  ];
  numbers = [
    { id: "n-main", phone_number: "+14035550100", kind: "main", status: "active", assigned_user_id: null, ported: false },
    { id: "n-sam", phone_number: "+14035550111", kind: "direct", status: "active", assigned_user_id: "u-sam", ported: false },
  ];
  h.query.mockReset().mockImplementation(async (sql: string, p?: unknown[]) => fakeDb(sql, p));
  h.mail.mockReset().mockResolvedValue({ ok: true });
  clearPlanCache();
  setLastLoadedConnections(null);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  setProvisionNumbersApiForTests(null);
  setPortRequestsFetchForTests(null);
});

describe("temporary numbers", () => {
  it("each person's temporary number is their direct line, else the main line", async () => {
    const r = await portingPeople(h as any, { ...ENV, TWILIO_MAIN_LINE_NUMBER: "+14035550100" });
    expect(r.main_line).toBe("+14035550100");
    expect(r.people.find((p) => p.id === "u-sam")).toMatchObject({ temporary_number: "+14035550111", temporary_kind: "direct" });
    expect(r.people.find((p) => p.id === "u-lee")).toMatchObject({ temporary_number: "+14035550100", temporary_kind: "main" });
  });
});

describe("attaching a transferred number", () => {
  it("a broker's number becomes their direct line (caller ID), pointed at this server; their Keystone line is released after 7 days", async () => {
    const { api, calls } = fakeTwilio();
    const now = new Date("2026-11-10T12:00:00Z");
    const r = await attachPortedNumber(h as any, api, {
      phone_number: "(403) 555-0188", number_type: "mobile", user_id: "u-sam", temporary_number: "+14035550111", port_request_id: "pr-1", actor: "ks-ops porting",
    }, ENV, now);
    expect(r).toMatchObject({ ok: true, status: "attached", released: "+14035550111", number: { kind: "direct", assigned_user_id: "u-sam", ported: true, twilio_sid: "PNOWN1" } });
    expect(calls.webhooks[0]).toEqual({ sid: "PNOWN1", voiceUrl: "https://ks-acme-server.azurewebsites.net/api/webhooks/twilio/voice/twiml", smsUrl: "https://ks-acme-server.azurewebsites.net/api/webhooks/twilio/sms-inbound" });
    expect(users.find((u) => u.id === "u-sam")!.direct_number).toBe("+14035550188");
    const old = numbers.find((n) => n.id === "n-sam")!;
    expect(old.status).toBe("releasing");
    expect(new Date(old.release_after).getTime() - now.getTime()).toBe(7 * 86_400_000);
    // The admins are told, including to turn off forwarding.
    const mail = h.mail.mock.calls[0][0];
    expect(mail.text).toContain("Turn off the call forwarding");
    expect(mail.text).toContain("+14035550188");
    expect(events.map((e) => e.event)).toContain("ported_in");
  });

  it("the grace period comes from Keystone operations", async () => {
    const now = new Date("2026-11-10T12:00:00Z");
    await attachPortedNumber(h as any, fakeTwilio().api, { phone_number: "+14035550188", number_type: "local", user_id: "u-sam", grace_days: 14, actor: "ops" }, ENV, now);
    expect(new Date(numbers.find((n) => n.id === "n-sam")!.release_after).getTime() - now.getTime()).toBe(14 * 86_400_000);
  });

  it("a person who used the main line gets a direct line and the main line is kept", async () => {
    const r = await attachPortedNumber(h as any, fakeTwilio().api, { phone_number: "+14035550188", number_type: "local", user_id: "u-lee", temporary_number: "+14035550100", actor: "ops" }, ENV);
    expect(r).toMatchObject({ ok: true, released: null, number: { kind: "direct", assigned_user_id: "u-lee" } });
    expect(numbers.find((n) => n.id === "n-main")!.status).toBe("active");
  });

  it("the brokerage's own number replaces the Keystone main line and becomes the caller ID", async () => {
    const env = { ...ENV, TWILIO_MAIN_LINE_NUMBER: "+14035550100" };
    const r = await attachPortedNumber(h as any, fakeTwilio().api, { phone_number: "+14035550188", number_type: "local", temporary_number: "+14035550100", actor: "ops" }, env);
    expect(r).toMatchObject({ ok: true, released: "+14035550100", number: { kind: "main", assigned_user_id: null } });
    expect(settingsWrites[0]).toEqual(["ops", "+14035550188"]);
  });

  it("a toll-free number becomes the toll-free line", async () => {
    const r = await attachPortedNumber(h as any, fakeTwilio({ "+18885550142": "PNTF" }).api, { phone_number: "+18885550142", number_type: "toll_free", actor: "ops" }, ENV);
    expect(r).toMatchObject({ ok: true, number: { kind: "toll_free" } });
  });

  it("waits for Twilio: a number not in the account yet is refused with a plain reason, and nothing changes", async () => {
    const r = await attachPortedNumber(h as any, fakeTwilio({}).api, { phone_number: "+14035550188", number_type: "local", user_id: "u-sam", actor: "ops" }, ENV);
    expect(r).toMatchObject({ ok: false, status: 409, error: "not_in_account" });
    expect(numbers.find((n) => n.id === "n-sam")!.status).toBe("active");
  });

  it("is safe to call again", async () => {
    const t = fakeTwilio();
    await attachPortedNumber(h as any, t.api, { phone_number: "+14035550188", number_type: "local", user_id: "u-sam", actor: "ops" }, ENV);
    const again = await attachPortedNumber(h as any, t.api, { phone_number: "+14035550188", number_type: "local", user_id: "u-sam", actor: "ops" }, ENV);
    expect(again).toMatchObject({ ok: true, status: "already_attached" });
    expect(numbers.filter((n) => n.phone_number === "+14035550188")).toHaveLength(1);
  });

  it("refuses bad input and people who left", async () => {
    const api = fakeTwilio().api;
    expect(await attachPortedNumber(h as any, api, { phone_number: "nope", number_type: "local", actor: "ops" }, ENV)).toMatchObject({ ok: false, error: "invalid_number" });
    expect(await attachPortedNumber(h as any, api, { phone_number: "+14035550188", number_type: "fax", actor: "ops" }, ENV)).toMatchObject({ ok: false, error: "invalid_number_type" });
    expect(await attachPortedNumber(h as any, api, { phone_number: "+14035550188", number_type: "local", user_id: "u-gone", actor: "ops" }, ENV)).toMatchObject({ ok: false, error: "invalid_user" });
  });

  it("a plan change never releases a transferred number", async () => {
    await attachPortedNumber(h as any, fakeTwilio().api, { phone_number: "+14035550188", number_type: "local", user_id: "u-lee", actor: "ops" }, ENV);
    plan.plan = "starter"; // no direct lines on Starter
    clearPlanCache();
    const scheduled = await reconcileNumbers(h as any, { env: ENV });
    expect(scheduled).toContain("+14035550111"); // the Keystone direct line goes
    expect(scheduled).not.toContain("+14035550188"); // the brokerage's own number stays
  });

  it("the forwarding note says how to turn it off", () => {
    expect(forwardingOffNote("+14035550188", "+14035550111")).toMatch(/\*73.*##21#/);
  });
});

describe("routes", () => {
  const app = () => {
    const a = express();
    a.use(express.json({ limit: "10mb" }));
    a.use("/api/provision", provisionRoutes);
    a.use("/api/port-requests", portRequestsRoutes);
    return a;
  };
  const OPS = { KS_OPS_URL: "https://ops.example.test", KS_LICENSEE_ID: "22222222-2222-4222-8222-222222222222", KS_OPS_KEY: "ops-key-1234567890" };
  const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
    Object.assign(process.env, vars);
    try { await fn(); } finally { for (const k of Object.keys(vars)) delete process.env[k]; }
  };

  it("KS-Ops attaches finished transfers with the ops key", async () => {
    const t = fakeTwilio();
    setProvisionNumbersApiForTests(() => t.api);
    await withEnv({ ...ENV, KS_OPS_KEY: OPS.KS_OPS_KEY }, async () => {
      expect((await request(app()).post("/api/provision/ported-numbers").send({ numbers: [{}] })).status).toBe(401);
      const r = await request(app()).post("/api/provision/ported-numbers").set("X-KS-Ops-Key", OPS.KS_OPS_KEY)
        .send({ port_request_id: "pr-1", grace_days: 7, numbers: [{ phone_number: "+14035550188", number_type: "mobile", user_id: "u-sam" }, { phone_number: "+14035550199", number_type: "local" }] });
      expect(r.status).toBe(200);
      expect(r.body.results).toEqual([
        expect.objectContaining({ phone_number: "+14035550188", status: "attached", kind: "direct", released: "+14035550111" }),
        expect.objectContaining({ phone_number: "+14035550199", status: "failed", error: "not_in_account" }),
      ]);
    });
  });

  it("Admins only; relays a request with the temporary numbers worked out here, and never logs the account number or PIN", async () => {
    const sent: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
    setPortRequestsFetchForTests(async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return { ok: true, status: 201, json: async () => ({ ok: true, request: { id: "33333333-3333-4333-8333-333333333333", status: "draft" } }), text: async () => "" };
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await withEnv({ ...OPS, TWILIO_MAIN_LINE_NUMBER: "+14035550100" }, async () => {
      expect((await request(app()).get("/api/port-requests").set("Authorization", `Bearer ${token("Staff", "u-sam")}`)).status).toBe(403);
      const r = await request(app()).post("/api/port-requests").set("Authorization", `Bearer ${token("Admin")}`).send({
        carrier: "telus", account_number: "998877665", pin: "4321", account_name: "Acme Lending Inc.",
        service_address: { line1: "1 Test Way", city: "Calgary", region: "AB", postal_code: "T2P 1A1", country: "CA" },
        numbers: [{ phone_number: "403-555-0188", number_type: "mobile", user_id: "u-lee", temporary_number: "+19995550000" }],
        bill: { filename: "bill.pdf", content_type: "application/pdf", data_base64: Buffer.from("%PDF-1.4 test").toString("base64") },
      });
      expect(r.status).toBe(201);
      expect(sent[0].url).toBe("https://ops.example.test/api/licensees/22222222-2222-4222-8222-222222222222/port-requests");
      expect(sent[0].headers["X-KS-Ops-Key"]).toBe(OPS.KS_OPS_KEY);
      expect(sent[0].body.numbers[0]).toMatchObject({ phone_number: "+14035550188", user_id: "u-lee", assignee_name: "Lee Staff", temporary_number: "+14035550100" });
      expect(sent[0].body.requested_by).toMatchObject({ name: "Ana Admin", email: "ana@acme.example" });

      // A refusal from KS-Ops reaches the admin in KS-Ops's words, and the log has no account details.
      setPortRequestsFetchForTests(async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => JSON.stringify({ errors: { account_number: "Enter the account number from your bill." } }) }));
      const bad = await request(app()).post("/api/port-requests").set("Authorization", `Bearer ${token("Admin")}`).send({
        carrier: "telus", account_number: "998877665", pin: "4321", numbers: [{ phone_number: "4035550188", number_type: "mobile" }], bill: {},
      });
      expect(bad.status).toBe(400);
      expect(bad.body.errors.account_number).toMatch(/account number/);
      expect(JSON.stringify(errors.mock.calls)).not.toMatch(/998877665|4321/);
    });
  });

  it("refuses a team member who is not on the team, and says when the server is not linked to Keystone operations", async () => {
    const r1 = await request(app()).post("/api/port-requests").set("Authorization", `Bearer ${token("Admin")}`).send({ numbers: [{ phone_number: "4035550188", number_type: "local" }] });
    expect(r1.status).toBe(503);
    expect(r1.body.error).toBe("ops_not_configured");
    await withEnv(OPS, async () => {
      const r2 = await request(app()).post("/api/port-requests").set("Authorization", `Bearer ${token("Admin")}`).send({ numbers: [{ phone_number: "4035550188", number_type: "local", user_id: "u-nobody" }] });
      expect(r2.status).toBe(400);
      expect(r2.body.errors["numbers.0.user_id"]).toBeTruthy();
      const list = await request(app()).get("/api/port-requests").set("Authorization", `Bearer ${token("Admin")}`);
      expect(list.status).toBe(200);
    });
    const unlinked = await request(app()).get("/api/port-requests").set("Authorization", `Bearer ${token("Admin")}`);
    expect(unlinked.body).toMatchObject({ ops_ready: false, requests: [] });
    expect(unlinked.body.people.length).toBe(3);
  });

  it("signing passes the signer's address and browser to Keystone operations", async () => {
    const sent: any[] = [];
    setPortRequestsFetchForTests(async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "" }; });
    await withEnv(OPS, async () => {
      const id = "33333333-3333-4333-8333-333333333333";
      const r = await request(app()).post(`/api/port-requests/${id}/sign`).set("Authorization", `Bearer ${token("Admin")}`).set("User-Agent", "TestBrowser/1")
        .set("X-Forwarded-For", "203.0.113.9").send({ signer_name: "Ana Admin", signer_title: "Owner", agree: true, sha256: "a".repeat(64) });
      expect(r.status).toBe(200);
      expect(sent[0].url).toMatch(new RegExp(`/port-requests/${id}/sign$`));
      expect(sent[0].body).toMatchObject({ signer_name: "Ana Admin", signer_email: "ana@acme.example", ip: "203.0.113.9", user_agent: "TestBrowser/1" });
      expect((await request(app()).get("/api/port-requests/not-an-id/loa").set("Authorization", `Bearer ${token("Admin")}`)).status).toBe(404);
    });
  });
});
