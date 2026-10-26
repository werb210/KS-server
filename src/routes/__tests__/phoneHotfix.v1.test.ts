// BF_SERVER_PHONE_HOTFIX_v1
import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import twilio from "twilio";
import { answerBySql, callsMatching, sqlText } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  callLogStaff: "u-from-call-log" as string | null,
  enrich: vi.fn(async () => undefined),
}));
vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("twilio", async () => await vi.importActual<typeof import("twilio")>("twilio"));
vi.mock("../../modules/calls/calls.repo.js", async (orig) => ({
  ...(await orig<typeof import("../../modules/calls/calls.repo.js")>()),
  findCallLogByTwilioSid: vi.fn(async () => (h.callLogStaff ? { staff_user_id: h.callLogStaff } : null)),
}));
vi.mock("../../modules/voice/voicemailEnrich.service.js", () => ({ enrichAndDistributeVoicemail: h.enrich }));

const TODD = "11111111-1111-4111-8111-111111111111";
const ANDREW = "22222222-2222-4222-8222-222222222222";

// Twilio signs every webhook; requests here are signed with the real library.
async function signedPost(mount: string, modPath: string, path: string, params: Record<string, string>) {
  const router = (await import(modPath)).default;
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(mount, router);
  const full = mount + path;
  return request(app).post(full).type("form").set("X-Forwarded-Host", "example.com").set("X-Forwarded-Proto", "https")
    .set("X-Twilio-Signature", twilio.getExpectedTwilioSignature(String(process.env.TWILIO_AUTH_TOKEN), "https://example.com" + full, params))
    .send(params);
}

// KS_SETTINGS_PACK_v1_PHONE_MENU - the brokerage's menu: 1 rings a group, 2 rings one person.
const MENU = { greeting: { mode: "tts", text: "Thank you for calling.", audioId: null }, announceOptions: true,
  hours: { enabled: false, weekly: { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] } },
  afterHoursGreeting: { mode: "tts", text: "Closed.", audioId: null }, afterHours: { type: "voicemail", userId: null },
  options: [{ digit: "1", label: "sales", keywords: [], target: { type: "group", userIds: [TODD, ANDREW], strategy: "simultaneous" } },
    { digit: "2", label: "credit", keywords: [], target: { type: "user", userId: ANDREW } }],
  noAnswer: { ringSeconds: 25, target: { type: "voicemail", userId: null } }, holidays: [] };
function staff(ringable = true) {
  h.query.mockImplementation(answerBySql([
    [/FROM phone_menu_config/, { rows: [{ config: MENU, updated_at: null }] }],
    [/WHERE u\.id::text = ANY\(\$1::text\[\]\)/, { rows: ringable ? [{ user_id: TODD, twilio_identity: "todd-client" }, { user_id: ANDREW, twilio_identity: "andrew-client" }] : [] }],
    [/SELECT sp\.twilio_identity, u\.first_name FROM users u LEFT JOIN staff_presence/, { rows: [{ twilio_identity: "andrew-client", first_name: "Andrew" }] }],
  ]));
}

beforeEach(() => { h.query.mockReset(); h.callLogStaff = "u-from-call-log"; h.enrich.mockClear(); });

describe("phone hotfix", () => {
  it("voicemail list shows directed AND general (null-owner) voicemails", async () => {
    h.query.mockImplementation(answerBySql([[/FROM voicemails v/, { rows: [{ id: "vm-1" }, { id: "vm-2" }] }]]));
    const router = (await import("../crm/voicemails.js")).default;
    const app = express();
    app.use((req: any, _res, next) => { req.user = { userId: TODD, role: "Staff", silo: "BF" }; next(); });
    app.use("/api/crm/voicemails", router);
    const res = await request(app).get("/api/crm/voicemails");
    expect(res.status).toBe(200);
    const [sql, params] = callsMatching(h.query, /FROM voicemails v/)[0]!;
    expect(sqlText(sql)).toContain("v.staff_user_id = $2 OR v.staff_user_id IS NULL");
    expect(params).toEqual(["BF", TODD]);
  });

  it("reception forwards the real caller id, not the business line", async () => {
    staff();
    const withCaller = await signedPost("/api/webhooks/twilio/reception", "../reception.js", "/choice", { Digits: "1", From: "+15875550142" });
    expect(withCaller.status).toBe(200);
    expect(withCaller.text).toContain('callerId="+15875550142"');
    expect(withCaller.text).toContain(">andrew-client</Client>");

    const anonymous = await signedPost("/api/webhooks/twilio/reception", "../reception.js", "/choice", { Digits: "1" });
    const { config } = await import("../../config/index.js");
    const fallback = config.twilio.callerId || config.twilio.from || config.twilio.number;
    if (fallback) expect(anonymous.text).toContain(`callerId="${fallback}"`);
    else expect(anonymous.text).not.toContain("callerId=");
  });

  it("reception stamps the voicemail with the person who was rung", async () => {
    // Nobody in the group can be rung: the menu's no-answer fallback (shared voicemail).
    staff(false);
    const res = await signedPost("/api/webhooks/twilio/reception", "../reception.js", "/choice", { Digits: "1", From: "+15875550142" });
    expect(res.text).toContain(`action="/api/webhooks/twilio/voicemail"`);

    // No answer after ringing one person: the voicemail goes to the person asked for.
    staff();
    const noAnswer = await signedPost("/api/webhooks/twilio/reception", "../reception.js", `/direct-unavailable?user=${ANDREW}&menu=1`, { DialCallStatus: "no-answer" });
    expect(noAnswer.text).toContain(`action="/api/webhooks/twilio/voicemail?staff=${ANDREW}"`);
  });

  it("voicemail webhook prefers the ?staff hint over the call_log lookup", async () => {
    h.query.mockImplementation(answerBySql([]));
    const params = { RecordingUrl: "https://api.twilio.com/rec/RE1", RecordingSid: "RE1", CallSid: "CA1", From: "+15875550142", RecordingDuration: "12" };
    const hinted = await signedPost("/api/webhooks", "../webhooks.js", `/twilio/voicemail?staff=${ANDREW}`, params);
    expect(hinted.status).toBe(200);
    expect((callsMatching(h.query, /INSERT INTO voicemails/)[0]![1] as unknown[])[5]).toBe(ANDREW);
    expect((h.enrich.mock.calls[0] as unknown as [any])[0].staffUserId).toBe(ANDREW);

    h.query.mockClear(); h.enrich.mockClear();
    await signedPost("/api/webhooks", "../webhooks.js", "/twilio/voicemail", params);
    expect((callsMatching(h.query, /INSERT INTO voicemails/)[0]![1] as unknown[])[5]).toBe("u-from-call-log");
  });
});
