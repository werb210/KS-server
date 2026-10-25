// KS_SERVER_v14_RETENTION - the retention rules, the /api/retention routes, the delete guard and the purge's
// retention archive, against a database fake that answers by SQL content (not call order).
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", () => ({ pool: { query: queryMock }, db: { query: queryMock }, runQuery: queryMock }));

import retentionRoutes from "../../routes/retention.js";
import { isClosedFile, lockedBody, retainUntil, retentionStatus } from "../policy.js";
import { refuseIfLocked } from "../retention.js";
import { blobKeeper, retentionArchiveSql, runLicenseePurge } from "../../plans/purge.js";
import { clearPlanCache } from "../../plans/state.js";

type Row = Record<string, any>;
const APP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DOC = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CONTACT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const YEAR = 365.25 * 86_400_000;

let app: Row | null;
let holds: Row[];
let audits: Row[];
let calls: string[];

function fakeDb(sql: string, p: unknown[] = []): { rows: any[]; rowCount: number } {
  calls.push(sql);
  const ok = (rows: any[]) => ({ rows, rowCount: rows.length });
  if (/FROM retention_applications WHERE application_id = \$1/.test(sql)) {
    if (!app || p[0] !== APP) return ok([]);
    return ok([{ application_id: APP, label: "Acme Ltd", ...app }]);
  }
  if (/FROM retention_documents WHERE document_id = \$1/.test(sql)) {
    if (!app || p[0] !== DOC) return ok([]);
    return ok([{ document_id: DOC, application_id: APP, uploaded_at: app.last_upload_at, closed_at: app.closed_at }]);
  }
  if (/FROM retention_documents WHERE application_id = \$1/.test(sql)) {
    return ok(app && p[0] === APP ? [{ document_id: DOC, uploaded_at: app.last_upload_at, closed_at: app.closed_at }] : []);
  }
  if (/FROM retention_applications ra JOIN applications a/.test(sql)) return ok(app && p[0] === CONTACT ? [{ application_id: APP }] : []);
  if (/INSERT INTO legal_holds/.test(sql)) {
    if (holds.some((h) => h.target_type === p[0] && h.target_id === p[1] && !h.released_at)) return ok([]);
    const h = { id: `bbbbbbbb-bbbb-4bbb-8bbb-00000000000${holds.length}`, target_type: p[0], target_id: p[1], target_label: p[2], reason: p[3], placed_at: new Date(), placed_by_name: p[5], released_at: null };
    holds.push(h);
    return ok([h]);
  }
  if (/UPDATE legal_holds/.test(sql)) {
    const h = holds.find((x) => x.id === p[0] && !x.released_at);
    if (!h) return ok([]);
    Object.assign(h, { released_at: new Date(), released_by_name: p[2], release_reason: p[3] });
    return ok([h]);
  }
  if (/FROM legal_holds h/.test(sql)) {
    const active = holds.filter((h) => !h.released_at);
    if (/LIMIT 500/.test(sql)) return ok(/WHERE h.released_at IS NULL/.test(sql) ? active : holds);
    return ok(active);
  }
  if (/FROM contacts WHERE id = \$1::uuid/.test(sql)) return ok(p[0] === CONTACT ? [{ label: "Jane Client" }] : []);
  if (/insert into audit_events/i.test(sql)) { audits.push({ type: p[4], meta: p[10] }); return ok([]); }
  if (/count\(\*\) FILTER/.test(sql)) return ok([{ records: 3, open_files: 1, locked_until_date: 1, held: 0, eligible: 1 }]);
  if (/FROM retention_applications\s+WHERE is_record AND NOT held/.test(sql)) return ok([{ application_id: "old-app", label: "Old Co", silo: "BF", closed_at: new Date("2015-01-01"), retain_until: new Date("2022-01-01") }]);
  if (/FROM audit_events WHERE created_at <=/.test(sql)) return ok([{ count: 2, oldest: new Date("2016-05-01") }]);
  return ok([]);
}

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const token = (role: string) => jwt.sign({ sub: ADMIN_ID, id: ADMIN_ID, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
function server() {
  const a = express();
  a.use(express.json());
  a.use("/api/retention", retentionRoutes);
  return a;
}

beforeEach(() => {
  app = null;
  holds = [];
  audits = [];
  calls = [];
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: unknown, params?: unknown[]) => fakeDb(String(sql), params ?? []));
  clearPlanCache();
});

