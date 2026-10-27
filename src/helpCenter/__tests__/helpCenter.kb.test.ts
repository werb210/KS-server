// KS_SERVER_KB_v1 - the Help Center relays to KS-Ops's knowledge base: the reader's role decides admin articles, Ask
// Maya carries only this copy's own setup and a hashed asker, Contact support opens a normal ticket with the
// conversation and the articles tried, and KS-Ops's rate limit reaches the portal as 429. Database fake answers by SQL
// content; HTTP is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", () => ({ pool: { query: queryMock }, db: { query: queryMock }, runQuery: queryMock }));
vi.mock("../../plans/overview.js", () => ({
  planOverview: vi.fn(async () => ({
    plan: "growth",
    trial: { status: "none", days_left: 0 },
    usage: { minutes: 120, texts: 30, assistant_chats: 12, storage_bytes: 2 * 1024 ** 3, allowances: { minutes: 1500, texts: 1500, assistant_chats: 1000, storage_bytes: 75 * 1024 ** 3 } },
  })),
}));

import helpCenterRoutes from "../../routes/helpCenter.js";
import { escalationBody, userRef } from "../helpCenter.js";

const USER = "11111111-1111-4111-8111-111111111111";
const OPS_ENV = { KS_OPS_URL: "https://ops.example/", KS_LICENSEE_ID: "lic-1", KS_OPS_KEY: "k3y" };
const token = (role: string) => jwt.sign({ sub: USER, id: USER, role, name: "Sam Staff", email: "sam@prairie.example", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/help-center", helpCenterRoutes);
  return a;
}

let tickets: Array<Record<string, any>>;
beforeEach(() => {
  tickets = [];
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: unknown, p: unknown[] = []) => {
    const s = String(sql);
    const ok = (rows: any[]) => ({ rows, rowCount: rows.length });
    if (/o365_refresh_token IS NOT NULL/.test(s)) return ok([{ connected: true }]);
    if (/INSERT INTO support_tickets/.test(s)) {
      const t = { id: "t1", created_by: p[0], subject: p[1], body: p[2], priority: p[3], status: "open", created_at: new Date() };
      tickets.push(t);
      return ok([{ ...t }]);
    }
    if (/UPDATE support_tickets/.test(s)) return ok([{ ...tickets[0], ops_ticket_id: p[1] ?? null }]);
    return ok([]);
  });
  for (const k of ["KS_OPS_KEY", "KS_OPS_URL", "KS_LICENSEE_ID", "TWILIO_ACCOUNT_SID", "SIGNNOW_API_KEY"]) delete process.env[k];
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("Help Center", () => {
  it("passes the reader's role so only Admins get admin articles", async () => {
    const f = vi.fn(async () => reply(200, { articles: [{ slug: "pipeline-stages" }] }));
    vi.stubGlobal("fetch", f);
    Object.assign(process.env, OPS_ENV);
    const r = await request(app()).get("/api/help-center/articles?q=stages").set("Authorization", `Bearer ${token("Staff")}`);
    expect(r.status).toBe(200);
    expect(r.body.articles[0].slug).toBe("pipeline-stages");
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://ops.example/api/licensees/lic-1/kb/search");
    expect(init.headers["X-KS-Ops-Key"]).toBe("k3y");
    expect(JSON.parse(init.body)).toEqual({ q: "stages", category: "", viewer_role: "Staff" });

    await request(app()).get("/api/help-center/articles/add-users-and-roles").set("Authorization", `Bearer ${token("Admin")}`);
    expect(JSON.parse((f.mock.calls[1] as any)[1].body)).toEqual({ slug: "add-users-and-roles", viewer_role: "Admin" });
  });

  it("needs a signed-in user, and says help is unavailable without the operations link", async () => {
    expect((await request(app()).get("/api/help-center/categories")).status).toBe(401);
    const r = await request(app()).get("/api/help-center/categories").set("Authorization", `Bearer ${token("Staff")}`);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("help_not_available");
  });

  it("Ask Maya sends the conversation, a hashed asker and only this copy's own setup", async () => {
    const f = vi.fn(async () => reply(200, { answer: "Open **Settings**.", citations: [{ slug: "get-phone-numbers", title: "Get your phone numbers" }], offer_support: false }));
    vi.stubGlobal("fetch", f);
    Object.assign(process.env, OPS_ENV, { TWILIO_ACCOUNT_SID: "AC1" });
    const r = await request(app()).post("/api/help-center/ask").set("Authorization", `Bearer ${token("Admin")}`)
      .send({ messages: [{ role: "user", text: "How do I get a number?" }] });
    expect(r.status).toBe(200);
    expect(r.body.citations[0].slug).toBe("get-phone-numbers");
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://ops.example/api/licensees/lic-1/kb/ask");
    const body = JSON.parse(init.body);
    expect(body.messages).toEqual([{ role: "user", text: "How do I get a number?" }]);
    expect(body.viewer).toEqual({ role: "Admin", user_ref: userRef({ id: USER, role: "Admin" }, { KS_LICENSEE_ID: "lic-1" }) });
    expect(body.context.usage.minutes).toEqual({ used: 120, included: 1500 });
    expect(body.context.usage.storage_gb).toEqual({ used: 2, included: 75 });
    expect(body.context.integrations).toMatchObject({ phone: true, e_signing: false, microsoft_365: true, operations_link: true });
    // Who is asking travels only as a hash; no email, name or user id.
    expect(init.body).not.toContain("sam@prairie.example");
    expect(init.body).not.toContain(USER);
  });

  it("passes KS-Ops's rate limit on as 429 and refuses a malformed conversation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(429, { error: "rate_limited" })));
    Object.assign(process.env, OPS_ENV);
    const r = await request(app()).post("/api/help-center/ask").set("Authorization", `Bearer ${token("Staff")}`).send({ messages: [{ role: "user", text: "hi" }] });
    expect(r.status).toBe(429);
    expect(r.body.error).toBe("rate_limited");
    const bad = await request(app()).post("/api/help-center/ask").set("Authorization", `Bearer ${token("Staff")}`).send({ messages: [{ role: "assistant", text: "x" }] });
    expect(bad.status).toBe(400);
  });

  it("Contact support opens a normal ticket with the conversation and the articles tried", async () => {
    const f = vi.fn(async () => reply(201, { id: "ops-9" }));
    vi.stubGlobal("fetch", f);
    Object.assign(process.env, OPS_ENV);
    const r = await request(app()).post("/api/help-center/contact-support").set("Authorization", `Bearer ${token("Staff")}`).send({
      messages: [{ role: "user", text: "My fax rejects documents" }, { role: "assistant", text: "I couldn't find an article." }],
      articles: [{ slug: "documents-and-ocr", title: "Uploads, OCR and document sorting" }, { slug: "BAD SLUG", title: "x" }],
    });
    expect(r.status).toBe(201);
    expect(r.body.relayed).toBe(true);
    expect(tickets[0].subject).toBe("Help request: My fax rejects documents");
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://ops.example/api/licensees/lic-1/tickets");
    const sent = JSON.parse(init.body);
    expect(sent.body).toContain("Me: My fax rejects documents");
    expect(sent.body).toContain("Maya: I couldn't find an article.");
    expect(sent.body).toContain("- Uploads, OCR and document sorting (documents-and-ocr)");
    expect(sent.body).not.toContain("BAD SLUG");
  });

  it("Contact support is not for the Ops role", async () => {
    const r = await request(app()).post("/api/help-center/contact-support").set("Authorization", `Bearer ${token("Ops")}`).send({ note: "x" });
    expect(r.status).toBe(403);
  });

  it("writes 'none' when no articles were tried", () => {
    expect(escalationBody([{ role: "user", text: "q" }], [], "")).toContain("Help articles tried:\n- none");
  });
});
