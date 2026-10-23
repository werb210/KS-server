// KS_SERVER_v12_GOOGLE_WORKSPACE - POST /api/o365/mail/send for a staff member on Google only: the message goes
// out through Gmail (merge fields, signature, attachments, threading headers) and lands on the contact timeline
// exactly as an Outlook send does (crm_email_log with the open-tracking pixel token).
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  queries: [] as Array<{ sql: string; params: any[] }>,
  gmailFetch: vi.fn(),
  graph: null as any,
  google: null as any,
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.user = { id: "u-1", userId: "u-1", role: "Staff" }; next(); },
  requireAuthorization: () => (_req: any, _res: any, next: any) => next(),
  auth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../db.js", () => ({
  pool: {
    query: vi.fn(async (sql: string, params: any[] = []) => {
      h.queries.push({ sql, params });
      if (/SELECT first_name, last_name, name, email FROM contacts/.test(sql)) return { rows: [{ first_name: "Sam", last_name: "Lee", name: "Sam Lee", email: "sam@client.example" }] };
      if (/SELECT email_signature_html FROM user_settings/.test(sql)) return { rows: [{ email_signature_html: "<p>Pat, Northwind</p>" }] };
      if (/SELECT id, lower\(email\) AS email/.test(sql)) return { rows: [{ id: "c-1", email: "sam@client.example", secondary_email: null }] };
      return { rows: [], rowCount: 0 };
    }),
  },
  runQuery: vi.fn(),
}));
vi.mock("../modules/o365/graphClient.js", () => ({ getGraphForUser: vi.fn(async () => h.graph) }));
vi.mock("../services/workspace/googleAuth.js", async (orig) => ({ ...(await orig() as any), getGoogleForUser: vi.fn(async () => h.google) }));

import o365Routes from "../routes/o365.js";
import { SENT_LOGGED_HEADER } from "../modules/o365/sentItemsLog.js";

const app = express();
app.use(express.json({ limit: "30mb" }));
app.use("/api/o365", o365Routes);

beforeEach(() => {
  h.queries.length = 0;
  h.graph = null;
  h.gmailFetch.mockReset();
  h.gmailFetch.mockImplementation(async () => new Response(JSON.stringify({ id: "gm-1", threadId: "th-1" }), { status: 200 }));
  h.google = { provider: "google", userId: "u-1", email: "pat@northwind.example", scopes: [], accessToken: "AT", fetch: h.gmailFetch };
});

const sentMime = (): string => Buffer.from(JSON.parse(h.gmailFetch.mock.calls[0][1].body).raw, "base64url").toString("utf8");

describe("Gmail send through the composer route", () => {
  it("sends via Gmail and logs to the contact timeline like an Outlook send", async () => {
    const r = await request(app).post("/api/o365/mail/send").send({
      to: ["sam@client.example"], subject: "Hello {{first_name}}", body_html: "<p>Hi {{first_name}}</p>",
      attachments: [{ name: "terms.pdf", contentType: "application/pdf", contentBytes: Buffer.from("PDF").toString("base64") }],
      in_reply_to: "<orig@client.example>", thread_id: "th-0",
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(h.gmailFetch).toHaveBeenCalledTimes(1);
    expect(h.gmailFetch.mock.calls[0][0]).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(JSON.parse(h.gmailFetch.mock.calls[0][1].body).threadId).toBe("th-0");
    const mime = sentMime();
    expect(mime).toContain("From: pat@northwind.example");
    expect(mime).toContain("To: sam@client.example");
    expect(mime).toContain("Subject: Hello Sam");
    expect(mime).toContain("In-Reply-To: <orig@client.example>");
    expect(mime).toContain(`${SENT_LOGGED_HEADER}: 1`);
    expect(mime).toContain('filename="terms.pdf"');
    const html = Buffer.from(mime.split("Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n")[1]!.split("\r\n--")[0]!.replace(/\r\n/g, ""), "base64").toString("utf8");
    expect(html).toContain("<p>Hi Sam</p>");
    expect(html).toContain("<p>Pat, Northwind</p>");
    expect(html).toMatch(/\/api\/track\/email\/[0-9a-f-]{36}\.gif/);
    const log = h.queries.find((q) => /INSERT INTO crm_email_log/.test(q.sql))!;
    expect(log.params[4]).toBe("Hello Sam");
    expect(log.params[6]).toBe("u-1");
    expect(log.params[7]).toBe("c-1");
    expect(log.params[10]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses a shared mailbox and scheduled send, which gmail.send cannot do", async () => {
    const shared = await request(app).post("/api/o365/mail/send").send({ from: "info@northwind.example", to: ["a@b.co"], subject: "s", body_html: "x" });
    expect(shared.status).toBe(403);
    expect(shared.body.error).toBe("from_not_allowed");
    const later = await request(app).post("/api/o365/mail/send").send({ to: ["a@b.co"], subject: "s", body_html: "x", scheduleAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(later.status).toBe(400);
    expect(later.body.error).toBe("schedule_not_supported");
    expect(h.gmailFetch).not.toHaveBeenCalled();
  });

  it("a Gmail failure is a 502 with Google's reason and nothing is logged", async () => {
    h.gmailFetch.mockImplementation(async () => new Response(JSON.stringify({ error: { message: "Insufficient Permission" } }), { status: 403 }));
    const r = await request(app).post("/api/o365/mail/send").send({ to: ["sam@client.example"], subject: "s", body_html: "x" });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("gmail_send_failed");
    expect(String(r.body.detail)).toContain("Insufficient Permission");
    expect(h.queries.some((q) => /INSERT INTO crm_email_log/.test(q.sql))).toBe(false);
  });

  it("neither provider connected: the same 412 as before", async () => {
    h.google = null;
    const r = await request(app).post("/api/o365/mail/send").send({ to: ["a@b.co"], subject: "s", body_html: "x" });
    expect(r.status).toBe(412);
    expect(r.body).toEqual({ error: "o365_not_connected" });
  });

  it("Microsoft 365 connected: Graph is used and Gmail is never touched", async () => {
    const graphFetch = vi.fn(async () => new Response("", { status: 202 }));
    h.graph = { fetch: graphFetch, accessToken: "ms" };
    const r = await request(app).post("/api/o365/mail/send").send({ to: ["sam@client.example"], subject: "s", body_html: "x" });
    expect(r.status).toBe(200);
    expect((graphFetch.mock.calls as any[]).map((c) => c[0])).toContain("/me/sendMail");
    expect(h.gmailFetch).not.toHaveBeenCalled();
  });
});
