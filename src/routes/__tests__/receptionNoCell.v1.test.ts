import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import twilio from "twilio";
import { answerBySql, callsMatching, sqlText, type SqlRule } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db");
  return { ...actual, pool: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("twilio", async () => await vi.importActual<typeof import("twilio")>("twilio"));

const PERSON = "22222222-2222-4222-8222-222222222222";
const DIRECT_OWNER = "33333333-3333-4333-8333-333333333333";
const CALLER = "+15875550142";
const WATCH_CELL_SQL = /WHERE u\.id::text = \$1\s+AND u\.callback_verified_at IS NOT NULL/;
const NAMED_RECIPIENTS = /AND id::text = ANY\(\$1::text\[\]\)/;
const BASE = "/api/webhooks/twilio/reception";

// KS_SETTINGS_PACK_v1_PHONE_MENU - the brokerage's menu: 1 rings one person; nobody answering goes to their voicemail.
const MENU = { greeting: { mode: "tts", text: "Thank you for calling.", audioId: null }, announceOptions: true,
  hours: { enabled: false, weekly: { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] } },
  afterHoursGreeting: { mode: "tts", text: "Closed.", audioId: null }, afterHours: { type: "voicemail", userId: null },
  options: [{ digit: "1", label: "credit", keywords: [], target: { type: "user", userId: PERSON } }],
  noAnswer: { ringSeconds: 25, target: { type: "voicemail", userId: null } }, holidays: [] };

// The person behind option 1, with or without a verified cell and the Watch opt-in.
function person(cell: string | null, extra: SqlRule[] = []) {
  h.query.mockImplementation(answerBySql([
    ...extra,
    [/FROM phone_menu_config/, { rows: [{ config: MENU, updated_at: null }] }],
    [/SELECT sp\.twilio_identity, u\.first_name FROM users u LEFT JOIN staff_presence/, { rows: [{ twilio_identity: "person-client", first_name: "Pat" }] }],
    [WATCH_CELL_SQL, { rows: cell ? [{ phone: cell }] : [] }],
  ]));
}

async function post(pathAndQuery: string, params: Record<string, string>) {
  const router = (await import("../reception.js")).default;
  const app = express();
  app.use(BASE, router);
  const full = `${BASE}${pathAndQuery}`;
  const res = await request(app).post(full).type("form").set("X-Forwarded-Host", "example.com").set("X-Forwarded-Proto", "https")
    .set("X-Twilio-Signature", twilio.getExpectedTwilioSignature(String(process.env.TWILIO_AUTH_TOKEN), "https://example.com" + full, params))
    .send(params);
  expect(res.status).toBe(200);
  return res.text;
}

const pressOne = () => post("/choice", { Digits: "1", From: CALLER });

beforeEach(() => { h.query.mockReset(); });

describe("a menu option that rings one person", () => {
  it("rings only their app (25 s) without the Watch fallback, even with a cell on file elsewhere", async () => {
    person(null);
    const xml = await pressOne();
    expect(xml).toMatch(/<Client[^>]*>person-client<\/Client>/);
    expect(xml).toContain('timeout="25"');
    expect(xml).not.toContain("<Number");
    expect(xml).toContain(`/direct-unavailable?user=${PERSON}&amp;menu=1`);
    expect(xml).not.toContain("cell=1");
  });

  // BF_SERVER_v820_WATCH_CALLS - app first, then the cell: sequential, never in the same <Dial>.
  it("with the Watch fallback on, rings the app first and hands the cell to the action callback", async () => {
    person("4035550100");
    const xml = await pressOne();
    expect(xml).toMatch(/<Client[^>]*>person-client<\/Client>/);
    expect(xml).toContain('timeout="22"');
    expect(xml).toContain(`/direct-unavailable?user=${PERSON}&amp;cell=1&amp;menu=1`);
    expect(xml).not.toContain("<Number");
  });

  it("an unanswered app leg then rings the verified cell with the press-1 screen, keeping the menu's fallback", async () => {
    person("4035550100");
    const xml = await post(`/direct-unavailable?user=${PERSON}&cell=1&menu=1`, { DialCallStatus: "no-answer", CallStatus: "in-progress", From: CALLER });
    expect(xml).toContain(`<Number url="${BASE}/screen?from=%2B15875550142" method="POST">+14035550100</Number>`);
    expect(xml).toContain(`action="${BASE}/direct-unavailable?user=${PERSON}&amp;menu=1"`); // no second cell hop
    expect(xml).not.toContain("<Record");
  });

  it("a busy or failed app leg also falls through to the cell", async () => {
    for (const status of ["busy", "failed"]) {
      person("4035550100");
      const xml = await post(`/direct-unavailable?user=${PERSON}&cell=1&menu=1`, { DialCallStatus: status, From: CALLER });
      expect(xml).toContain("+14035550100</Number>");
    }
  });

  it("an answered leg never rings the cell", async () => {
    person("4035550100");
    const xml = await post(`/direct-unavailable?user=${PERSON}&cell=1&menu=1`, { DialCallStatus: "completed", From: CALLER });
    expect(xml).not.toContain("<Number");
    expect(xml).not.toContain("<Record");
  });

  it("a caller who already hung up is not dialled onward", async () => {
    person("4035550100");
    const xml = await post(`/direct-unavailable?user=${PERSON}&cell=1&menu=1`, { DialCallStatus: "no-answer", CallStatus: "completed", From: CALLER });
    expect(xml).not.toContain("<Number");
  });

  it("nobody answering runs the menu's no-answer fallback: the person's own voicemail, and a missed-call alert", async () => {
    person(null);
    const xml = await post(`/direct-unavailable?user=${PERSON}&menu=1`, { DialCallStatus: "no-answer", From: CALLER, CallSid: "CA-missed-1" });
    expect(xml).toContain("<Record");
    expect(xml).toContain(`staff=${PERSON}`);
    expect(xml).not.toContain("<Number");
    await vi.waitFor(() => expect(callsMatching(h.query, NAMED_RECIPIENTS)).toHaveLength(1));
    expect(callsMatching(h.query, NAMED_RECIPIENTS)[0]![1]).toEqual([[PERSON]]);
  });

  it("the Watch fallback reads only a server-verified callback number and an enabled Watch", async () => {
    person(null);
    await pressOne();
    const [sql] = callsMatching(h.query, WATCH_CELL_SQL)[0]!;
    expect(sqlText(sql)).toContain("callback_verified_at IS NOT NULL");
  });
});

