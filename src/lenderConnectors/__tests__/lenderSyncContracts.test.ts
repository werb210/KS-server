// KS_LENDER_SYNC_CONTRACTS - lender-reported balances on Active Contracts (daily polling after funding), and lender
// conditions on the funding checklist. The database is mocked and answers by SQL content.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, type SqlRule } from "../../__tests__/helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", async () => ({ ...(await vi.importActual<any>("../../db.js")), pool: { query: queryMock }, dbQuery: queryMock }));

import { applyRemoteUpdate, type SubmissionRow } from "../sync.js";
import { genericRestConnector } from "../connectors/generic.js";
import { readSalesforceRecord, salesforceConnector } from "../connectors/salesforce.js";
import { readServicing } from "../mapping.js";
import { isClosedServicingStatus, type RemoteUpdate } from "../types.js";
import { normaliseConditionText, rowToCondition, sourceLabel, syncLenderConditions } from "../../brokerTools/conditions.js";
import { contractView } from "../../activeContracts/repo.js";
import { keepPollingFunded } from "../../activeContracts/lenderReported.js";
import type { HttpClient } from "../http.js";

const LENDER = "11111111-1111-1111-1111-111111111111";
const CONTRACT = "44444444-4444-4444-4444-444444444444";
const funded: SubmissionRow = { id: "s1", application_id: "app-1", lender_id: LENDER, connector: "generic_rest", external_id: "D-9", lender_status: "Funded", bucket: "funded" };

function run(rules: SqlRule[], update: RemoteUpdate, sub: SubmissionRow = funded) {
  const db = { query: vi.fn(answerBySql(rules)) };
  const p = applyRemoteUpdate(db as any, {
    submission: sub, lenderName: "Test Lender", source: "poll", adminStatusMap: {}, connectorDefaults: { Funded: "funded" }, pollIntervalMinutes: 30, update,
  });
  return { db, p };
}
const submissionUpdate = (db: { query: { mock: { calls: unknown[][] } } }) => callsMatching(db.query, /UPDATE lender_api_submissions/)[0]![1] as unknown[];

const servicing = { balance: 41250.5, asOf: "2026-11-02", paymentsMade: 9, nextPaymentDate: "2026-11-09", nextPaymentAmount: 1250, status: "Active" };

describe("reading a funded deal's balance from the lender", () => {
  it("reads nothing unless the Admin set balance fields, and parses money and dates", () => {
    expect(readServicing({}, () => 1)).toBeUndefined();
    const body: Record<string, unknown> = { bal: "$41,250.50", asof: "2026-11-02T10:00:00Z", paid: "9", next: { d: "2026-11-09", a: 1250 }, st: "Active" };
    expect(readServicing({ balance: "bal", as_of: "asof", payments_made: "paid", next_payment_date: "next.d", next_payment_amount: "next.a", status: "st" },
      (p) => p.split(".").reduce<any>((o, k) => o?.[k], body))).toEqual(servicing);
  });

  it("the generic connector reads servicing_paths and validates them", async () => {
    const config = { base_url: "https://api.lender.example", submit: { path: "/apps", field_map: { n: "company" } },
      status: { path: "/apps/{{external_id}}", status_path: "state", servicing_paths: { balance: "loan.balance", as_of: "loan.as_of", next_payment_date: "loan.next_due", status: "loan.status" } } };
    expect(genericRestConnector.validateConfig(config)).toEqual([]);
    expect(genericRestConnector.validateConfig({ ...config, status: { ...config.status, servicing_paths: { balance: "__proto__.x" } } }).some((p) => /balance field path/.test(p))).toBe(true);
    const http: HttpClient = async () => ({ status: 200, headers: {}, text: JSON.stringify({ state: "Funded", loan: { balance: 1000, as_of: "2026-11-01", next_due: "2026-11-08", status: "Paid off" } }) });
    const out = await genericRestConnector.fetchStatus!({ config, secrets: {}, http }, "D-9");
    expect(out).toMatchObject({ ok: true, update: { status: "Funded", servicing: { balance: 1000, asOf: "2026-11-01", nextPaymentDate: "2026-11-08", status: "Paid off", paymentsMade: null } } });
  });

  it("the Salesforce connector reads servicing_fields from the record it follows", () => {
    const st = { status_field: "Status", follow: { object: "Opportunity", status_field: "StageName", servicing_fields: { balance: "Balance__c", status: "Loan_Status__c" } } };
    const u = readSalesforceRecord({ Status: "Converted" }, st, "00Q", { StageName: "Closed Won", Balance__c: 1500, Loan_Status__c: "Active" });
    expect(u.servicing).toMatchObject({ balance: 1500, status: "Active" });
    expect(salesforceConnector.validateConfig({ site_url: "https://x.my.site.com", submit: { object: "Lead", field_map: { Company: "company" } }, status: { servicing_fields: { balance: "Bad Name" } } })
      .some((p) => /Bad Name/.test(p))).toBe(true);
  });

  it("knows the lender words for a finished contract", () => {
    for (const s of ["Paid off", "PAID_OUT", "Paid in full", "Closed", "Settled", "Written off"]) expect(isClosedServicingStatus(s)).toBe(true);
    for (const s of ["Active", "In repayment", null, "Closing"]) expect(isClosedServicingStatus(s)).toBe(false);
  });
});

