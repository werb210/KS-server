// KS_LENDER_SYNC_CONTRACTS - against real Postgres: the migration (twice), a funded deal's lender-reported balance on
// its Active Contract next to the balance staff typed, daily polling after funding that stops when the contract is
// paid out, and the lender's conditions on the funding checklist (no duplicates on re-sync, cleared when the lender
// clears them, staff conditions kept). Made-up names only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pool } from "../db.js";
import { applyRemoteUpdate, type SubmissionRow } from "../lenderConnectors/sync.js";
import { addBalance } from "../activeContracts/money.js";
import { contractView, getContractRow, type Q } from "../activeContracts/repo.js";
import { listConditions } from "../brokerTools/conditions.js";
import type { RemoteUpdate } from "../lenderConnectors/types.js";

const db = pool as unknown as Q;
const MIGRATIONS = ["migrations/2026_11_05_ks_lender_api.sql", "migrations/2026_11_07_ks_active_contracts.sql",
  "migrations/2026_11_04_broker_tools_1_conditions.sql", "migrations/2026_11_17_ks_lender_sync_contracts.sql"];
const tag = randomUUID().slice(0, 8);
const LENDER = randomUUID();
const APP = randomUUID();
const CONTRACT = randomUUID();
let sub: SubmissionRow;

const apply = (update: RemoteUpdate) => applyRemoteUpdate(db, {
  submission: sub, lenderName: `Sample Lender ${tag}`, update, source: "poll", adminStatusMap: {}, connectorDefaults: { Funded: "funded", Approved: "offer" }, pollIntervalMinutes: 30,
});
const reload = async () => {
  const r = (await pool.query(`SELECT id::text AS id, application_id, lender_id::text AS lender_id, connector, external_id, lender_status, bucket, next_poll_at FROM lender_api_submissions WHERE application_id = $1`, [APP])).rows[0];
  sub = r as SubmissionRow;
  return r;
};

async function cleanup() {
  await pool.query(`BEGIN; ALTER TABLE active_contract_balances DISABLE TRIGGER active_contract_balances_no_change;`);
  await pool.query(`DELETE FROM active_contract_balances WHERE contract_id = $1::uuid`, [CONTRACT]);
  await pool.query(`ALTER TABLE active_contract_balances ENABLE TRIGGER active_contract_balances_no_change; COMMIT;`);
  await pool.query(`DELETE FROM active_contracts WHERE id = $1::uuid`, [CONTRACT]);
  await pool.query(`DELETE FROM funding_conditions WHERE application_id = $1`, [APP]);
  await pool.query(`DELETE FROM lender_api_events WHERE lender_id = $1`, [LENDER]);
  await pool.query(`DELETE FROM lender_api_conditions WHERE lender_id = $1`, [LENDER]);
  await pool.query(`DELETE FROM lender_api_submissions WHERE lender_id = $1`, [LENDER]);
  await pool.query(`DELETE FROM notifications WHERE application_id = $1`, [APP]);
  await pool.query(`DELETE FROM application_stage_events WHERE application_id::text = $1`, [APP]);
  await pool.query(`DELETE FROM applications WHERE id = $1`, [APP]);
  await pool.query(`DELETE FROM lenders WHERE id = $1`, [LENDER]);
}

