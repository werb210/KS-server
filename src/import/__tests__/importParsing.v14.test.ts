// KS_SERVER_v14_DATA_IMPORT - reading files (CSV, XLSX, zips) and turning rows into Keystone values: no database.
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { csvHeaders, detectDelimiter, iterateCsvRecords, iterateCsvRows, readXlsx, iterateRecordsAsRows, toCsv, csvCell, normaliseHeaders } from "../parse.js";
import { autoMatch, mappingProblems, templateCsv, FIELDS, RECORD_TYPES } from "../fields.js";
import { applyMapping, mapCategory, mapStage, normalise, parseDate, parseNumber, phoneKey } from "../normalise.js";
import { fileKindOf, keystoneInput, openSource, SourceError, zipLookup } from "../source.js";

describe("CSV", () => {
  it("handles quotes, embedded delimiters and newlines, CRLF, a BOM and blank lines", () => {
    const text = '﻿Name,Email,Notes\r\n"Doe, Jane",jane@example.com,"said ""hi""\nthen left"\r\n\r\nBob,bob@example.com,\r\n';
    const rows = [...iterateCsvRows(text)];
    expect(rows).toEqual([
      { Name: "Doe, Jane", Email: "jane@example.com", Notes: 'said "hi"\nthen left' },
      { Name: "Bob", Email: "bob@example.com", Notes: "" },
    ]);
  });

  it("detects semicolon and tab delimited exports", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
    expect([...iterateCsvRecords("a;b\n1;2")]).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("makes header names unique and fills blanks", () => {
    expect(normaliseHeaders(["Email", "email", "", " Phone  number "])).toEqual(["Email", "email (2)", "Column 3", "Phone number"]);
    expect(csvHeaders("First Name,Last Name\nA,B")).toEqual(["First Name", "Last Name"]);
  });

  it("streams tens of thousands of rows", () => {
    const lines = ["email,first_name"];
    for (let i = 0; i < 30000; i++) lines.push(`p${i}@example.com,P${i}`);
    let n = 0;
    for (const r of iterateCsvRows(lines.join("\n"))) { n++; if (n === 30000) expect(r.email).toBe("p29999@example.com"); }
    expect(n).toBe(30000);
  });

  it("error CSV cells cannot start a formula and are quoted when needed", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(toCsv(["row", "problem"], [{ row: 2, problem: "bad, email" }])).toBe('row,problem\r\n2,"bad, email"\r\n');
  });
});

async function xlsx(rows: Array<Array<string | number>>, dateCol?: number): Promise<Buffer> {
  const zip = new JSZip();
  const shared: string[] = [];
  const sIdx = (s: string) => { let i = shared.indexOf(s); if (i < 0) { shared.push(s); i = shared.length - 1; } return i; };
  const colName = (i: number) => String.fromCharCode(65 + i);
  const sheetRows = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
    const ref = `${colName(ci)}${ri + 1}`;
    if (typeof v === "number") return `<c r="${ref}"${ci === dateCol && ri > 0 ? ' s="1"' : ""}><v>${v}</v></c>`;
    return `<c r="${ref}" t="s"><v>${sIdx(v)}</v></c>`;
  }).join("")}</row>`).join("");
  zip.file("xl/workbook.xml", `<workbook xmlns:r="r"><sheets><sheet name="Deals" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`);
  zip.file("xl/worksheets/sheet1.xml", `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`);
  zip.file("xl/sharedStrings.xml", `<sst>${shared.map((s) => `<si><t>${s.replace(/&/g, "&amp;")}</t></si>`).join("")}</sst>`);
  zip.file("xl/styles.xml", `<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("XLSX", () => {
  it("reads the first sheet: shared strings, numbers and date cells", async () => {
    const buf = await xlsx([["Deal Name", "Amount", "Close Date"], ["Doe & Sons", 150000, 45366]], 2);
    const sheet = await readXlsx(buf);
    expect(sheet.name).toBe("Deals");
    expect([...iterateRecordsAsRows(sheet.records())]).toEqual([{ "Deal Name": "Doe & Sons", Amount: "150000", "Close Date": "2024-03-15" }]);
  });

  it("opens as an import source with columns, counts and a sample", async () => {
    const buf = await xlsx([["Deal Name", "Amount"], ["A", 1], ["B", 2]]);
    const src = await openSource("xlsx", buf, { recordType: "applications" });
    expect(src.columns).toEqual(["Deal Name", "Amount"]);
    expect(src.counts).toEqual({ applications: 2 });
    const items = [...src.items({ name: "Deal Name", amount: "Amount" })];
    expect(items.map((i) => i.input)).toEqual([{ name: "A", amount: "1" }, { name: "B", amount: "2" }]);
  });
});