describe("applyRemoteUpdate after funding", () => {
  beforeEach(() => queryMock.mockReset());

  it("records the lender's balance on the matching contract and keeps polling daily", async () => {
    const { db, p } = run([
      [/FROM active_contracts\s+WHERE application_id/, { rows: [{ id: CONTRACT, status: "active" }] }],
      [/FROM active_contract_balances\s+WHERE contract_id = \$1::uuid AND source = 'lender_portal'/, { rows: [] }],
      [/INSERT INTO active_contract_balances/, { rows: [{ id: "b1" }] }],
    ], { externalId: "D-9", status: "Funded", servicing });
    const out = await p;
    expect(out.balanceRecorded).toBe(true);
    const ins = callsMatching(db.query, /INSERT INTO active_contract_balances/);
    expect(ins).toHaveLength(1);
    const v = ins[0]![1] as unknown[];
    expect(v[0]).toBe(CONTRACT);
    expect(v[1]).toBe(41250.5);
    expect(v[2]).toBe("2026-11-02");
    expect(v[3]).toBe("lender_portal");
    expect(v[4]).toBe(9);
    expect(v.slice(9)).toEqual(["Test Lender", "Active", "2026-11-09", 1250, "s1"]);
    // the match is by the application the submission carries, and the lender when the contract names one
    expect(callsMatching(db.query, /FROM active_contracts\s+WHERE application_id/)[0]![1]).toEqual(["app-1", LENDER]);
    const upd = submissionUpdate(db);
    expect(upd[7]).toBe(false);
    expect(upd[8]).toBe(String(24 * 60));
  });

  it("adds nothing when the lender reports the same thing again", async () => {
    const { db, p } = run([
      [/FROM active_contracts\s+WHERE application_id/, { rows: [{ id: CONTRACT, status: "active" }] }],
      [/source = 'lender_portal' ORDER BY/, { rows: [{ balance: "41250.50", as_of: new Date("2026-11-02T00:00:00Z"), payments_made: 9, next_payment_date: "2026-11-09", next_payment_amount: "1250.00", lender_status: "Active" }] }],
    ], { externalId: "D-9", status: "Funded", servicing });
    expect((await p).balanceRecorded).toBe(false);
    expect(callsMatching(db.query, /INSERT INTO active_contract_balances/)).toHaveLength(0);
  });

  it("stops polling when the contract is paid out or closed in Keystone", async () => {
    const { db, p } = run([[/FROM active_contracts\s+WHERE application_id/, { rows: [{ id: CONTRACT, status: "paid_out" }] }]], { externalId: "D-9", status: "Funded" });
    await p;
    expect(submissionUpdate(db)[7]).toBe(true);
  });

  it("stops polling and notes it on the contract when the lender says the contract is paid off", async () => {
    const { db, p } = run([
      [/FROM active_contracts\s+WHERE application_id/, { rows: [{ id: CONTRACT, status: "active" }] }],
      [/INSERT INTO active_contract_balances/, { rows: [{ id: "b2" }] }],
    ], { externalId: "D-9", status: "Paid Off", servicing: { ...servicing, balance: 0, status: "Paid off" } });
    const out = await p;
    expect(out.balanceRecorded).toBe(true);
    expect(submissionUpdate(db)[7]).toBe(true);
    // a later lender status never moves the funded file back, and the deal stays funded
    expect(out.bucket).toBe("funded");
    expect(callsMatching(db.query, /SELECT pipeline_state FROM applications/)).toHaveLength(0);
    expect(callsMatching(db.query, /FROM active_contracts c WHERE c.id = \$1::uuid/).length).toBeGreaterThan(0); // contract timeline event
  });

  it("keeps looking for a while when the contract has not been created yet", async () => {
    const now = new Date("2026-11-20T00:00:00Z");
    const db = { query: vi.fn(answerBySql([])) };
    expect(await keepPollingFunded(db as any, { applicationId: "a", lenderId: LENDER, lenderClosed: false, fundedSeenAt: null, now })).toBe(true);
    expect(await keepPollingFunded(db as any, { applicationId: "a", lenderId: LENDER, lenderClosed: false, fundedSeenAt: "2026-11-15T00:00:00Z", now })).toBe(true);
    expect(await keepPollingFunded(db as any, { applicationId: "a", lenderId: LENDER, lenderClosed: false, fundedSeenAt: "2026-10-01T00:00:00Z", now })).toBe(false);
    expect(await keepPollingFunded(db as any, { applicationId: "a", lenderId: LENDER, lenderClosed: true, fundedSeenAt: null, now })).toBe(false);
  });

  it("a deal that is not funded keeps its normal interval and declined deals stop", async () => {
    const a = run([], { externalId: "D-9", status: "Approved" }, { ...funded, bucket: "submitted", lender_status: "received" });
    await a.p;
    expect(submissionUpdate(a.db)[7]).toBe(false);
    expect(submissionUpdate(a.db)[8]).toBe("30");
    const b = run([], { externalId: "D-9", status: "Declined" }, { ...funded, bucket: "submitted", lender_status: "received" });
    await b.p;
    expect(submissionUpdate(b.db)[7]).toBe(true);
  });
});

