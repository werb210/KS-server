// KS_SERVER_v8_SERVICE_STATUS - suspended / cancelled licensees: the status from operations, the /api gate, paused
// workers, the data export and the 180-day purge (dry run and real, against a database fake answering by SQL content).
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { PassThrough } from "node:stream";
import { inflateRawSync } from "node:zlib";

const { queryMock, sendMock } = vi.hoisted(() => ({ queryMock: vi.fn(), sendMock: vi.fn() }));

vi.mock("../../db.js", () => ({ pool: { query: queryMock }, db: { query: queryMock }, runQuery: queryMock }));
vi.mock("../email.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../email.js")>();
  return { ...real, sendPlanMail: sendMock };
});

import planRoutes from "../../routes/plan.js";
import { clearPlanCache } from "../state.js";
import { serviceGate, openWhileBlocked } from "../serviceGate.js";
import { claimedTick, setServiceStoppedCheck, workersPaused } from "../../workers/claim.js";
import { writeExport } from "../dataExport.js";
import { PURGE_KEEP_TABLES, runLicenseePurge } from "../purge.js";

type Row = Record<string, any>;
let plan: Row;
let tables: Record<string, Row[]>;
let truncated: string[];

function fakeDb(sql: string, p: unknown[] = []): { rows: any[]; rowCount: number } {
  const ok = (rows: any[]) => ({ rows, rowCount: rows.length });
  if (/FROM licensee_plan WHERE id = 1/.test(sql) && /^\s*SELECT/.test(sql)) return ok([{ ...plan }]);
  if (/INSERT INTO licensee_plan/.test(sql)) return ok([]);
  if (/UPDATE licensee_plan SET updated_at/.test(sql)) {
    const st = sql.match(/service_status = \$(\d+)/);
    const pl = sql.match(/[^_]plan = \$(\d+)/);
    if (pl) plan.plan = p[Number(pl[1]) - 1];
    if (st) {
      plan.service_status = p[Number(st[1]) - 1];
      if (/cancelled_at = COALESCE/.test(sql)) plan.cancelled_at ??= new Date();
      if (/cancelled_at = NULL/.test(sql)) Object.assign(plan, { cancelled_at: null, purge_warning_7_sent_at: null, purge_warning_1_sent_at: null });
    }
    return ok([]);
  }
  const warn = sql.match(/UPDATE licensee_plan SET (purge_warning_\d_sent_at) = (now\(\)|NULL)/);
  if (warn) {
    const [, col, val] = warn;
    if (val === "NULL") { plan[col] = null; return ok([]); }
    if (plan[col] || plan.service_status !== "cancelled") return ok([]);
    plan[col] = new Date();
    return ok([{ id: 1 }]);
  }
  if (/UPDATE licensee_plan SET purged_at/.test(sql)) { plan.purged_at = new Date(); return ok([]); }
  if (/FROM plan_trial_feature_usage/.test(sql)) return ok([]);
  if (/AS used_bytes/.test(sql)) return ok([{ used_bytes: "0" }]);
  if (/AS seats FROM users/.test(sql)) return ok([{ seats: 1 }]);
  if (/SELECT email FROM users WHERE role = 'Admin'/.test(sql)) return ok([{ email: "owner@prairie.example" }]);
  if (/FROM information_schema.tables/.test(sql)) return ok(Object.keys(tables).sort().map((table_name) => ({ table_name })));
  if (/FROM information_schema.columns/.test(sql)) {
    const cols = Object.keys(tables[String(p[0])]?.[0] ?? {});
    return ok(cols.map((column_name) => ({ column_name })));
  }
  const page = sql.match(/SELECT \* FROM "(\w+)" ORDER BY ctid LIMIT (\d+) OFFSET (\d+)/);
  if (page) return ok((tables[page[1]] ?? []).slice(Number(page[3]), Number(page[3]) + Number(page[2])));
  const files = sql.match(/AS file_key.*FROM "(\w+)"/s);
  if (files) return ok((tables[files[1]] ?? []).filter((r) => r.blob_name).map((r) => ({ id: r.id, file_key: r.blob_name, file_name: r.filename })));
  if (/^TRUNCATE/.test(sql)) { truncated = [...sql.matchAll(/"(\w+)"/g)].map((m) => m[1]); return ok([]); }
  return ok([]);
}

const token = (role: string) => jwt.sign({ sub: "11111111-1111-4111-8111-111111111111", id: "11111111-1111-4111-8111-111111111111", role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
const db = { query: queryMock };

beforeEach(() => {
  plan = { plan: "growth", trial_started_at: null, trial_ends_at: null, extra_storage_blocks: 0, service_status: "active", cancelled_at: null };
  tables = {};
  truncated = [];
  clearPlanCache();
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: unknown, params?: unknown[]) => fakeDb(String(sql), params ?? []));
  sendMock.mockReset();
  sendMock.mockResolvedValue({ ok: true });
  setServiceStoppedCheck(null);
  delete process.env.KS_OPS_KEY;
});

