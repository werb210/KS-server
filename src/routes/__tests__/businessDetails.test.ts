// KS_SERVER_SETUP_BUSINESS_DETAILS_v1 - the set-up form for the business address and number relays to Keystone
// operations with the ops key. Admins only. The database and KS-Ops are fakes.
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db.js", () => ({ pool: { query: h.query }, db: { query: h.query } }));

import businessDetailsRoutes, { setBusinessDetailsFetchForTests } from "../businessDetails.js";

const OPS = { KS_OPS_URL: "https://ops.example.test", KS_LICENSEE_ID: "22222222-2222-4222-8222-222222222222", KS_OPS_KEY: "ops-key-1234567890" };
const token = (role: string, id = "u-admin") => jwt.sign({ sub: id, id, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
const app = () => {
  const a = express();
  a.use(express.json());
  a.use("/api/business-details", businessDetailsRoutes);
  return a;
};
const withEnv = async (vars: Record<string, string>, fn: () => Promise<void>) => {
  Object.assign(process.env, vars);
  try { await fn(); } finally { for (const k of Object.keys(vars)) delete process.env[k]; }
};

h.query.mockImplementation(async (sql: string) => {
  const s = String(sql).replace(/\s+/g, " ");
  if (/AS name, email FROM users WHERE id::text = \$1/.test(s)) return { rows: [{ name: "Ana Admin", email: "ana@acme.example" }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
});

afterEach(() => setBusinessDetailsFetchForTests(null));

describe("business details (set-up)", () => {
  it("says so plainly when this server is not linked to Keystone operations", async () => {
    const r = await request(app()).get("/api/business-details").set("Authorization", `Bearer ${token("Admin")}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ops_ready: false, details: null });
    const put = await request(app()).put("/api/business-details").set("Authorization", `Bearer ${token("Admin")}`).send({ city: "Calgary" });
    expect(put.status).toBe(503);
  });

  it("Admins only", async () => {
    await withEnv(OPS, async () => {
      expect((await request(app()).get("/api/business-details").set("Authorization", `Bearer ${token("Staff", "u-sam")}`)).status).toBe(403);
      expect((await request(app()).put("/api/business-details").send({})).status).toBe(401);
    });
  });

  it("reads the details on file and saves the form, with who saved it", async () => {
    const sent: Array<{ url: string; body: any; key: string }> = [];
    setBusinessDetailsFetchForTests(async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body), key: init.headers["X-KS-Ops-Key"] });
      return { ok: true, status: 200, json: async () => ({ ok: true, message: "Saved.", details: { city: "Calgary", complete: true } }), text: async () => "" };
    });
    await withEnv(OPS, async () => {
      const got = await request(app()).get("/api/business-details").set("Authorization", `Bearer ${token("Admin")}`);
      expect(got.body).toMatchObject({ ops_ready: true, details: { city: "Calgary" } });
      const put = await request(app()).put("/api/business-details").set("Authorization", `Bearer ${token("Admin")}`)
        .send({ address_line1: "100 Main St SW", city: "Calgary", province_state: "AB", postal_code: "T2P 1P6", something_else: "ignored" });
      expect(put.status).toBe(200);
      expect(put.body.message).toBe("Saved.");
      expect(sent[1].url).toBe(`https://ops.example.test/api/licensees/${OPS.KS_LICENSEE_ID}/business-details/save`);
      expect(sent[1].key).toBe(OPS.KS_OPS_KEY);
      expect(sent[1].body).toMatchObject({ address_line1: "100 Main St SW", city: "Calgary", saved_by: "Ana Admin" });
      expect(sent[1].body.something_else).toBeUndefined();
    });
  });

  it("passes on what Keystone operations says is wrong, in its words", async () => {
    setBusinessDetailsFetchForTests(async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => JSON.stringify({ ok: false, errors: { postal_code: "Enter a Canadian postal code like T2P 1P6." } }) }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await withEnv(OPS, async () => {
      const r = await request(app()).put("/api/business-details").set("Authorization", `Bearer ${token("Admin")}`).send({ postal_code: "nope" });
      expect(r.status).toBe(400);
      expect(r.body.errors.postal_code).toMatch(/postal code/);
    });
    errors.mockRestore();
  });
});