describe("contract page: lender-reported and staff-entered balances", () => {
  const base = { id: CONTRACT, status: "active", original_amount: "50000", lender_name: "Test Lender", reported_balance: "40000", reported_as_of: "2026-11-02", reported_source: "manual" };
  it("shows both when they differ, and the lender's next payment", () => {
    const v = contractView({ ...base, lr_balance: "41250.50", lr_as_of: "2026-11-02", lr_lender_name: "Test Lender", lr_next_payment_date: "2026-11-09", lr_next_payment_amount: "1250",
      lr_lender_status: "Active", sb_balance: "40000", sb_as_of: "2026-11-02", sb_source: "manual" }, new Date("2026-11-04T00:00:00Z"));
    expect(v.lender_reported).toMatchObject({ balance: 41250.5, as_of: "2026-11-02", lender_name: "Test Lender", next_payment_date: "2026-11-09", next_payment_amount: 1250 });
    expect(v.staff_balance).toEqual({ balance: 40000, as_of: "2026-11-02", source: "manual" });
    expect(v.balances_differ).toBe(true);
    expect(v.balance.balance).toBe(40000); // same as-of date: what staff typed stays the headline
  });
  it("no lender report, nothing extra", () => {
    const v = contractView({ ...base }, new Date("2026-11-04T00:00:00Z"));
    expect(v.lender_reported).toBeNull();
    expect(v.balances_differ).toBe(false);
  });
});

