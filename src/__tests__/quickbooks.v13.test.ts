// KS_SERVER_v13_QUICKBOOKS - QuickBooks Online fee invoices. Every Intuit call is mocked (global fetch); the
// database is an in-memory fake that answers by SQL content.
import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  states: [] as Array<{ nonce_hash: string; user_id: string; expires_at: Date; consumed_at: Date | null }>,
  conn: null as null | Record<string, any>,
  invoices: new Map<string, Record<string, any>>(),
  app: null as null | Record<string, any>,
  role: "Admin",
}));

vi.mock("../middleware/auth.js", () => ({
  auth: (req: any, _res: any, next: any) => { req.user = { id: "u-admin", userId: "u-admin", role: db.role }; next(); },
  requireAuth: (req: any, _res: any, next: any) => { req.user = { id: "u-admin", userId: "u-admin", role: db.role }; next(); },
  requireAuthorization: (opts: { roles?: string[] } = {}) => (req: any, res: any, next: any) =>
    (!opts.roles || opts.roles.includes(req.user?.role) ? next() : res.status(403).json({ error: "forbidden" })),
}));

function invoiceRow(id: string) {
  let r = db.invoices.get(id);
  if (!r) {
    r = { application_id: id, realm_id: null, customer_id: null, invoice_id: null, doc_number: null, amount: null, fee_percent: null, base_amount: null, funded: false, payment_id: null, status: "none", sync_status: "queued", last_error: null, attempts: 0, next_attempt_at: new Date(), locked_until: null, synced_at: null };
    db.invoices.set(id, r);
  }
  return r;
}