describe("cell-leg call screening", () => {
  it("names the CRM contact and waits 8 s for a single key, then hangs up", async () => {
    h.query.mockImplementation(answerBySql([[/FROM contacts/, { rows: [{ id: "c-1", name: "Jane Client" }] }]]));
    const xml = await post("/screen?from=%2B15875550142", { From: CALLER, ParentCallSid: "CA-parent" });
    expect(xml).toMatch(/<Gather input="dtmf" numDigits="1" timeout="8" action="\/api\/webhooks\/twilio\/reception\/screen-result" method="POST"><Say voice="Polly.Joanna">Keystone Demo Brokerage call from Jane Client\. Press 1 to accept\.<\/Say><\/Gather><Hangup\/>/);
    const [, params] = callsMatching(h.query, /FROM contacts/)[0]!;
    expect(params).toEqual(["5875550142"]);
  });

  it("reads an unknown caller's number digit by digit", async () => {
    h.query.mockImplementation(answerBySql([]));
    const xml = await post("/screen?from=%2B15875550142", {});
    expect(xml).toContain("Keystone Demo Brokerage call from 5 8 7, 5 5 5, 0 1 4 2. Press 1 to accept.");
  });

  it("connects only on 1; any other key or silence hangs up the cell leg", async () => {
    const yes = await post("/screen-result", { Digits: "1" });
    expect(yes).toContain("Connecting.");
    expect(yes).not.toContain("<Hangup");
    for (const params of [{ Digits: "2" }, { Digits: "" }, {}] as Record<string, string>[]) {
      expect(await post("/screen-result", params)).toContain("<Hangup/>");
    }
  });
});

describe("direct line with the Watch fallback", () => {
  it("an unanswered app leg rings the owner's verified cell, screened, once", async () => {
    h.query.mockImplementation(answerBySql([[WATCH_CELL_SQL, { rows: [{ phone: "(403) 555-0102" }] }]]));
    const xml = await post(`/direct-unavailable?user=${DIRECT_OWNER}&cell=1`, { DialCallStatus: "no-answer", From: CALLER });
    expect(xml).toContain(`<Number url="${BASE}/screen?from=%2B15875550142" method="POST">+14035550102</Number>`);
    expect(xml).toContain(`action="${BASE}/direct-unavailable?user=${DIRECT_OWNER}"`);
    expect(callsMatching(h.query, WATCH_CELL_SQL)[0]![1]).toEqual([DIRECT_OWNER]);
  });

  it("without the fallback the owner's voicemail answers and they get a missed-call alert", async () => {
    h.query.mockImplementation(answerBySql([[/SELECT first_name FROM users/, { rows: [{ first_name: "Pat" }] }]]));
    const xml = await post(`/direct-unavailable?user=${DIRECT_OWNER}&cell=1`, { DialCallStatus: "no-answer", From: CALLER });
    expect(xml).toContain("Sorry, Pat isn't available right now.");
    expect(xml).toContain("<Record");
    expect(xml).not.toContain("<Number");
    await vi.waitFor(() => expect(callsMatching(h.query, NAMED_RECIPIENTS)).toHaveLength(1));
    expect(callsMatching(h.query, NAMED_RECIPIENTS)[0]![1]).toEqual([[DIRECT_OWNER]]);
  });

  it("an answered direct line does nothing more", async () => {
    h.query.mockImplementation(answerBySql([[WATCH_CELL_SQL, { rows: [{ phone: "4035550102" }] }]]));
    const xml = await post(`/direct-unavailable?user=${DIRECT_OWNER}&cell=1`, { DialCallStatus: "completed", From: CALLER });
    expect(xml).not.toContain("<Number");
    expect(xml).not.toContain("<Record");
  });
});