describe("PUT /api/plan { status }", () => {
  const app = () => { const a = express(); a.use(express.json()); a.use("/api/plan", planRoutes); return a; };

  it("stores the status from operations, records cancelled_at, and GET /api/plan shows it", async () => {
    process.env.KS_OPS_KEY = "secret";
    expect((await request(app()).put("/api/plan").set("X-KS-Ops-Key", "secret").send({ status: "frozen" })).status).toBe(400);
    const r = await request(app()).put("/api/plan").set("X-KS-Ops-Key", "secret").send({ status: "cancelled" });
    expect(r.status).toBe(200);
    expect(r.body.service_status).toBe("cancelled");
    expect(r.body.cancelled_at).toBeTruthy();
    expect(new Date(r.body.purge_after).getTime() - new Date(r.body.cancelled_at).getTime()).toBe(180 * 86_400_000);
    const back = await request(app()).put("/api/plan").set("X-KS-Ops-Key", "secret").send({ status: "active" });
    expect(back.body).toMatchObject({ service_status: "active", cancelled_at: null });
    const g = await request(app()).get("/api/plan").set("Authorization", `Bearer ${token("Staff")}`);
    expect(g.body.service_status).toBe("active");
  });
});

describe("the /api service gate", () => {
  const app = () => {
    const a = express();
    a.use(express.json());
    const api = express.Router();
    api.use(serviceGate(() => db, { always: true }));
    api.all("*", (_req, res) => { res.json({ ok: true }); });
    a.use("/api", api);
    return a;
  };

  it("lets everything through when active, trial or past_due", async () => {
    for (const s of ["active", "trial", "past_due"]) {
      plan.service_status = s;
      clearPlanCache();
      expect((await request(app()).post("/api/applications").send({})).status).toBe(200);
    }
  });

  it("suspended: everything answers 423 service_suspended except sign-in, Plan, branding and Help", async () => {
    plan.service_status = "suspended";
    for (const [m, path] of [["post", "/api/applications"], ["post", "/api/crm/contacts"], ["post", "/api/telephony/outbound-call"],
      ["post", "/api/communications/sms"], ["post", "/api/email/send"], ["post", "/api/maya/message"], ["get", "/api/crm/contacts"],
      ["post", "/api/client/submissions"], ["post", "/api/webhooks/twilio/sms"], ["get", "/api/export"]] as const) {
      const r = await (request(app()) as any)[m](path).send({});
      expect(r.status, path).toBe(423);
      expect(r.body).toMatchObject({ error: "service_suspended", service_status: "suspended" });
      expect(r.body.message).toMatch(/temporarily unavailable/);
    }
    for (const path of ["/api/auth/me", "/api/plan", "/api/plan/usage-report", "/api/licensee", "/api/licensee/admin", "/api/support/tickets"]) {
      expect((await request(app()).get(path)).status, path).toBe(200);
    }
  });

  it("cancelled: the same, plus the data export stays open", async () => {
    plan.service_status = "cancelled";
    expect((await request(app()).post("/api/ai/start").send({})).status).toBe(423); // no assistant
    expect((await request(app()).get("/api/export")).status).toBe(200);
    expect(openWhileBlocked("/export", "suspended")).toBe(false);
    expect(openWhileBlocked("/licensee/branding-x", "cancelled")).toBe(false);
  });
});