describe("the retention rules", () => {
  it("a file closes when funded, declined or withdrawn", () => {
    expect(isClosedFile({ funded_at: new Date() })).toBe(true);
    for (const s of ["Accepted", "Funded", "Rejected", "Declined", "DECLINED", "Withdrawn", "Closed", "Archived"]) expect(isClosedFile({ pipeline_state: s })).toBe(true);
    expect(isClosedFile({ application_status: "withdrawn" })).toBe(true);
    for (const s of ["Received", "In Review", "Off to Lender", "Offer", "Fraud", "Hold"]) expect(isClosedFile({ pipeline_state: s })).toBe(false);
  });

  it("keeps a record 7 years from the later of upload and closing", () => {
    const closed = new Date("2026-03-01T00:00:00Z");
    expect(retainUntil(new Date("2025-01-01T00:00:00Z"), closed)?.toISOString().slice(0, 10)).toBe("2033-03-01");
    expect(retainUntil(new Date("2026-06-01T00:00:00Z"), closed)?.toISOString().slice(0, 10)).toBe("2033-06-01");
    expect(retainUntil(new Date(), null)).toBeNull();
  });

  it("explains a lock with the date; a hold beats the date; an empty draft is deletable", () => {
    const now = new Date("2027-01-01T00:00:00Z");
    const s = retentionStatus({ is_record: true, uploaded_at: new Date("2026-01-01T00:00:00Z"), closed_at: new Date("2026-02-01T00:00:00Z"), holds: [], noun: "This document" }, now);
    expect(s).toMatchObject({ locked: true, reason: "retention", deletable_on: "2033-02-01" });
    expect(s.message).toBe("This document is kept for 7 years and cannot be deleted before 2033-02-01.");
    const open = retentionStatus({ is_record: true, uploaded_at: new Date("2026-01-01T00:00:00Z"), closed_at: null, holds: [], noun: "This document" }, now);
    expect(open).toMatchObject({ locked: true, file_open: true, deletable_on: null, earliest_deletable_on: "2033-01-01" });
    const held = retentionStatus({ is_record: false, uploaded_at: null, closed_at: null, holds: [{ id: "h", target_type: "contact", target_id: "c", target_label: null, reason: "litigation", placed_at: null }], noun: "This application" }, now);
    expect(held).toMatchObject({ locked: true, reason: "hold" });
    expect(lockedBody(held)).toMatchObject({ error: "legal_hold", code: "legal_hold" });
    expect(retentionStatus({ is_record: false, uploaded_at: null, closed_at: null, holds: [], noun: "x" }, now).locked).toBe(false);
    const past = retentionStatus({ is_record: true, uploaded_at: new Date("2015-01-01T00:00:00Z"), closed_at: new Date("2016-01-01T00:00:00Z"), holds: [], noun: "x" }, now);
    expect(past).toMatchObject({ locked: false, deletable_on: "2023-01-01" });
  });
});