describe("lender conditions on the funding checklist", () => {
  const lender = { id: LENDER, name: "Test Lender" };
  const cond = (o: Partial<{ externalId: string; description: string; status: "open" | "satisfied" | "waived"; kind: "condition" | "document_request"; documentType: string | null }> = {}) =>
    ({ externalId: "ST1", kind: "condition" as const, description: "Void cheque", documentType: null, status: "open" as const, ...o });

  it("normalises text", () => {
    expect(normaliseConditionText("  Void   Cheque. ")).toBe("void cheque");
    expect(sourceLabel("lender", "Test Lender")).toBe("Reported by Test Lender");
    expect(rowToCondition({ id: "c", application_id: "a", title: "T", source: "lender", lender_name: "Test Lender" }).source_label).toBe("Reported by Test Lender");
    expect(rowToCondition({ id: "c", application_id: "a", title: "T", source: "manual" }).source_label).toBe("Added by staff");
  });

  it("adds a new lender condition with its source", async () => {
    const db = { query: vi.fn(answerBySql([[/INSERT INTO funding_conditions/, { rows: [{ id: "c1", status: "open" }] }]])) };
    const r = await syncLenderConditions(db as any, "app-1", lender, [cond({ kind: "document_request", documentType: "void_check" })], { addNew: true });
    expect(r).toEqual({ added: 1, linked: 0, cleared: 0, waived: 0 });
    const v = callsMatching(db.query, /INSERT INTO funding_conditions/)[0]![1] as unknown[];
    expect(v).toEqual(["app-1", "Void cheque", "Document: void_check", true, LENDER, "ST1", "Test Lender"]);
    expect(String(callsMatching(db.query, /INSERT INTO funding_conditions/)[0]![0])).toMatch(/'lender'/);
  });

  it("does not add it twice: by the lender's id, or by the same text staff already added", async () => {
    const db = { query: vi.fn(answerBySql([[/SELECT id::text AS id, title, status, lender_id/, { rows: [
      { id: "c1", title: "Void cheque", status: "open", lender_id: LENDER, lender_condition_id: "ST1" },
      { id: "c2", title: "Insurance certificate.", status: "open", lender_id: null, lender_condition_id: null },
    ] }]])) };
    const r = await syncLenderConditions(db as any, "app-1", lender, [cond(), cond({ externalId: "ST2", description: "insurance  CERTIFICATE" })], { addNew: true });
    expect(r).toEqual({ added: 0, linked: 1, cleared: 0, waived: 0 });
    expect(callsMatching(db.query, /INSERT INTO funding_conditions/)).toHaveLength(0);
    expect(callsMatching(db.query, /UPDATE funding_conditions SET lender_id/)[0]![1]).toEqual(["c2", LENDER, "ST2"]);
  });

  it("clears or waives what the lender cleared, never re-opens or deletes what staff did", async () => {
    const db = { query: vi.fn(answerBySql([[/SELECT id::text AS id, title, status, lender_id/, { rows: [
      { id: "c1", title: "Void cheque", status: "open", lender_id: LENDER, lender_condition_id: "ST1" },
      { id: "c2", title: "Bank letter", status: "received", lender_id: LENDER, lender_condition_id: "ST2" },
      { id: "c3", title: "Site visit", status: "cleared", lender_id: LENDER, lender_condition_id: "ST3" },
    ] }]])) };
    const r = await syncLenderConditions(db as any, "app-1", lender, [
      cond({ status: "satisfied" }), cond({ externalId: "ST2", description: "Bank letter", status: "waived" }), cond({ externalId: "ST3", description: "Site visit", status: "open" }),
    ], { addNew: true });
    expect(r).toEqual({ added: 0, linked: 0, cleared: 1, waived: 1 });
    expect(callsMatching(db.query, /SET status = 'cleared'/)[0]![1]).toEqual(["c1"]);
    expect(callsMatching(db.query, /SET status = 'waived'/)[0]![1]).toEqual(["c2", "Waived by Test Lender"]);
    expect(callsMatching(db.query, /DELETE/)).toHaveLength(0);
    expect(callsMatching(db.query, /SET status = 'open'/)).toHaveLength(0);
  });

  it("adds no new ones once the file is funded, and none already cleared", async () => {
    const db = { query: vi.fn(answerBySql([])) };
    expect(await syncLenderConditions(db as any, "app-1", lender, [cond()], { addNew: false })).toMatchObject({ added: 0 });
    expect(await syncLenderConditions(db as any, "app-1", lender, [cond({ status: "satisfied" })], { addNew: true })).toMatchObject({ added: 0 });
    expect(callsMatching(db.query, /INSERT INTO funding_conditions/)).toHaveLength(0);
  });

  it("applyRemoteUpdate puts the chosen lender's conditions on the checklist, and not another lender's", async () => {
    const stored = { rows: [{ external_id: "c1", kind: "document_request", description: "Void cheque", document_type: "void_check", status: "open" }] };
    const sub: SubmissionRow = { ...funded, bucket: "offer", lender_status: "Approved" };
    const upd: RemoteUpdate = { externalId: "D-9", conditions: [{ externalId: "c1", kind: "document_request", description: "Void cheque", documentType: "void_check", status: "open" }] };
    const chosen = run([
      [/INSERT INTO lender_api_conditions/, { rows: [{ inserted: true, status: "open" }] }],
      [/FROM lender_api_conditions WHERE submission_id/, stored],
      [/AS chosen/, { rows: [{ chosen: true, funded: false }] }],
      [/INSERT INTO funding_conditions/, { rows: [{ id: "fc1", status: "open" }] }],
    ], upd, sub);
    expect((await chosen.p).checklist).toEqual({ added: 1, linked: 0, cleared: 0, waived: 0 });
    const other = run([
      [/INSERT INTO lender_api_conditions/, { rows: [{ inserted: true, status: "open" }] }],
      [/FROM lender_api_conditions WHERE submission_id/, stored],
      [/AS chosen/, { rows: [{ chosen: false, funded: false }] }],
    ], upd, sub);
    expect((await other.p).checklist).toBeUndefined();
    expect(callsMatching(other.db.query, /INSERT INTO funding_conditions/)).toHaveLength(0);
  });
});