const fakeQuery = vi.hoisted(() => vi.fn(async (sql: string, params: any[] = []) => {
  const s = sql.replace(/\s+/g, " ").trim();
  const none = { rows: [] as any[], rowCount: 0 };
  // OAuth state
  if (/^INSERT INTO quickbooks_oauth_states/.test(s)) { db.states.push({ nonce_hash: params[0], user_id: params[1], expires_at: params[2], consumed_at: null }); return { rows: [], rowCount: 1 }; }
  if (/^DELETE FROM quickbooks_oauth_states/.test(s)) return none;
  if (/^UPDATE quickbooks_oauth_states/.test(s)) {
    const row = db.states.find((r) => r.nonce_hash === params[0] && !r.consumed_at && r.expires_at.getTime() > Date.now());
    if (!row) return none;
    row.consumed_at = new Date();
    return { rows: [{ user_id: row.user_id }], rowCount: 1 };
  }
  // Connection
  if (/^INSERT INTO quickbooks_connection/.test(s)) {
    db.conn = { realm_id: params[0], company_name: params[1], environment: params[2], access_token_enc: params[3], refresh_token_enc: params[4], access_token_expires_at: params[5], status: "connected", last_error: null, tax_code_id: db.conn?.tax_code_id ?? null, tax_code_name: null, item_id: null, connected_at: new Date() };
    return { rows: [], rowCount: 1 };
  }
  if (/^SELECT realm_id, company_name/.test(s)) return { rows: db.conn ? [db.conn] : [], rowCount: db.conn ? 1 : 0 };
  if (/^UPDATE quickbooks_connection SET access_token_enc = \$1/.test(s)) { Object.assign(db.conn!, { access_token_enc: params[0], refresh_token_enc: params[1], access_token_expires_at: params[2] }); return { rows: [], rowCount: 1 }; }
  if (/^UPDATE quickbooks_connection SET status = 'reauth_required'/.test(s)) { Object.assign(db.conn!, { status: "reauth_required", access_token_enc: null, refresh_token_enc: null }); return { rows: [], rowCount: 1 }; }
  if (/^UPDATE quickbooks_connection SET item_id/.test(s)) { db.conn!.item_id = params[0]; return { rows: [], rowCount: 1 }; }
  if (/^UPDATE quickbooks_connection SET tax_code_id/.test(s)) { if (!db.conn) return none; Object.assign(db.conn, { tax_code_id: params[0], tax_code_name: params[1] }); return { rows: [], rowCount: 1 }; }
  if (/^DELETE FROM quickbooks_connection/.test(s)) { db.conn = null; return { rows: [], rowCount: 1 }; }
  // Invoices / outbox
  if (/^INSERT INTO quickbooks_invoices \(application_id, sync_status, next_attempt_at, attempts, updated_at\)/.test(s)) {
    if (db.conn?.status !== "connected") return none;
    const existing = db.invoices.get(params[0]);
    if (existing && existing.status === "paid") return none;
    const r = invoiceRow(params[0]);
    Object.assign(r, { sync_status: "queued", next_attempt_at: new Date(), attempts: 0 });
    return { rows: [], rowCount: 1 };
  }
  if (/^INSERT INTO quickbooks_invoices \(application_id, sync_status, next_attempt_at\) SELECT m.application_id/.test(s)) {
    if (db.conn?.status !== "connected" || !db.app || db.app.fee_status !== "signed" || db.invoices.has(db.app.id)) return none;
    invoiceRow(db.app.id);
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE quickbooks_invoices q SET sync_status = 'queued'/.test(s)) {
    let n = 0;
    for (const r of db.invoices.values()) if (db.app?.funded_at && r.status === "open" && r.sync_status === "ok" && !r.next_attempt_at) { Object.assign(r, { sync_status: "queued", next_attempt_at: new Date() }); n++; }
    return { rows: [], rowCount: n };
  }
  if (/^UPDATE quickbooks_invoices SET locked_until/.test(s)) {
    const r = db.invoices.get(params[0]);
    if (!r || !r.next_attempt_at || (r.locked_until && r.locked_until > new Date())) return none;
    r.locked_until = new Date(Date.now() + 300000);
    return { rows: [{ attempts: r.attempts }], rowCount: 1 };
  }
  if (/^SELECT application_id FROM quickbooks_invoices WHERE next_attempt_at IS NOT NULL/.test(s)) {
    return { rows: [...db.invoices.values()].filter((r) => r.next_attempt_at && r.next_attempt_at <= new Date()).map((r) => ({ application_id: r.application_id })), rowCount: 1 };
  }
  if (/^SELECT application_id, realm_id, customer_id/.test(s)) { const r = db.invoices.get(params[0]); return { rows: r ? [{ ...r, amount: r.amount === null ? null : String(r.amount) }] : [], rowCount: r ? 1 : 0 }; }
  if (/^SELECT invoice_id, doc_number/.test(s)) { const r = db.invoices.get(params[0]); return { rows: r ? [r] : [], rowCount: r ? 1 : 0 }; }
  if (/^UPDATE quickbooks_invoices SET sync_status = 'ok', last_error = NULL, attempts = 0/.test(s)) { Object.assign(db.invoices.get(params[0])!, { sync_status: "ok", last_error: null, attempts: 0, next_attempt_at: null, locked_until: null, synced_at: new Date() }); return { rows: [], rowCount: 1 }; }
  if (/^UPDATE quickbooks_invoices SET sync_status = CASE/.test(s)) { Object.assign(db.invoices.get(params[0])!, { sync_status: params[1] ? "failed" : "ok", last_error: params[1], next_attempt_at: null, locked_until: null }); return { rows: [], rowCount: 1 }; }
  if (/^UPDATE quickbooks_invoices SET sync_status = \$2/.test(s)) {
    Object.assign(db.invoices.get(params[0])!, { sync_status: params[1], last_error: params[2], attempts: params[3], next_attempt_at: params[1] === "failed" ? null : new Date(Date.now() + Number(params[4]) * 60000), locked_until: null });
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE quickbooks_invoices SET /.test(s)) {
    const cols = [...s.matchAll(/(\w+) = \$(\d+)/g)].map((m) => [m[1], Number(m[2])] as const);
    const r = db.invoices.get(params[0])!;
    for (const [c, i] of cols) r[c!] = params[i - 1];
    return { rows: [], rowCount: 1 };
  }
  // Application + agreement
  if (/^SELECT a.id::text AS id, a.name, a.requested_amount/.test(s)) return { rows: db.app ? [db.app] : [], rowCount: db.app ? 1 : 0 };
  throw new Error("unexpected SQL in test: " + s.slice(0, 120));
}));

