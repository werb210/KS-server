// KS_SERVER_v16_DATA_IMPORT - the import wizard against real Postgres: the migration (twice), uploads through the
// routes, preview, dry run (nothing written), the run with dedupe and cross-file links, documents, the error CSV,
// undo (created rows removed, changed fields restored unless edited since), a Keystone export zip, a resumed job
// and admin-only access. Only blob storage is an in-memory fake.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import JSZip from "jszip";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const store = vi.hoisted(() => {
  const files = new Map<string, Buffer>();
  let n = 0;
  return {
    files,
    get: async (key: string) => files.get(key) ?? null,
    put: async (p: { buffer: Buffer; filename: string; pathPrefix?: string }) => {
      const blobName = `${p.pathPrefix ?? "x"}/${++n}-${p.filename}`;
      files.set(blobName, p.buffer);
      return { blobName, url: `mem://${blobName}`, sizeBytes: p.buffer.length, hash: "" };
    },
    delete: async (key: string) => { files.delete(key); },
  };
});
vi.mock("../import/deps.js", () => ({
  importFileStore: () => store,
  importJobDeps: () => ({ files: store }),
}));

import { pool } from "../db.js";
import dataImportRoutes from "../routes/dataImport.js";
import { claimNextJob, runQueuedJobs, CHUNK } from "../import/engine.js";

