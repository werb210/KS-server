// KS_WHATSAPP_v1 - WhatsApp on the client conversation: the 24-hour window, templates, inbound filing.
import { describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { sendWhatsApp, toE164, whatsappFrom, windowState } from "../whatsapp/whatsapp.js";

const NOW = new Date("2026-11-04T18:00:00Z");
const client = () => ({ messages: { create: vi.fn(async () => ({ sid: "SM123", status: "queued" })) } });
const db = (lastIn: string | null) => ({ query: vi.fn(answerBySql([
  [/max\(created_at\)/, { rows: [{ at: lastIn }] }],
  [/INSERT INTO communications_messages/, { rows: [{ id: "m1", created_at: NOW }] }],
])) });

describe("helpers", () => {
  it("normalises numbers and the sender", () => {
    expect(toE164("(780) 555-0100")).toBe("+17805550100");
    expect(toE164("whatsapp:+447700900123")).toBe("+447700900123");
    expect(toE164("123")).toBeNull();
    expect(whatsappFrom({ TWILIO_WHATSAPP_FROM: "+1 825 555 0100" } as any)).toBe("whatsapp:+18255550100");
    expect(whatsappFrom({} as any)).toBeNull();
  });
  it("opens the window for 24 hours after the client's last message", () => {
    expect(windowState(new Date("2026-11-04T00:00:00Z"), NOW).open).toBe(true);
    expect(windowState(new Date("2026-11-03T17:00:00Z"), NOW).open).toBe(false);
    expect(windowState(null, NOW)).toEqual({ open: false, closesAt: null, lastInboundAt: null });
  });
});

describe("sending", () => {
  it("sends free text inside the window and files it as WhatsApp", async () => {
    const d = db("2026-11-04T10:00:00Z"); const c = client();
    const r = await sendWhatsApp(d, c, { to: "7805550100", contactId: null, body: "Hi Pat", silo: "BF" }, { from: "whatsapp:+18255550100", now: NOW });
    expect(r.sid).toBe("SM123");
    expect(c.messages.create).toHaveBeenCalledWith({ from: "whatsapp:+18255550100", to: "whatsapp:+17805550100", body: "Hi Pat" });
    const ins = callsMatching(d.query, /INSERT INTO communications_messages/)[0];
    expect(String(ins[0])).toContain("'whatsapp', 'whatsapp', 'outbound'");
    expect((ins[1] as unknown[])[3]).toBe("+18255550100");
  });
  it("refuses free text outside the window but allows a template", async () => {
    const c = client();
    await expect(sendWhatsApp(db(null), c, { to: "7805550100", contactId: null, body: "Hi", silo: "BF" }, { from: "whatsapp:+18255550100", now: NOW }))
      .rejects.toMatchObject({ code: "window_closed", status: 409 });
    expect(c.messages.create).not.toHaveBeenCalled();
    const sid = "HX" + "a".repeat(32);
    await sendWhatsApp(db(null), c, { to: "7805550100", contactId: null, contentSid: sid, contentVariables: { "1": "Pat" }, silo: "BF" }, { from: "whatsapp:+18255550100", now: NOW });
    expect(c.messages.create).toHaveBeenCalledWith({ from: "whatsapp:+18255550100", to: "whatsapp:+17805550100", contentSid: sid, contentVariables: '{"1":"Pat"}' });
  });
  it("says so when WhatsApp is not set up", async () => {
    await expect(sendWhatsApp(db(null), client(), { to: "7805550100", contactId: null, body: "x", silo: "BF" }, { from: null }))
      .rejects.toMatchObject({ code: "whatsapp_not_configured" });
  });
});

// Inbound: a WhatsApp message on the shared inbound address is filed as WhatsApp, with the plain number.
import request from "supertest";
const ih = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: ih.query }, dbQuery: ih.query, runQuery: ih.query }));
vi.mock("../middleware/twilioWebhookValidation.js", () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { twilioWebhookValidation: pass, validateTwilioWebhook: pass };
});
vi.mock("../voice/blockedNumbers.js", () => ({ ignoreBlockedText: async () => false }));

describe("inbound", () => {
  it("files whatsapp:+1... as a WhatsApp message from the plain number", async () => {
    ih.query.mockReset();
    ih.query.mockImplementation(answerBySql([[/WITH matched AS/, { rows: [{ id: "c1", silo: "BF", name: "Pat", primary_match: true }] }]]));
    const { mountRouter } = await import("./helpers/staffRouterApp.js");
    const app = mountRouter((await import("../routes/webhooks.js")).default, "/api/webhooks");
    const res = await request(app).post("/api/webhooks/twilio/sms").type("form")
      .send({ From: "whatsapp:+17805550100", To: "whatsapp:+18255550100", Body: "Hello", MessageSid: "SMwa1" });
    expect(res.status).toBe(200);
    const ins = callsMatching(ih.query, /INSERT INTO communications_messages/)[0];
    expect(ins).toBeTruthy();
    const p = ins[1] as unknown[];
    expect(p[3]).toBe("+17805550100");
    expect(p[4]).toBe("+18255550100");
    expect(p[7]).toBe("whatsapp");
  });
});