vi.mock("../db.js", () => ({ pool: { query: fakeQuery }, dbQuery: fakeQuery, runQuery: fakeQuery }));

import quickbooksRoutes from "../routes/quickbooks.js";
import { pool } from "../db.js";
import { mediaFee } from "../services/quickbooks/feeMath.js";
import { BACKOFF_MINUTES, enqueueQuickBooksSync, processInvoiceJob, runInvoiceWorkerOnce, customerFor, qboQuote } from "../services/quickbooks/feeInvoice.js";
import { getQboClient } from "../services/quickbooks/qboAuth.js";
import { qboConfig, qboConfigProblem } from "../services/quickbooks/qboConfig.js";
import { decryptToken, encryptToken } from "../services/workspace/tokenCrypto.js";

const app = express();
app.use(express.json());
app.use("/api/quickbooks", quickbooksRoutes);

const API = "https://sandbox-quickbooks.api.intuit.com/v3/company/realm-9/";
type Call = { url: string; method: string; body: any; headers: Record<string, string> };
let calls: Call[] = [];
let failNext: { match: RegExp; status: number } | null = null;
let tokenBody: any;
const store = { customers: [] as any[], items: [] as any[], invoices: new Map<string, any>(), payments: [] as any[] };

function intuit(url: string, init: any): Response {
  const method = String(init?.method ?? "GET");
  const body = init?.body ? (String(init.body).startsWith("{") ? JSON.parse(init.body) : String(init.body)) : null;
  calls.push({ url, method, body, headers: init?.headers ?? {} });
  if (failNext && failNext.match.test(url)) { const s = failNext.status; failNext = null; return new Response(JSON.stringify({ Fault: { Error: [{ Message: "Boom", Detail: "Service down", code: "500" }] } }), { status: s }); }
  if (url.startsWith("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer")) return new Response(JSON.stringify(tokenBody), { status: tokenBody.error ? 400 : 200 });
  if (url.startsWith("https://developer.api.intuit.com/v2/oauth2/tokens/revoke")) return new Response("", { status: 200 });
  if (!url.startsWith(API)) return new Response("unexpected " + url, { status: 599 });
  const path = new URL(url).pathname.replace("/v3/company/realm-9/", "");
  const query = new URL(url).searchParams.get("query") ?? "";
  if (path.startsWith("companyinfo/")) return Response.json({ CompanyInfo: { CompanyName: "Northwind Capital" } });
  if (path === "query") {
    if (/from Customer/.test(query)) return Response.json({ QueryResponse: store.customers.length ? { Customer: store.customers } : {} });
    if (/from Item/.test(query)) return Response.json({ QueryResponse: store.items.length ? { Item: store.items } : {} });
    if (/from Account/.test(query)) return Response.json({ QueryResponse: { Account: [{ Id: "79" }] } });
    if (/from TaxCode/.test(query)) return Response.json({ QueryResponse: { TaxCode: [{ Id: "4", Name: "Exempt" }, { Id: "6", Name: "GST" }] } });
  }
  if (path === "customer" && method === "POST") { const c = { Id: "C1", ...body }; store.customers.push(c); return Response.json({ Customer: c }); }
  if (path === "item" && method === "POST") { const it = { Id: "I1", ...body }; store.items.push(it); return Response.json({ Item: it }); }
  if (path === "invoice" && method === "POST") {
    if (body.Id) { const inv = store.invoices.get(body.Id); Object.assign(inv, { Line: body.Line, TotalAmt: body.Line[0].Amount, Balance: body.Line[0].Amount, SyncToken: String(Number(inv.SyncToken) + 1) }); return Response.json({ Invoice: inv }); }
    const inv = { Id: "INV1", DocNumber: "1001", SyncToken: "0", ...body, TotalAmt: body.Line[0].Amount, Balance: body.Line[0].Amount };
    store.invoices.set(inv.Id, inv);
    return Response.json({ Invoice: inv });
  }
  if (path.startsWith("invoice/") && method === "GET") return Response.json({ Invoice: store.invoices.get(path.split("/")[1]!) });
  if (path === "payment" && method === "POST") { const p = { Id: "P1", ...body }; store.payments.push(p); const inv = store.invoices.get(body.Line[0].LinkedTxn[0].TxnId); inv.Balance = 0; return Response.json({ Payment: p }); }
  return new Response("unhandled " + method + " " + path, { status: 599 });
}