describe("column mapping", () => {
  it("auto-matches HubSpot, Salesforce and Pipedrive export headers", () => {
    expect(autoMatch("hubspot", "contacts", ["Record ID", "First Name", "Last Name", "Email", "Phone Number", "Associated Company IDs", "Contact owner", "Create Date"]))
      .toEqual({ external_id: "Record ID", first_name: "First Name", last_name: "Last Name", email: "Email", phone: "Phone Number", company_external_id: "Associated Company IDs", owner_email: "Contact owner", created_at: "Create Date" });
    expect(autoMatch("salesforce", "applications", ["Id", "Name", "StageName", "Amount", "AccountId", "CloseDate"]))
      .toMatchObject({ external_id: "Id", name: "Name", stage: "StageName", amount: "Amount", company_external_id: "AccountId", funded_at: "CloseDate" });
    expect(autoMatch("pipedrive", "applications", ["Deal - ID", "Deal - Title", "Deal - Stage", "Deal - Value", "Deal - Organization"]))
      .toMatchObject({ external_id: "Deal - ID", name: "Deal - Title", stage: "Deal - Stage", amount: "Deal - Value", company_name: "Deal - Organization" });
  });

  it("matches a spreadsheet using Keystone's own column names (the template)", () => {
    for (const type of RECORD_TYPES) {
      const cols = templateCsv(type).split("\r\n")[0].split(",");
      const m = autoMatch("spreadsheet", type, cols);
      expect(Object.keys(m).sort()).toEqual(FIELDS[type].map((f) => f.key).sort());
    }
  });

  it("uses each column once", () => {
    const m = autoMatch("spreadsheet", "contacts", ["Name", "Email"]);
    expect(m).toEqual({ name: "Name", email: "Email" });
  });

  it("reports missing required fields and one-of groups", () => {
    expect(mappingProblems("companies", {})).toEqual(['Choose a column for "Company name".']);
    expect(mappingProblems("lender_products", { name: "n", category: "c" })[0]).toMatch(/at least one of: Lender ID in the old system, Lender name/);
    expect(mappingProblems("contacts", { email: "E", bogus: "X" })).toEqual(['"bogus" is not a Contacts field.']);
    expect(applyMapping({ E: " a@b.co ", X: "1" }, { email: "E" })).toEqual({ email: "a@b.co" });
  });
});

