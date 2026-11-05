// KS_NOTIFICATION_TOPICS_v1 - notification settings per topic.
import { describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { topicForType, typeMatchers, isLocked } from "../notificationPrefs/topics.js";
import { saveSettings, settingsFor, usersWhoMuted } from "../notificationPrefs/prefs.js";
import { notifyAllStaff } from "../services/notifications/notifyAllStaff.js";

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";

describe("topics", () => {
  it("maps types to topics, unknown types to other", () => {
    expect(topicForType("mention")).toBe("mentions");
    expect(topicForType("team_messages")).toBe("mentions");
    expect(topicForType("lender_offer")).toBe("lenders");
    expect(topicForType("offer_term_sheet_signed")).toBe("lenders");
    expect(topicForType("call_missed")).toBe("calls");
    expect(topicForType("sms_inbound")).toBe("client_messages");
    expect(topicForType("fraud_staff_alert")).toBe("security");
    expect(topicForType("phone_number")).toBe("other");
  });
  it("escapes LIKE wildcards in prefixes", () => {
    expect(typeMatchers(["lenders"]).like).toEqual(["lender\\_%", "offer\\_%"]);
  });
  it("security alerts always reach the bell", () => {
    expect(isLocked("security", "bell")).toBe(true);
    expect(isLocked("security", "push")).toBe(false);
  });
});

describe("settings", () => {
  it("fills defaults and keeps locked channels on", async () => {
    const db = { query: vi.fn(answerBySql([[/FROM notification_preferences/, { rows: [
      { topic: "tasks", bell: true, push: false, text_message: false },
      { topic: "security", bell: false, push: false, text_message: true },
    ] }]])) };
    const s = await settingsFor(A, db);
    expect(s.find((x) => x.topic === "tasks")).toEqual({ topic: "tasks", bell: true, push: false, text: false });
    expect(s.find((x) => x.topic === "security")).toEqual({ topic: "security", bell: true, push: false, text: true });
    expect(s.find((x) => x.topic === "mentions")).toEqual({ topic: "mentions", bell: true, push: true, text: true });
  });
  it("saves known topics only and cannot turn a locked channel off", async () => {
    const db = { query: vi.fn(answerBySql([])) };
    await saveSettings(A, [{ topic: "security", bell: false, push: false }, { topic: "nope", bell: false }], db);
    const ins = callsMatching(db.query, /INSERT INTO notification_preferences/);
    expect(ins).toHaveLength(1);
    expect(ins[0][1]).toEqual([A, "security", true, false, true]);
  });
  it("never mutes the other topic", async () => {
    const db = { query: vi.fn() };
    expect((await usersWhoMuted([A], "other", "bell", db as any)).size).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("staff fan-out", () => {
  it("skips the bell, push and text for people who turned this topic off", async () => {
    const query = vi.fn(answerBySql([
      [/FROM users/, { rows: [{ id: A, phone_number: "+15555550101", email: null }, { id: B, phone_number: "+15555550102", email: null }] }],
      [/FROM notification_preferences[\s\S]*bell = false/, { rows: [{ user_id: A }] }],
      [/FROM notification_preferences[\s\S]*push = false/, { rows: [{ user_id: B }] }],
      [/FROM notification_preferences[\s\S]*text_message = false/, { rows: [{ user_id: A }, { user_id: B }] }],
    ]));
    const push = vi.fn(async () => undefined);
    const sms = vi.fn(async () => ({ success: true }));
    const r = await notifyAllStaff(
      { pool: { query } as any, notificationType: "sms_inbound", title: "Text", body: "Hello" },
      { pushToUser: push as any, sendSMS: sms as any },
    );
    const inserts = callsMatching(query, /INSERT INTO notifications/);
    expect(inserts.map((c) => (c[1] as unknown[])[0])).toEqual([B]);
    expect(push.mock.calls.map((c: unknown[]) => c[0])).toEqual([A]);
    expect(sms).not.toHaveBeenCalled();
    expect(r.notifsCreated).toBe(1);
  });
});
