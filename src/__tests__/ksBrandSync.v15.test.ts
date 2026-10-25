// KS_SERVER_v15_BRAND_SYNC - branding chosen at sign-up arrives with the plan push; the admin's own edits win.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return {
    ...actual,
    pool: { query: queryMock, connect: vi.fn(async () => ({ query: queryMock, release: vi.fn() })) },
    runQuery: queryMock, dbQuery: queryMock, query: queryMock, safeQuery: queryMock,
  };
});

import { applyOpsBranding, parseOpsBranding, updateLicenseeSettings, clearLicenseeCache } from "../licensee/settings.js";

/** A one-row licensee_settings table that understands the INSERT ... ON CONFLICT statements the module writes. */
function settingsTable(initial: Record<string, any> = {}) {
  let row: Record<string, any> | null = Object.keys(initial).length ? { ...initial } : null;
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const flat = sql.replace(/\s+/g, " ");
    if (/^SELECT .* FROM licensee_settings/.test(flat)) return { rows: row ? [{ ...row }] : [] };
    const ins = /INSERT INTO licensee_settings \(id, updated_by, ([^)]*)\) VALUES \(1, ([^,]+), (.*)\) ON CONFLICT/.exec(flat);
    if (ins) {
      const cols = ins[1].split(",").map((c) => c.trim());
      const vals = ins[3].split(",").map((v) => v.trim());
      row = row ?? {};
      cols.forEach((c, i) => {
        const m = /\$(\d+)/.exec(vals[i]!)!;
        const v = params[Number(m[1]) - 1];
        row![c] = c === "ops_branding" ? JSON.parse(String(v)) : v;
      });
      return { rows: [] };
    }
    return { rows: [] };
  });
  return { query, row: () => row };
}

beforeEach(() => clearLicenseeCache());

describe("parseOpsBranding", () => {
  it("accepts the known fields, skips invalid ones, refuses a non-object", () => {
    expect(parseOpsBranding(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseOpsBranding("x")).toEqual({ ok: false });
    expect(parseOpsBranding({ primary_color: "#7A1F3D", font_family: "Lato", logo_url: "http://insecure.example/l.png", accent_color: null, other: 1 }))
      .toEqual({ ok: true, value: { primary_color: "#7A1F3D", font_family: "Lato", accent_color: "" } });
  });
});

describe("applyOpsBranding", () => {
  const SIGNUP = { primary_color: "#7A1F3D", accent_color: "#0E6655", background_color: "#FFFAF0", font_family: "Lato", logo_url: "https://ops.example/api/public/logos/abcdefghijklmnop" };

  it("fills a new copy with the sign-up branding", async () => {
    const t = settingsTable();
    const r = await applyOpsBranding(t, SIGNUP);
    expect(r).toEqual({ applied: ["primary_color", "accent_color", "background_color", "font_family", "logo_url"], kept: [] });
    expect(t.row()).toMatchObject({ ...SIGNUP, ops_branding: SIGNUP });
  });

  it("follows later pushes until the admin changes a field; then the admin's value wins", async () => {
    const t = settingsTable();
    await applyOpsBranding(t, SIGNUP);
    // The admin changes the main colour on the Company page.
    await updateLicenseeSettings(t, { primary_color: "#112233" }, "admin-1");
    const r = await applyOpsBranding(t, { ...SIGNUP, primary_color: "#445566", font_family: "Merriweather" });
    expect(r).toEqual({ applied: ["font_family"], kept: ["primary_color"] });
    expect(t.row()).toMatchObject({ primary_color: "#112233", font_family: "Merriweather" });
    expect(t.row()!.ops_branding).toMatchObject({ primary_color: "#445566", font_family: "Merriweather" });
  });

  it("an admin-cleared field takes the pushed value again (empty means no choice)", async () => {
    const t = settingsTable({ id: 1, primary_color: "", ops_branding: { primary_color: "#7A1F3D" } });
    expect((await applyOpsBranding(t, { primary_color: "#7A1F3D" })).applied).toEqual(["primary_color"]);
  });
});

describe("PUT /api/plan { branding }", () => {
  it("applies branding pushed by operations, alone or with a plan change", async () => {
    const t = settingsTable();
    queryMock.mockImplementation(answerBySql([
      [/licensee_settings/, (sql: string, params?: unknown[]) => t.query(sql, params ?? [])],
      [/FROM licensee_plan WHERE id = 1/, { rows: [{ plan: "growth", extra_storage_blocks: 0, addons: {} }] }],
    ]));
    process.env.KS_OPS_KEY = "ops-key-0123456789";
    const router = (await import("../routes/plan.js")).default;
    const a = express();
    a.use(express.json());
    a.use("/api/plan", router);
    const res = await request(a).put("/api/plan").set("X-KS-Ops-Key", "ops-key-0123456789").send({ branding: { primary_color: "#7A1F3D", font_family: "Lato" } });
    expect(res.status).toBe(200);
    expect(res.body.branding).toEqual({ applied: ["primary_color", "font_family"], kept: [] });
    expect(t.row()).toMatchObject({ primary_color: "#7A1F3D", font_family: "Lato" });
    expect((await request(a).put("/api/plan").set("X-KS-Ops-Key", "ops-key-0123456789").send({ branding: "red" })).status).toBe(400);
    expect((await request(a).put("/api/plan").send({ branding: { primary_color: "#000000" } })).status).toBe(401);
  });
});
