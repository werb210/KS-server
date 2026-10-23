// KS_SERVER_v10_DEMO - the sales demo against real Postgres: two prospects side by side can never see or touch each
// other's data, the full walkthrough flow works end to end (uploads -> real fraud flags -> call -> credit summary ->
// lenders -> package), progress events reach KS-Ops grouped per session, and wiping a session removes everything.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { pool } from "../db.js";
import type { Q } from "../plans/state.js";
import { demoRouter } from "../demo/routes.js";
import { sampleFiles } from "../demo/samples.js";
import { flushCompletions, flushEvents, type OpsPoster } from "../demo/progress.js";
import { deleteExpiredSessions } from "../demo/repo.js";
import { signDemoToken } from "../demo/tokens.js";
import { SAMPLE_DOCS } from "../demo/fixture.js";

const MIGRATION = "migrations/2026_10_24_ks_v10_demo.sql";
const OPS_KEY = "demo-int-ops-key-123";
const opsIds: string[] = [];

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/demo", demoRouter({ db: () => pool as unknown as Q, ask: async () => null }));
  return a;
}

type Made = { opsId: string; sessionId: string; staff: string; code: string };

async function makeSession(name: string): Promise<Made> {
  const opsId = `ops_${randomUUID().replace(/-/g, "")}`;
  opsIds.push(opsId);
  const r = await request(app()).post("/api/demo/ops/sessions").set("X-KS-Ops-Key", OPS_KEY)
    .send({ ops_session_id: opsId, name, email: `${name.toLowerCase()}@prospect.example`, company: `${name} Capital`, expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString() });
  expect(r.status).toBe(201);
  return { opsId, sessionId: r.body.session_id, staff: r.body.staff_token, code: r.body.client_code };
}

async function clientToken(code: string): Promise<string> {
  const r = await request(app()).post("/api/demo/client/session").set("User-Agent", "Mozilla/5.0 (iPhone)").send({ code });
  expect(r.status).toBe(200);
  return r.body.client_token;
}

