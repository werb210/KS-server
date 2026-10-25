// KS_SERVER_v17_TICKET_FOLLOW_UPS - follow-up replies on a support ticket are stored and relayed to KS-Ops
// (POST /api/licensees/{id}/tickets/{ops_ticket_id}/messages). Database fake answers by SQL content; HTTP is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", () => ({ pool: { query: queryMock }, db: { query: queryMock }, runQuery: queryMock }));

import supportRoutes from "../../routes/support.js";

type Row = Record<string, any>;
const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let tickets: Row[];
let messages: Row[];

function fakeDb(sql: string, p: unknown[] = []) {
  const ok = (rows: any[]) => ({ rows, rowCount: rows.length });
  if (/FROM support_tickets WHERE id = \$1/.test(sql)) return ok(tickets.filter((t) => t.id === p[0]));
  if (/INSERT INTO support_ticket_messages/.test(sql)) {
    const m = { id: `m${messages.length + 1}`, ticket_id: p[0], created_by: p[1], body: p[2], ops_message_id: null, relayed_at: null, relay_error: null, created_at: new Date() };
    messages.push(m);
    return ok([{ ...m }]);
  }
  if (/UPDATE support_ticket_messages SET ops_message_id/.test(sql)) {
    const m = messages.find((x) => x.id === p[0])!;
    Object.assign(m, { ops_message_id: p[1], relayed_at: new Date(), relay_error: null });
    return ok([{ ...m }]);
  }
  if (/UPDATE support_ticket_messages SET relay_error/.test(sql)) {
    const m = messages.find((x) => x.id === p[0])!;
    m.relay_error = p[1];
    return ok([{ ...m }]);
  }
  if (/FROM support_ticket_messages WHERE ticket_id/.test(sql)) return ok(messages.filter((m) => m.ticket_id === p[0]));
  return ok([]);
}

const OPS_ENV = { KS_OPS_URL: "https://ops.example/", KS_LICENSEE_ID: "lic-1", KS_OPS_KEY: "k3y" };
const token = (role: string) => jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", id: "11111111-1111-4111-8111-111111111111", role, name: "Sam Staff", email: "sam@prairie.example", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
const fetchOk = (body: unknown) => vi.fn(async () => ({ ok: true, status: 201, json: async () => body, text: async () => JSON.stringify(body) }));

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/support", supportRoutes);
  return a;
}

beforeEach(() => {
  tickets = [
    { id: T1, created_by: "u1", subject: "Dialler down", body: "No calls", priority: "urgent", status: "open", ops_ticket_id: "ops-77", relayed_at: new Date(), relay_error: null, created_at: new Date() },
    { id: T2, created_by: "u1", subject: "Not sent", body: "x", priority: "normal", status: "open", ops_ticket_id: null, relayed_at: null, relay_error: "status_503", created_at: new Date() },
  ];
  messages = [];
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: unknown, params?: unknown[]) => fakeDb(String(sql), params ?? []));
  for (const k of ["KS_OPS_KEY", "KS_OPS_URL", "KS_LICENSEE_ID"]) delete process.env[k];
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("support ticket follow-ups", () => {
  it("stores the reply and relays it to KS-Ops on the ticket's operations id", async () => {
    const f = fetchOk({ ok: true, ticket_id: "ops-77", message_id: "ops-m-1" });
    vi.stubGlobal("fetch", f);
    Object.assign(process.env, OPS_ENV);
    const r = await request(app()).post(`/api/support/tickets/${T1}/messages`).set("Authorization", `Bearer ${token("Staff")}`).send({ body: "Still down this morning." });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ ok: true, relayed: true, message: { ticket_id: T1, body: "Still down this morning.", ops_message_id: "ops-m-1" } });
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://ops.example/api/licensees/lic-1/tickets/ops-77/messages");
    expect(init.headers["X-KS-Ops-Key"]).toBe("k3y");
    expect(JSON.parse(init.body)).toMatchObject({ body: "Still down this morning.", local_message_id: "m1" });

    const detail = await request(app()).get(`/api/support/tickets/${T1}`).set("Authorization", `Bearer ${token("Admin")}`);
    expect(detail.status).toBe(200);
    expect(detail.body.ticket.id).toBe(T1);
    expect(detail.body.messages).toHaveLength(1);
  });

  it("keeps the reply when the ticket never reached operations or the relay fails", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "down" }));
    vi.stubGlobal("fetch", f);
    Object.assign(process.env, OPS_ENV);
    const notRelayed = await request(app()).post(`/api/support/tickets/${T2}/messages`).set("Authorization", `Bearer ${token("Admin")}`).send({ body: "Any news?" });
    expect(notRelayed.status).toBe(201);
    expect(notRelayed.body).toMatchObject({ relayed: false, relay_error: "ticket_not_relayed" });
    expect(f).not.toHaveBeenCalled();
    const down = await request(app()).post(`/api/support/tickets/${T1}/messages`).set("Authorization", `Bearer ${token("Admin")}`).send({ body: "Hello?" });
    expect(down.body).toMatchObject({ relayed: false });
    expect(messages[1].relay_error).toMatch(/status_503/);
  });

  it("validates, needs Admin or Staff, and 404s an unknown ticket", async () => {
    expect((await request(app()).post(`/api/support/tickets/${T1}/messages`).send({ body: "x" })).status).toBe(401);
    expect((await request(app()).post(`/api/support/tickets/${T1}/messages`).set("Authorization", `Bearer ${token("Lender")}`).send({ body: "x" })).status).toBe(403);
    const bad = await request(app()).post(`/api/support/tickets/${T1}/messages`).set("Authorization", `Bearer ${token("Staff")}`).send({ body: "  " });
    expect(bad.status).toBe(400);
    expect(bad.body.errors).toEqual({ body: "required" });
    const missing = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    expect((await request(app()).post(`/api/support/tickets/${missing}/messages`).set("Authorization", `Bearer ${token("Staff")}`).send({ body: "x" })).status).toBe(404);
    expect((await request(app()).get("/api/support/tickets/not-a-uuid").set("Authorization", `Bearer ${token("Staff")}`)).status).toBe(404);
    expect(messages).toHaveLength(0);
  });
});
