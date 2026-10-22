// KS_SERVER_v10_DEMO - the demo's pure parts: sample files, the real fraud checks on them, the walkthrough, lender
// match, credit summary, package, tokens and the DEMO_MODE gate. No database (see ksDemo.v10.integration.test.ts).
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { PDFDocument } from "pdf-lib";
import { buildSampleFilesUncached, sampleFiles } from "../samples.js";
import { scanDemoDocument } from "../fraud.js";
import { pdfTextLines, statementRowsFromLines } from "../pdfText.js";
import { DEMO_STEPS, DOCTORED, SAMPLE_DOCS, SAMPLE_FINANCIALS, SAMPLE_BUSINESS, SAMPLE_CONTACT, SAMPLE_REQUEST } from "../fixture.js";
import { applyWalkthrough, completeByAction } from "../walkthrough.js";
import type { ApplicationRow, DocumentRow, Walkthrough } from "../repo.js";
import { matchLenders } from "../lenders.js";
import { buildCreditSummary } from "../creditSummary.js";
import { buildLenderPackage, pdfSafe } from "../packagePdf.js";
import { clientCodeFor, signDemoToken, verifyDemoToken } from "../tokens.js";
import { demoAllowedPath, demoMode, demoTokenKey } from "../config.js";
import { demoGate } from "../index.js";
import { demoRouter } from "../routes.js";
import { answerQuestion, scriptedAnswer } from "../assistant.js";

const SID = "6f1d3c1e-1111-4111-8111-111111111111";
const OTHER = "6f1d3c1e-2222-4222-8222-222222222222";

describe("sample documents", () => {
  it("are the same bytes every time (so every server instance serves identical files)", async () => {
    const a = await buildSampleFilesUncached();
    const b = await buildSampleFilesUncached();
    expect([...a.keys()].sort()).toEqual(SAMPLE_DOCS.map((d) => d.key).sort());
    for (const [k, f] of a) expect(f.sha256).toBe(b.get(k)!.sha256);
  });

  it("every page says SAMPLE", async () => {
    for (const f of (await sampleFiles()).values()) {
      expect((await pdfTextLines(f.bytes)).join(" ")).toMatch(/SAMPLE/);
    }
  });

  it("the statement text reads back as rows, and the doctored deposit is printed with the edited amount", async () => {
    const f = (await sampleFiles()).get("bank_2026_09")!;
    const rows = statementRowsFromLines(await pdfTextLines(f.bytes));
    expect(rows[0]).toMatchObject({ description: "Opening balance" });
    expect(rows[rows.length - 1]).toMatchObject({ description: "Closing balance" });
    expect(rows.filter((r) => typeof r.amount === "number")).toHaveLength(12);
    expect(rows.find((r) => r.date === DOCTORED.date)?.amount).toBe(DOCTORED.shown);
  });
});

describe("the real fraud checks on the samples", () => {
  it("flag the doctored September statement red on both the tamper scan and the statement math", async () => {
    const f = (await sampleFiles()).get("bank_2026_09")!;
    const r = await scanDemoDocument(f.bytes, "bank_statement");
    expect(r.status).toBe("red");
    expect(r.tamper.status).toBe("red");
    expect(r.tamper.reasons.map((x) => x.code)).toEqual(expect.arrayContaining(["editor_producer", "incremental_saves", "modified_after_create"]));
    expect(r.statement_math?.status).toBe("red");
    expect(r.statement_math?.reasons.map((x) => x.code)).toEqual(expect.arrayContaining(["totals_mismatch", "balance_breaks"]));
  });

  it("pass the genuine statements and the other documents", async () => {
    const files = await sampleFiles();
    for (const d of SAMPLE_DOCS.filter((x) => x.key !== "bank_2026_09")) {
      const r = await scanDemoDocument(files.get(d.key)!.bytes, d.category);
      expect({ key: d.key, status: r.status }).toEqual({ key: d.key, status: "green" });
    }
    const jul = await scanDemoDocument(files.get("bank_2026_07")!.bytes, "bank_statement");
    expect(jul.statement_math?.reasons[0]?.code).toBe("math_ok");
    expect(jul.totals?.transactions).toBe(12);
    expect(jul.totals?.deposits).toBeGreaterThan(100_000);
  });
});