function setEnv() {
  process.env.QBO_CLIENT_ID = "qbo-client";
  process.env.QBO_CLIENT_SECRET = "qbo-secret";
  process.env.QBO_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.QBO_REDIRECT_URI = "https://server.example/api/quickbooks/oauth/callback";
  delete process.env.QBO_ENVIRONMENT;
}

function connected(extra: Record<string, any> = {}) {
  db.conn = {
    realm_id: "realm-9", company_name: "Northwind Capital", environment: "sandbox", status: "connected", last_error: null,
    access_token_enc: encryptToken("AT-live", process.env, "QBO_TOKEN_ENCRYPTION_KEY"),
    refresh_token_enc: encryptToken("RT-live", process.env, "QBO_TOKEN_ENCRYPTION_KEY"),
    access_token_expires_at: new Date(Date.now() + 3600_000), tax_code_id: null, tax_code_name: null, item_id: null, connected_at: new Date(Date.now() - 60_000), ...extra,
  };
}

beforeEach(() => {
  db.states.length = 0; db.conn = null; db.invoices.clear(); db.role = "Admin";
  db.app = { id: "app-1", name: "Acme Films Ltd", requested_amount: "250000", funded_amount: null, funded_at: null, metadata: { applicant: { email: "pat@acme.example", firstName: "Pat", lastName: "Lee" } }, fee_status: "signed", fee_percent: null, fee_amount: null, signer_name: "Pat Lee", signer_email: "pat@acme.example" };
  calls = []; failNext = null; store.customers = []; store.items = []; store.invoices = new Map(); store.payments = [];
  tokenBody = { access_token: "AT-1", refresh_token: "RT-1", expires_in: 3600, x_refresh_token_expires_in: 8640000 };
  setEnv();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any = {}) => intuit(String(url), init)));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ["QBO_CLIENT_ID", "QBO_CLIENT_SECRET", "QBO_TOKEN_ENCRYPTION_KEY", "QBO_REDIRECT_URI", "QBO_ENVIRONMENT"]) delete process.env[k];
});

describe("fee maths", () => {
  it("is 2% of the requested amount before funding and of the funded amount after", () => {
    expect(mediaFee({ feePercent: null, feeAmount: null, requestedAmount: "250000", fundedAmount: null, funded: false })).toEqual({ amount: 5000, percent: 2, base: 250000, description: "Media funding fee (2% of funding)" });
    expect(mediaFee({ feePercent: null, feeAmount: null, requestedAmount: 250000, fundedAmount: "180000.50", funded: true })?.amount).toBe(3600.01);
  });
  it("uses a recorded percent, a fixed fee wins, and nothing is invoiced without an amount", () => {
    expect(mediaFee({ feePercent: "1.5", feeAmount: null, requestedAmount: 100000, fundedAmount: null, funded: false })?.description).toBe("Media funding fee (1.5% of funding)");
    expect(mediaFee({ feePercent: "1.5", feeAmount: "750", requestedAmount: 100000, fundedAmount: 90000, funded: true })).toMatchObject({ amount: 750, description: "Media funding fee (fixed fee)" });
    expect(mediaFee({ feePercent: null, feeAmount: null, requestedAmount: null, fundedAmount: null, funded: false })).toBeNull();
  });
  it("escapes quotes in QuickBooks queries and keeps colons out of customer names", () => {
    expect(qboQuote("O'Brien")).toBe("O\\'Brien");
    expect(customerFor({ name: "A: B", metadata: {}, signer_name: null, signer_email: null }).displayName).toBe("A  B");
  });
});