describe("the delete guard", () => {
  const res = () => {
    const r: any = { statusCode: 200, body: null };
    r.status = (c: number) => { r.statusCode = c; return r; };
    r.json = (b: unknown) => { r.body = b; return r; };
    return r;
  };

  it("refuses a document inside its 7 years with 423, the date, and an audit entry", async () => {
    app = { is_record: true, created_at: new Date(Date.now() - YEAR), last_upload_at: new Date(Date.now() - YEAR), closed_at: new Date(Date.now() - 0.5 * YEAR) };
    const r = res();
    expect(await refuseIfLocked({ user: { id: ADMIN_ID } }, r, "document", DOC)).toBe(true);
    expect(r.statusCode).toBe(423);
    expect(r.body).toMatchObject({ error: "retention_locked", file_open: false });
    expect(r.body.deletable_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.body.message).toContain(r.body.deletable_on);
    expect(audits.map((a) => a.type)).toContain("retention.delete_refused");
  });

  it("lets a delete through once the 7 years are up, or for an empty draft", async () => {
    app = { is_record: true, created_at: new Date(Date.now() - 9 * YEAR), last_upload_at: new Date(Date.now() - 9 * YEAR), closed_at: new Date(Date.now() - 8 * YEAR) };
    expect(await refuseIfLocked({}, res(), "application", APP)).toBe(false);
    app = { is_record: false, created_at: new Date(), last_upload_at: null, closed_at: null };
    expect(await refuseIfLocked({}, res(), "application", APP)).toBe(false);
  });

  it("a legal hold on the applicant blocks deleting the application and the contact, whatever the date", async () => {
    app = { is_record: true, created_at: new Date(Date.now() - 9 * YEAR), last_upload_at: null, closed_at: new Date(Date.now() - 8 * YEAR) };
    holds.push({ id: "h1", target_type: "contact", target_id: CONTACT, target_label: "Jane", reason: "litigation", placed_at: new Date(), released_at: null });
    const r = res();
    expect(await refuseIfLocked({}, r, "application", APP)).toBe(true);
    expect(r.body).toMatchObject({ error: "legal_hold" });
    expect(r.body.message).toContain("litigation");
    const c = res();
    expect(await refuseIfLocked({}, c, "contact", CONTACT)).toBe(true);
    expect(c.body.error).toBe("legal_hold");
  });

  it("a contact linked to an open file cannot be deleted", async () => {
    app = { is_record: true, created_at: new Date(), last_upload_at: new Date(), closed_at: null };
    const c = res();
    expect(await refuseIfLocked({}, c, "contact", CONTACT)).toBe(true);
    expect(c.body).toMatchObject({ error: "retention_locked", file_open: true });
  });
});