describe("values", () => {
  it("numbers, dates, phones", () => {
    expect(parseNumber("$1,200,000.50")).toBe(1200000.5);
    expect(parseNumber("1.200.000,50")).toBe(1200000.5);
    expect(parseNumber("250k")).toBe(250000);
    expect(parseNumber("(500)")).toBe(-500);
    expect(parseNumber("")).toBeNull();
    expect(Number.isNaN(parseNumber("lots"))).toBe(true);
    expect((parseDate("2024-03-15") as Date).toISOString()).toBe("2024-03-15T00:00:00.000Z");
    expect((parseDate("03/15/2024") as Date).toISOString()).toBe("2024-03-15T00:00:00.000Z");
    expect((parseDate("15/03/2024") as Date).toISOString()).toBe("2024-03-15T00:00:00.000Z");
    expect(parseDate("13/13/2024")).toBe("invalid");
    expect(parseDate("someday")).toBe("invalid");
    expect(phoneKey("+1 (403) 555-0100")).toBe("4035550100");
    expect(phoneKey("403.555.0100")).toBe("4035550100");
    expect(phoneKey("12")).toBe("");
  });

  it("maps CRM pipeline stages to Keystone stages, with the licensee's own map first", () => {
    expect(mapStage("closedwon").stage).toBe("Accepted");
    expect(mapStage("Closed Lost").stage).toBe("Rejected");
    expect(mapStage("Appointment scheduled").stage).toBe("Received");
    expect(mapStage("Qualified to buy").stage).toBe("In Review");
    expect(mapStage("Contract sent").stage).toBe("Offer");
    expect(mapStage("Submitted to lender").stage).toBe("Off to Lender");
    expect(mapStage("Docs needed").stage).toBe("Documents Required");
    expect(mapStage("On hold").stage).toBe("Hold");
    expect(mapStage("Off to Lender").stage).toBe("Off to Lender");
    expect(mapStage("Stage 7")).toEqual({ stage: "Received", matched: false });
    expect(mapStage("Stage 7", { "stage 7": "Offer" })).toEqual({ stage: "Offer", matched: true });
    expect(mapCategory("Line of credit")).toBe("LOC");
    expect(mapCategory("Equipment Leasing")).toBe("EQUIPMENT");
    expect(mapCategory("mystery")).toBeNull();
  });

  it("contacts: splits a full name, lowercases email, needs some identity", () => {
    const n = normalise("contacts", { name: "Jane Q Doe", email: "Jane@Example.com", tags: "a; b,c" });
    expect(n.errors).toEqual([]);
    expect(n.values).toMatchObject({ first_name: "Jane", last_name: "Q Doe", email: "jane@example.com", tags: ["a", "b", "c"] });
    expect(normalise("contacts", { email: "not-an-email" }).errors.map((e) => e.field)).toEqual(["email", "email"]);
    expect(normalise("contacts", {}).errors[0].message).toMatch(/needs a name, an email or a phone/);
  });

  it("deals: stage, amounts, dates, first of several associated ids", () => {
    const n = normalise("applications", { name: "Deal", stage: "Closed Won", amount: "$150,000", created_at: "2024-01-02", contact_external_id: "11;22" });
    expect(n.errors).toEqual([]);
    expect(n.values).toMatchObject({ stage: "Accepted", source_stage: "Closed Won", amount: 150000, contact_external_id: "11", created_at: "2024-01-02T00:00:00.000Z" });
    const bad = normalise("applications", { name: "", amount: "lots", stage: "Weird" });
    expect(bad.errors.map((e) => e.field)).toEqual(["name", "amount"]);
    expect(bad.warnings[0].message).toMatch(/not a Keystone stage/);
  });

  it("lender products: category, country, amount range", () => {
    expect(normalise("lender_products", { lender_name: "L", name: "P", category: "line of credit", country: "Canada", amount_min: "10,000", amount_max: "5,000" }).errors)
      .toEqual([{ field: "amount_max", message: "maximum amount is below the minimum" }]);
    const ok = normalise("lender_products", { lender_name: "L", name: "P", category: "TERM", rate_type: "fixed" });
    expect(ok.values).toMatchObject({ category: "TERM", country: "BOTH", rate_type: "FIXED" });
  });

  it("notes and documents need something to attach to", () => {
    expect(normalise("notes", { body: "hi" }).errors[0].field).toBe("contact_email");
    expect(normalise("notes", { body: "Left a voicemail", activity_type: "Logged call", contact_email: "a@b.co" }).values.activity_type).toBe("call");
    expect(normalise("documents", { file: "x.pdf" }).errors[0].field).toBe("application_external_id");
    expect(normalise("documents", { file: ".\\docs\\x.pdf", category: "Bank Statements", contact_email: "a@b.co" }).values).toMatchObject({ file: "docs/x.pdf", category: "bank_statements" });
  });
});

