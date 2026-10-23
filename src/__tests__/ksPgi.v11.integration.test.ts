// KS_SERVER_v11_PGI - PGI referrals against real Postgres: the migration (twice), the link, sending a referral,
// forwarding the signed term sheet, a signed partner callback, a reply, the list and the worker. Only the insurance
// partner (fetch) and the file store are faked.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pool } from "../db.js";
import pgiRoutes from "../routes/pgi.js";
import type { Q } from "../plans/state.js";
import { savePartnerLink } from "../pgi/link.js";
import { forwardDocuments, runPgiTick, sendReferral } from "../pgi/service.js";

const MIGRATION = "migrations/2026_10_25_ks_v11_pgi_referrals.sql";
const db = pool as unknown as Q;
const ADMIN = randomUUID();
const APP = randomUUID();
const SECRET = "p".repeat(64);
const token = jwt.sign({ sub: ADMIN, id: ADMIN, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
const calls: Array<{ url: string; method: string }> = [];
const fetchImpl = vi.fn(async (url: string, init: any) => {
  calls.push({ url, method: init.method });
  const json = (b: unknown, status = 200) => ({ ok: status < 400, status, json: async () => b, text: async () => JSON.stringify(b) });
  if (url.endsWith("/api/v1/bi/ks/referrals")) {
    return json({ ok: true, created: true, bi_application_id: "bi-int-1", application_code: "BI-INT001", public_id: "pub-int",
      completion_url: "https://partner.example/login?next=/applications/pub-int/form", status: "awaiting_client", bi_status: "created",
      checklist: { documents: [], missing_documents: [{ slot: "profit_loss", label: "P&L" }], missing_fields: [] }, referral_fee: null }, 201);
  }
  if (url.endsWith("/documents")) return json({ ok: true, bi_document_id: "bd-int" }, 201);
  if (url.endsWith("/messages")) return json({ ok: true }, 201);
  return json({ ok: true, status: "in_review", bi_status: "document_review", checklist: { documents: [], missing_documents: [], missing_fields: [] }, messages: [] });
});
const deps = { fetchImpl: fetchImpl as any, loadFile: async () => Buffer.from("%PDF-1.4 signed term sheet"), notify: async () => undefined };

function app() {
  const a = express();
  a.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
  a.use("/api/pgi", pgiRoutes);
  return a;
}

describe("KS v11 PGI referrals (real Postgres)", () => {
  beforeAll(async () => {
    await pool.query(readFileSync(MIGRATION, "utf8"));
    await pool.query(readFileSync(MIGRATION, "utf8")); // safe to run again
    await pool.query(`DELETE FROM pgi_partner_link`);
    await pool.query(`INSERT INTO users (id, email, active, role, first_name, last_name) VALUES ($1, $2, true, 'Admin', 'Pat', 'Admin')`, [ADMIN, `pgi-${ADMIN.slice(0, 8)}@example.com`]);
    await pool.query(
      `INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, owner_user_id, business_legal_name, metadata)
       VALUES ($1, 'PGI Widget Co', now(), now(), 'draft', 'RECEIVED', $2, 'PGI Widget Co', '{}'::jsonb)`,
      [APP, ADMIN],
    );
    await pool.query(
      `INSERT INTO documents (id, application_id, created_at, category, document_type, status, filename, uploaded_by)
       VALUES ($1, $2, now(), 'signed_term_sheet', 'signed_term_sheet', 'uploaded', 'term-sheet.pdf', 'system')`,
      [randomUUID(), APP],
    );
    await savePartnerLink(db, { url: "https://partner.azurewebsites.net", referralSourceId: "src-int", apiKey: "bk_ks_" + "i".repeat(30), callbackSecret: SECRET }, "test");
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM pgi_referrals WHERE application_id = $1`, [APP]);
    await pool.query(`DELETE FROM pgi_partner_link`);
    await pool.query(`DELETE FROM documents WHERE application_id = $1`, [APP]);
    await pool.query(`DELETE FROM applications WHERE id = $1`, [APP]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [ADMIN]);
  });

  it("refers the application, records the partner's link and forwards the signed term sheet once", async () => {
    await pool.query(`INSERT INTO pgi_referrals (application_id, input, referring_user_id) VALUES ($1, $2::jsonb, $3)`,
      [APP, JSON.stringify({ business_legal_name: "PGI Widget Co", guarantor_name: "Jane Doe", guarantor_phone: "+14035550100" }), ADMIN]);
    expect(await sendReferral(db, APP, deps)).toEqual({ ok: true });
    const ref = (await pool.query(`SELECT status, bi_application_id, missing_count FROM pgi_referrals WHERE application_id = $1`, [APP])).rows[0];
    expect(ref).toEqual({ status: "awaiting_client", bi_application_id: "bi-int-1", missing_count: 1 });
    const a = (await pool.query(`SELECT bi_application_id, bi_completion_url FROM applications WHERE id = $1`, [APP])).rows[0];
    expect(a.bi_application_id).toBe("bi-int-1");
    const prompt = (await pool.query(`SELECT cta_label, cta_action FROM communications_messages WHERE application_id = $1`, [APP])).rows;
    expect(prompt).toEqual([{ cta_label: "Complete PGI Application", cta_action: a.bi_completion_url }]);
    const fwd = (await pool.query(`SELECT slot, forwarded_at IS NOT NULL AS sent FROM pgi_referral_documents d JOIN pgi_referrals p ON p.id = d.referral_id WHERE p.application_id = $1`, [APP])).rows;
    expect(fwd).toEqual([{ slot: "loan_agreement", sent: true }]);
    expect(await forwardDocuments(db, APP, deps)).toEqual({ sent: 0, skipped: 1, failed: 0 });
  });

  it("a signed partner callback lands in the thread once; staff see it in the list and reply", async () => {
    vi.stubGlobal("fetch", fetchImpl);
    const raw = JSON.stringify({ event_id: `evt-${APP}`, type: "doc_request", ks_application_id: APP, message: { body: "Please send the P&L" },
      missing_documents: [{ slot: "profit_loss", label: "P&L" }], missing_fields: [] });
    const ts = Math.floor(Date.now() / 1000);
    const post = () => request(app()).post("/api/pgi/bi-events").set("Content-Type", "application/json").set("X-BI-Referral-Source", "src-int")
      .set("X-BI-Timestamp", String(ts)).set("X-BI-Signature", "v1=" + createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex")).send(raw);
    expect((await post()).body).toEqual({ ok: true, stored: true });
    expect((await post()).body).toEqual({ ok: true, stored: false });
    const list = await request(app()).get("/api/pgi/referrals").set("Authorization", `Bearer ${token}`);
    expect(list.body.referrals.find((r: any) => r.application_id === APP)).toMatchObject({ unread_count: 1, application_name: "PGI Widget Co", referring_user_name: "Pat Admin" });
    const view = await request(app()).get(`/api/pgi/referrals/${APP}`).set("Authorization", `Bearer ${token}`);
    expect(view.body.messages.map((m: any) => m.direction)).toEqual(["from_partner"]);
    expect(view.body.checklist.find((r: any) => r.slot === "loan_agreement").state).toBe("sent");
    const reply = await request(app()).post(`/api/pgi/referrals/${APP}/messages`).set("Authorization", `Bearer ${token}`).send({ body: "Uploading today" });
    expect(reply.body).toMatchObject({ ok: true, sent: true });
    vi.unstubAllGlobals();
  });

  it("the worker query runs on the real schema", async () => {
    await pool.query(`UPDATE pgi_referrals SET last_synced_at = NULL WHERE application_id = $1`, [APP]);
    const r = await runPgiTick(db, deps);
    expect(r.synced).toBeGreaterThanOrEqual(1);
    expect((await pool.query(`SELECT status FROM pgi_referrals WHERE application_id = $1`, [APP])).rows[0].status).toBe("in_review");
  });
});
