// KS_SERVER_GMAIL_INBOX - Gmail inbox reading: off by default (no scope, 409 with the pending-review message, no sync),
// and when switched on: history sync, incremental history, the 404 fallback, inbound mail to the timeline with the
// application, Gmail-sent mail to crm_email_log, portal sends skipped, attachments filed, read receipts, push.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const USER = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  account: { gmail_history_id: null as string | null },
  logged: new Set<string>(),
  google: null as any,
  puts: [] as string[],
}));

// Answers by SQL content only.
async function answer(sql: string, params: unknown[] = []) {
  h.queries.push({ sql, params });
  if (/SELECT gmail_history_id FROM google_workspace_accounts/.test(sql)) return { rows: [h.account] };
  if (/SELECT 1 FROM gmail_messages/.test(sql)) return { rows: h.logged.has(String(params[1])) ? [{ x: 1 }] : [] };
  if (/INSERT INTO gmail_messages/.test(sql)) {
    if (h.logged.has(String(params[1]))) return { rows: [], rowCount: 0 };
    h.logged.add(String(params[1]));
    return { rows: [], rowCount: 1 };
  }
  if (/FROM contacts\s+WHERE \(\$1::text IS NULL OR silo = \$1\)/.test(sql)) {
    const emails = params[1] as string[];
    return { rows: emails.includes("client@acme.example") ? [{ id: CONTACT, silo: "BF", email: "client@acme.example", secondary_email: null }] : [] };
  }
  if (/FROM applications WHERE contact_id = \$1/.test(sql)) return { rows: [{ id: "app-1" }] };
  if (/SELECT silo FROM users WHERE id/.test(sql)) return { rows: [{ silo: "BF" }] };
  if (/INSERT INTO communications_messages/.test(sql)) return { rows: [], rowCount: 1 };
  if (/INSERT INTO crm_email_log/.test(sql)) return { rows: [], rowCount: 1 };
  if (/UPDATE crm_email_log SET opened_at/.test(sql)) return { rows: [], rowCount: String(params[1]).toLowerCase() === "rates for march" ? 1 : 0 };
  if (/INSERT INTO contact_documents/.test(sql)) return { rows: [], rowCount: 1 };
  if (/FROM google_workspace_accounts WHERE status = 'connected' AND position/.test(sql)) return { rows: [{ user_id: USER }] };
  if (/lower\(google_email\) = \$1/.test(sql)) return { rows: params[0] === "pat@broker.example" ? [{ user_id: USER }] : [] };
  return { rows: [], rowCount: 0 };
}

vi.mock("../../../db.js", () => {
  const pool = { query: vi.fn((sql: string, params?: unknown[]) => answer(String(sql), params ?? [])) };
  return { pool, db: pool, default: pool };
});
vi.mock("../../../services/workspace/googleAuth.js", () => ({ getGoogleForUser: vi.fn(async () => h.google) }));
vi.mock("../../../lib/storage/index.js", () => ({
  getStorage: () => ({ put: async (o: any) => { h.puts.push(o.filename); return { blobName: `b/${o.filename}`, url: null }; } }),
}));
vi.mock("../../../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.user = { id: USER, userId: USER, role: "Staff" }; next(); },
}));
vi.mock("../../notifications/notifications.repo.js", () => ({ createNotification: vi.fn(async () => undefined) }));
vi.mock("../../automation/automationEngine.js", () => ({ emitAutomationEvent: vi.fn(async () => undefined) }));

import { pool } from "../../../db.js";
import { syncGmailAccount, syncAllGmail } from "../gmailSync.js";
import { parsePush } from "../gmailPush.js";
import { requestedScopes } from "../../../services/workspace/googleConfig.js";
import gmailRoutes from "../../../routes/gmail.js";
import gmailPushRoutes from "../../../routes/gmailPush.js";
import { createNotification } from "../../notifications/notifications.repo.js";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const READ = "https://www.googleapis.com/auth/gmail.readonly";

function msg(id: string, o: { labels: string[]; from: string; to?: string; subject?: string; extra?: Array<{ name: string; value: string }>; attach?: boolean }) {
  const headers = [
    { name: "From", value: o.from }, { name: "To", value: o.to ?? "pat@broker.example" }, { name: "Subject", value: o.subject ?? "Your file" },
    { name: "Message-ID", value: `<${id}@mail.example>` }, ...(o.extra ?? []),
  ];
  const parts: any[] = [{ mimeType: "text/html", body: { data: b64("<p>Hello</p>") } }];
  if (o.attach) {
    parts.push({ mimeType: "application/pdf", filename: "statement.pdf", headers: [{ name: "Content-Disposition", value: "attachment" }], body: { attachmentId: `att-${id}`, size: 10 } });
    parts.push({ mimeType: "image/png", filename: "logo.png", headers: [{ name: "Content-Disposition", value: "inline" }, { name: "Content-ID", value: "<logo>" }], body: { attachmentId: "logo", size: 5 } });
  }
  return { id, threadId: `t-${id}`, labelIds: o.labels, snippet: "Hi there", internalDate: String(Date.parse("2026-10-30T12:00:00Z")), payload: { mimeType: "multipart/mixed", headers, parts } };
}

