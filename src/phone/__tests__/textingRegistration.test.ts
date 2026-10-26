// KS_SERVER_TEXTING_REGISTRATION - the texting status Keystone operations pushes, where texts to US mobiles go from
// (the brokerage's own approved toll-free line), why they wait until approval, and the address / bundle KS-Ops
// registered being used for purchases. The database is answered by SQL content; Twilio is never called.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn(), regs: [] as any[], comp: [] as any[], create: vi.fn() }));
vi.mock("../../db.js", () => ({ pool: { query: h.query }, db: { query: h.query } }));
vi.mock("../../services/twilio.js", () => ({ fetchTwilioClient: () => ({ messages: { create: h.create } }) }));

import { addressSidFor, bundleSidFor, loadTextingState, saveCompliance, saveTexting, setTextingSnapshotForTests, textingMessages } from "../textingState.js";
import { smsFromFor, usTextingHold, UsTextingPendingError } from "../../lib/smsFrom.js";
import { setupStatus } from "../numbers.js";
import provisionRoutes from "../../routes/provision.js";
import { sendSms } from "../../modules/notifications/sms.service.js";
import { config } from "../../config/index.js";

const US = "+12125550100";
const CA = "+14035550100";
const TF = "+18885550111";

function db() {
  h.query.mockImplementation(answerBySql([
    [/INSERT INTO texting_registrations/, (_s: string, p?: unknown[]) => {
      const [kind, status, phone_number, reason, message] = p as any[];
      h.regs = [...h.regs.filter((r) => r.kind !== kind), { kind, status, phone_number, reason, message, updated_at: new Date() }];
      return { rows: [], rowCount: 1 };
    }],
    [/FROM texting_registrations/, () => ({ rows: h.regs })],
    [/INSERT INTO twilio_compliance/, (_s: string, p?: unknown[]) => {
      const [address_sid, bundle_sid] = p as any[];
      const cur = h.comp[0] ?? {};
      h.comp = [{ address_sid: address_sid ?? cur.address_sid ?? null, bundle_sid: bundle_sid ?? cur.bundle_sid ?? null }];
      return { rows: [], rowCount: 1 };
    }],
    [/FROM twilio_compliance/, () => ({ rows: h.comp })],
  ]));
  return { query: h.query } as any;
}

beforeEach(() => { h.query.mockReset(); h.regs = []; h.comp = []; setTextingSnapshotForTests(null); });
afterEach(() => { setTextingSnapshotForTests(null); delete process.env.TWILIO_US_SMS_FROM; vi.restoreAllMocks(); });

