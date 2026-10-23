// KS_SERVER_v11_PGI - the PGI routes and referral lifecycle against a database fake that answers by SQL content and
// a fake insurance partner (fetch).
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const h = vi.hoisted(() => ({ query: vi.fn(), notify: vi.fn(), mail: vi.fn(async () => ({ ok: true })) }));
vi.mock("../../db.js", () => ({ pool: { query: h.query }, db: { query: h.query } }));
vi.mock("../../modules/notifications/notifications.repo.js", () => ({ createNotification: h.notify }));
vi.mock("../../plans/email.js", async (orig) => ({ ...(await orig<typeof import("../../plans/email.js")>()), sendPlanMail: h.mail }));
vi.mock("../../fraud/documents.js", () => ({ defaultLoadFile: async () => Buffer.from("%PDF-1.4 ks file") }));
vi.mock("../../licensee/brand.js", async (orig) => ({ ...(await orig<typeof import("../../licensee/brand.js")>()), supportEmail: () => "help@acme.example" }));

import pgiRoutes from "../../routes/pgi.js";
import { sealSecret } from "../partner.js";
import { forwardDocuments, runPgiTick, sendReferral } from "../service.js";

const OPS = "ops-key-v11";
const SECRET = "s".repeat(64);
const USER = "11111111-1111-4111-8111-111111111111";
const token = (role: string) => jwt.sign({ sub: USER, id: USER, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));

type Row = Record<string, any>;
let link: Row | null;
let referrals: Row[];
let messages: Row[];
let fwd: Row[];
let docs: Row[];
let appUpdates: unknown[][];
let cms: unknown[][];

