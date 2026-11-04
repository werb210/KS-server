// KS_SETUP_WIZARD - the set-up wizard against real Postgres: the migration twice, every detection query runs against
// the real schema without a logged failure, a lender and the team tick their steps off, and manual answers stick.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../lib/logWarnSwallowed.js", () => ({ logWarnSwallowed: (err: unknown, where: string, fallback: unknown) => { warn(where, (err as Error)?.message); return fallback; } }));

import { pool } from "../db.js";
import { buildWizard, dismissWizard, setStepStatus } from "../setup/setupWizard.js";
import type { Q } from "../plans/state.js";

const db = pool as unknown as Q;
const admin = randomUUID();
const broker = randomUUID();
const marketing = randomUUID();
const tag = admin.slice(0, 8);
const lenderId = randomUUID();

describe("set-up wizard (real Postgres)", () => {
  beforeAll(async () => {
    const sql = readFileSync("migrations/2026_11_16_ks_setup_wizard.sql", "utf8");
    await pool.query(sql);
    await pool.query(sql);
    for (const [id, role, first] of [[admin, "Admin", "Ada"], [broker, "Staff", "Bo"], [marketing, "Marketing", "Mo"]] as const) {
      await pool.query("INSERT INTO users (id, email, active, role, first_name, phone) VALUES ($1, $2, true, $3, $4, $5)", [id, `${tag}-${first}@example.test`, role, first, "+15875550100"]);
    }
  });
  afterAll(async () => {
    await pool.query("DELETE FROM setup_progress WHERE user_id = ANY($1::uuid[])", [[admin, broker, marketing]]);
    await pool.query("DELETE FROM lenders WHERE id = $1", [lenderId]);
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[admin, broker, marketing]]);
  });

  it("every role's detection runs against the real schema with no failed query", async () => {
    for (const [id, role] of [[admin, "Admin"], [broker, "Staff"], [marketing, "Marketing"]] as const) {
      const w = await buildWizard(db, id, role);
      expect(w.steps.length).toBeGreaterThan(4);
      expect(w.steps.find((s) => s.key === "profile")?.status).toBe(role === "Staff" ? "todo" : "done"); // name + mobile (Brokers also need a signature)
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("a lender ticks off the Admin's lender step; a manual skip and done stick; dismiss is remembered", async () => {
    await pool.query("INSERT INTO lenders (id, name, country) VALUES ($1, $2, 'CA')", [lenderId, `Wizard Lender ${tag}`]);
    let w = await buildWizard(db, admin, "Admin");
    expect(w.steps.find((s) => s.key === "lenders")?.status).toBe("done");
    expect(w.steps.find((s) => s.key === "team")?.status).toBe("done"); // three people now

    expect(await setStepStatus(db, admin, "Admin", "import", "skipped")).toEqual({ ok: true });
    expect(await setStepStatus(db, admin, "Admin", "test_link", "done")).toEqual({ ok: true });
    expect(await setStepStatus(db, admin, "Admin", "test_link", "done")).toEqual({ ok: true }); // again: upsert
    w = await buildWizard(db, admin, "Admin");
    expect(w.steps.find((s) => s.key === "import")?.status).toBe("skipped");
    expect(w.steps.find((s) => s.key === "test_link")?.status).toBe("done");
    expect(w.dismissed).toBe(false);

    await dismissWizard(db, admin);
    expect((await buildWizard(db, admin, "Admin")).dismissed).toBe(true);
    expect((await buildWizard(db, broker, "Staff")).dismissed).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
