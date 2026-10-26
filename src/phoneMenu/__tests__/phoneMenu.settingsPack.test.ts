// KS_SETTINGS_PACK_v1_PHONE_MENU - the Admin-edited phone menu: the rules, the Settings API and what callers hear.
// The database fake answers by SQL content (not call order).
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import twilio from "twilio";
import { answerBySql, callsMatching, type SqlRule } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: h.query }, db: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  return { ...actual, pool: { query: h.query }, db: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("twilio", async () => await vi.importActual<typeof import("twilio")>("twilio"));

import { defaultMenu, matchSpeech, officeOpen, staleUserIds, validateMenu, type PhoneMenu } from "../menu.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const AUDIO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const users = [
  { id: A, first_name: "Jane", last_name: "Smith", role: "Admin" },
  { id: B, first_name: "Raj", last_name: "Patel", role: "Staff" },
];
const week = (ranges: Array<[string, string]>) => ({ sun: [], mon: ranges, tue: ranges, wed: ranges, thu: ranges, fri: ranges, sat: [] });

function menu(over: Partial<PhoneMenu> = {}): PhoneMenu {
  return {
    greeting: { mode: "tts", text: "Thank you for calling Acme Capital.", audioId: null },
    announceOptions: true,
    hours: { enabled: false, weekly: week([["09:00", "17:00"]]) },
    afterHoursGreeting: { mode: "tts", text: "We're closed.", audioId: null },
    afterHours: { type: "voicemail", userId: null },
    options: [
      { digit: "1", label: "sales", keywords: ["apply", "loan"], target: { type: "group", userIds: [A, B], strategy: "simultaneous" } },
      { digit: "2", label: "Raj Patel", keywords: ["raj"], target: { type: "user", userId: B } },
      { digit: "3", label: "the order desk", keywords: [], target: { type: "group", userIds: [A, B], strategy: "sequential" } },
      { digit: "4", label: "our assistant", keywords: [], target: { type: "ai" } },
      { digit: "5", label: "voicemail", keywords: [], target: { type: "voicemail", userId: A } },
    ],
    noAnswer: { ringSeconds: 20, target: { type: "voicemail", userId: null } },
    holidays: [],
    ...over,
  };
}

describe("the menu rules", () => {
  it("the default menu is built from the brokerage's own users, never fixed names", () => {
    const m = defaultMenu("Acme Capital", users);
    expect(m.greeting.text).toBe("Thank you for calling Acme Capital.");
    expect(m.options.map((o) => [o.digit, o.label, o.target.type])).toEqual([
      ["1", "the next available person", "group"], ["2", "Jane Smith", "user"], ["3", "Raj Patel", "user"],
    ]);
    expect(defaultMenu("Acme", [users[0]!]).options).toHaveLength(1);
    expect(defaultMenu("Acme", []).options).toEqual([]);
    expect(JSON.stringify(m)).not.toMatch(/Todd|Andrew|Boreal|Risk Management|underwriting/i);
  });

  it("validates keys, labels, people, recordings, hours and holidays", () => {
    const ok = validateMenu(menu(), { userIds: [A, B], audioIds: [] });
    expect(ok.ok).toBe(true);
    const bad = validateMenu(menu({
      greeting: { mode: "audio", text: "", audioId: AUDIO },
      options: [
        { digit: "1", label: "", keywords: [], target: { type: "user", userId: C } },
        { digit: "1", label: "dup", keywords: [], target: { type: "group", userIds: [], strategy: "simultaneous" } },
      ],
      hours: { enabled: true, weekly: { ...week([["17:00", "09:00"]]) } },
      holidays: [{ date: "Christmas", name: "x" }],
      noAnswer: { ringSeconds: 5, target: { type: "meeting" } },
    }), { userIds: [A, B], audioIds: [] });
    expect(bad.ok).toBe(false);
    const errors = (bad as { errors: Record<string, string> }).errors;
    expect(Object.keys(errors).sort()).toEqual([
      "greeting.audioId", "holidays.0", "hours.fri", "hours.mon", "hours.thu", "hours.tue", "hours.wed", "noAnswer.ringSeconds",
      "noAnswer.target", "options.0.label", "options.0.target", "options.1.digit", "options.1.target",
    ].sort());
    expect(validateMenu(menu({ greeting: { mode: "audio", text: "", audioId: AUDIO } }), { userIds: [A, B], audioIds: [AUDIO] }).ok).toBe(true);
  });

  it("knows when the office is open, in the brokerage's zone, with holidays", () => {
    const m = menu({ hours: { enabled: true, weekly: week([["09:00", "17:00"]]) }, holidays: [{ date: "2026-12-25", name: "Christmas Day" }] });
    // Edmonton default: UTC-6 all year.
    expect(officeOpen(m, new Date("2026-12-07T15:30:00Z")).open).toBe(true); // Mon 09:30
    expect(officeOpen(m, new Date("2026-12-07T14:30:00Z")).open).toBe(false); // Mon 08:30
    expect(officeOpen(m, new Date("2026-12-12T18:00:00Z")).open).toBe(false); // Saturday
    expect(officeOpen(m, new Date("2026-12-25T18:00:00Z"))).toEqual({ open: false, holiday: "Christmas Day" });
    // Hours switched off: always open, except holidays.
    expect(officeOpen({ ...m, hours: { ...m.hours, enabled: false } }, new Date("2026-12-12T18:00:00Z")).open).toBe(true);
    expect(officeOpen({ ...m, hours: { ...m.hours, enabled: false } }, new Date("2026-12-25T18:00:00Z")).open).toBe(false);
  });

  it("routes spoken answers by keyword, label or number, and refuses a guess", () => {
    const m = menu();
    expect(matchSpeech(m, "I'd like to apply for a loan")?.digit).toBe("1");
    expect(matchSpeech(m, "Raj please")?.digit).toBe("2");
    expect(matchSpeech(m, "option two")?.digit).toBe("2");
    expect(matchSpeech(m, "the order desk")?.digit).toBe("3");
    expect(matchSpeech(m, "hello")).toBeNull();
  });

  it("flags people the menu still rings who are no longer active", () => {
    expect(staleUserIds(menu(), new Set([A]))).toEqual([B]);
  });
});