async function uploadSample(token: string, key: string) {
  const f = (await sampleFiles()).get(key)!;
  return request(app()).post("/api/demo/client/documents").set("Authorization", `Bearer ${token}`)
    .field("sample_key", key).attach("file", f.bytes, { filename: f.filename, contentType: "application/pdf" });
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("KS v10 demo (real Postgres)", () => {
  let A: Made, B: Made, clientA: string, clientB: string;

  beforeAll(async () => {
    await pool.query(readFileSync(MIGRATION, "utf8"));
    await pool.query(readFileSync(MIGRATION, "utf8")); // safe to run again
    process.env.KS_OPS_KEY = OPS_KEY;
    process.env.KS_DEMO_CLIENT_URL = "https://client.demo.example/";
    A = await makeSession("Alice");
    B = await makeSession("Bruno");
    clientA = await clientToken(A.code);
    clientB = await clientToken(B.code);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM demo_sessions WHERE ops_session_id = ANY($1::text[])`, [opsIds]).catch((e) => console.warn("cleanup", String(e)));
    delete process.env.KS_OPS_KEY;
    delete process.env.KS_DEMO_CLIENT_URL;
  });

  it("ops routes need the ops key; the same ops id again returns the same session with a fresh token", async () => {
    expect((await request(app()).post("/api/demo/ops/sessions").send({})).status).toBe(401);
    expect((await request(app()).post("/api/demo/ops/sessions").set("X-KS-Ops-Key", "wrong").send({})).status).toBe(401);
    const again = await request(app()).post("/api/demo/ops/sessions").set("X-KS-Ops-Key", OPS_KEY)
      .send({ ops_session_id: A.opsId, name: "Alice", email: "alice@prospect.example", company: "Alice Capital" });
    expect(again.status).toBe(200);
    expect(again.body.session_id).toBe(A.sessionId);
    expect(again.body.client_url).toBe(`https://client.demo.example/demo/${A.code}`);
    const bad = await request(app()).post("/api/demo/ops/sessions").set("X-KS-Ops-Key", OPS_KEY).send({ ops_session_id: "x", email: "nope" });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.errors)).toEqual(expect.arrayContaining(["ops_session_id", "name", "email", "company"]));
  });

  it("each session starts with its own fresh sample file, and the portal greets the prospect by name", async () => {
    const a = await request(app()).get("/api/demo/staff/state").set(auth(A.staff));
    const b = await request(app()).get("/api/demo/staff/state").set(auth(B.staff));
    expect(a.status).toBe(200);
    expect(a.body.session).toMatchObject({ name: "Alice", company: "Alice Capital", used_phone: true });
    expect(b.body.session).toMatchObject({ name: "Bruno", company: "Bruno Capital" });
    expect(a.body.application.id).not.toBe(b.body.application.id);
    expect(a.body.application).toMatchObject({ status: "draft", business: { legal_name: "Juniper Hollow Millwork Ltd." } });
    expect(a.body.documents).toEqual([]);
    expect(a.body.lenders.length).toBeGreaterThanOrEqual(5);
    expect(a.body.session.walkthrough).toMatchObject({ current: "welcome" });
  });

  it("only the exact sample files can be uploaded; uploads run the real fraud checks and make the file appear live", async () => {
    const fake = await request(app()).post("/api/demo/client/documents").set(auth(clientA))
      .field("sample_key", "bank_2026_07").attach("file", Buffer.from("%PDF-1.4 my real statement"), { filename: "x.pdf", contentType: "application/pdf" });
    expect(fake.status).toBe(400);
    expect(fake.body.error).toBe("only_sample_documents");
    for (const d of SAMPLE_DOCS) {
      const r = await uploadSample(clientA, d.key);
      expect({ key: d.key, status: r.status }).toEqual({ key: d.key, status: 201 });
    }
    const state = await request(app()).get("/api/demo/staff/state").set(auth(A.staff));
    expect(state.body.application.status).toBe("in_review");
    const docs = state.body.documents as Array<{ sample_key: string; fraud_status: string; tamper: any; statement_math: any }>;
    expect(docs).toHaveLength(SAMPLE_DOCS.length);
    const sep = docs.find((d) => d.sample_key === "bank_2026_09")!;
    expect(sep.fraud_status).toBe("red");
    expect(sep.tamper.status).toBe("red");
    expect(sep.statement_math.status).toBe("red");
    expect(docs.filter((d) => d.sample_key !== "bank_2026_09").every((d) => d.fraud_status === "green")).toBe(true);
    const bState = await request(app()).get("/api/demo/staff/state").set(auth(B.staff));
    expect(bState.body.documents).toEqual([]);
    expect(bState.body.application.status).toBe("draft");
  });

  it("ISOLATION: one prospect can never read, decide on or download another's documents, by any route or token", async () => {
    const aDocs = (await request(app()).get("/api/demo/staff/state").set(auth(A.staff))).body.documents as Array<{ id: string }>;
    const target = aDocs[0]!.id;
    expect((await request(app()).get(`/api/demo/staff/documents/${target}/file`).set(auth(A.staff))).status).toBe(200);
    expect((await request(app()).get(`/api/demo/staff/documents/${target}/file`).set(auth(B.staff))).status).toBe(404);
    expect((await request(app()).post(`/api/demo/staff/documents/${target}/decision`).set(auth(B.staff)).send({ decision: "rejected" })).status).toBe(404);
    const stillPending = (await request(app()).get("/api/demo/staff/state").set(auth(A.staff))).body.documents.find((d: { id: string }) => d.id === target);
    expect(stillPending.status).toBe("pending");
    // A client (borrower) token cannot use the staff routes, nor a staff token the client routes.
    expect((await request(app()).get("/api/demo/staff/state").set(auth(clientA))).status).toBe(401);
    expect((await request(app()).get(`/api/demo/staff/documents/${target}/file`).set(auth(clientA))).status).toBe(401);
    expect((await request(app()).get("/api/demo/client/state").set(auth(A.staff))).status).toBe(401);
    // B's borrower sees only B's (empty) file.
    const cb = await request(app()).get("/api/demo/client/state").set(auth(clientB));
    expect(cb.body.samples.every((s: { uploaded: boolean }) => !s.uploaded)).toBe(true);
    // A real staff token (JWT_SECRET) is not a demo token; a forged token for A's session made with JWT_SECRET fails.
    const real = jwt.sign({ sub: A.sessionId, sid: A.sessionId, aud: "ks-demo-staff", iss: "ks-demo" }, String(process.env.JWT_SECRET));
    expect((await request(app()).get("/api/demo/staff/state").set(auth(real))).status).toBe(401);
    // A session id in the URL or body is never used: there is no route that takes one.
    const sneaky = await request(app()).get(`/api/demo/staff/state?session_id=${A.sessionId}`).set(auth(B.staff));
    expect(sneaky.body.session.name).toBe("Bruno");
    // Wrong or guessed borrower codes do not open anything.
    expect((await request(app()).post("/api/demo/client/session").send({ code: "aaaaaaaaaa" })).status).toBe(404);
    // B's lender selections and submission do not touch A.
    await request(app()).post("/api/demo/staff/lenders").set(auth(B.staff)).send({ lender_ids: ["aspen-ridge"] });
    const aApp = (await request(app()).get("/api/demo/staff/state").set(auth(A.staff))).body.application;
    expect(aApp.selected_lenders).toEqual([]);
    // The database itself: every demo row of B points at B's session only.
    const leak = await pool.query(
      `SELECT count(*)::int AS n FROM demo_documents d JOIN demo_applications a ON a.id = d.application_id WHERE d.session_id <> a.session_id`,
    );
    expect(leak.rows[0].n).toBe(0);
  });

  it("runs the whole walkthrough: decisions, call, financials, credit summary, lenders, submit, package", async () => {
    const h = auth(A.staff);
    const docs = (await request(app()).get("/api/demo/staff/state").set(h)).body.documents as Array<{ id: string; sample_key: string }>;
    for (const d of docs) {
      const decision = d.sample_key === "bank_2026_09" ? "rejected" : "accepted";
      const r = await request(app()).post(`/api/demo/staff/documents/${d.id}/decision`).set(h).send({ decision, reason: decision === "rejected" ? "Edited copy - ask for the bank's original." : undefined });
      expect(r.status).toBe(200);
    }
    expect((await request(app()).post("/api/demo/staff/walkthrough").set(h).send({ action: "complete", step: "documents" })).body.walkthrough.current).toBe("call");
    expect((await request(app()).post("/api/demo/staff/walkthrough").set(h).send({ action: "jump" })).status).toBe(400);
    await request(app()).post("/api/demo/staff/call").set(h).send({ action: "ring" });
    const ans = await request(app()).post("/api/demo/staff/call").set(h).send({ action: "answer" });
    expect(ans.body.script.length).toBeGreaterThan(3);
    const done = await request(app()).post("/api/demo/staff/call").set(h).send({ action: "complete" });
    expect(done.body.call.summary.headline).toMatch(/September statement/);
    expect((await request(app()).post("/api/demo/staff/financials/review").set(h)).status).toBe(200);
    const cs = await request(app()).post("/api/demo/staff/credit-summary").set(h);
    expect(cs.body.credit_summary.documents.flagged[0]).toMatchObject({ label: "Bank statement - September 2026", decision: "rejected" });
    expect(cs.body.credit_summary.banking.statements_used).toHaveLength(2);
    expect((await request(app()).post("/api/demo/staff/submit").set(h)).status).toBe(400); // no lenders yet
    expect((await request(app()).post("/api/demo/staff/lenders").set(h).send({ lender_ids: ["made-up"] })).status).toBe(400);
    expect((await request(app()).post("/api/demo/staff/lenders").set(h).send({ lender_ids: ["aspen-ridge", "northgate", "granite-peak"] })).status).toBe(200);
    const sub = await request(app()).post("/api/demo/staff/submit").set(h);
    expect(sub.status).toBe(200);
    expect(sub.body).toMatchObject({ emailed_to: "alice@prospect.example", lenders: expect.arrayContaining(["Aspen Ridge Capital"]) });
    expect((await request(app()).post("/api/demo/staff/submit").set(h)).status).toBe(409);
    const pkg = await request(app()).get("/api/demo/staff/package").set(h).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(pkg.status).toBe(200);
    const pdf = await PDFDocument.load(pkg.body as Buffer);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(6); // summary + 5 accepted sample files
    expect((await request(app()).get("/api/demo/staff/package").set(auth(B.staff))).status).toBe(404);
    const st = (await request(app()).get("/api/demo/staff/state").set(h)).body;
    expect(st.session.completed_at).toBeTruthy();
    expect(st.session.walkthrough.completed).toEqual(expect.arrayContaining(["call", "financials", "credit_summary", "lenders", "submit"]));
    expect(st.application.notes[0]).toMatchObject({ kind: "call_summary" });
  });

  it("KS_SERVER_v11_LIVE_DEMO guided submit: the documents arrive, decisions + call + lenders apply, the package is built once", async () => {
    const C = await makeSession("Cara");
    const h = auth(C.staff);
    expect((await request(app()).post("/api/demo/staff/guided-submit").set(h).send({ accepted: ["nope"], lenders: ["aspen-ridge"] })).status).toBe(400);
    expect((await request(app()).post("/api/demo/staff/guided-submit").set(h).send({ accepted: [], lenders: [] })).status).toBe(400);
    expect((await request(app()).post("/api/demo/staff/guided-submit").set(h).send({ lenders: ["made-up"] })).status).toBe(400);
    const all = ["bank_2026_07", "bank_2026_08", "bank_2026_09", "financials_2025", "void_cheque", "photo_id"];
    const r = await request(app()).post("/api/demo/staff/guided-submit").set(h)
      .send({ accepted: all, rejected: [], lenders: ["aspen-ridge", "granite-peak"], call_answered: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ emailed_to: "cara@prospect.example", lenders: expect.arrayContaining(["Aspen Ridge Capital", "Granite Peak Credit Union"]) });
    const st = (await request(app()).get("/api/demo/staff/state").set(h)).body;
    expect(st.documents).toHaveLength(6);
    expect(st.documents.every((d: { status: string }) => d.status === "accepted")).toBe(true);
    expect(st.documents.find((d: { sample_key: string }) => d.sample_key === "bank_2026_09").fraud_status).toBe("red");
    expect(st.application.call.status).toBe("completed");
    expect(st.application.notes[0]).toMatchObject({ kind: "call_summary" });
    expect(st.application.selected_lenders).toEqual(["aspen-ridge", "granite-peak"]);
    expect(st.session.completed_at).toBeTruthy();
    const again = await request(app()).post("/api/demo/staff/guided-submit").set(h).send({ accepted: all, lenders: ["aspen-ridge"] });
    expect(again.status).toBe(409);
    expect(again.body.emailed_to).toBe("cara@prospect.example");
    // Another prospect's token cannot see Cara's file.
    expect((await request(app()).get("/api/demo/staff/package").set(auth(B.staff))).status).toBe(404);
  });

  it("KS_SERVER_v11_LIVE_DEMO serves the sample PDFs publicly (same bytes as the uploads check), and 404s anything else", async () => {
    const r = await request(app()).get("/api/demo/samples/bank_2026_09").buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/application\/pdf/);
    expect(Buffer.compare(r.body as Buffer, (await sampleFiles()).get("bank_2026_09")!.bytes)).toBe(0);
    expect((await request(app()).get("/api/demo/samples/..%2Fetc").send()).status).toBe(404);
    expect((await request(app()).get("/api/demo/samples/nope")).status).toBe(404);
  });

  it("the borrower can ask the assistant (capped) and finish from the phone", async () => {
    const r = await request(app()).post("/api/demo/client/assistant").set(auth(clientB)).send({ message: "How long will approval take?" });
    expect(r.status).toBe(200);
    expect(r.body.source).toBe("scripted");
    expect(r.body.messages.map((m: { role: string }) => m.role)).toEqual(["borrower", "assistant"]);
    await pool.query(`UPDATE demo_sessions SET assistant_questions = 999 WHERE ops_session_id = $1`, [B.opsId]);
    expect((await request(app()).post("/api/demo/client/assistant").set(auth(clientB)).send({ message: "again?" })).status).toBe(429);
    const s = await request(app()).post("/api/demo/client/submit").set(auth(clientB));
    expect(s.body.borrower_submitted_at).toBeTruthy();
    expect((await request(app()).get("/api/demo/staff/state").set(auth(A.staff))).body.messages).toEqual([]);
  });

  it("sends progress events to KS-Ops grouped per session, then the completion with the package", async () => {
    const posts: Array<{ path: string; body: any }> = [];
    const post: OpsPoster = async (path, body) => { posts.push({ path, body }); return { ok: true, status: 202 }; };
    // Other test files' sessions may have events too: only look at ours.
    while ((await flushEvents(pool, post)).sent > 0) { /* drain */ }
    const ours = posts.filter((p) => p.path.includes(A.opsId) || p.path.includes(B.opsId));
    const aTypes = ours.filter((p) => p.path === `/api/demo/sessions/${A.opsId}/events`).flatMap((p) => p.body.events.map((e: { type: string }) => e.type));
    expect(aTypes).toEqual(expect.arrayContaining(["session_created", "borrower_joined", "document_uploaded", "document_decision", "call_completed", "credit_summary_built", "lenders_selected", "submitted"]));
    const bEvents = ours.filter((p) => p.path === `/api/demo/sessions/${B.opsId}/events`).flatMap((p) => p.body.events);
    expect(bEvents.some((e: { type: string }) => e.type === "submitted")).toBe(false);
    expect((await pool.query(`SELECT count(*)::int AS n FROM demo_events e JOIN demo_sessions s ON s.id = e.session_id WHERE s.ops_session_id = ANY($1::text[]) AND e.sent_at IS NULL`, [[A.opsId, B.opsId]])).rows[0].n).toBe(0);
    posts.length = 0;
    await flushCompletions(pool, post);
    const comp = posts.find((p) => p.path === `/api/demo/sessions/${A.opsId}/complete`)!;
    expect(comp.body.summary).toMatchObject({ name: "Alice", email: "alice@prospect.example", used_phone: true });
    expect(Buffer.from(comp.body.package_pdf_base64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    posts.length = 0;
    await flushCompletions(pool, post);
    expect(posts.some((p) => p.path.includes(A.opsId))).toBe(false); // sent once
  });

  it("a failed post is kept and retried", async () => {
    await request(app()).post("/api/demo/staff/track").set(auth(B.staff)).send({ name: "opened_help", step: "welcome" });
    const fail: OpsPoster = async () => ({ ok: false, status: 503, error: "status_503" });
    await flushEvents(pool, fail);
    const unsent = await pool.query(`SELECT count(*)::int AS n FROM demo_events e JOIN demo_sessions s ON s.id = e.session_id WHERE s.ops_session_id = $1 AND e.sent_at IS NULL`, [B.opsId]);
    expect(unsent.rows[0].n).toBe(1);
    expect((await request(app()).post("/api/demo/staff/track").set(auth(B.staff)).send({ name: "Bad Name!" })).status).toBe(400);
  });

  it("an expired session stops working, and wiping removes every row it made", async () => {
    const C = await makeSession("Cleo");
    const clientC = await clientToken(C.code);
    await uploadSample(clientC, "void_cheque");
    await pool.query(`UPDATE demo_sessions SET expires_at = now() - interval '2 hours' WHERE ops_session_id = $1`, [C.opsId]);
    expect((await request(app()).get("/api/demo/staff/state").set(auth(C.staff))).status).toBe(401);
    expect((await request(app()).get("/api/demo/client/state").set(auth(clientC))).status).toBe(401);
    expect((await request(app()).post("/api/demo/client/session").send({ code: C.code })).status).toBe(404);
    expect((await request(app()).post("/api/demo/ops/sessions").set("X-KS-Ops-Key", OPS_KEY).send({ ops_session_id: C.opsId, name: "Cleo", email: "c@x.example", company: "C" })).status).toBe(410);
    expect(await deleteExpiredSessions(pool as unknown as Q)).toBeGreaterThanOrEqual(1);
    for (const t of ["demo_sessions", "demo_applications", "demo_documents", "demo_events"]) {
      const r = await pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE ${t === "demo_sessions" ? "id" : "session_id"} = $1`, [C.sessionId]);
      expect({ t, n: r.rows[0].n }).toEqual({ t, n: 0 });
    }
    // The ops wipe works the same way for a live session.
    expect((await request(app()).delete(`/api/demo/ops/sessions/${B.opsId}`).set("X-KS-Ops-Key", OPS_KEY)).status).toBe(204);
    expect((await request(app()).get("/api/demo/staff/state").set(auth(B.staff))).status).toBe(401);
    expect((await pool.query(`SELECT count(*)::int AS n FROM demo_messages m WHERE m.session_id = $1`, [B.sessionId])).rows[0].n).toBe(0);
    // A token for a session that never existed is refused.
    expect((await request(app()).get("/api/demo/staff/state").set(auth(signDemoToken(randomUUID(), "ks-demo-staff", new Date(Date.now() + 60_000))))).status).toBe(401);
  });
});