describe("KS lender sync into contracts and the funding checklist (real Postgres)", () => {
  beforeAll(async () => {
    for (const m of MIGRATIONS) await pool.query(readFileSync(m, "utf8"));
    await pool.query(readFileSync(MIGRATIONS[3]!, "utf8")); // safe to run again
    await pool.query(`INSERT INTO lenders (id, name, country, submission_method, submission_email) VALUES ($1, $2, 'CA', 'email', 'deals@lender.example')`, [LENDER, `Sample Lender ${tag}`]);
    await pool.query(
      `INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, silo, requested_amount, lender_id)
       VALUES ($1, $2, now(), now(), 'Accepted', 'ACCEPTED', 'BF', 50000, $3)`, [APP, `Sample Co ${tag}`, LENDER]);
    await pool.query(
      `INSERT INTO lender_api_submissions (application_id, lender_id, connector, status, external_id, submitted_at, lender_status, bucket)
       VALUES ($1, $2, 'generic_rest', 'submitted', 'D-1', now(), 'Approved', 'offer')`, [APP, LENDER]);
    await reload();
  });
  afterAll(async () => { await cleanup().catch((e) => console.warn("cleanup", String(e))); });

  it("puts the lender's conditions on the checklist once, linked to a matching staff condition", async () => {
    await pool.query(`INSERT INTO funding_conditions (application_id, title, source, owner) VALUES ($1, 'Insurance certificate', 'manual', 'staff')`, [APP]);
    const conditions: RemoteUpdate["conditions"] = [
      { externalId: "ST1", kind: "document_request", description: "Void cheque", documentType: "void_check", status: "open" },
      { externalId: "ST2", kind: "condition", description: "insurance certificate.", documentType: null, status: "open" },
    ];
    const first = await apply({ externalId: "D-1", conditions });
    expect(first.checklist).toMatchObject({ added: 1, linked: 1 });
    await reload();
    await apply({ externalId: "D-1", conditions });
    const list = await listConditions(db, APP);
    expect(list).toHaveLength(2);
    const lenderRow = list.find((c) => c.title === "Void cheque")!;
    expect(lenderRow).toMatchObject({ source: "lender", source_label: `Reported by Sample Lender ${tag}`, requires_document: true, status: "open" });
    expect(list.find((c) => c.title === "Insurance certificate")).toMatchObject({ source: "manual", source_label: "Added by staff" });

    // The lender clears both: both are cleared here; nothing is deleted.
    await reload();
    const cleared = await apply({ externalId: "D-1", conditions: conditions!.map((c) => ({ ...c, status: "satisfied" as const })) });
    expect(cleared.checklist).toMatchObject({ cleared: 2 });
    const after = await listConditions(db, APP);
    expect(after.map((c) => c.status).sort()).toEqual(["cleared", "cleared"]);
  });

  it("records the lender's balance on the contract next to the staff balance, and polls daily after funding", async () => {
    await pool.query(`UPDATE applications SET pipeline_state = 'Funded', funded_at = now() WHERE id = $1`, [APP]);
    await pool.query(
      `INSERT INTO active_contracts (id, silo, application_id, lender_id, lender_name, original_amount, funded_at, status)
       VALUES ($1, 'BF', $2, $3, $4, 50000, CURRENT_DATE - 60, 'active')`, [CONTRACT, APP, LENDER, `Sample Lender ${tag}`]);
    const today = new Date().toISOString().slice(0, 10);
    await addBalance(db, CONTRACT, { balance: 40000, as_of: today, source: "manual" }, null);

    await reload();
    const servicing = { balance: 41250.5, asOf: today, paymentsMade: 9, nextPaymentDate: null, nextPaymentAmount: 1250, status: "Active" };
    const out = await apply({ externalId: "D-1", status: "Funded", servicing });
    expect(out.bucket).toBe("funded");
    expect(out.balanceRecorded).toBe(true);
    const s = await reload();
    const hours = (new Date(s.next_poll_at).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThan(25);

    const again = await apply({ externalId: "D-1", servicing });
    expect(again.balanceRecorded).toBe(false);
    expect((await pool.query(`SELECT count(*)::int AS n FROM active_contract_balances WHERE contract_id = $1::uuid`, [CONTRACT])).rows[0].n).toBe(2);

    const v = contractView(await getContractRow(db, CONTRACT, "BF"));
    expect(v.lender_reported).toMatchObject({ balance: 41250.5, as_of: today, lender_name: `Sample Lender ${tag}`, payments_made: 9, next_payment_amount: 1250, lender_status: "Active" });
    expect(v.staff_balance).toMatchObject({ balance: 40000, source: "manual" });
    expect(v.balances_differ).toBe(true);
    expect(v.balance.balance).toBe(40000); // the staff value is never replaced on the same date
  });

  it("stops polling once the contract is paid out", async () => {
    await pool.query(`UPDATE active_contracts SET status = 'paid_out' WHERE id = $1::uuid`, [CONTRACT]);
    await reload();
    await apply({ externalId: "D-1", status: "Funded" });
    expect((await reload()).next_poll_at).toBeNull();
  });
});