describe("feature off when QBO_* is unset", () => {
  it("reports why, queues nothing and the worker does nothing", async () => {
    delete process.env.QBO_CLIENT_ID;
    expect(qboConfigProblem()).toMatch(/QBO_CLIENT_ID/);
    expect(qboConfig()).toBeNull();
    const r = await request(app).get("/api/quickbooks/status");
    expect(r.body).toMatchObject({ configured: false, connected: false });
    expect(r.body.reason).toMatch(/not set up/);
    expect(await enqueueQuickBooksSync(pool as any, "app-1", "test")).toBe(false);
    expect(await runInvoiceWorkerOnce(pool as any)).toEqual({ queued: 0, ran: 0 });
    expect((await request(app).post("/api/quickbooks/connect")).status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});

describe("connect / callback / disconnect", () => {
  async function connect() {
    const r = await request(app).post("/api/quickbooks/connect");
    expect(r.status).toBe(200);
    const url = new URL(r.body.url);
    return { url, state: url.searchParams.get("state")!, cookie: String((r.headers["set-cookie"] as unknown as string[])[0]).split(";")[0]! };
  }

  it("is admin only", async () => {
    db.role = "Staff";
    expect((await request(app).get("/api/quickbooks/status")).status).toBe(403);
    expect((await request(app).post("/api/quickbooks/connect")).status).toBe(403);
    expect((await request(app).post("/api/quickbooks/disconnect")).status).toBe(403);
  });

  it("sends the admin to Intuit with the accounting scope and a hashed single-use state", async () => {
    const { url, state } = await connect();
    expect(url.origin + url.pathname).toBe("https://appcenter.intuit.com/connect/oauth2");
    expect(url.searchParams.get("scope")).toBe("com.intuit.quickbooks.accounting");
    expect(url.searchParams.get("redirect_uri")).toBe("https://server.example/api/quickbooks/oauth/callback");
    expect(db.states[0]!.nonce_hash).toBe(createHash("sha256").update(state).digest("hex"));
    expect(db.states[0]!.user_id).toBe("u-admin");
  });

  it("exchanges the code, stores tokens encrypted, and refuses the same state twice", async () => {
    const { state, cookie } = await connect();
    const cb = await request(app).get(`/api/quickbooks/oauth/callback?code=CODE1&state=${state}&realmId=realm-9`).set("Cookie", cookie);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toMatch(/quickbooks=connected/);
    const tokenCall = calls.find((c) => c.url.startsWith("https://oauth.platform.intuit.com"))!;
    expect(tokenCall.headers.Authorization).toBe("Basic " + Buffer.from("qbo-client:qbo-secret").toString("base64"));
    expect(String(tokenCall.body)).toContain("grant_type=authorization_code");
    expect(db.conn!.realm_id).toBe("realm-9");
    expect(db.conn!.company_name).toBe("Northwind Capital");
    expect(db.conn!.refresh_token_enc).not.toContain("RT-1");
    expect(decryptToken(db.conn!.refresh_token_enc, process.env, "QBO_TOKEN_ENCRYPTION_KEY")).toBe("RT-1");
    const again = await request(app).get(`/api/quickbooks/oauth/callback?code=CODE1&state=${state}&realmId=realm-9`).set("Cookie", cookie);
    expect(again.headers.location).toMatch(/quickbooks=error&reason=state/);
  });

  it("rejects a state cookie that does not match", async () => {
    const { state } = await connect();
    const cb = await request(app).get(`/api/quickbooks/oauth/callback?code=C&state=${state}&realmId=realm-9`).set("Cookie", "qbo_oauth_nonce=other");
    expect(cb.headers.location).toMatch(/reason=state/);
    expect(db.conn).toBeNull();
  });

  it("disconnect revokes the refresh token at Intuit and forgets the connection", async () => {
    connected();
    const r = await request(app).post("/api/quickbooks/disconnect");
    expect(r.body).toMatchObject({ ok: true, revoked: true });
    const revoke = calls.find((c) => c.url.startsWith("https://developer.api.intuit.com/v2/oauth2/tokens/revoke"))!;
    expect(revoke.body).toEqual({ token: "RT-live" });
    expect(db.conn).toBeNull();
  });

  it("saves the tax code setting and lists tax codes", async () => {
    connected();
    expect((await request(app).get("/api/quickbooks/tax-codes")).body.taxCodes).toEqual([{ id: "4", name: "Exempt", description: null }, { id: "6", name: "GST", description: null }]);
    const r = await request(app).put("/api/quickbooks/settings").send({ taxCodeId: "4", taxCodeName: "Exempt" });
    expect(r.body).toMatchObject({ connected: true, taxCodeId: "4", taxCodeName: "Exempt" });
  });
});

describe("token refresh", () => {
  it("refreshes an expired access token and stores the rotated refresh token", async () => {
    connected({ access_token_expires_at: new Date(Date.now() - 1000) });
    tokenBody = { access_token: "AT-2", refresh_token: "RT-2", expires_in: 3600 };
    const q = (await getQboClient(pool as any))!;
    await q.query("select Id from Item where Name = 'x'");
    const refresh = calls.find((c) => c.url.startsWith("https://oauth.platform.intuit.com"))!;
    expect(String(refresh.body)).toContain("refresh_token=RT-live");
    expect(decryptToken(db.conn!.refresh_token_enc, process.env, "QBO_TOKEN_ENCRYPTION_KEY")).toBe("RT-2");
    expect(calls.at(-1)!.headers.Authorization).toBe("Bearer AT-2");
  });
  it("marks the connection for reconnect when Intuit rejects the refresh token", async () => {
    connected({ access_token_expires_at: new Date(Date.now() - 1000) });
    tokenBody = { error: "invalid_grant" };
    const q = (await getQboClient(pool as any))!;
    await expect(q.query("select Id from Item")).rejects.toThrow(/intuit_token_400/);
    expect(db.conn!.status).toBe("reauth_required");
  });
});

describe("fee invoice sync", () => {
  it("signed agreement: finds or creates the customer and creates the invoice on the requested amount", async () => {
    connected({ tax_code_id: "4" });
    expect(await enqueueQuickBooksSync(pool as any, "app-1", "fee_agreement_signed")).toBe(true);
    expect(await processInvoiceJob(pool as any, "app-1")).toBe("done");
    const inv = store.invoices.get("INV1");
    expect(inv.CustomerRef).toEqual({ value: "C1" });
    expect(inv.Line[0]).toMatchObject({ Amount: 5000, Description: "Media funding fee (2% of funding)", SalesItemLineDetail: { ItemRef: { value: "I1" }, TaxCodeRef: { value: "4" } } });
    expect(store.customers[0]).toMatchObject({ DisplayName: "Acme Films Ltd", PrimaryEmailAddr: { Address: "pat@acme.example" } });
    expect(calls.filter((c) => c.method === "POST" && /\/invoice\?/.test(c.url))[0]!.url).toMatch(/requestid=[0-9a-f]{40}/);
    expect(db.invoices.get("app-1")).toMatchObject({ invoice_id: "INV1", doc_number: "1001", amount: 5000, status: "open", sync_status: "ok", next_attempt_at: null });
    expect(db.invoices.get("app-1")!.synced_at).toBeInstanceOf(Date);
  });

  it("reuses an existing customer and item", async () => {
    connected();
    store.customers.push({ Id: "C77", DisplayName: "Acme Films Ltd" });
    store.items.push({ Id: "I55", Name: "Media funding fee" });
    await enqueueQuickBooksSync(pool as any, "app-1", "t");
    await processInvoiceJob(pool as any, "app-1");
    expect(store.customers).toHaveLength(1);
    expect(store.invoices.get("INV1").CustomerRef).toEqual({ value: "C77" });
    expect(store.invoices.get("INV1").Line[0].SalesItemLineDetail.ItemRef).toEqual({ value: "I55" });
  });

  it("funded: moves the invoice to the funded amount and records a payment so it shows paid; running again changes nothing", async () => {
    connected();
    await enqueueQuickBooksSync(pool as any, "app-1", "signed");
    await processInvoiceJob(pool as any, "app-1");
    db.app!.funded_at = new Date();
    db.app!.funded_amount = "200000";
    const worker = await runInvoiceWorkerOnce(pool as any);
    expect(worker.queued).toBe(1);
    const inv = store.invoices.get("INV1");
    expect(inv.TotalAmt).toBe(4000);
    expect(inv.Balance).toBe(0);
    expect(store.payments).toHaveLength(1);
    expect(store.payments[0]).toMatchObject({ CustomerRef: { value: "C1" }, TotalAmt: 4000, Line: [{ Amount: 4000, LinkedTxn: [{ TxnId: "INV1", TxnType: "Invoice" }] }] });
    expect(db.invoices.get("app-1")).toMatchObject({ status: "paid", amount: 4000, payment_id: "P1", funded: true, sync_status: "ok" });
    const before = calls.length;
    expect(await runInvoiceWorkerOnce(pool as any)).toEqual({ queued: 0, ran: 0 });
    expect(await enqueueQuickBooksSync(pool as any, "app-1", "again")).toBe(false);
    expect(calls.length).toBe(before);
    expect(store.invoices.size).toBe(1);
  });

  it("does nothing for an unsigned agreement", async () => {
    connected();
    db.app!.fee_status = "pending";
    await enqueueQuickBooksSync(pool as any, "app-1", "t");
    expect(await processInvoiceJob(pool as any, "app-1")).toBe("skipped");
    expect(store.invoices.size).toBe(0);
    expect(db.invoices.get("app-1")).toMatchObject({ sync_status: "ok", last_error: null });
  });

  it("logs a failure, backs off, gives up after the last retry, and Retry queues it again", async () => {
    connected();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await enqueueQuickBooksSync(pool as any, "app-1", "t");
    failNext = { match: /\/invoice\?/, status: 500 };
    expect(await processInvoiceJob(pool as any, "app-1")).toBe("retrying");
    const row = db.invoices.get("app-1")!;
    expect(row).toMatchObject({ sync_status: "retrying", attempts: 1, invoice_id: null });
    expect(row.last_error).toMatch(/Boom/);
    expect(err).toHaveBeenCalledWith("[quickbooks] invoice sync failed", expect.objectContaining({ applicationId: "app-1" }));
    // Exhaust the retries.
    row.attempts = BACKOFF_MINUTES.length;
    row.next_attempt_at = new Date();
    failNext = { match: /\/invoice\?/, status: 500 };
    expect(await processInvoiceJob(pool as any, "app-1")).toBe("failed");
    expect(db.invoices.get("app-1")).toMatchObject({ sync_status: "failed", next_attempt_at: null });
    const view = await request(app).get("/api/quickbooks/applications/app-1/invoice");
    expect(view.body.invoice).toMatchObject({ syncStatus: "failed", canRetry: true });
    const retry = await request(app).post("/api/quickbooks/applications/app-1/invoice/retry");
    expect(retry.body).toMatchObject({ ok: true, result: "done", invoice: { invoiceId: "INV1", docNumber: "1001", amount: 5000, status: "open", syncStatus: "ok", canRetry: false } });
    expect(store.invoices.size).toBe(1);
    err.mockRestore();
  });
});