function db(sql: string, p: any[] = []) {
  const ok = (rows: any[]) => ({ rows, rowCount: rows.length });
  if (/FROM pgi_partner_link WHERE id = 1/.test(sql)) return ok(link ? [link] : []);
  if (/INSERT INTO pgi_partner_link/.test(sql)) { link = { bi_server_url: p[0], referral_source_id: p[1], api_key_enc: p[2], callback_secret_enc: p[3], updated_at: new Date() }; return ok([]); }
  if (/SELECT \* FROM pgi_referrals WHERE application_id/.test(sql)) return ok(referrals.filter((r) => r.application_id === p[0]));
  if (/INSERT INTO pgi_referrals/.test(sql)) {
    if (!referrals.find((r) => r.application_id === p[0])) {
      referrals.push({ id: `ref-${p[0]}`, application_id: p[0], status: "pending", input: JSON.parse(p[1]), referring_user_id: p[2] ?? null,
        bi_application_id: null, checklist: null, missing_count: 0, unread_count: 0, created_at: new Date().toISOString() });
    }
    return ok([]);
  }
  if (/UPDATE pgi_referrals\s+SET status = \$2, partner_status/.test(sql)) {
    const r = referrals.find((x) => x.id === p[0])!;
    Object.assign(r, { status: p[1], partner_status: p[2], bi_application_id: p[3] ?? r.bi_application_id, bi_application_code: p[4], completion_url: p[5],
      checklist: JSON.parse(p[6]), missing_count: p[7], referral_fee_amount: p[8], last_error: null, last_synced_at: new Date().toISOString() });
    return ok([]);
  }
  if (/UPDATE pgi_referrals SET status = \$2, last_error/.test(sql)) { Object.assign(referrals.find((x) => x.id === p[0])!, { status: p[1], last_error: p[2] }); return ok([]); }
  if (/UPDATE pgi_referrals\s+SET unread_count = unread_count \+ 1/.test(sql)) {
    const r = referrals.find((x) => x.id === p[0])!;
    r.unread_count += 1; if (p[1]) r.status = p[1]; if (p[2] != null) r.referral_fee_amount = p[2];
    return ok([]);
  }
  if (/UPDATE pgi_referrals SET input/.test(sql)) { const r = referrals.find((x) => x.application_id === p[0])!; r.input = { ...r.input, ...JSON.parse(p[1]) }; return ok([]); }
  if (/UPDATE pgi_referrals SET missing_count/.test(sql)) return ok([]);
  if (/UPDATE pgi_referrals SET unread_count = 0/.test(sql)) { referrals.find((x) => x.id === p[0])!.unread_count = 0; return ok([]); }
  if (/INSERT INTO pgi_referral_messages \(referral_id, direction, kind, body, author_name, missing/.test(sql)) {
    if (messages.find((m) => m.bi_event_id === p[6])) return ok([]);
    const m = { id: `m${messages.length + 1}`, referral_id: p[0], direction: "from_partner", kind: p[1], body: p[2], bi_event_id: p[6], status: p[5] };
    messages.push(m); return ok([{ id: m.id }]);
  }
  if (/INSERT INTO pgi_referral_messages \(referral_id, direction, kind, body, author_name, author_user_id\)/.test(sql)) {
    const m = { id: `m${messages.length + 1}`, referral_id: p[0], direction: "to_partner", body: p[1] }; messages.push(m); return ok([{ id: m.id }]);
  }
  if (/UPDATE pgi_referral_messages SET sent_at/.test(sql)) { Object.assign(messages.find((m) => m.id === p[0])!, { sent: p[1], send_error: p[2] }); return ok([]); }
  if (/FROM pgi_referral_messages WHERE referral_id/.test(sql)) return ok(messages.filter((m) => m.referral_id === p[0]));
  if (/FROM pgi_referral_documents WHERE referral_id/.test(sql)) return ok(fwd.filter((f) => f.referral_id === p[0]));
  if (/INSERT INTO pgi_referral_documents/.test(sql)) {
    const prev = fwd.find((f) => f.referral_id === p[0] && f.document_id === p[1]);
    const row = { referral_id: p[0], document_id: p[1], slot: p[2], sha256: p[3], forwarded_at: p[5] ? null : new Date().toISOString(), last_error: p[5] };
    if (prev) Object.assign(prev, row); else fwd.push(row);
    return ok([]);
  }
  if (/FROM documents WHERE application_id/.test(sql)) return ok(docs);
  if (/UPDATE applications SET bi_application_id/.test(sql)) { appUpdates.push(p); return ok([]); }
  if (/FROM communications_messages WHERE application_id/.test(sql)) return ok(cms.length ? [{ id: "x" }] : []);
  if (/INSERT INTO communications_messages/.test(sql)) { cms.push(p); return ok([]); }
  if (/FROM users u\s+WHERE u.id::text = COALESCE/.test(sql)) return ok([{ id: USER, email: "sam@acme.example", name: "Sam Broker" }]);
  if (/FROM users WHERE role = 'Admin'/.test(sql)) return ok([{ id: "admin-1" }]);
  if (/SELECT name FROM applications/.test(sql)) return ok([{ name: "Widget Co" }]);
  if (/SELECT metadata, requested_amount FROM applications/.test(sql)) return ok(p[0] === "app-2" ? [{ metadata: { formData: { business: { legalName: "Two Co" } } }, requested_amount: "300000" }] : []);
  if (/FROM pgi_referrals p\s+LEFT JOIN applications/.test(sql)) return ok(referrals.map((r) => ({ ...r, application_name: "Widget Co" })));
  if (/m.direction = 'to_partner' AND m.sent_at IS NULL/.test(sql)) return ok([]);
  if (/SELECT application_id FROM pgi_referrals/.test(sql)) return ok(referrals.filter((r) => !["policy_issued", "declined", "not_eligible"].includes(r.status)).map((r) => ({ application_id: r.application_id })));
  if (/NULLIF\(trim\(concat_ws\(' ', first_name, last_name\)\), ''\) AS name, email FROM users/.test(sql)) return ok([{ name: "Sam Broker", email: "sam@acme.example" }]);
  return ok([]);
}

const partnerView = (over: Row = {}) => ({
  ok: true, created: true, bi_application_id: "bi-1", application_code: "BI-ABC123", public_id: "pub-1",
  completion_url: "https://www.example.test/login?next=/applications/pub-1/form", bi_status: "created", status: "awaiting_client",
  checklist: { documents: [{ slot: "loan_agreement", status: "missing" }], missing_documents: [{ slot: "loan_agreement", label: "Term sheet" }], missing_fields: [] },
  referral_fee: null, messages: [], ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;
function app() {
  const a = express();
  a.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
  a.use("/api/pgi", pgiRoutes);
  return a;
}
function signed(body: object, opts: { ts?: number; secret?: string; source?: string } = {}) {
  const raw = JSON.stringify(body);
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const sig = "v1=" + createHmac("sha256", opts.secret ?? SECRET).update(`${ts}.${raw}`).digest("hex");
  return request(app()).post("/api/pgi/bi-events").set("Content-Type", "application/json")
    .set("X-BI-Referral-Source", opts.source ?? "src-1").set("X-BI-Timestamp", String(ts)).set("X-BI-Signature", sig).send(raw);
}

beforeEach(() => {
  process.env.KS_OPS_KEY = OPS;
  link = { bi_server_url: "https://bi.azurewebsites.net", referral_source_id: "src-1", api_key_enc: sealSecret("bk_ks_" + "k".repeat(30)), callback_secret_enc: sealSecret(SECRET) };
  referrals = []; messages = []; fwd = []; docs = []; appUpdates = []; cms = [];
  h.query.mockReset().mockImplementation(async (sql: string, p?: any[]) => db(sql, p));
  h.notify.mockReset().mockResolvedValue({});
  h.mail.mockClear();
  fetchMock = vi.fn(async (url: string, init: any) => {
    if (url.endsWith("/referrals") && init.method === "POST") return { ok: true, status: 201, json: async () => partnerView(), text: async () => "" };
    if (/\/documents$/.test(url)) return { ok: true, status: 201, json: async () => ({ ok: true, bi_document_id: "bd-1" }), text: async () => "" };
    if (/\/messages$/.test(url)) return { ok: true, status: 201, json: async () => ({ ok: true }), text: async () => "" };
    return { ok: true, status: 200, json: async () => partnerView({ created: false }), text: async () => "" };
  });
  vi.stubGlobal("fetch", fetchMock);
});

describe("PUT /api/pgi/link (operations)", () => {
  it("needs the ops key and a valid link; stores the secrets encrypted", async () => {
    link = null;
    const body = { bi_server_url: "https://bi.azurewebsites.net", referral_source_id: "src-9", api_key: "bk_ks_" + "a".repeat(30), callback_secret: "c".repeat(64) };
    expect((await request(app()).put("/api/pgi/link").set("X-KS-Ops-Key", "wrong").send(body)).status).toBe(401);
    expect((await request(app()).put("/api/pgi/link").set("X-KS-Ops-Key", OPS).send({ ...body, bi_server_url: "https://evil.example" })).status).toBe(400);
    const r = await request(app()).put("/api/pgi/link").set("X-KS-Ops-Key", OPS).send(body);
    expect(r.status).toBe(200);
    expect(link!.api_key_enc).toMatch(/^v1:/);
    expect(link!.api_key_enc).not.toContain("aaaa");
    const status = await request(app()).get("/api/pgi/link").set("Authorization", `Bearer ${token("Admin")}`);
    expect(status.body).toMatchObject({ configured: true, referral_source_id: "src-9", partner_host: "bi.azurewebsites.net" });
  });
});

describe("referral lifecycle", () => {
  it("sends the referral, records the partner's link, posts the client prompt and forwards accepted documents", async () => {
    referrals.push({ id: "ref-a", application_id: "app-1", status: "pending", input: { business_legal_name: "Widget Co" }, referring_user_id: USER, bi_application_id: null, unread_count: 0 });
    docs = [
      { id: "d1", application_id: "app-1", category: "signed_term_sheet", document_type: "signed_term_sheet", status: "uploaded", created_at: "2026-10-20", filename: "ts.pdf" },
      { id: "d2", application_id: "app-1", category: "A/R", document_type: "A/R", status: "uploaded", created_at: "2026-10-20", filename: "ar.pdf" },
    ];
    const r = await sendReferral({ query: h.query } as any, "app-1");
    expect(r.ok).toBe(true);
    const ref = referrals[0]!;
    expect(ref).toMatchObject({ status: "awaiting_client", bi_application_id: "bi-1", bi_application_code: "BI-ABC123" });
    const create = fetchMock.mock.calls.find(([u, i]: any) => u.endsWith("/api/v1/bi/ks/referrals") && i.method === "POST")!;
    expect(create[1].headers.Authorization).toMatch(/^Bearer bk_ks_/);
    expect(JSON.parse(create[1].body)).toMatchObject({ ks_application_id: "app-1", broker: { name: "Sam Broker" } });
    expect(appUpdates[0]).toEqual(["app-1", "bi-1", "pub-1", expect.stringContaining("/applications/pub-1/form")]);
    expect(cms).toHaveLength(1);
    const uploads = fetchMock.mock.calls.filter(([u]: any) => /\/documents$/.test(u));
    expect(uploads).toHaveLength(1); // only the signed term sheet: the A/R is not accepted yet
    expect((uploads[0]![1].body as FormData).get("slot")).toBe("loan_agreement");
    expect(fwd).toHaveLength(1);
    // the same file is not sent twice
    expect(await forwardDocuments({ query: h.query } as any, "app-1")).toEqual({ sent: 0, skipped: 1, failed: 0 });
  });

  it("without the partner link the referral waits (not_configured); Quebec is not eligible", async () => {
    link = null;
    referrals.push({ id: "ref-b", application_id: "app-b", status: "pending", input: {}, bi_application_id: null });
    await sendReferral({ query: h.query } as any, "app-b");
    expect(referrals[0]).toMatchObject({ status: "not_configured", last_error: "insurance_partner_not_linked" });
    link = { bi_server_url: "https://bi.azurewebsites.net", referral_source_id: "src-1", api_key_enc: sealSecret("bk_ks_" + "k".repeat(30)), callback_secret_enc: sealSecret(SECRET) };
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: "quebec_not_eligible" }), text: async () => "" });
    await sendReferral({ query: h.query } as any, "app-b");
    expect(referrals[0]).toMatchObject({ status: "not_eligible", last_error: "quebec_not_eligible" });
  });

  it("staff turn PGI on for an application, fill in fields, and list referrals", async () => {
    const created = await request(app()).post("/api/pgi/referrals/app-2").set("Authorization", `Bearer ${token("Staff")}`);
    expect(created.status).toBe(201);
    expect(referrals[0]).toMatchObject({ application_id: "app-2", referring_user_id: USER });
    const patched = await request(app()).patch("/api/pgi/referrals/app-2").set("Authorization", `Bearer ${token("Staff")}`).send({ naics_code: "236220", loan_type: "Other Secured Loan" });
    expect(patched.status).toBe(200);
    expect(referrals[0]!.input).toMatchObject({ naics_code: "236220", loan_type: "Other Secured Loan", business_legal_name: "Two Co" });
    const list = await request(app()).get("/api/pgi/referrals").set("Authorization", `Bearer ${token("Staff")}`);
    expect(list.body.referrals).toHaveLength(1);
    expect((await request(app()).get("/api/pgi/referrals/nope").set("Authorization", `Bearer ${token("Staff")}`)).status).toBe(404);
    expect((await request(app()).get("/api/pgi/referrals")).status).toBe(401);
  });

  it("a reply goes to the partner with our message id", async () => {
    referrals.push({ id: "ref-c", application_id: "app-c", status: "awaiting_client", input: {}, bi_application_id: "bi-1", unread_count: 2 });
    const r = await request(app()).post("/api/pgi/referrals/app-c/messages").set("Authorization", `Bearer ${token("Staff")}`).send({ body: "A/R aging uploaded" });
    expect(r.status).toBe(201);
    expect(r.body.sent).toBe(true);
    const call = fetchMock.mock.calls.find(([u]: any) => /\/referrals\/app-c\/messages$/.test(u))!;
    expect(JSON.parse(call[1].body)).toMatchObject({ body: "A/R aging uploaded", author_name: "Sam Broker", ks_message_id: "m1" });
    await request(app()).post("/api/pgi/referrals/app-c/read").set("Authorization", `Bearer ${token("Staff")}`);
    expect(referrals[0]!.unread_count).toBe(0);
  });

  it("the worker syncs open referrals", async () => {
    referrals.push({ id: "ref-d", application_id: "app-d", status: "awaiting_client", input: {}, bi_application_id: "bi-1", unread_count: 0 });
    referrals.push({ id: "ref-e", application_id: "app-e", status: "policy_issued", input: {}, bi_application_id: "bi-2", unread_count: 0 });
    const r = await runPgiTick({ query: h.query } as any);
    expect(r.synced).toBe(1);
  });
});