describe("walkthrough", () => {
  const start: Walkthrough = { current: "welcome", completed: [], skipped: [], tour_skipped: false };

  it("complete moves to the next step; skip records the skip; the last step stays put", () => {
    const a = applyWalkthrough(start, "complete", "welcome") as Walkthrough;
    expect(a).toMatchObject({ current: "borrower", completed: ["welcome"] });
    const b = applyWalkthrough(a, "skip", "borrower") as Walkthrough;
    expect(b).toMatchObject({ current: "application", skipped: ["borrower"] });
    const c = applyWalkthrough(b, "complete", "borrower") as Walkthrough;
    expect(c.skipped).toEqual([]);
    expect(c.completed).toEqual(["welcome", "borrower"]);
    const last = applyWalkthrough(c, "complete", "submit") as Walkthrough;
    expect(last.current).toBe("submit");
  });

  it("can hide and resume the tour without losing progress; unknown steps are refused", () => {
    const a = applyWalkthrough({ ...start, completed: ["welcome"] }, "skip_tour") as Walkthrough;
    expect(a).toMatchObject({ tour_skipped: true, completed: ["welcome"] });
    expect(applyWalkthrough(a, "resume_tour")).toMatchObject({ tour_skipped: false, completed: ["welcome"] });
    expect(applyWalkthrough(a, "view", "nope")).toEqual({ error: "unknown_step" });
    expect(applyWalkthrough(a, "view", "documents")).toMatchObject({ current: "documents" });
  });

  it("doing the thing completes its step even when Next was never pressed; skipping a completed step keeps it completed", () => {
    const a = completeByAction(start, "call");
    expect(a.completed).toEqual(["call"]);
    expect(completeByAction(a, "call")).toBe(a);
    expect((applyWalkthrough(a, "skip", "call") as Walkthrough).skipped).toEqual([]);
    expect(DEMO_STEPS[0]).toBe("welcome");
  });
});

function app(over: Partial<ApplicationRow> = {}): ApplicationRow {
  return {
    id: "a1", session_id: SID, status: "in_review", business: SAMPLE_BUSINESS, contact: SAMPLE_CONTACT, request: SAMPLE_REQUEST,
    financials: SAMPLE_FINANCIALS, financials_reviewed_at: null, credit_summary: null, selected_lenders: [], call: null, notes: [],
    borrower_submitted_at: null, submitted_at: null, has_package: false, updated_at: new Date(), ...over,
  };
}

async function docRows(decisions: Record<string, "accepted" | "rejected" | "pending">): Promise<DocumentRow[]> {
  const files = await sampleFiles();
  const out: DocumentRow[] = [];
  for (const d of SAMPLE_DOCS) {
    if (!(d.key in decisions)) continue;
    const r = await scanDemoDocument(files.get(d.key)!.bytes, d.category);
    out.push({
      id: d.key, session_id: SID, application_id: "a1", sample_key: d.key, category: d.category, label: d.label, filename: d.filename,
      mime_type: "application/pdf", size_bytes: 1, uploaded_via: "phone", status: decisions[d.key]!, reject_reason: null,
      tamper: r.tamper, statement_math: r.statement_math ? { ...r.statement_math, totals: r.totals } : null, fraud_status: r.status,
      decided_at: null, created_at: new Date(),
    });
  }
  return out;
}

describe("lender match, credit summary and package", () => {
  it("ranks equipment lenders that fit above ones that do not, with plain reasons", () => {
    const m = matchLenders({ amount: 250_000, years_in_business: 7, annual_revenue: 2_140_000, province: "AB", industry: SAMPLE_BUSINESS.industry, equipment: true, dscr: 2.4 });
    expect(m[0]!.fit).toBe("strong");
    expect(m.find((l) => l.id === "harbourline")!.fit).toBe("poor");
    expect(m.find((l) => l.id === "harbourline")!.blockers.join(" ")).toMatch(/revenue/i);
    expect(m.findIndex((l) => l.id === "cobalt-bay")).toBeGreaterThan(m.findIndex((l) => l.id === "aspen-ridge"));
    expect(matchLenders({ amount: 250_000, years_in_business: 7, annual_revenue: 2_140_000, province: "ON", industry: "x", equipment: true, dscr: 2 })
      .find((l) => l.id === "granite-peak")!.fit).toBe("poor");
  });

  it("the credit summary uses the accepted statements' deposits and names the flagged statement", async () => {
    const docs = await docRows({ bank_2026_07: "accepted", bank_2026_08: "accepted", bank_2026_09: "rejected", financials_2025: "accepted" });
    const s = buildCreditSummary(app(), docs);
    expect(s.financial_snapshot.dscr).toBeGreaterThan(2);
    expect(s.banking.statements_used).toHaveLength(2);
    expect(s.banking.avg_monthly_deposits).toBeGreaterThan(150_000);
    expect(s.documents.flagged.map((f) => f.label)).toEqual(["Bank statement - September 2026"]);
    expect(s.documents.missing).toEqual(["Void cheque", "Photo ID (placeholder)"]);
    expect(s.recommendation).toMatch(/subject to the original September statement/);
    const accepted = buildCreditSummary(app(), await docRows({ bank_2026_09: "accepted" }));
    expect(accepted.recommendation).toMatch(/^Hold/);
  });

  it("the lender package has the summary pages plus the accepted documents, and survives odd characters in names", async () => {
    const docs = await docRows({ bank_2026_07: "accepted", bank_2026_09: "rejected" });
    const files = await sampleFiles();
    const pdf = await buildLenderPackage({
      prospect: { name: "Zoë “Test” 李", company: "Acme—Brokers" },
      summary: buildCreditSummary(app(), docs),
      lenders: matchLenders({ amount: 250_000, years_in_business: 7, annual_revenue: 2_140_000, province: "AB", industry: "manufacturing", equipment: true, dscr: 2 }).slice(0, 2),
      documents: docs,
      accepted: [{ label: "Bank statement - July 2026", content: files.get("bank_2026_07")!.bytes, mime_type: "application/pdf" }],
      call: null,
      submittedAt: new Date("2026-10-24T12:00:00Z"),
    });
    const loaded = await PDFDocument.load(pdf);
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(2);
    const text = (await pdfTextLines(pdf)).join("\n");
    expect(text).toMatch(/Lender submission package/);
    expect(text).toMatch(/SAMPLE/);
    expect(text).toMatch(/Bank statement - September 2026 - REJECTED - fraud check: CONCERN/);
    expect(pdfSafe("a—b “c” 李")).toBe('a-b "c" ?');
  });
});

