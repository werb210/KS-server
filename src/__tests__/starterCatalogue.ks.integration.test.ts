// KS_SERVER_STARTER_CATALOGUE - against a real Postgres: a brokerage with no lenders gets the starter list once.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../db.js";
import { STARTER_LENDER_NAME, STARTER_MARKER, STARTER_PRODUCTS, seedStarterCatalogue } from "../tenancy/starterCatalogue.js";

// A transaction that is rolled back. The shared test database may already hold other tests' lenders, so the "has this
// brokerage any lenders?" question is answered "no" here; every write is the real one.
let client: Awaited<ReturnType<typeof pool.connect>>;
const asNew = { query: (sql: string, params?: unknown[]) => (/^SELECT 1 FROM lenders LIMIT 1$/.test(sql.trim()) ? Promise.resolve({ rows: [] }) : client.query(sql, params as any[])) };
beforeAll(async () => {
  client = await pool.connect();
  await client.query("BEGIN");
  await client.query("DELETE FROM settings WHERE key = $1", [STARTER_MARKER]);
});
afterAll(async () => { await client.query("ROLLBACK"); client.release(); });

describe("starter list for a new brokerage", () => {
  it("adds one active product per kind of financing under a clearly named starter lender", async () => {
    expect(await seedStarterCatalogue(asNew as any, "CA")).toBe(STARTER_PRODUCTS.length);
    const l = await client.query("SELECT id, country FROM lenders WHERE name = $1", [STARTER_LENDER_NAME]);
    expect(l.rows).toHaveLength(1);
    expect(l.rows[0].country).toBe("CA");
    const p = await client.query("SELECT category, country FROM lender_products WHERE lender_id = $1 AND active = true ORDER BY category", [l.rows[0].id]);
    expect(p.rows.map((r: any) => r.category)).toEqual(STARTER_PRODUCTS.map((x) => x.category).sort());
    expect(p.rows.find((r: any) => r.category === "SBA")?.country).toBe("US");
  });
  it("is added once: it does not come back after it has been added", async () => {
    expect(await seedStarterCatalogue(asNew as any, "CA")).toBe(0);
    expect((await client.query("SELECT 1 FROM lenders WHERE name = $1", [STARTER_LENDER_NAME])).rows).toHaveLength(1);
  });
  it("is not added to a brokerage that already has lenders", async () => {
    await client.query("DELETE FROM settings WHERE key = $1", [STARTER_MARKER]);
    const has = { query: (sql: string, params?: unknown[]) => (/^SELECT 1 FROM lenders LIMIT 1$/.test(sql.trim()) ? Promise.resolve({ rows: [{ "?column?": 1 }] }) : client.query(sql, params as any[])) };
    expect(await seedStarterCatalogue(has as any, "CA")).toBe(0);
    expect((await client.query("SELECT 1 FROM settings WHERE key = $1", [STARTER_MARKER])).rows).toHaveLength(1);
  });
});