describe("US texts", () => {
  it("a copy KS-Ops never pushed a status to keeps the old behaviour (nothing held, TWILIO_US_SMS_FROM still used)", () => {
    process.env.TWILIO_US_SMS_FROM = "+12125550199";
    expect(usTextingHold(US)).toBeNull();
    expect(smsFromFor(US, "+14035550100")).toBe("+12125550199");
  });

  it("go from the brokerage's own approved toll-free line, not TWILIO_US_SMS_FROM", () => {
    process.env.TWILIO_US_SMS_FROM = "+12125550199";
    setTextingSnapshotForTests({ registrations: {
      toll_free: { kind: "toll_free", status: "approved", phone_number: TF, reason: null, message: null },
      a2p_10dlc: { kind: "a2p_10dlc", status: "not_needed", phone_number: CA, reason: null, message: null },
    } });
    expect(usTextingHold(US)).toBeNull();
    expect(smsFromFor(US, CA)).toBe(TF);
    // Canadian mobiles keep the business line.
    expect(smsFromFor("+15875550123", CA)).toBe(CA);
  });

  it("wait while the carriers review, with a plain reason; Canadian mobiles are never held", () => {
    setTextingSnapshotForTests({ registrations: { toll_free: { kind: "toll_free", status: "pending", phone_number: TF, reason: null, message: null } } });
    expect(usTextingHold(US)).toBe("Texts to US mobiles wait until the carriers approve your texting registration (usually 3-10 business days). Canadian mobiles get texts now.");
    expect(usTextingHold(CA)).toBeNull();
    expect(smsFromFor(US, CA)).toBe(CA);
  });

  it("a registered US business line (A2P 10DLC approved) texts US mobiles itself", () => {
    setTextingSnapshotForTests({ registrations: {
      toll_free: { kind: "toll_free", status: "not_needed", phone_number: null, reason: null, message: null },
      a2p_10dlc: { kind: "a2p_10dlc", status: "approved", phone_number: US, reason: null, message: null },
    } });
    expect(usTextingHold("+13105550100")).toBeNull();
    expect(smsFromFor("+13105550100", US)).toBe(US);
  });

  it("Starter without a toll-free line, and a rejected registration, explain why", () => {
    setTextingSnapshotForTests({ registrations: { toll_free: { kind: "toll_free", status: "not_needed", phone_number: null, reason: null, message: null } } });
    expect(usTextingHold(US)).toMatch(/need an approved toll-free line \(Growth and Pro plans\)/);
    setTextingSnapshotForTests({ registrations: { toll_free: { kind: "toll_free", status: "rejected", phone_number: TF, reason: "x", message: null } } });
    expect(usTextingHold(US)).toMatch(/not approved\. Keystone support has been told/);
  });

  it("the notification sender refuses a held text without calling Twilio", async () => {
    setTextingSnapshotForTests({ registrations: { toll_free: { kind: "toll_free", status: "pending", phone_number: TF, reason: null, message: null } } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const prev = config.app.testMode;
    (config.app as any).testMode = "false";
    try {
      await expect(sendSms({ to: "+12127364100", message: "hi" })).rejects.toBeInstanceOf(UsTextingPendingError);
    } finally {
      (config.app as any).testMode = prev;
    }
    expect(h.create).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[sms] US text held until texting registration is approved", expect.anything());
  });
});

describe("status from Keystone operations", () => {
  it("is validated, stored, and shown in plain English on Settings > Phone lines", async () => {
    const q = db();
    expect(await saveTexting(q, { registrations: [{ kind: "sms", status: "pending" }] }, "ops")).toMatchObject({ ok: false, error: "invalid_kind" });
    expect(await saveTexting(q, { registrations: [{ kind: "toll_free", status: "maybe" }] }, "ops")).toMatchObject({ ok: false, error: "invalid_status" });
    expect(await saveTexting(q, { registrations: [{ kind: "toll_free", status: "pending", phone_number: "888" }] }, "ops")).toMatchObject({ ok: false, error: "invalid_phone_number" });
    const msg = "Texting from your toll-free line +18885550111: approval pending with carriers (usually 3-10 business days). Until then, texts to US mobiles wait; Canadian mobiles get texts from your business line.";
    const r = await saveTexting(q, { registrations: [{ kind: "toll_free", status: "pending", phone_number: TF, message: msg }, { kind: "a2p_10dlc", status: "not_needed", phone_number: CA, message: "Your business line is Canadian." }] }, "ks-ops texting");
    expect(r.ok).toBe(true);
    expect(textingMessages()).toEqual([msg, "Your business line is Canadian."]);
    expect(setupStatus({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", KS_SERVER_URL: "https://ks-x.azurewebsites.net" }).messages).toContain(msg);
    expect(usTextingHold(US)).toMatch(/wait until the carriers approve/);
    // Approval arrives: the next push frees US texts.
    await saveTexting(q, { registrations: [{ kind: "toll_free", status: "approved", phone_number: TF }] }, "ks-ops texting");
    expect(smsFromFor(US, CA)).toBe(TF);
    // Another instance loads the same state from the database.
    setTextingSnapshotForTests(null);
    await loadTextingState(q);
    expect(smsFromFor(US, CA)).toBe(TF);
  });

  it("a database failure keeps the last state and is logged", async () => {
    setTextingSnapshotForTests({ registrations: { toll_free: { kind: "toll_free", status: "approved", phone_number: TF, reason: null, message: null } } });
    h.query.mockRejectedValue(new Error("connection reset"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await loadTextingState({ query: h.query } as any);
    expect(smsFromFor(US, CA)).toBe(TF);
    expect(err).toHaveBeenCalledWith("[texting] registration state not loaded; keeping the last one", { message: "connection reset" });
  });

  it("the address and bundle KS-Ops registered are used for purchases unless the App Service sets its own", async () => {
    const q = db();
    expect(await saveCompliance(q, { address_sid: "AD123" }, "ops")).toEqual({ ok: false, error: "invalid_address_sid" });
    const ad = `AD${"a".repeat(32)}`;
    const bu = `BU${"b".repeat(32)}`;
    expect(await saveCompliance(q, { address_sid: ad }, "ops")).toEqual({ ok: true });
    expect(await saveCompliance(q, { bundle_sid: bu }, "ops")).toEqual({ ok: true });
    expect(addressSidFor({})).toBe(ad);
    expect(bundleSidFor({})).toBe(bu);
    expect(addressSidFor({ TWILIO_ADDRESS_SID: "ADenv" })).toBe("ADenv");
    expect(setupStatus({}).address_sid).toBe(true);
  });

  it("PUT /api/provision/texting needs the ops key", async () => {
    db();
    process.env.KS_OPS_KEY = "ops-key-1234567890";
    try {
      const app = express().use(express.json()).use("/api/provision", provisionRoutes);
      const body = { registrations: [{ kind: "toll_free", status: "pending", phone_number: TF }] };
      expect((await request(app).put("/api/provision/texting").send(body)).status).toBe(401);
      const r = await request(app).put("/api/provision/texting").set("X-KS-Ops-Key", "ops-key-1234567890").set("X-KS-Ops-User", "ks-ops texting").send(body);
      expect(r.status).toBe(200);
      expect(callsMatching(h.query, /INSERT INTO texting_registrations/)[0]![1]).toEqual(["toll_free", "pending", TF, null, null, "ks-ops ks-ops texting"]);
      const bad = await request(app).put("/api/provision/texting").set("X-KS-Ops-Key", "ops-key-1234567890").send({ registrations: [] });
      expect(bad.status).toBe(400);
    } finally {
      delete process.env.KS_OPS_KEY;
    }
  });
});