describe("demo tokens", () => {
  it("carry only the session id, for one audience, and are not valid with JWT_SECRET (nor real tokens here)", () => {
    const exp = new Date(Date.now() + 3600_000);
    const staff = signDemoToken(SID, "ks-demo-staff", exp);
    expect(verifyDemoToken(staff, "ks-demo-staff")).toBe(SID);
    expect(verifyDemoToken(staff, "ks-demo-client")).toBeNull();
    expect(() => jwt.verify(staff, String(process.env.JWT_SECRET))).toThrow();
    const real = jwt.sign({ sid: SID, sub: SID, aud: "ks-demo-staff", iss: "ks-demo" }, String(process.env.JWT_SECRET));
    expect(verifyDemoToken(real, "ks-demo-staff")).toBeNull();
    expect(demoTokenKey()).not.toBe(process.env.JWT_SECRET);
    expect(verifyDemoToken(signDemoToken(SID, "ks-demo-staff", new Date(Date.now() - 1000)), "ks-demo-staff")).toBeNull();
  });

  it("borrower link codes differ per session and avoid lookalike characters", () => {
    expect(clientCodeFor(SID)).toMatch(/^[a-hjkmnp-z2-9]{10}$/);
    expect(clientCodeFor(SID)).toBe(clientCodeFor(SID));
    expect(clientCodeFor(SID)).not.toBe(clientCodeFor(OTHER));
  });
});

describe("DEMO_MODE gate", () => {
  const saved = process.env.DEMO_MODE;
  afterEach(() => { if (saved === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = saved; });

  it("is off unless DEMO_MODE=true", () => {
    expect(demoMode({ DEMO_MODE: "TRUE" } as NodeJS.ProcessEnv)).toBe(true);
    expect(demoMode({} as NodeJS.ProcessEnv)).toBe(false);
    expect(demoAllowedPath("/api/demo/staff/state")).toBe(true);
    expect(demoAllowedPath("/api/applications")).toBe(false);
    expect(demoAllowedPath("/api/auth/otp/start")).toBe(false);
    expect(demoAllowedPath("/api/demox")).toBe(false);
  });

  it("closes every non-demo route and needs a demo token on demo routes", async () => {
    const a = express();
    a.use(express.json());
    a.use(demoGate);
    a.use("/api/demo", demoRouter({ db: () => ({ query: async () => { throw new Error("no database in this test"); } }) }));
    a.use("/api", (_req, res) => res.status(200).json({ reached: "real route" }));
    for (const p of ["/api/applications", "/api/auth/otp/start", "/api/sms/send", "/api/o365/mail/send", "/api/plan"]) {
      const r = await request(a).post(p).send({});
      expect({ p, status: r.status, error: r.body.error }).toEqual({ p, status: 404, error: "not_available_in_demo" });
    }
    expect((await request(a).get("/api/demo/staff/state")).status).toBe(401);
    expect((await request(a).get("/api/demo/client/state")).status).toBe(401);
    const real = jwt.sign({ sub: "u1", id: "u1", role: "Admin" }, String(process.env.JWT_SECRET));
    expect((await request(a).get("/api/demo/staff/state").set("Authorization", `Bearer ${real}`)).status).toBe(401);
    const client = signDemoToken(SID, "ks-demo-client", new Date(Date.now() + 60_000));
    expect((await request(a).get("/api/demo/staff/state").set("Authorization", `Bearer ${client}`)).status).toBe(401);
    expect((await request(a).post("/api/demo/ops/sessions").send({})).status).toBe(401);
  });
});

describe("assistant", () => {
  it("answers from the script without a model, and uses the model's answer when there is one", async () => {
    expect(scriptedAnswer("How long will this take?")).toMatch(/business days/);
    expect(scriptedAnswer("what's the interest rate")).toMatch(/7\.2%/);
    expect(await answerQuestion("documents?", async () => null)).toMatchObject({ source: "scripted" });
    expect(await answerQuestion("hi", async () => "Model says hi")).toEqual({ answer: "Model says hi", source: "model" });
  });
});