describe("zips", () => {
  it("documents zip: finds the mapping CSV and files by path, case or name", async () => {
    const zip = new JSZip();
    zip.file("import/files.csv", "file,deal id,category\nStatements/Jan.PDF,D1,bank\nmissing.pdf,D2,id\n");
    zip.file("import/statements/jan.pdf", "%PDF-1.4 jan");
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const src = await openSource("zip", buf, { recordType: "documents" });
    expect(src.columns).toEqual(["file", "deal id", "category"]);
    const items = [...src.items({ file: "file", application_external_id: "deal id", category: "category" })];
    expect((await items[0].readFile!())?.buffer.toString()).toBe("%PDF-1.4 jan");
    expect(await items[1].readFile!()).toBeNull();
    const look = zipLookup(await JSZip.loadAsync(buf));
    expect(look("jan.pdf")?.name).toBe("import/statements/jan.pdf");
  });

  it("refuses the wrong kind of file for the record type", async () => {
    await expect(openSource("csv", Buffer.from("a\n1"), { recordType: "documents" })).rejects.toBeInstanceOf(SourceError);
    await expect(openSource("zip", Buffer.from("not a zip"), { recordType: "keystone" })).rejects.toBeInstanceOf(SourceError);
    expect(fileKindOf("x.XLSX")).toBe("xlsx");
    expect(fileKindOf("x.xls")).toBeNull();
  });

  it("Keystone export: tables in dependency order, ids as source ids, owners by email, stored files", async () => {
    const zip = new JSZip();
    zip.file("manifest.json", "{}");
    zip.file("tables/users.jsonl", JSON.stringify({ id: "u1", email: "pat@example.com", password_hash: "x" }) + "\n");
    zip.file("tables/contacts.jsonl", JSON.stringify({ id: "c1", first_name: "Jane", email: "jane@example.com", company_id: "co1", owner_id: "u1" }) + "\n");
    zip.file("tables/companies.jsonl", JSON.stringify({ id: "co1", name: "Doe Ltd", tags: ["x"] }) + "\n");
    zip.file("tables/applications.jsonl", JSON.stringify({ id: "a1", name: "Deal", pipeline_state: "Offer", contact_id: "c1", requested_amount: "5000" }) + "\n");
    zip.file("tables/crm_notes.jsonl", [JSON.stringify({ id: "n1", body: "kept", contact_id: "c1" }), JSON.stringify({ id: "n2", body: "gone", is_deleted: true })].join("\n") + "\n");
    zip.file("tables/documents.jsonl", JSON.stringify({ id: "d1", application_id: "a1", filename: "s.pdf", category: "bank_statements" }) + "\n");
    zip.file("documents/documents/d1-s.pdf", "%PDF");
    const src = await openSource("zip", await zip.generateAsync({ type: "nodebuffer" }), { recordType: "keystone" });
    expect(src.counts).toEqual({ companies: 1, contacts: 1, applications: 1, notes: 1, documents: 1 });
    const items = [...src.items({})];
    expect(items.map((i) => i.type)).toEqual(["companies", "contacts", "applications", "notes", "documents"]);
    expect(items[1].input).toMatchObject({ external_id: "c1", company_external_id: "co1", owner_email: "pat@example.com" });
    expect(items[2].input).toMatchObject({ stage: "Offer", amount: "5000", contact_external_id: "c1" });
    expect((await items[4].readFile!())?.buffer.toString()).toBe("%PDF");
    expect(keystoneInput("companies", { id: "x", name: "N", tags: ["a", "b"] }, new Map()).tags).toBe("a; b");
  });
});