describe("workers pause while the service is stopped", () => {
  it("skips ticks except the plan notices, usage reports and purge", async () => {
    let stopped = true;
    setServiceStoppedCheck(async () => stopped);
    const fn = vi.fn(async () => undefined);
    const lock = { withWorkerLock: vi.fn(async (_n: string, f: () => Promise<unknown>) => ({ ran: true as const, result: await f() })) };
    await claimedTick("sequence", fn, lock)();
    expect(fn).not.toHaveBeenCalled();
    await claimedTick("usage_reports", fn, lock)();
    expect(fn).toHaveBeenCalledTimes(1);
    stopped = false;
    await claimedTick("sequence", fn, lock)();
    expect(fn).toHaveBeenCalledTimes(2);
    setServiceStoppedCheck(async () => { throw new Error("db"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await workersPaused("send_queue")).toBe(false); // a failed check never pauses work
    warn.mockRestore();
  });
});

/** Reads a zip's entries (central directory, stored or deflated). */
function unzip(buf: Buffer): Record<string, Buffer> {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Record<string, Buffer> = {};
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    out[name] = method === 8 ? inflateRawSync(raw) : raw;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe("data export", () => {
  it("zips every table as JSON lines plus the stored documents, leaving credentials out", async () => {
    tables = {
      contacts: Array.from({ length: 2500 }, (_, i) => ({ id: `c${i}`, name: `Contact ${i}` })),
      documents: [{ id: "d1", filename: "bank.pdf", blob_name: "app/d1.pdf" }, { id: "d2", filename: "gone.pdf", blob_name: "app/missing.pdf" }],
      otp_codes: [{ id: 1, code: "123456" }],
      refresh_tokens: [{ id: 1, token: "x" }],
    };
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on("data", (c) => chunks.push(c));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const manifest = await writeExport(db, out, { fetchBlob: async (k) => (k === "app/d1.pdf" ? Buffer.from("%PDF-1.4 test") : null) });
    warn.mockRestore();
    const files = unzip(Buffer.concat(chunks));
    expect(Object.keys(files).sort()).toEqual([
      "documents/documents/d1-bank.pdf", "documents/documents/d2-gone.pdf", "manifest.json", "tables/contacts.jsonl", "tables/documents.jsonl",
    ]);
    const lines = files["tables/contacts.jsonl"].toString("utf8").trim().split("\n");
    expect(lines).toHaveLength(2500); // more than one page
    expect(JSON.parse(lines[2499])).toEqual({ id: "c2499", name: "Contact 2499" });
    expect(files["documents/documents/d1-bank.pdf"].toString()).toBe("%PDF-1.4 test");
    const m = JSON.parse(files["manifest.json"].toString("utf8"));
    expect(m.tables).toEqual([{ table: "contacts", rows: 2500 }, { table: "documents", rows: 2 }]);
    expect(m.documents).toBe(1);
    expect(m.errors).toEqual([{ where: "documents/d2", error: "file not found" }]);
    expect(manifest.documents).toBe(1);
  });
});

describe("the 180-day purge", () => {
  const DAY = 86_400_000;
  const cancelled = (daysAgo: number) => Object.assign(plan, { service_status: "cancelled", cancelled_at: new Date(Date.now() - daysAgo * DAY) });

  it("never runs unless the service is cancelled", async () => {
    const empty = vi.fn(async () => 0);
    for (const s of ["active", "trial", "past_due", "suspended"]) {
      Object.assign(plan, { service_status: s, cancelled_at: new Date(Date.now() - 400 * DAY) });
      expect(await runLicenseePurge(db, new Date(), { emptyContainer: empty })).toEqual({ action: "none", reason: "not_cancelled" });
    }
    expect(truncated).toEqual([]);
    expect(empty).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("dry run: lists what would be deleted and deletes nothing", async () => {
    cancelled(181);
    tables = { contacts: [{ id: 1 }], users: [{ id: 1 }], schema_migrations: [{ id: "x" }], licensee_settings: [{ id: 1 }], licensee_plan: [{ id: 1 }] };
    const r = await runLicenseePurge(db, new Date(), { dryRun: true, env: {} });
    expect(r).toEqual({ action: "would_purge", tables: ["contacts", "users"], containers: ["bf-documents", "voicemails", "signed-applications", "mms-inbound", "marketing-assets"] });
    for (const t of PURGE_KEEP_TABLES) expect((r as any).tables).not.toContain(t);
    expect(truncated).toEqual([]);
    expect(plan.purged_at).toBeUndefined();
    cancelled(100);
    expect(await runLicenseePurge(db, new Date(), { dryRun: true })).toEqual({ action: "none", reason: "not_due" });
  });

  it("warns 7 days and 1 day before, once each, to admins and support", async () => {
    cancelled(150);
    expect((await runLicenseePurge(db)).action).toBe("none");
    cancelled(174);
    expect(await runLicenseePurge(db)).toEqual({ action: "warned", days_left: 7 });
    expect(sendMock.mock.calls[0][0].subject).toMatch(/deleted in 7 days/);
    expect(sendMock.mock.calls[0][0].text).toMatch(/export/);
    expect((await runLicenseePurge(db)).action).toBe("none");
    cancelled(179.5);
    expect(await runLicenseePurge(db)).toEqual({ action: "warned", days_left: 1 });
    expect((await runLicenseePurge(db)).action).toBe("none");
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("after 180 days deletes every table but the ledger and every stored file, then records purged_at", async () => {
    cancelled(181);
    tables = { contacts: [{ id: 1 }], documents: [{ id: 1 }], schema_migrations: [{ id: "x" }], licensee_plan: [{ id: 1 }] };
    const empty = vi.fn(async (_c: string) => 3);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await runLicenseePurge(db, new Date(), { emptyContainer: empty, env: { AZURE_STORAGE_CONTAINER_BF: "acme-docs" } });
    warn.mockRestore();
    expect(r.action).toBe("purged");
    expect(truncated).toEqual(["contacts", "documents"]);
    expect(empty.mock.calls.map((c) => c[0])).toContain("acme-docs");
    expect(plan.purged_at).toBeInstanceOf(Date);
    expect(await runLicenseePurge(db)).toEqual({ action: "none", reason: "already_purged" });
  });
});
