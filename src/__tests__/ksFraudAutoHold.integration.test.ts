// KS_SERVER_FRAUD_AUTO_HOLD_v1 - moving a file to Fraud places a legal hold and notifies Admins (real Postgres).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pool } from "../db.js";

const APP = "f2500000-0000-4000-8000-000000000001";
const ADMIN = "f2500000-0000-4000-8000-0000000000a1";
const hasDb = process.env.VITEST_INTEGRATION === "true";

async function cleanup() {
  await pool.query(`DELETE FROM notifications WHERE ref_id = $1`, [APP]);
  await pool.query(`DELETE FROM applications WHERE id = $1`, [APP]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [ADMIN]);
  await pool.query(`BEGIN; ALTER TABLE legal_holds DISABLE TRIGGER ks_legal_holds_no_delete;
    DELETE FROM legal_holds WHERE target_id = '${APP}';
    ALTER TABLE legal_holds ENABLE TRIGGER ks_legal_holds_no_delete; COMMIT;`);
}
const holds = async () => (await pool.query(`SELECT reason, placed_by_name, released_at FROM legal_holds WHERE target_id = $1 ORDER BY placed_at`, [APP])).rows;

describe.runIf(hasDb)("Fraud places an automatic legal hold (real Postgres)", () => {
  beforeAll(async () => {
    await pool.query(readFileSync("migrations/2026_10_28_ks_v14_retention.sql", "utf8"));
    await pool.query(readFileSync("migrations/2026_11_25_ks_fraud_auto_hold.sql", "utf8"));
    await pool.query(readFileSync("migrations/2026_11_25_ks_fraud_auto_hold.sql", "utf8")); // safe to run again
    await cleanup();
    await pool.query(`INSERT INTO users (id, email, role, active) VALUES ($1, 'fraud-admin@test.local', 'Admin', true)`, [ADMIN]);
    await pool.query(`INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status) VALUES ($1, 'Fraudulent Co', now(), now(), 'Received', 'RECEIVED')`, [APP]);
  });
  afterAll(async () => { await cleanup().catch((e) => console.warn("cleanup", String(e))); });

  it("holds the file and tells the Admins when it enters Fraud", async () => {
    expect(await holds()).toHaveLength(0);
    await pool.query(`UPDATE applications SET pipeline_state = 'Fraud' WHERE id = $1`, [APP]);
    const h = await holds();
    expect(h).toHaveLength(1);
    expect(h[0].reason).toMatch(/^Fraud - automatic/);
    expect(h[0].placed_by_name).toBe("Keystone (automatic)");
    const n = await pool.query(`SELECT user_id::text AS user_id, type FROM notifications WHERE ref_id = $1`, [APP]);
    expect(n.rows).toEqual([{ user_id: ADMIN, type: "fraud_legal_hold" }]);
  });

  it("keeps the hold when the file leaves Fraud, and never doubles it", async () => {
    await pool.query(`UPDATE applications SET pipeline_state = 'Hold' WHERE id = $1`, [APP]);
    await pool.query(`UPDATE applications SET pipeline_state = 'Fraud' WHERE id = $1`, [APP]);
    const h = await holds();
    expect(h).toHaveLength(1);
    expect(h[0].released_at).toBeNull();
  });
});