// ------------------------------------------------------------------ the Settings API
const token = (role: string, id = A) => jwt.sign({ sub: id, id, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
let saved: PhoneMenu | null;
let audits: Array<{ type: unknown; meta: unknown }>;
function apiDb(extra: SqlRule[] = []) {
  h.query.mockImplementation(answerBySql([
    ...extra,
    [/FROM users\s+WHERE id = \$1|FROM users WHERE id/, (_s: string, p?: unknown[]) => ({ rows: [{ id: p?.[0], role: p?.[0] === A ? "Admin" : "Staff", active: true, status: "ACTIVE", token_version: 0, disabled: false }] })],
    [/FROM users\s+WHERE COALESCE\(active, true\)/, { rows: users }],
    [/SELECT config, updated_at FROM phone_menu_config/, () => ({ rows: saved ? [{ config: saved, updated_at: new Date() }] : [] })],
    [/INSERT INTO phone_menu_config/, (_s: string, p?: unknown[]) => { saved = JSON.parse(String(p?.[0])); return { rows: [] }; }],
    [/DELETE FROM phone_menu_config/, () => { saved = null; return { rows: [] }; }],
    [/FROM phone_menu_audio ORDER BY/, { rows: [{ id: AUDIO, file_name: "hello.mp3", content_type: "audio/mpeg", size_bytes: 10, created_at: new Date() }] }],
    [/INSERT INTO phone_menu_audio/, (_s: string, p?: unknown[]) => ({ rows: [{ id: AUDIO, file_name: p?.[0], content_type: p?.[1], size_bytes: p?.[2], created_at: new Date() }] })],
    [/DELETE FROM phone_menu_audio/, { rows: [{ id: AUDIO }] }],
    [/insert into audit_events/i, (_s: string, p?: unknown[]) => { audits.push({ type: p?.[4], meta: p?.[10] }); return { rows: [] }; }],
  ]));
}
async function api() {
  const router = (await import("../../routes/phoneMenu.js")).default;
  const a = express();
  a.use(express.json());
  a.use("/api/phone-menu", router);
  return a;
}

describe("Settings > Phone menu API", () => {
  beforeEach(() => { h.query.mockReset(); saved = null; audits = []; apiDb(); });

  it("is Admin only", async () => {
    const res = await request(await api()).get("/api/phone-menu").set("Authorization", `Bearer ${token("Staff", B)}`);
    expect([401, 403]).toContain(res.status);
  });

  it("shows the default menu built from the staff, then saves an edited one (audited)", async () => {
    const app = await api();
    const first = await request(app).get("/api/phone-menu").set("Authorization", `Bearer ${token("Admin")}`);
    expect(first.status).toBe(200);
    expect(first.body.is_default).toBe(true);
    expect(first.body.users.map((u: any) => u.name)).toEqual(["Jane Smith", "Raj Patel"]);
    expect(first.body.time_zone).toBe("America/Edmonton");

    const bad = await request(app).put("/api/phone-menu").set("Authorization", `Bearer ${token("Admin")}`)
      .send({ menu: menu({ options: [{ digit: "1", label: "x", keywords: [], target: { type: "user", userId: C } }] }) });
    expect(bad.status).toBe(400);
    expect(bad.body.errors["options.0.target"]).toBeTruthy();

    const put = await request(app).put("/api/phone-menu").set("Authorization", `Bearer ${token("Admin")}`).send({ menu: menu() });
    expect(put.status).toBe(200);
    expect(put.body.spoken_greeting).toContain("For sales, press 1. For Raj Patel, press 2.");
    expect(saved?.options).toHaveLength(5);
    expect(audits.map((a) => a.type)).toContain("phone_menu.updated");

    const reset = await request(app).post("/api/phone-menu/reset").set("Authorization", `Bearer ${token("Admin")}`);
    expect(reset.body.is_default).toBe(true);
    expect(saved).toBeNull();
    expect(audits.map((a) => a.type)).toContain("phone_menu.reset");
  });

  it("takes MP3/WAV recordings only, and will not delete one the menu still plays", async () => {
    const app = await api();
    const wav = Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVEfmt "), Buffer.alloc(32)]);
    const ok = await request(app).post("/api/phone-menu/audio").set("Authorization", `Bearer ${token("Admin")}`)
      .attach("file", wav, { filename: "greeting.wav", contentType: "audio/wav" });
    expect(ok.status).toBe(201);
    expect(audits.map((a) => a.type)).toContain("phone_menu.audio_uploaded");
    const fake = await request(app).post("/api/phone-menu/audio").set("Authorization", `Bearer ${token("Admin")}`)
      .attach("file", Buffer.from("<html>not audio</html>"), { filename: "x.mp3", contentType: "audio/mpeg" });
    expect(fake.status).toBe(400);
    saved = menu({ greeting: { mode: "audio", text: "", audioId: AUDIO } });
    const inUse = await request(app).delete(`/api/phone-menu/audio/${AUDIO}`).set("Authorization", `Bearer ${token("Admin")}`);
    expect(inUse.status).toBe(409);
    saved = menu();
    const gone = await request(app).delete(`/api/phone-menu/audio/${AUDIO}`).set("Authorization", `Bearer ${token("Admin")}`);
    expect(gone.status).toBe(200);
  });
});

// ------------------------------------------------------------------ what callers hear
const BASE = "/api/webhooks/twilio/reception";
function callDb(m: PhoneMenu, extra: SqlRule[] = []) {
  h.query.mockImplementation(answerBySql([
    ...extra,
    [/FROM phone_menu_config/, { rows: [{ config: m, updated_at: null }] }],
    [/WHERE u\.id::text = ANY\(\$1::text\[\]\)/, { rows: [{ user_id: A, twilio_identity: "jane-app" }, { user_id: B, twilio_identity: "raj-app" }] }],
    [/SELECT sp\.twilio_identity, u\.first_name FROM users u LEFT JOIN staff_presence/, { rows: [{ twilio_identity: "raj-app", first_name: "Raj" }] }],
  ]));
}
async function call(path: string, params: Record<string, string> = {}) {
  const router = (await import("../../routes/reception.js")).default;
  const a = express();
  a.use(BASE, router);
  const full = BASE + path;
  const res = await request(a).post(full).type("form").set("X-Forwarded-Host", "example.com").set("X-Forwarded-Proto", "https")
    .set("X-Twilio-Signature", twilio.getExpectedTwilioSignature(String(process.env.TWILIO_AUTH_TOKEN), "https://example.com" + full, params))
    .send(params);
  expect(res.status).toBe(200);
  return res.text;
}

describe("callers", () => {
  beforeEach(() => { h.query.mockReset(); });

  it("hear the greeting and the options; an uploaded recording is played instead of read", async () => {
    callDb(menu());
    const xml = await call("/greeting");
    expect(xml).toContain("Thank you for calling Acme Capital. For sales, press 1. For Raj Patel, press 2.");
    callDb(menu({ greeting: { mode: "audio", text: "", audioId: AUDIO } }));
    const rec = await call("/greeting");
    expect(rec).toContain(`<Play>${BASE}/audio/${AUDIO}</Play>`);
    expect(rec).not.toContain("Thank you for calling Acme Capital.");
  });

  it("after hours or on a holiday hear the after-hours greeting and reach the after-hours choice", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-25T18:00:00Z"));
    try {
      callDb(menu({ holidays: [{ date: "2026-12-25", name: "Christmas Day" }] }));
      const xml = await call("/greeting", { From: "+15875550142" });
      expect(xml).toContain("We're closed.");
      expect(xml).toContain('<Record maxLength="120" playBeep="true" action="/api/webhooks/twilio/voicemail"/>');
      expect(xml).not.toContain("<Gather");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a group rings everyone at once, and nobody answering runs the no-answer fallback", async () => {
    callDb(menu());
    const xml = await call("/choice", { Digits: "1", From: "+15875550142", CallSid: "CA1" });
    expect(xml).toMatch(/<Client[^>]*>jane-app<\/Client>/);
    expect(xml).toMatch(/<Client[^>]*>raj-app<\/Client>/);
    expect(xml).toContain('timeout="20"');
    expect(xml).toContain(`action="${BASE}/no-answer?ref=opt%3A1"`);
    const after = await call("/no-answer?ref=opt%3A1", { DialCallStatus: "no-answer", From: "+15875550142" });
    expect(after).toContain('action="/api/webhooks/twilio/voicemail"');
    const answered = await call("/no-answer?ref=opt%3A1", { DialCallStatus: "completed" });
    expect(answered).toContain("<Hangup/>");
  });

  it("a one-at-a-time group rings each person in turn, then the fallback", async () => {
    callDb(menu());
    const first = await call("/choice", { Digits: "3", From: "+15875550142" });
    expect(first).toMatch(/<Client[^>]*>jane-app<\/Client>/);
    expect(first).not.toContain("raj-app");
    expect(first).toContain(`group-next?ref=opt%3A3&amp;after=${A}`);
    const second = await call(`/group-next?ref=opt%3A3&after=${A}`, { DialCallStatus: "no-answer", From: "+15875550142" });
    expect(second).toMatch(/<Client[^>]*>raj-app<\/Client>/);
    expect(second).toContain(`after=${B}`);
    const last = await call(`/group-next?ref=opt%3A3&after=${B}`, { DialCallStatus: "no-answer", From: "+15875550142" });
    expect(last).toContain("<Record");
  });

  it("a voicemail option records into that person's private voicemail", async () => {
    callDb(menu());
    const xml = await call("/choice", { Digits: "5", From: "+15875550142" });
    expect(xml).toContain(`action="/api/webhooks/twilio/voicemail?staff=${A}"`);
  });

  it("the AI receptionist asks what the call is about and routes by the answer, else takes a message", async () => {
    delete process.env.OPENAI_API_KEY;
    callDb(menu());
    const ask = await call("/choice", { Digits: "4" });
    expect(ask).toContain('input="speech"');
    expect(ask).toContain(`action="${BASE}/ai?ref=opt%3A4"`);
    const routed = await call("/ai?ref=opt%3A4", { SpeechResult: "I want to apply for a loan", From: "+15875550142" });
    expect(routed).toMatch(/<Client[^>]*>jane-app<\/Client>/);
    const message = await call("/ai?ref=opt%3A4", { SpeechResult: "something else entirely", From: "+15875550142" });
    expect(message).toContain("Let me take a message");
    expect(message).toContain("<Record");
  });

  it("an unclear answer gets one more go, then the no-answer fallback; spoken words work too", async () => {
    callDb(menu());
    const first = await call("/choice", { Digits: "9" });
    expect(first).toContain(`${BASE}/greeting?again=1`);
    const again = await call("/greeting?again=1");
    expect(again).toContain("For sales, press 1.");
    expect(again).not.toContain("Thank you for calling Acme Capital.");
    const second = await call("/choice?again=1", { Digits: "9" });
    expect(second).toContain("<Record");
    const spoken = await call("/choice", { SpeechResult: "Raj please", From: "+15875550142" });
    expect(spoken).toContain(`direct-unavailable?user=${B}&amp;menu=1`);
  });

  it("serves an uploaded recording to Twilio", async () => {
    h.query.mockImplementation(answerBySql([[/FROM phone_menu_audio WHERE id::text = \$1/, { rows: [{ content_type: "audio/mpeg", bytes: Buffer.from("ID3abc") }] }]]));
    const router = (await import("../../routes/reception.js")).default;
    const a = express();
    a.use(BASE, router);
    const res = await request(a).get(`${BASE}/audio/${AUDIO}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("audio/mpeg");
    expect(callsMatching(h.query, /FROM phone_menu_audio/)[0]![1]).toEqual([AUDIO]);
  });
});
