// KS_SERVER_LICENSEE_DOCUMENTS - the upload, review and client sides.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { PDFDocument } from "pdf-lib";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});

import docsRouter from "../routes/licenseeDocuments.js";
import extraRouter from "../routes/clientExtraQuestions.js";

const app = express();
app.use(express.json());
app.use("/api/licensee-documents", docsRouter);
app.use("/api/client/extra-questions", extraRouter);
const token = (role: string) => "Bearer " + jwt.sign({ sub: "76767676-7676-4676-8676-767676767676", role, tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

async function pdfWith(names: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  names.forEach((n, i) => doc.getForm().createTextField(n).addToPage(page, { x: 100, y: 700 - i * 30, width: 200, height: 18 }));
  return Buffer.from(await doc.save());
}

const DOC = { id: "dddddddd-1111-4111-8111-111111111111", kind: "application_form", name: "Our form", file_name: "f.pdf", format: "pdf_form", active: true, created_at: "", updated_at: "" };

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([
    [/INSERT INTO licensee_documents/, (_s: string, p?: unknown[]) => ({ rows: [{ ...DOC, fields: JSON.parse(String(p?.[5])) }] })],
    [/SELECT key FROM licensee_wizard_questions/, { rows: [] }],
    [/FROM licensee_wizard_questions q JOIN licensee_documents d/, (s: string) => ({ rows: /q\.active AND d\.active/.test(s)
      ? [{ id: "q1", document_id: DOC.id, key: "fleet_size", label: "Fleet size", type: "text", options: [], required: true, active: true, sort: 0 },
         { id: "q2", document_id: DOC.id, key: "fleet_size", label: "Fleet size (dup)", type: "text", options: [], required: false, active: true, sort: 1 }]
      : [] })],
  ]));
});

describe("Settings > Your documents", () => {
  it("only an admin uploads", async () => {
    const r = await request(app).post("/api/licensee-documents").set("Authorization", token("Staff")).field("kind", "application_form").attach("file", await pdfWith(["BusinessLegalName"]), "f.pdf");
    expect(r.status).toBe(403);
  });

  it("reads and matches the fields, and makes an extra question for each unmatched one", async () => {
    const r = await request(app).post("/api/licensee-documents").set("Authorization", token("Admin"))
      .field("kind", "application_form").attach("file", await pdfWith(["BusinessLegalName", "Fleet size"]), "Our form.pdf");
    expect(r.status).toBe(201);
    expect(r.body.document.fields.map((f: any) => [f.name, f.mapped_to])).toEqual([["BusinessLegalName", "business.legal_name"], ["Fleet size", null]]);
    // the previous application form is switched off first, then one question is written for "Fleet size"
    expect(sqlText(callsMatching(h.query, /UPDATE licensee_documents SET active = false/)[0]![0])).toMatch(/kind = \$1/);
    const qs = callsMatching(h.query, /INSERT INTO licensee_wizard_questions/);
    expect(qs).toHaveLength(1);
    expect(qs[0]![1]!.slice(1, 4)).toEqual(["fleet_size", "Fleet size", "text"]);
  });

  it("refuses a file with nothing to fill and says how to fix it", async () => {
    const doc = await PDFDocument.create(); doc.addPage();
    const r = await request(app).post("/api/licensee-documents").set("Authorization", token("Admin")).field("kind", "term_sheet").attach("file", Buffer.from(await doc.save()), "flat.pdf");
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/fillable PDF/);
    expect(callsMatching(h.query, /INSERT INTO licensee_documents/)).toHaveLength(0);
  });

  it("the licensee's correction wins, and a now-matched field stops being a question", async () => {
    const fields = [{ name: "Fleet size", label: "Fleet size", type: "text", mapped_to: null, matched_by: null }];
    h.query.mockImplementation(answerBySql([
      [/FROM licensee_documents WHERE id::text = \$1/, { rows: [{ ...DOC, fields, file: Buffer.from("x") }] }],
      [/UPDATE licensee_documents SET fields/, (_s: string, p?: unknown[]) => ({ rows: [{ ...DOC, fields: JSON.parse(String(p?.[1])) }] })],
      [/SELECT key FROM licensee_wizard_questions/, { rows: [{ key: "fleet_size" }] }],
    ]));
    const r = await request(app).put(`/api/licensee-documents/${DOC.id}/fields`).set("Authorization", token("Admin")).send({ fields: [{ name: "Fleet size", mapped_to: "business.employees" }] });
    expect(r.status).toBe(200);
    expect(r.body.document.fields[0]).toMatchObject({ mapped_to: "business.employees", matched_by: "licensee" });
    expect(callsMatching(h.query, /INSERT INTO licensee_wizard_questions/)).toHaveLength(0);
    expect(callsMatching(h.query, /UPDATE licensee_wizard_questions SET active = false/)[0]![1]).toEqual([DOC.id, ["fleet_size"]]);
  });

  it("an unknown key is not saved as a match", async () => {
    const fields = [{ name: "Fleet size", label: "Fleet size", type: "text", mapped_to: null, matched_by: null }];
    h.query.mockImplementation(answerBySql([
      [/FROM licensee_documents WHERE id::text = \$1/, { rows: [{ ...DOC, fields, file: Buffer.from("x") }] }],
      [/UPDATE licensee_documents SET fields/, (_s: string, p?: unknown[]) => ({ rows: [{ ...DOC, fields: JSON.parse(String(p?.[1])) }] })],
      [/SELECT key FROM licensee_wizard_questions/, { rows: [] }],
    ]));
    const r = await request(app).put(`/api/licensee-documents/${DOC.id}/fields`).set("Authorization", token("Admin")).send({ fields: [{ name: "Fleet size", mapped_to: "nope" }] });
    expect(r.body.document.fields[0].mapped_to).toBeNull();
  });
});

describe("the client wizard", () => {
  it("gets each live extra question once, with no sign-in", async () => {
    const r = await request(app).get("/api/client/extra-questions");
    expect(r.status).toBe(200);
    expect(r.body.questions).toEqual([{ key: "fleet_size", label: "Fleet size", type: "text", options: [], required: true }]);
  });
});
