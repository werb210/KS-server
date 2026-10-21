// KS_SERVER_v1_LICENSEE - the licensee settings row against the real schema, and the public read.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { pool } from "../db.js";
import licensee from "../routes/licensee.js";
import { clearLicenseeCache, getLicenseeSettings, updateLicenseeSettings } from "../licensee/settings.js";

let before: any = null;

describe("KS v1 licensee settings (real Postgres)", () => {
  beforeAll(async () => {
    await pool.query(readFileSync("migrations/2026_10_21_ks_v1_licensee_settings.sql", "utf8"));
    await pool.query(readFileSync("migrations/2026_10_21_ks_v1_licensee_settings.sql", "utf8")); // safe to run again
    before = (await pool.query(`SELECT * FROM licensee_settings WHERE id = 1`)).rows[0] ?? null;
    await pool.query(`DELETE FROM licensee_settings WHERE id = 1`);
    clearLicenseeCache();
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM licensee_settings WHERE id = 1`).catch((e) => console.warn("cleanup", String(e)));
    if (before) {
      const cols = Object.keys(before);
      await pool.query(`INSERT INTO licensee_settings (${cols.join(", ")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(", ")})`, cols.map((c) => before[c]))
        .catch((e) => console.warn("restore", String(e)));
    }
    clearLicenseeCache();
  });

  it("saves the fields given, keeps the others, and refuses bad values", async () => {
    expect((await getLicenseeSettings(pool)).company_name).toBeTruthy();
    const bad = await updateLicenseeSettings(pool, { primary_color: "red" }, "u-1");
    expect(bad.ok).toBe(false);
    const r = await updateLicenseeSettings(pool, { company_name: "Prairie Capital", assistant_name: "Sky" }, "u-1");
    expect(r.ok).toBe(true);
    const r2 = await updateLicenseeSettings(pool, { support_email: "help@prairie.ca" }, "u-1");
    expect(r2.ok && r2.settings).toMatchObject({ company_name: "Prairie Capital", assistant_name: "Sky", support_email: "help@prairie.ca" });
    const rows = await pool.query(`SELECT count(*)::int AS n FROM licensee_settings`);
    expect(rows.rows[0].n).toBe(1);
  });

  it("GET is public and shows branding and addresses only; PUT needs a sign-in", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/licensee", licensee);
    const g = await request(app).get("/api/licensee");
    expect(g.status).toBe(200);
    expect(g.body.licensee.company_name).toBe("Prairie Capital");
    expect(g.body.licensee.urls.server).toMatch(/^https:\/\//);
    expect(JSON.stringify(g.body)).not.toMatch(/secret|token|password/i);
    const p = await request(app).put("/api/licensee").send({ company_name: "x" });
    expect(p.status).toBe(401);
  });
});