describe("/api/retention", () => {
  it("status: staff can ask; unknown type or record is refused", async () => {
    app = { is_record: true, created_at: new Date(), last_upload_at: new Date(), closed_at: null };
    expect((await request(server()).get(`/api/retention/status?type=document&id=${DOC}`)).status).toBe(401);
    const r = await request(server()).get(`/api/retention/status?type=document&id=${DOC}`).set("Authorization", `Bearer ${token("Staff")}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, locked: true, file_open: true, retention_years: 7 });
    expect((await request(server()).get(`/api/retention/status?type=bogus&id=${DOC}`).set("Authorization", `Bearer ${token("Staff")}`)).status).toBe(400);
    expect((await request(server()).get(`/api/retention/status?type=document&id=${APP}`).set("Authorization", `Bearer ${token("Staff")}`)).status).toBe(404);
    const all = await request(server()).get(`/api/retention/applications/${APP}`).set("Authorization", `Bearer ${token("Staff")}`);
    expect(all.body.documents[DOC]).toMatchObject({ locked: true });
  });

  it("holds: Admin only; place (audited), refuse a duplicate, release (audited)", async () => {
    expect((await request(server()).post("/api/retention/holds").set("Authorization", `Bearer ${token("Staff")}`).send({})).status).toBe(403);
    const bad = await request(server()).post("/api/retention/holds").set("Authorization", `Bearer ${token("Admin")}`).send({ target_type: "lender", target_id: CONTACT, reason: "" });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.errors)).toEqual(["target_type", "reason"]);
    expect((await request(server()).post("/api/retention/holds").set("Authorization", `Bearer ${token("Admin")}`)
      .send({ target_type: "contact", target_id: "dddddddd-0000-4000-8000-000000000000", reason: "litigation" })).status).toBe(404);
    const placed = await request(server()).post("/api/retention/holds").set("Authorization", `Bearer ${token("Admin")}`)
      .send({ target_type: "contact", target_id: CONTACT, reason: "litigation" });
    expect(placed.status).toBe(201);
    expect(placed.body.hold).toMatchObject({ target_type: "contact", target_label: "Jane Client", reason: "litigation" });
    const dup = await request(server()).post("/api/retention/holds").set("Authorization", `Bearer ${token("Admin")}`)
      .send({ target_type: "contact", target_id: CONTACT, reason: "again" });
    expect(dup.status).toBe(409);
    const list = await request(server()).get("/api/retention/holds").set("Authorization", `Bearer ${token("Admin")}`);
    expect(list.body.holds).toHaveLength(1);
    const rel = await request(server()).post(`/api/retention/holds/${placed.body.hold.id}/release`).set("Authorization", `Bearer ${token("Admin")}`).send({ reason: "settled" });
    expect(rel.status).toBe(200);
    expect(rel.body.hold).toMatchObject({ release_reason: "settled" });
    expect((await request(server()).post(`/api/retention/holds/${placed.body.hold.id}/release`).set("Authorization", `Bearer ${token("Admin")}`).send({})).status).toBe(404);
    expect(audits.map((a) => a.type)).toEqual(["legal_hold.placed", "legal_hold.released"]);
  });

  it("report: Admin only; lists what is eligible and deletes nothing", async () => {
    expect((await request(server()).get("/api/retention/report").set("Authorization", `Bearer ${token("Staff")}`)).status).toBe(403);
    const r = await request(server()).get("/api/retention/report").set("Authorization", `Bearer ${token("Admin")}`);
    expect(r.status).toBe(200);
    expect(r.body.eligible_applications).toEqual([expect.objectContaining({ application_id: "old-app", eligible_since: "2022-01-01" })]);
    expect(r.body.eligible_audit_events.count).toBe(2);
    expect(r.body.totals.eligible).toBe(1);
    expect(calls.some((s) => /^\s*(DELETE|TRUNCATE)/i.test(s))).toBe(false);
  });
});

describe("the cancellation purge keeps what retention requires", () => {
  it("archive SQL: one transaction, open files counted as closed on cancellation, read-only triggers", () => {
    const sql = retentionArchiveSql(new Date("2026-01-01T00:00:00.000Z"), new Date("2026-07-01T00:00:00.000Z"));
    expect(sql.startsWith("BEGIN;")).toBe(true);
    expect(sql.trim().endsWith("COMMIT;")).toBe(true);
    expect(sql).toContain("COALESCE(ra.closed_at, '2026-01-01T00:00:00.000Z'::timestamptz)");
    expect(sql).toContain("WHERE ra.is_record AND (ra.held OR");
    for (const t of ["applications", "documents", "document_versions", "application_packages", "contacts", "companies", "audit_events", "legal_holds", "blobs"]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS retention_archive.${t} AS`);
      expect(sql).toContain(`CREATE TRIGGER read_only BEFORE UPDATE OR DELETE ON retention_archive.${t}`);
    }
  });

  it("keeps a stored file listed by name or under an archived application's folder", () => {
    const keep = blobKeeper(["x/kept.pdf"], ["app-1"]);
    expect(keep("x/kept.pdf")).toBe(true);
    expect(keep("applications/app-1/a.pdf")).toBe(true);
    expect(keep("app-1/signed.pdf")).toBe(true);
    expect(keep("applications/app-2/a.pdf")).toBe(false);
    expect(keep("voicemail/1.mp3")).toBe(false);
  });

  it("archives before emptying the tables, and passes the keep rule to every container", async () => {
    const plan: Row = { plan: "growth", service_status: "cancelled", cancelled_at: new Date(Date.now() - 181 * 86_400_000), purge_warning_7_sent_at: new Date(), purge_warning_1_sent_at: new Date() };
    const order: string[] = [];
    queryMock.mockImplementation(async (sql: string) => {
      const ok = (rows: any[]) => ({ rows, rowCount: rows.length });
      if (/FROM licensee_plan WHERE id = 1/.test(sql)) return ok([{ ...plan }]);
      if (/^BEGIN;\nCREATE SCHEMA IF NOT EXISTS retention_archive/.test(sql)) { order.push("archive"); return ok([]); }
      if (/FROM information_schema.tables/.test(sql)) return ok([{ table_name: "contacts" }, { table_name: "documents" }]);
      if (/^TRUNCATE/.test(sql)) { order.push("truncate"); return ok([]); }
      if (/SELECT blob_name FROM retention_archive.blobs/.test(sql)) return ok([{ blob_name: "applications/app-1/kept.pdf" }]);
      if (/SELECT application_id FROM retention_archive.kept_applications/.test(sql)) return ok([{ application_id: "app-1" }]);
      if (/AS kept_until/.test(sql)) return ok([{ applications: 1, documents: 2, audit_events: 5, holds: 0, files: 1, kept_until: new Date("2033-01-01") }]);
      if (/UPDATE licensee_plan SET purged_at/.test(sql)) { order.push("purged"); return ok([]); }
      return ok([]);
    });
    const kept: Record<string, boolean[]> = {};
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await runLicenseePurge({ query: queryMock } as any, new Date(), {
      env: {},
      emptyContainer: async (c, keep) => { kept[c] = [keep("applications/app-1/kept.pdf"), keep("voicemail/1.mp3")]; return 1; },
    });
    warn.mockRestore();
    expect(r).toMatchObject({ action: "purged", retained: { applications: 1, documents: 2, audit_events: 5, kept_until: "2033-01-01" } });
    expect(order).toEqual(["archive", "truncate", "purged"]);
    expect(kept["bf-documents"]).toEqual([true, false]);
    expect(kept["voicemails"]).toEqual([true, false]);
  });

  it("after the purge, later runs release only what is due, and say so when nothing is", async () => {
    const plan: Row = { plan: "growth", service_status: "cancelled", cancelled_at: new Date(Date.now() - 400 * 86_400_000), purged_at: new Date(), retention_archived_at: new Date(), retention_released_at: null };
    let due: Row[] = [];
    const sqls: string[] = [];
    queryMock.mockImplementation(async (sql: string) => {
      sqls.push(sql);
      const ok = (rows: any[]) => ({ rows, rowCount: rows.length });
      if (/FROM licensee_plan WHERE id = 1/.test(sql)) return ok([{ ...plan }]);
      if (/^SELECT k.application_id FROM retention_archive.kept_applications k/.test(sql)) return ok(due);
      if (/FROM retention_archive.audit_events WHERE created_at <=/.test(sql)) return ok([{ n: 0 }]);
      if (/AS kept_until/.test(sql)) return ok([{ applications: due.length ? 0 : 1, documents: 0, audit_events: 0, holds: 0, files: 0, kept_until: null }]);
      return ok([]);
    });
    expect(await runLicenseePurge({ query: queryMock } as any, new Date(), { env: {}, emptyContainer: async () => 0 })).toEqual({ action: "none", reason: "retention_archive_kept" });
    expect(sqls.some((s) => /SET LOCAL ks.retention_release/.test(s))).toBe(false);

    due = [{ application_id: "app-1" }];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await runLicenseePurge({ query: queryMock } as any, new Date(), { env: {}, emptyContainer: async () => 2 });
    warn.mockRestore();
    expect(r).toMatchObject({ action: "retention_released", applications: 1, archive_dropped: true });
    expect(sqls.some((s) => /SET LOCAL ks.retention_release = 'on'/.test(s) && /DELETE FROM retention_archive.documents/.test(s))).toBe(true);
    expect(sqls.some((s) => /DROP SCHEMA IF EXISTS retention_archive CASCADE/.test(s))).toBe(true);
  });
});