const MIGRATION = "migrations/2026_10_30_ks_v16_data_import.sql";
const ADMIN = randomUUID();
const STAFF = randomUUID();
const TAG = randomUUID().slice(0, 8);
const token = jwt.sign({ sub: ADMIN, id: ADMIN, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
const staffToken = jwt.sign({ sub: STAFF, id: STAFF, role: "Staff", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
const audits: Array<{ action: string }> = [];
const deps = { files: store, audit: async (e: { action: string }) => { audits.push(e); } };
const batches: string[] = [];

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/data-import", dataImportRoutes);
  return a;
}
const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);
const email = (s: string) => `${s}-${TAG}@example.com`;

async function uploadFile(name: string, body: Buffer | string, source: string, recordType: string) {
  const r = await auth(request(app()).post("/api/data-import/uploads"))
    .field("source", source).field("record_type", recordType).attach("file", Buffer.from(body), name);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  batches.push(r.body.batch.id);
  return r.body;
}
async function dryRunAndRun(id: string) {
  expect((await auth(request(app()).post(`/api/data-import/batches/${id}/dry-run`))).status).toBe(202);
  await runQueuedJobs(pool, deps);
  const ready = (await auth(request(app()).get(`/api/data-import/batches/${id}`))).body.batch;
  expect(ready.status).toBe("ready");
  expect((await auth(request(app()).post(`/api/data-import/batches/${id}/run`))).status).toBe(202);
  await runQueuedJobs(pool, deps);
  const done = (await auth(request(app()).get(`/api/data-import/batches/${id}`))).body.batch;
  return { dry: ready.dry_run, done };
}

// Real jobs over real rows: generous timeouts, since CI runs the integration files in parallel.
describe("KS v16 data import (real Postgres)", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    await pool.query(readFileSync(MIGRATION, "utf8"));
    await pool.query(readFileSync(MIGRATION, "utf8")); // safe to run again
    await pool.query(`INSERT INTO users (id, email, active, role, first_name, last_name) VALUES ($1, $2, true, 'Admin', 'Pat', 'Admin'), ($3, $4, true, 'Staff', 'Sam', 'Staff')`,
      [ADMIN, email("admin"), STAFF, email("staff")]);
    // An existing contact the import will match by email, and one it will match by phone.
    await pool.query(`INSERT INTO contacts (id, name, first_name, last_name, email, phone, job_title, silo, created_at, updated_at) VALUES
      ($1, 'Old Jane', 'Old', 'Jane', $2, '403-555-0100', 'Clerk', 'BF', now(), now()),
      ($3, 'Phone Only', 'Phone', 'Only', NULL, '+1 (587) 555-0199', NULL, 'BF', now(), now())`,
      [randomUUID(), email("jane"), randomUUID()]);
  }, 60_000);

  afterAll(async () => {
    for (const id of batches) {
      const items = await pool.query(`SELECT entity_table, entity_id FROM import_batch_items WHERE batch_id = $1 AND action = 'created' AND undone_at IS NULL ORDER BY id DESC`, [id]);
      for (const it of items.rows) await pool.query(`DELETE FROM ${it.entity_table} WHERE id::text = $1`, [it.entity_id]);
    }
    await pool.query(`DELETE FROM crm_notes WHERE body LIKE $1`, [`%${TAG}%`]);
    await pool.query(`DELETE FROM applications WHERE name LIKE $1`, [`%${TAG}%`]);
    await pool.query(`DELETE FROM companies WHERE name LIKE $1`, [`%${TAG}%`]);
    await pool.query(`DELETE FROM import_batches WHERE id = ANY($1::uuid[])`, [batches]);
    await pool.query(`DELETE FROM import_external_ids WHERE external_id LIKE $1 OR batch_id IS NULL AND entity_id NOT IN (SELECT id::text FROM contacts UNION ALL SELECT id::text FROM companies UNION ALL SELECT id::text FROM applications)`, [`%${TAG}%`]);
    await pool.query(`DELETE FROM import_mappings WHERE name LIKE $1`, [`%${TAG}%`]);
    await pool.query(`DELETE FROM contacts WHERE email LIKE $1 OR phone = '+1 (587) 555-0199'`, [`%-${TAG}@example.com`]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ADMIN, STAFF]]);
  }, 120_000);

  it("is for admins only", async () => {
    const r = await request(app()).get("/api/data-import/presets").set("Authorization", `Bearer ${staffToken}`);
    expect(r.status).toBe(403);
    const ok = await auth(request(app()).get("/api/data-import/presets"));
    expect(ok.body.stages).toContain("Off to Lender");
    expect(ok.body.record_types.map((t: any) => t.key)).toEqual(["contacts", "companies", "lenders", "lender_products", "applications", "notes", "documents"]);
    const tpl = await auth(request(app()).get("/api/data-import/templates/contacts"));
    expect(tpl.text.split("\r\n")[0]).toMatch(/^external_id,first_name,last_name,name,email,phone/);
  });

  it("companies, then contacts linked by the old system's company id, deduped by email and phone", async () => {
    const companies = `Record ID,Company name,City,Industry\nCO1-${TAG},Doe Trucking ${TAG},Calgary,Transport\nCO2-${TAG},Acme ${TAG},Edmonton,\n,,,\n`;
    const up = await uploadFile("companies.csv", companies, "hubspot", "companies");
    expect(up.suggested_mapping).toMatchObject({ external_id: "Record ID", name: "Company name", city: "City", industry: "Industry" });
    expect(up.total_rows).toBe(2);
    const { done } = await dryRunAndRun(up.batch.id);
    expect(done).toMatchObject({ status: "completed", created_count: 2, updated_count: 0, error_count: 0 });

    const contacts = [
      "Record ID,First Name,Last Name,Email,Phone Number,Job Title,Associated Company IDs,Create Date",
      `P1-${TAG},Jane,Doe,${email("jane").toUpperCase()},,Owner,CO1-${TAG},2024-03-15`,
      `P2-${TAG},Phone,Match,,587.555.0199,,,`,
      `P3-${TAG},New,Person,${email("new")},,,CO2-${TAG},`,
      `P4-${TAG},Bad,Email,not-an-email,,,,`,
      `P5-${TAG},Dup,OfNew,${email("new")},,Manager,,`,
    ].join("\n");
    const cu = await uploadFile("contacts.csv", contacts, "hubspot", "contacts");
    expect(cu.suggested_mapping.company_external_id).toBe("Associated Company IDs");

    const preview = await auth(request(app()).get(`/api/data-import/batches/${cu.batch.id}/preview`));
    expect(preview.body.rows).toHaveLength(5);
    expect(preview.body.rows[3].errors[0]).toMatchObject({ field: "email" });

    const { dry, done: c } = await dryRunAndRun(cu.batch.id);
    // The dry run counts exactly what the run then does, and wrote nothing.
    expect(dry).toMatchObject({ created: 1, updated: 3, errors: 1 });
    expect(c).toMatchObject({ created_count: 1, updated_count: 3, error_count: 1 });

    const jane = (await pool.query(`SELECT c.*, co.name AS co_name FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE lower(c.email) = $1`, [email("jane")])).rows[0];
    expect(jane).toMatchObject({ first_name: "Jane", last_name: "Doe", job_title: "Owner", co_name: `Doe Trucking ${TAG}` });
    expect(new Date(jane.created_at).getUTCFullYear()).toBeGreaterThan(2024); // an existing record keeps its own created date
    const phone = (await pool.query(`SELECT last_name, phone FROM contacts WHERE phone = '587.555.0199' OR phone = '+1 (587) 555-0199'`)).rows;
    expect(phone).toEqual([{ last_name: "Match", phone: "587.555.0199" }]);
    const fresh = (await pool.query(`SELECT job_title, owner_id::text AS owner FROM contacts WHERE lower(email) = $1`, [email("new")])).rows;
    expect(fresh).toEqual([{ job_title: "Manager", owner: ADMIN }]); // second row of the same email updated the first

    const csv = await auth(request(app()).get(`/api/data-import/batches/${cu.batch.id}/errors.csv?phase=run`));
    expect(csv.text).toContain("not-an-email");
    expect(csv.text.split("\r\n")[0]).toContain("row,level,record_type,field,problem");

    // Someone edits Jane's job title after the import; undo puts back the other fields but keeps that edit.
    await pool.query(`UPDATE contacts SET job_title = 'Founder' WHERE lower(email) = $1`, [email("jane")]);
    expect((await auth(request(app()).post(`/api/data-import/batches/${cu.batch.id}/undo`))).status).toBe(202);
    await runQueuedJobs(pool, deps);
    const undone = (await auth(request(app()).get(`/api/data-import/batches/${cu.batch.id}`))).body.batch;
    expect(undone.status).toBe("undone");
    expect(undone.undo_summary).toMatchObject({ removed: 1 });
    expect(undone.undo_summary.kept).toBeGreaterThanOrEqual(1);
    const after = (await pool.query(`SELECT first_name, last_name, job_title, company_id FROM contacts WHERE lower(email) = $1`, [email("jane")])).rows[0];
    expect(after).toEqual({ first_name: "Old", last_name: "Jane", job_title: "Founder", company_id: null });
    expect((await pool.query(`SELECT count(*)::int AS n FROM contacts WHERE lower(email) = $1`, [email("new")])).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT last_name FROM contacts WHERE phone = '+1 (587) 555-0199'`)).rows[0].last_name).toBe("Only");
    expect((await pool.query(`SELECT count(*)::int AS n FROM import_external_ids WHERE batch_id = $1`, [cu.batch.id])).rows[0].n).toBe(0);
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["data_import.completed", "data_import.undone"]));
  });

  it("lenders and products, deals with stages and links, notes and a documents zip", async () => {
    const lenders = await uploadFile("lenders.xlsx.csv", `name,country,submission_email\nPrairie ${TAG},Canada,deals-${TAG}@example.com\n`, "spreadsheet", "lenders");
    await dryRunAndRun(lenders.batch.id);
    const products = await uploadFile("products.csv",
      `lender,product,category,min amount,max amount,required documents\nPrairie ${TAG},LOC ${TAG},Line of credit,"25,000","500,000",6 months business banking statements; nonsense doc\nNew Lender ${TAG},Term ${TAG},term,,,\n`,
      "spreadsheet", "lender_products");
    expect(products.suggested_mapping).toMatchObject({ lender_name: "lender", name: "product", category: "category" });
    const p = await dryRunAndRun(products.batch.id);
    expect(p.done).toMatchObject({ created_count: 2, error_count: 0 });
    const lp = (await pool.query(`SELECT lp.category, lp.amount_min, lp.required_documents, l.name AS lender FROM lender_products lp JOIN lenders l ON l.id = lp.lender_id WHERE lp.name = $1`, [`LOC ${TAG}`])).rows[0];
    expect(lp).toMatchObject({ category: "LOC", lender: `Prairie ${TAG}` });
    expect(Number(lp.amount_min)).toBe(25000);
    expect(lp.required_documents.map((d: any) => d.category)).toEqual(["6 months business banking statements"]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM lenders WHERE name = $1`, [`New Lender ${TAG}`])).rows[0].n).toBe(1);

    await uploadFile("c.csv", `id,email,first_name\nK1-${TAG},${email("deal")},Dee\n`, "salesforce", "contacts").then((b) => dryRunAndRun(b.batch.id));
    const deals = [
      "Id,Name,StageName,Amount,ContactId,Lender,CloseDate",
      `D1-${TAG},Deal one ${TAG},Closed Won,"$150,000",K1-${TAG},Prairie ${TAG},2024-05-01`,
      `D2-${TAG},Deal two ${TAG},Weird stage,1000,,,`,
    ].join("\n");
    const du = await uploadFile("deals.csv", deals, "salesforce", "applications");
    const prev = await auth(request(app()).get(`/api/data-import/batches/${du.batch.id}/preview`));
    expect(prev.body.stages).toEqual([{ value: "Closed Won", rows: 1, stage: "Accepted", matched: true }, { value: "Weird stage", rows: 1, stage: "Received", matched: false }]);
    // The admin maps the unknown stage.
    const map = await auth(request(app()).put(`/api/data-import/batches/${du.batch.id}/mapping`)).send({ mapping: du.batch.mapping, options: { stage_map: { "Weird stage": "In Review" } } });
    expect(map.status).toBe(200);
    // Saved mappings are kept per record type.
    const saved = await auth(request(app()).post("/api/data-import/mappings")).send({ name: `SF deals ${TAG}`, source: "salesforce", record_type: "applications", mapping: du.batch.mapping, options: { stage_map: { "Weird stage": "In Review" } } });
    expect(saved.body.mapping.name).toBe(`SF deals ${TAG}`);
    expect((await auth(request(app()).get("/api/data-import/mappings?record_type=applications"))).body.mappings.some((m: any) => m.name === `SF deals ${TAG}`)).toBe(true);
    const d = await dryRunAndRun(du.batch.id);
    expect(d.done).toMatchObject({ created_count: 2, error_count: 0 });
    const apps = (await pool.query(`SELECT a.name, a.pipeline_state, a.status, a.requested_amount, a.silo, a.source, c.email, l.name AS lender
        FROM applications a LEFT JOIN contacts c ON c.id = a.contact_id LEFT JOIN lenders l ON l.id = a.lender_id WHERE a.name LIKE $1 ORDER BY a.name`, [`Deal % ${TAG}`])).rows;
    expect(apps.map((a: any) => [a.name, a.pipeline_state, a.status, Number(a.requested_amount), a.email, a.lender, a.silo, a.source])).toEqual([
      [`Deal one ${TAG}`, "Accepted", "ACCEPTED", 150000, email("deal"), `Prairie ${TAG}`, "BF", "import"],
      [`Deal two ${TAG}`, "In Review", "IN_REVIEW", 1000, null, null, "BF", "import"],
    ]);

    const notes = await uploadFile("notes.csv", `Id,WhatId,WhoId,Type,Subject,Description,ActivityDate\nN1-${TAG},D1-${TAG},K1-${TAG},Call,Intro,Talked about rates,2024-04-01\nN2-${TAG},,MISSING,Note,,Orphan,\n`, "salesforce", "notes");
    const n = await dryRunAndRun(notes.batch.id);
    expect(n.done).toMatchObject({ created_count: 1, error_count: 1 });
    const note = (await pool.query(`SELECT body, application_id IS NOT NULL AS has_app, contact_id IS NOT NULL AS has_contact FROM crm_notes WHERE body LIKE 'Call: Intro%' AND silo = 'BF' ORDER BY created_at DESC LIMIT 1`)).rows[0];
    expect(note).toEqual({ body: "Call: Intro\n\nTalked about rates", has_app: true, has_contact: true });

    const zip = new JSZip();
    zip.file("files.csv", `file,deal id,contact email,category\nbank/jan.pdf,D1-${TAG},,Bank Statements\nid.png,,${email("deal")},id\nnot-there.pdf,D1-${TAG},,other\n`);
    zip.file("bank/jan.pdf", "%PDF-1.4 jan statement");
    zip.file("id.png", "PNGDATA");
    const docs = await uploadFile("docs.zip", await zip.generateAsync({ type: "nodebuffer" }), "spreadsheet", "documents");
    const dd = await dryRunAndRun(docs.batch.id);
    expect(dd.dry).toMatchObject({ created: 2, errors: 1 });
    expect(dd.done).toMatchObject({ created_count: 2, error_count: 1 });
    const doc = (await pool.query(`SELECT d.category, d.filename, d.blob_name, d.uploaded_by FROM documents d JOIN applications a ON a.id = d.application_id WHERE a.name = $1`, [`Deal one ${TAG}`])).rows[0];
    expect(doc).toMatchObject({ category: "bank_statements", filename: "jan.pdf", uploaded_by: "import" });
    expect(store.files.get(doc.blob_name)?.toString()).toBe("%PDF-1.4 jan statement");
    // Importing the same zip again skips both files.
    const again = await uploadFile("docs.zip", await zip.generateAsync({ type: "nodebuffer" }), "spreadsheet", "documents");
    expect((await dryRunAndRun(again.batch.id)).done).toMatchObject({ created_count: 0, skipped_count: 2 });

    // Undo the documents import: rows and stored files go.
    await auth(request(app()).post(`/api/data-import/batches/${docs.batch.id}/undo`));
    await runQueuedJobs(pool, deps);
    expect((await pool.query(`SELECT count(*)::int AS n FROM documents WHERE blob_name = $1`, [doc.blob_name])).rows[0].n).toBe(0);
    expect(store.files.has(doc.blob_name)).toBe(false);
  });

  it("re-imports a Keystone export zip, keeping the links between records", async () => {
    const co = randomUUID(); const ct = randomUUID(); const ap = randomUUID();
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify({ tables: [] }));
    zip.file("tables/users.jsonl", JSON.stringify({ id: "old-user", email: email("admin") }) + "\n");
    zip.file("tables/companies.jsonl", JSON.stringify({ id: co, name: `Export Co ${TAG}`, silo: "BF", types_of_financing: ["LOC"], tags: [] }) + "\n");
    zip.file("tables/contacts.jsonl", JSON.stringify({ id: ct, first_name: "Ex", last_name: "Port", email: email("export"), company_id: co, owner_id: "old-user" }) + "\n");
    zip.file("tables/applications.jsonl", JSON.stringify({ id: ap, name: `Export deal ${TAG}`, pipeline_state: "Off to Lender", contact_id: ct, company_id: co, requested_amount: "75000" }) + "\n");
    zip.file("tables/crm_notes.jsonl", JSON.stringify({ id: randomUUID(), body: `Exported note ${TAG}`, application_id: ap, contact_id: ct }) + "\n");
    const up = await uploadFile("data-export.zip", await zip.generateAsync({ type: "nodebuffer" }), "keystone", "keystone");
    expect(up.counts).toEqual({ companies: 1, contacts: 1, applications: 1, notes: 1 });
    const r = await dryRunAndRun(up.batch.id);
    expect(r.done).toMatchObject({ created_count: 4, error_count: 0 });
    const row = (await pool.query(`SELECT a.pipeline_state, c.email, co.name AS company, c.owner_id::text AS owner,
        (SELECT count(*)::int FROM crm_notes n WHERE n.application_id = a.id) AS notes
        FROM applications a JOIN contacts c ON c.id = a.contact_id JOIN companies co ON co.id = a.company_id WHERE a.name = $1`, [`Export deal ${TAG}`])).rows[0];
    expect(row).toEqual({ pipeline_state: "Off to Lender", email: email("export"), company: `Export Co ${TAG}`, owner: ADMIN, notes: 1 });
    // A legal hold on the imported deal keeps it, its note, its contact and its company through an undo.
    const deal = (await pool.query(`SELECT id FROM applications WHERE name = $1`, [`Export deal ${TAG}`])).rows[0].id;
    await pool.query(`INSERT INTO legal_holds (target_type, target_id, reason) VALUES ('application', $1, 'Litigation')`, [deal]);
    await auth(request(app()).post(`/api/data-import/batches/${up.batch.id}/undo`));
    await runQueuedJobs(pool, deps);
    const undone = (await auth(request(app()).get(`/api/data-import/batches/${up.batch.id}`))).body.batch;
    expect(undone.undo_summary).toMatchObject({ removed: 0, held: 4 });
    expect((await pool.query(`SELECT count(*)::int AS n FROM applications WHERE id = $1`, [deal])).rows[0].n).toBe(1);
    await pool.query(`UPDATE legal_holds SET released_at = now(), release_reason = 'test' WHERE target_id = $1`, [deal]);
  });

  it("only a finished dry run can be run, and a job whose worker stopped is picked up again", async () => {
    const up = await uploadFile("c.csv", `email\n${email("resume")}\n`, "spreadsheet", "contacts");
    const early = await auth(request(app()).post(`/api/data-import/batches/${up.batch.id}/run`));
    expect(early.status).toBe(409);
    await pool.query(`UPDATE import_batches SET status = 'running', heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [up.batch.id]);
    const claimed = await claimNextJob(pool);
    expect(claimed).toEqual({ id: up.batch.id, status: "running" });
    await pool.query(`UPDATE import_batches SET status = 'queued' WHERE id = $1`, [up.batch.id]);
    await runQueuedJobs(pool, deps);
    expect((await pool.query(`SELECT status, created_count FROM import_batches WHERE id = $1`, [up.batch.id])).rows[0]).toEqual({ status: "completed", created_count: 1 });
    expect(CHUNK).toBeGreaterThan(0);
  });

  it("handles a file larger than one chunk (600 rows, 250 per transaction)", async () => {
    const lines = ["email,first_name,last_name"];
    for (let i = 0; i < 600; i++) lines.push(`${email(`bulk${i}`)},Bulk,${i}`);
    const up = await uploadFile("bulk.csv", lines.join("\n"), "spreadsheet", "contacts");
    const r = await dryRunAndRun(up.batch.id);
    expect(r.done).toMatchObject({ status: "completed", created_count: 600, processed_rows: 600, error_count: 0 });
    await auth(request(app()).post(`/api/data-import/batches/${up.batch.id}/undo`));
    await runQueuedJobs(pool, deps);
    expect((await pool.query(`SELECT count(*)::int AS n FROM contacts WHERE email LIKE $1`, [`bulk%-${TAG}@example.com`])).rows[0].n).toBe(0);
  });
});