describe("POST /api/pgi/bi-events (partner callbacks)", () => {
  const event = {
    event_id: "evt-1", type: "doc_request", ks_application_id: "app-1", bi_application_id: "bi-1", at: "2026-10-22T15:00:00Z",
    message: { id: "evt-1", body: "Please send the A/R aging", author_name: "Andrew, Boreal Insurance" },
    missing_documents: [{ slot: "ar_aging", label: "Accounts Receivable Aging Summary" }], missing_fields: [], status: null,
  };
  beforeEach(() => {
    referrals.push({ id: "ref-a", application_id: "app-1", status: "awaiting_client", input: {}, referring_user_id: USER, bi_application_id: "bi-1", unread_count: 0 });
  });

  it("refuses a bad signature, another source and a stale timestamp", async () => {
    expect((await signed(event, { secret: "x".repeat(64) })).status).toBe(401);
    expect((await signed(event, { source: "src-2" })).status).toBe(401);
    expect((await signed(event, { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(409);
    expect(messages).toHaveLength(0);
  });

  it("stores the request once and tells the referring seat, the admins and the support inbox", async () => {
    const r = await signed(event);
    expect(r.status).toBe(202);
    expect(r.body.stored).toBe(true);
    expect(messages).toHaveLength(1);
    expect(referrals[0]!.unread_count).toBe(1);
    expect(h.notify.mock.calls.map((c) => c[0].userId).sort()).toEqual(["admin-1", USER].sort());
    expect(h.notify.mock.calls[0]![0]).toMatchObject({ applicationId: "app-1", type: "pgi_partner_update", title: "The insurance partner needs documents" });
    expect(h.mail).toHaveBeenCalledWith(expect.objectContaining({ to: ["help@acme.example"] }));
    expect(String((h.mail.mock.calls[0] as any)[0].text)).toContain("- Accounts Receivable Aging Summary");
    const again = await signed(event);
    expect(again.body.stored).toBe(false);
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it("a status update with the referral fee", async () => {
    const r = await signed({ ...event, event_id: "evt-2", type: "status", status: "policy_issued", message: { body: "Bound" },
      referral_fee: { amount: 108, currency: "CAD", status: "accrued" } });
    expect(r.status).toBe(202);
    expect(referrals[0]).toMatchObject({ status: "policy_issued", referral_fee_amount: 108 });
  });

  it("404 for an application this server never referred", async () => {
    expect((await signed({ ...event, ks_application_id: "other" })).status).toBe(404);
  });
});