const MAILBOX: Record<string, any> = {
  m1: msg("m1", { labels: ["INBOX", "UNREAD"], from: "Client <client@acme.example>", attach: true }),
  m2: msg("m2", { labels: ["SENT"], from: "pat@broker.example", to: "client@acme.example" }),
  m3: msg("m3", { labels: ["SENT"], from: "pat@broker.example", to: "client@acme.example", extra: [{ name: "X-Boreal-Logged", value: "1" }] }),
  m4: msg("m4", { labels: ["INBOX"], from: "news@shop.example" }),
  m5: msg("m5", { labels: ["SPAM"], from: "client@acme.example" }),
  m6: msg("m6", { labels: ["INBOX"], from: "client@acme.example", subject: "Read: Rates for March" }),
};

function fakeGoogle(opts: { history?: "ok" | "gone" } = {}) {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  return {
    calls,
    client: {
      provider: "google", userId: USER, email: "pat@broker.example", scopes: ["openid", READ], accessToken: "t",
      fetch: async (url: string) => {
        const path = url.replace("https://gmail.googleapis.com/gmail/v1/users/me", "");
        calls.push(path);
        if (path === "/profile") return json({ emailAddress: "pat@broker.example", historyId: "900" });
        if (path.startsWith("/messages?")) return json({ messages: ["m1", "m2", "m3", "m4", "m5", "m6"].reverse().map((id) => ({ id })) });
        if (path.startsWith("/history?")) return opts.history === "gone" ? json({ error: "gone" }, 404) : json({ history: [{ messagesAdded: [{ message: { id: "m1" } }] }], historyId: "950" });
        const att = /^\/messages\/(\w+)\/attachments\/(.+)$/.exec(path);
        if (att) return json({ data: b64("%PDF-1.4 test"), size: 13 });
        const one = /^\/messages\/(\w+)\?format=full$/.exec(path);
        if (one) return MAILBOX[one[1]!] ? json(MAILBOX[one[1]!]) : json({}, 404);
        return json({}, 404);
      },
    },
  };
}

const sqlsMatching = (re: RegExp) => h.queries.filter((q) => re.test(q.sql));

beforeEach(() => {
  h.queries = [];
  h.account = { gmail_history_id: null };
  h.logged = new Set();
  h.puts = [];
  (createNotification as any).mockClear();
  delete process.env.KS_GOOGLE_GMAIL_READ_ENABLED;
  delete process.env.GOOGLE_GMAIL_READ_ENABLED;
});
afterEach(() => { delete process.env.KS_GOOGLE_GMAIL_READ_ENABLED; delete process.env.KS_GOOGLE_PUBSUB_PUSH_TOKEN; });

describe("switched off (until CASA is done)", () => {
  it("never asks for gmail.readonly, and the inbox routes say reading is pending Google's security review", async () => {
    expect(requestedScopes({} as any)).not.toContain(READ);
    expect(requestedScopes({ KS_GOOGLE_GMAIL_READ_ENABLED: "false" } as any)).not.toContain(READ);
    expect(requestedScopes({ KS_GOOGLE_GMAIL_READ_ENABLED: "true" } as any)).toContain(READ);
    expect(requestedScopes({ KS_GOOGLE_GMAIL_READ_ENABLED: "true" } as any)).not.toContain("https://www.googleapis.com/auth/gmail.modify");
    const app = express();
    app.use("/api/google/gmail", gmailRoutes);
    for (const path of ["/status", "/threads", "/threads/t1", "/messages/m1/attachments/0"]) {
      const r = await request(app).get(`/api/google/gmail${path}`);
      expect(r.status, path).toBe(409);
      expect(r.body).toMatchObject({ error: "gmail_read_pending", message: "Gmail inbox reading is pending Google's security review." });
    }
    expect((await request(app).post("/api/google/gmail/sync")).status).toBe(409);
    expect(h.queries).toEqual([]);
    process.env.KS_GOOGLE_GMAIL_READ_ENABLED = "true";
    h.google = { ...fakeGoogle().client, scopes: ["openid"] };
    const reconnect = await request(app).get("/api/google/gmail/threads");
    expect(reconnect.status).toBe(412);
    expect(reconnect.body.error).toBe("gmail_reconnect_required");
    delete process.env.KS_GOOGLE_GMAIL_READ_ENABLED;
    h.queries = [];
    expect((await syncAllGmail(pool as any, { GOOGLE_OAUTH_CLIENT_ID: "x", GOOGLE_OAUTH_CLIENT_SECRET: "y", GOOGLE_TOKEN_ENCRYPTION_KEY: "k" } as any))).toEqual({ ran: false, users: 0 });
    expect(h.queries).toEqual([]);
  });
});

