// KS_SERVER_STORE_REVIEW_SEED_v1 - the app-store reviewer's sign-in and sample data, against real Postgres.
import { afterAll, describe, expect, it, vi } from "vitest";

// The shared-server switch is covered by qaLogin tests; here only the brokerage's own test flag decides.
vi.mock("../../services/qaLogin.js", () => ({ qaLoginEnabled: (env: NodeJS.ProcessEnv) => env.KS_TEST_BROKERAGE === "true" }));

import { pool } from "../../db.js";
import { REVIEW_STAFF, SAMPLE_FILES, SAMPLE_LENDERS, seedStoreReview } from "../seed.js";

const TEST_ENV = { KS_TEST_BROKERAGE: "true", KS_QA_LOGIN_CODE: "123456", KS_STORE_REVIEW: "true" } as NodeJS.ProcessEnv;

async function cleanup() {
  await pool.query(`DELETE FROM application_contacts WHERE application_id IN (SELECT id FROM applications WHERE metadata->>'sample_data' = 'true')`);
  await pool.query(`DELETE FROM applications WHERE metadata->>'sample_data' = 'true'`);
  await pool.query(`DELETE FROM contacts WHERE 'sample_data' = ANY(tags)`);
  await pool.query(`DELETE FROM companies WHERE name = ANY($1)`, [SAMPLE_FILES.map((f) => f.company)]);
  await pool.query(`DELETE FROM lenders WHERE name = ANY($1)`, [SAMPLE_LENDERS.map((l) => l.name)]);
  await pool.query(`DELETE FROM users WHERE phone_number = $1`, [REVIEW_STAFF.phone]);
}

describe("store-review seed (real Postgres)", () => {
  afterAll(cleanup);

  it("does nothing on a brokerage that is not a test brokerage", async () => {
    await cleanup();
    expect(await seedStoreReview(pool as any, { KS_TEST_BROKERAGE: "false" } as NodeJS.ProcessEnv)).toEqual({ ran: false, files: 0 });
    const u = await pool.query(`SELECT 1 FROM users WHERE phone_number = $1`, [REVIEW_STAFF.phone]);
    expect(u.rows).toHaveLength(0);
  });

  it("adds the reviewer and the sample files once, and a second run changes nothing", async () => {
    expect(await seedStoreReview(pool as any, TEST_ENV)).toEqual({ ran: true, files: SAMPLE_FILES.length });
    const u = await pool.query(`SELECT role, active, status FROM users WHERE phone_number = $1`, [REVIEW_STAFF.phone]);
    expect(u.rows).toEqual([{ role: "Admin", active: true, status: "ACTIVE" }]);
    const apps = await pool.query(
      `SELECT a.name, a.pipeline_state, a.contact_id IS NOT NULL AS has_contact,
              EXISTS (SELECT 1 FROM application_contacts ac WHERE ac.application_id = a.id) AS linked
         FROM applications a WHERE a.metadata->>'sample_data' = 'true' ORDER BY a.name`,
    );
    expect(apps.rows).toHaveLength(SAMPLE_FILES.length);
    expect(apps.rows.every((r: any) => r.has_contact && r.linked)).toBe(true);
    expect((await pool.query(`SELECT 1 FROM lenders WHERE name = ANY($1)`, [SAMPLE_LENDERS.map((l) => l.name)])).rows).toHaveLength(2);

    expect(await seedStoreReview(pool as any, TEST_ENV)).toEqual({ ran: true, files: 0 });
    expect((await pool.query(`SELECT 1 FROM users WHERE phone_number = $1`, [REVIEW_STAFF.phone])).rows).toHaveLength(1);
    expect((await pool.query(`SELECT 1 FROM applications WHERE metadata->>'sample_data' = 'true'`)).rows).toHaveLength(SAMPLE_FILES.length);
  });

  it("KS_SERVER_STORE_REVIEW_SEED_v2: another test brokerage switches the reviewer off and adds nothing", async () => {
    const other = { KS_TEST_BROKERAGE: "true", KS_QA_LOGIN_CODE: "123456" } as NodeJS.ProcessEnv;
    expect(await seedStoreReview(pool as any, other)).toEqual({ ran: false, files: 0 });
    const u = await pool.query(`SELECT active, disabled FROM users WHERE phone_number = $1`, [REVIEW_STAFF.phone]);
    expect(u.rows).toEqual([{ active: false, disabled: true }]);
  });
});