describe("history sync and incremental sync", () => {
  it("first sync: logs client mail to the timeline with the deal, Gmail-sent mail to the email log, files attachments", async () => {
    const g = fakeGoogle();
    h.google = g.client;
    const stats = await syncGmailAccount(pool as any, USER, { KS_GMAIL_HISTORY_DAYS: "14" } as any);
    expect(stats).toMatchObject({ mode: "first", seen: 6, inbound: 1, outbound: 1, receipts: 1, attachments: 1 });
    expect(g.calls.find((c) => c.startsWith("/messages?"))).toContain(encodeURIComponent("newer_than:14d").replace(/%20/g, "+"));
    const inbound = sqlsMatching(/INSERT INTO communications_messages/);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.params.slice(0, 2)).toEqual([CONTACT, "app-1"]);
    const sent = sqlsMatching(/INSERT INTO crm_email_log/);
    expect(sent).toHaveLength(1); // m3 was sent from the portal and logged then
    expect(sent[0]!.params.slice(-2)).toEqual(["m2", "t-m2"]);
    expect(h.puts).toEqual(["statement.pdf"]); // the inline logo is not filed
    expect(sqlsMatching(/INSERT INTO contact_documents/)[0]!.params[7]).toBe("gmail:m1");
    expect(sqlsMatching(/UPDATE google_workspace_accounts\s+SET gmail_history_id/)[0]!.params).toEqual([USER, "900"]);
    expect(createNotification).not.toHaveBeenCalled(); // no "new email" storm for old mail
    // Unknown senders and spam are never stored.
    expect([...h.logged].sort()).toEqual(["m1", "m2"]);
  });

  it("incremental sync reads Gmail history from the stored id and notifies", async () => {
    const g = fakeGoogle();
    h.google = g.client;
    h.account = { gmail_history_id: "800" };
    const stats = await syncGmailAccount(pool as any, USER);
    expect(stats).toMatchObject({ mode: "incremental", seen: 1, inbound: 1 });
    expect(g.calls.some((c) => c.startsWith("/history?") && c.includes("startHistoryId=800"))).toBe(true);
    expect(sqlsMatching(/SET gmail_history_id/)[0]!.params).toEqual([USER, "950"]);
    expect(createNotification).toHaveBeenCalledTimes(1);
    // Run again: nothing is logged twice.
    await syncGmailAccount(pool as any, USER);
    expect(sqlsMatching(/INSERT INTO communications_messages/)).toHaveLength(1);
  });

  it("falls back to a 7-day sync when Google no longer has the history", async () => {
    const g = fakeGoogle({ history: "gone" });
    h.google = g.client;
    h.account = { gmail_history_id: "5" };
    const stats = await syncGmailAccount(pool as any, USER);
    expect(stats.mode).toBe("resync");
    expect(g.calls.find((c) => c.startsWith("/messages?"))).toContain("newer_than%3A7d");
  });

  it("does nothing for a person who has not granted read access", async () => {
    h.google = { ...fakeGoogle().client, scopes: ["openid"] };
    expect((await syncGmailAccount(pool as any, USER)).mode).toBe("none");
    expect(sqlsMatching(/gmail_messages/)).toHaveLength(0);
  });
});

describe("Gmail push", () => {
  it("reads the mailbox from the Pub/Sub message and needs the shared token", async () => {
    const data = Buffer.from(JSON.stringify({ emailAddress: "Pat@Broker.example", historyId: 951 })).toString("base64");
    expect(parsePush({ message: { data } })).toEqual({ emailAddress: "pat@broker.example", historyId: "951" });
    expect(parsePush({ message: { data: "not json" } })).toBeNull();
    const app = express();
    app.use(express.json());
    app.use("/api/gmail-push", gmailPushRoutes);
    expect((await request(app).post("/api/gmail-push").send({ message: { data } })).status).toBe(403);
    process.env.KS_GOOGLE_PUBSUB_PUSH_TOKEN = "push-secret";
    expect((await request(app).post("/api/gmail-push?token=wrong").send({ message: { data } })).status).toBe(403);
    process.env.KS_GOOGLE_GMAIL_READ_ENABLED = "true";
    h.google = fakeGoogle().client;
    h.account = { gmail_history_id: "800" };
    expect((await request(app).post("/api/gmail-push?token=push-secret").send({ message: { data } })).status).toBe(204);
    await vi.waitFor(() => expect(sqlsMatching(/INSERT INTO communications_messages/)).toHaveLength(1));
  });
});
