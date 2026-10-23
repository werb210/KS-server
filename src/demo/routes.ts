// KS_SERVER_v10_DEMO - the demo API, mounted at /api/demo only when DEMO_MODE=true.
//
// Operations (X-KS-Ops-Key = KS_OPS_KEY; KS-Ops calls these):
//   POST   /api/demo/ops/sessions                  { ops_session_id, name, email, company, expires_at }
//          (an existing session takes the name, email and company sent, so a repeat sign-up's new details show)
//          -> 201 { session_id, staff_token, client_code, client_url, expires_at }   (same ops id again: a fresh token)
//   DELETE /api/demo/ops/sessions/:opsSessionId    wipe the session and everything it made -> 204
// Prospect in the demo portal (Bearer staff token):
//   GET  /api/demo/staff/state ; POST /api/demo/staff/walkthrough { action, step } ; POST /api/demo/staff/borrower-token
//   POST /api/demo/staff/documents/:id/decision { decision: accepted|rejected, reason? } ; GET .../documents/:id/file
//   POST /api/demo/staff/call { action: ring|answer|decline|complete } ; POST /api/demo/staff/financials/review
//   POST /api/demo/staff/credit-summary ; POST /api/demo/staff/lenders { lender_ids } ; POST /api/demo/staff/submit
//   POST /api/demo/staff/guided-submit { accepted, rejected, lenders, call_answered } (KS_SERVER_v11_LIVE_DEMO)
//   GET  /api/demo/samples/:key (public: the sample PDFs)
//   GET  /api/demo/staff/package ; POST /api/demo/staff/track { name, step? } ; POST /api/demo/staff/heartbeat
// Prospect playing the borrower (phone link, or on-screen):
//   POST /api/demo/client/session { code } -> { client_token }   (public, rate limited)
//   GET  /api/demo/client/state ; GET /api/demo/client/samples/:key ; POST /api/demo/client/documents (multipart file + sample_key)
//   POST /api/demo/client/submit ; POST /api/demo/client/assistant { message }
//
// Isolation: the session comes only from the verified token (never from the URL or body), and every query filters on
// it (src/demo/repo.ts), so a prospect can only ever see their own sample file.
import { createHash } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import type { Q } from "../plans/state.js";
import { opsKeyMatches } from "../routes/plan.js";
import { rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { demoAssistantLimit, demoClientUrl, demoSessionDays } from "./config.js";
import { DEMO_STEPS, STEP_LABELS, SAMPLE_DOCS, CALL_SCRIPT, CALL_SUMMARY, DEMO_DURATION_SECONDS, isDemoStep, sampleDoc } from "./fixture.js";
import * as repo from "./repo.js";
import { bearer, clientCodeFor, normalizeCode, signDemoToken, verifyDemoToken } from "./tokens.js";
import { recordEvent, type DemoEventType } from "./progress.js";
import { sampleFile } from "./samples.js";
import { scanDemoDocument } from "./fraud.js";
import { applyWalkthrough, completeByAction, WALKTHROUGH_ACTIONS, type WalkthroughAction } from "./walkthrough.js";
import { lenderIds, matchLenders, type LenderMatch } from "./lenders.js";
import { buildCreditSummary, dscrFor } from "./creditSummary.js";
import { buildDemoLenderSubmission } from "./lenderSubmission.js";
import { answerQuestion, MAX_QUESTION_CHARS, type AskModel } from "./assistant.js";

export type DemoDeps = { db: () => Q; ask?: AskModel; onEvent?: () => void };

type DemoReq = Request & { demoSession?: repo.SessionRow };

const MAX_LENDERS = 4;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function limiter(limit: number, windowMs: number) {
  return rateLimit({
    windowMs, limit, standardHeaders: "draft-7", legacyHeaders: false, keyGenerator: rateLimitKeyFromRequest,
    message: { error: "rate_limited", message: "Too many requests. Please wait a minute and try again." },
  });
}

export function clientLinkFor(sessionId: string): { code: string; url: string | null } {
  const code = clientCodeFor(sessionId);
  const base = demoClientUrl();
  return { code, url: base ? `${base}/demo/${code}` : null };
}

export function lenderMatchesFor(app: repo.ApplicationRow): LenderMatch[] {
  return matchLenders({
    amount: Number(app.request.amount), years_in_business: Number(app.business.years_in_business),
    annual_revenue: Number(app.business.annual_revenue), province: String(app.business.province),
    industry: String(app.business.industry), equipment: /equipment/i.test(String(app.request.product)), dscr: dscrFor(app),
  });
}

function publicDocument(d: repo.DocumentRow) {
  return {
    id: d.id, sample_key: d.sample_key, label: d.label, category: d.category, filename: d.filename, size_bytes: d.size_bytes,
    uploaded_via: d.uploaded_via, status: d.status, reject_reason: d.reject_reason, fraud_status: d.fraud_status,
    tamper: d.tamper ? { status: d.tamper.status, reasons: d.tamper.reasons ?? [] } : null,
    statement_math: d.statement_math ? { status: d.statement_math.status, reasons: d.statement_math.reasons ?? [], totals: d.statement_math.totals ?? null } : null,
    uploaded_at: d.created_at, decided_at: d.decided_at,
  };
}

export async function staffState(db: Q, s: repo.SessionRow) {
  const [app, docs, messages] = await Promise.all([repo.applicationFor(db, s.id), repo.documentsFor(db, s.id), repo.messagesFor(db, s.id)]);
  const link = clientLinkFor(s.id);
  const lenders = app ? lenderMatchesFor(app) : [];
  const docsOut = docs.map(publicDocument);
  const version = createHash("sha1").update(JSON.stringify([app?.updated_at, docs.map((d) => [d.id, d.status, d.created_at]), messages.length, s.walkthrough, s.used_phone, s.used_screen])).digest("hex").slice(0, 16);
  return {
    session: {
      name: s.prospect_name, company: s.company, email: s.prospect_email, created_at: s.created_at, expires_at: s.expires_at,
      client_code: link.code, client_url: link.url, used_phone: s.used_phone, used_screen: s.used_screen,
      walkthrough: repo.walkthroughOf(s), completed_at: s.completed_at,
    },
    steps: DEMO_STEPS.map((key) => ({ key, label: STEP_LABELS[key] })),
    application: app ? {
      id: app.id, status: app.status, business: app.business, contact: app.contact, request: app.request, financials: app.financials,
      financials_reviewed_at: app.financials_reviewed_at, credit_summary: app.credit_summary, selected_lenders: app.selected_lenders ?? [],
      call: app.call, notes: app.notes ?? [], borrower_submitted_at: app.borrower_submitted_at, submitted_at: app.submitted_at,
      has_package: app.has_package,
    } : null,
    documents: docsOut,
    expected_documents: SAMPLE_DOCS.map((d) => ({ key: d.key, label: d.label })),
    lenders,
    messages: messages.map((m) => ({ role: m.role, body: m.body, at: m.created_at })),
    call_script: { lines: CALL_SCRIPT, duration_seconds: DEMO_DURATION_SECONDS },
    version,
  };
}

async function clientState(db: Q, s: repo.SessionRow) {
  const [app, docs, messages] = await Promise.all([repo.applicationFor(db, s.id), repo.documentsFor(db, s.id), repo.messagesFor(db, s.id)]);
  const byKey = new Map(docs.map((d) => [d.sample_key, d]));
  return {
    business: { name: app?.business?.legal_name, industry: app?.business?.industry },
    contact: { name: app?.contact?.name },
    request: app?.request ?? null,
    broker: { company: s.company, name: s.prospect_name },
    samples: SAMPLE_DOCS.map((d) => ({ key: d.key, label: d.label, hint: d.hint, filename: d.filename, uploaded: byKey.has(d.key), status: byKey.get(d.key)?.status ?? null })),
    messages: messages.map((m) => ({ role: m.role, body: m.body, at: m.created_at })),
    assistant_remaining: Math.max(0, demoAssistantLimit() - s.assistant_questions),
    borrower_submitted_at: app?.borrower_submitted_at ?? null,
    lender_submitted_at: app?.submitted_at ?? null,
  };
}

export function demoRouter(deps: DemoDeps): Router {
  const router = Router();
  const db = () => deps.db();
  const event = async (sid: string, type: DemoEventType, opts: { step?: string | null; data?: Record<string, unknown> } = {}) => {
    await recordEvent(db(), sid, type, opts);
    deps.onEvent?.();
  };
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 4 } });

  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

  // ---------------------------------------------------------------- operations (KS-Ops)
  const requireOps = (req: Request, res: Response, next: NextFunction) => {
    if (!opsKeyMatches(req.headers["x-ks-ops-key"])) return res.status(401).json({ error: "invalid_ops_key" });
    next();
  };

  router.post("/ops/sessions", requireOps, safeHandler(async (req: Request, res: Response) => {
    const b = req.body ?? {};
    const opsId = clean(b.ops_session_id, 64);
    const name = clean(b.name, 120);
    const email = clean(b.email, 200).toLowerCase();
    const company = clean(b.company, 160);
    const maxExpiry = Date.now() + demoSessionDays() * 86_400_000;
    const asked = b.expires_at ? new Date(String(b.expires_at)).getTime() : maxExpiry;
    const errors: Record<string, string> = {};
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(opsId)) errors.ops_session_id = "required";
    if (!name) errors.name = "required";
    if (!EMAIL_RE.test(email)) errors.email = "invalid";
    if (!company) errors.company = "required";
    if (!Number.isFinite(asked) || asked <= Date.now()) errors.expires_at = "invalid";
    if (Object.keys(errors).length) return res.status(400).json({ errors });
    let s = await repo.sessionByOpsId(db(), opsId);
    let created = false;
    if (s && new Date(s.expires_at).getTime() <= Date.now()) return res.status(410).json({ error: "demo_session_ended" });
    if (!s) {
      try {
        s = await repo.createSession(db(), { opsSessionId: opsId, name, email, company, expiresAt: new Date(Math.min(asked, maxExpiry)) });
        created = true;
      } catch (err) {
        // Two KS-Ops calls at once for the same id: the second reads the first's row.
        if ((err as { code?: string }).code !== "23505") throw err;
        s = await repo.sessionByOpsId(db(), opsId);
        if (!s) throw err;
      }
      if (created) await event(s.id, "session_created");
    } else if (s.prospect_name !== name || s.prospect_email !== email || s.company !== company) {
      // A repeat sign-up with new details: the reopened demo shows what they typed last.
      s = (await repo.refreshProspect(db(), s.id, { name, email, company })) ?? s;
    }
    const link = clientLinkFor(s.id);
    return res.status(created ? 201 : 200).json({
      session_id: s.id,
      staff_token: signDemoToken(s.id, "ks-demo-staff", new Date(s.expires_at)),
      client_code: link.code,
      client_url: link.url,
      expires_at: new Date(s.expires_at).toISOString(),
    });
  }));

  router.delete("/ops/sessions/:opsSessionId", requireOps, safeHandler(async (req: Request, res: Response) => {
    await repo.deleteSessionByOpsId(db(), clean(req.params.opsSessionId, 64));
    return res.status(204).end();
  }));

  // ---------------------------------------------------------------- the prospect in the demo portal
  const requireAudience = (aud: "ks-demo-staff" | "ks-demo-client") => safeHandler(async (req: DemoReq, res: Response, next: NextFunction) => {
    const sid = verifyDemoToken(bearer(req.headers.authorization), aud);
    if (!sid) return res.status(401).json({ error: "demo_sign_in_required", message: "Open the demo from the link in your email." });
    const s = await repo.liveSession(db(), sid);
    if (!s) return res.status(401).json({ error: "demo_session_ended", message: "This demo has ended. You can start a new one from the website." });
    req.demoSession = s;
    next();
  });
  const staff = requireAudience("ks-demo-staff");
  const client = requireAudience("ks-demo-client");
  const sess = (req: DemoReq) => req.demoSession!;

  router.get("/staff/state", staff, safeHandler(async (req: DemoReq, res: Response) => {
    res.json(await staffState(db(), sess(req)));
  }));

  router.post("/staff/opened", staff, safeHandler(async (req: DemoReq, res: Response) => {
    await event(sess(req).id, "portal_opened", { data: { viewport: clean(req.body?.viewport, 20) || null } });
    res.status(204).end();
  }));

  router.post("/staff/walkthrough", staff, safeHandler(async (req: DemoReq, res: Response) => {
    const s = sess(req);
    const action = String(req.body?.action ?? "") as WalkthroughAction;
    if (!WALKTHROUGH_ACTIONS.includes(action)) return res.status(400).json({ error: "unknown_action" });
    const before = repo.walkthroughOf(s);
    const next = applyWalkthrough(before, action, req.body?.step);
    if ("error" in next) return res.status(400).json({ error: next.error });
    await repo.setWalkthrough(db(), s.id, next);
    const step = isDemoStep(req.body?.step) ? req.body.step : null;
    const type: DemoEventType = action === "view" ? "step_viewed" : action === "complete" ? "step_completed" : action === "skip" ? "step_skipped" : action === "skip_tour" ? "tour_skipped" : "tour_resumed";
    // Viewing the step you are already on is not news.
    if (!(action === "view" && before.current === step)) await event(s.id, type, { step });
    res.json({ walkthrough: next });
  }));

  router.post("/staff/borrower-token", staff, safeHandler(async (req: DemoReq, res: Response) => {
    const s = sess(req);
    await repo.markBorrowerDevice(db(), s.id, "screen");
    await event(s.id, "borrower_joined", { step: "borrower", data: { via: "screen" } });
    res.json({ client_token: signDemoToken(s.id, "ks-demo-client", new Date(s.expires_at)) });
  }));

  router.get("/staff/documents/:id/file", staff, safeHandler(async (req: DemoReq, res: Response) => {
    const id = String(req.params.id);
    const f = UUID_RE.test(id) ? await repo.documentContent(db(), sess(req).id, id) : null;
    if (!f) return res.status(404).json({ error: "not_found" });
    await event(sess(req).id, "document_viewed", { step: "documents", data: { filename: f.filename } });
    res.setHeader("Content-Type", f.mime_type);
    res.setHeader("Content-Disposition", `inline; filename="${f.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
    res.send(f.content);
  }));

  router.post("/staff/documents/:id/decision", staff, safeHandler(async (req: DemoReq, res: Response) => {
    const s = sess(req);
    const id = String(req.params.id);
    const decision = req.body?.decision;
    if (decision !== "accepted" && decision !== "rejected") return res.status(400).json({ error: "decision_required" });
    const reason = decision === "rejected" ? clean(req.body?.reason, 300) || "Not acceptable as sent." : null;
    const d = UUID_RE.test(id) ? await repo.decideDocument(db(), s.id, id, decision, reason) : null;
    if (!d) return res.status(404).json({ error: "not_found" });
    await event(s.id, "document_decision", { step: "documents", data: { document: d.label, sample_key: d.sample_key, decision, fraud_status: d.fraud_status, reason } });
    res.json({ document: publicDocument(d) });
  }));

  router.post("/staff/call", staff, safeHandler(async (req: DemoReq, res: Response) => {
    const s = sess(req);
    const action = String(req.body?.action ?? "");
    const app = await repo.applicationFor(db(), s.id);
    if (!app) return res.status(404).json({ error: "not_found" });
    const now = new Date().toISOString();
    if (action === "ring") {
      await event(s.id, "call_rang", { step: "call" });
      return res.json({ call: app.call });
    }
    if (action === "decline") {
      await repo.updateApplication(db(), s.id, { call: { ...(app.call ?? {}), status: "declined", declined_at: now } });
      await event(s.id, "call_declined", { step: "call" });
      return res.json({ call: (await repo.applicationFor(db(), s.id))?.call });
    }
    if (action === "answer") {
      await repo.updateApplication(db(), s.id, { call: { status: "in_progress", answered_at: now, from: app.contact?.name, phone: app.contact?.phone } });
      await event(s.id, "call_answered", { step: "call" });
      return res.json({ call: (await repo.applicationFor(db(), s.id))?.call, script: CALL_SCRIPT });
    }
    if (action === "complete") {
      const call = {
        ...(app.call ?? {}), status: "completed", completed_at: now, duration_seconds: DEMO_DURATION_SECONDS,
        from: app.contact?.name, phone: app.contact?.phone, transcript: CALL_SCRIPT, summary: CALL_SUMMARY,
      };
      const notes = [...(app.notes ?? []).filter((n: { kind?: string }) => n.kind !== "call_summary"),
        { kind: "call_summary", at: now, author: "AI call summary", body: CALL_SUMMARY.headline, points: CALL_SUMMARY.points, follow_up: CALL_SUMMARY.follow_up }];
      await repo.updateApplication(db(), s.id, { call, notes });
      await repo.setWalkthrough(db(), s.id, completeByAction(repo.walkthroughOf(s), "call"));
      await event(s.id, "call_completed", { step: "call" });
      return res.json({ call });
    }
    return res.status(400).json({ error: "unknown_action" });
  }));

  router.post("/staff/financials/review", staff, safeHandler(async (req: DemoReq, res: Response) => {
    const s = sess(req);
    await repo.updateApplication(db(), s.id, { financials_reviewed_at: new Date() });
    await repo.setWalkthrough(db(), s.id, completeByAction(repo.walkthroughOf(s), "financials"));
    await event(s.id, "financials_reviewed", { step: "financials" });
    res.json({ ok: true });
  }));

  router.post("/staff/credit-summary", staff, safeHandler(async (req: DemoReq, res: Response) => {
    const s = sess(req);
    const app = await repo.applicationFor(db(), s.id);
    if (!app) return res.status(404).json({ error: "not_found" });
    const summary = buildCreditSummary(app, await repo.documentsFor(db(), s.id));
    await repo.updateApplication(db(), s.id, { credit_summary: summary });
    await repo.setWalkthrough(db(), s.id, completeByAction(repo.walkthroughOf(s), "credit_summary"));
    await event(s.id, "credit_summary_built", { step: "credit_summary", data: { dscr: summary.financial_snapshot.dscr, flagged: summary.documents.flagged.length } });
    res.json({ credit_summary: summary });
  }));

  router.post("/staff/lenders", staff, safeHandler(async (req: DemoReq, res: Response) => {
    const s = sess(req);
    const ids = Array.isArray(req.body?.lender_ids) ? [...new Set((req.body.lender_ids as unknown[]).map(String))] : null;
    const known = lenderIds();
    if (!ids || ids.some((id) => !known.has(id))) return res.status(400).json({ error: "unknown_lender" });
    if (ids.length > MAX_LENDERS) return res.status(400).json({ error: "too_many_lenders", max: MAX_LENDERS });
    const app = await repo.applicationFor(db(), s.id);
    if (app?.submitted_at) return res.status(409).json({ error: "already_submitted" });
    await repo.updateApplication(db(), s.id, { selected_lenders: ids });
    await event(s.id, "lenders_selected", { step: "lenders", data: { lenders: ids } });
    res.json({ selected_lenders: ids });
  }));

  /** Builds the lender package, marks the demo complete and queues the emails (KS-Ops sends them). */
  const submitToLenders = async (s: repo.SessionRow, app: repo.ApplicationRow) => {
    const docs = await repo.documentsFor(db(), s.id);
    const summary = app.credit_summary ?? buildCreditSummary(app, docs);
    const matches = lenderMatchesFor(app).filter((l) => app.selected_lenders.includes(l.id));
    const submittedAt = new Date();
    // KS_SERVER_v12_DEMO_REAL_PACKAGE - the real package and lender email, for the first lender picked (the real send
    // emails each picked lender the same package).
    const sub = await buildDemoLenderSubmission({
      applicationId: app.id, app, summary,
      broker: { name: s.prospect_name, company: s.company || s.prospect_name, email: s.prospect_email },
      lenderName: matches[0]?.name ?? "Lender",
      accepted: await repo.acceptedDocumentFiles(db(), s.id), submittedAt, documents: docs, call: app.call,
    });
    await repo.updateApplication(db(), s.id, {
      credit_summary: summary, submitted_at: submittedAt, status: "submitted_to_lenders",
      package_pdf: sub.signedApplicationPdf, package_zip: sub.zip,
      package_mail: { lender_name: sub.email.lenderName, subject: sub.email.subject, html: sub.email.html, text: sub.email.text, attachment_filename: sub.zipFilename },
    });
    let w = completeByAction(repo.walkthroughOf(s), "lenders");
    w = completeByAction(w, "submit");
    await repo.setWalkthrough(db(), s.id, w);
    await repo.markCompleted(db(), s.id);
    await event(s.id, "submitted", {
      step: "submit",
      data: {
        lenders: matches.map((l) => l.name), package_bytes: sub.zip.length,
        accepted: docs.filter((d) => d.status === "accepted").map((d) => d.sample_key),
        rejected: docs.filter((d) => d.status === "rejected").map((d) => d.sample_key),
        doctored_rejected: docs.some((d) => d.fraud_status === "red" && d.status === "rejected"),
      },
    });
    return { submitted_at: submittedAt, emailed_to: s.prospect_email, lenders: matches.map((l) => l.name), package_bytes: sub.zip.length };
  };

  router.post("/staff/submit", staff, safeHandler(async (req: DemoReq, res: Response) => {
    const s = sess(req);
    const app = await repo.applicationFor(db(), s.id);
    if (!app) return res.status(404).json({ error: "not_found" });
    if (app.submitted_at) return res.status(409).json({ error: "already_submitted", submitted_at: app.submitted_at });
    if (!(app.selected_lenders ?? []).length) return res.status(400).json({ error: "pick_lenders_first", message: "Pick at least one lender first." });
    res.json(await submitToLenders(s, app));
  }));

  // KS_SERVER_v11_LIVE_DEMO - the guided demo runs the real portal in the browser on sample data and sends everything
  // the prospect decided in one call when they press Send: the six sample documents arrive (fraud-scanned), their
  // decisions, the call, the credit summary and the lenders, then the package is built and emailed like /staff/submit.
  router.post("/staff/guided-submit", staff, safeHandler(async (req: DemoReq, res: Response) => {
    const s = sess(req);
    const keys = new Set(SAMPLE_DOCS.map((d) => d.key));
    const list = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(String))] : []);
    const accepted = list(req.body?.accepted);
    const rejected = list(req.body?.rejected).filter((k) => !accepted.includes(k));
    const lenders = list(req.body?.lenders);
    if ([...accepted, ...rejected].some((k) => !keys.has(k))) return res.status(400).json({ error: "unknown_document" });
    const known = lenderIds();
    if (!lenders.length) return res.status(400).json({ error: "pick_lenders_first", message: "Pick at least one lender first." });
    if (lenders.some((id) => !known.has(id))) return res.status(400).json({ error: "unknown_lender" });
    if (lenders.length > MAX_LENDERS) return res.status(400).json({ error: "too_many_lenders", max: MAX_LENDERS });
    let app = await repo.applicationFor(db(), s.id);
    if (!app) return res.status(404).json({ error: "not_found" });
    if (app.submitted_at) return res.status(409).json({ error: "already_submitted", submitted_at: app.submitted_at, emailed_to: s.prospect_email });

    // The client's documents arrive (the demo client app never uploads anything).
    const have = new Set((await repo.documentsFor(db(), s.id)).map((d) => d.sample_key));
    for (const def of SAMPLE_DOCS) {
      if (have.has(def.key)) continue;
      const sample = await sampleFile(def.key);
      if (!sample) continue;
      const scan = await scanDemoDocument(sample.bytes, def.category);
      await repo.upsertDocument(db(), s.id, {
        applicationId: app.id, sampleKey: def.key, category: def.category, label: def.label, filename: def.filename,
        mime: sample.mime, content: sample.bytes, via: "phone", tamper: scan.tamper,
        statementMath: scan.statement_math ? { ...scan.statement_math, totals: scan.totals } : null, fraudStatus: scan.status,
      });
    }
    const now = new Date();
    if (!app.borrower_submitted_at) {
      await repo.updateApplication(db(), s.id, { borrower_submitted_at: now, status: "in_review" });
      await event(s.id, "borrower_submitted", { step: "borrower", data: { documents: SAMPLE_DOCS.length, guided: true } });
    }
    const byKey = new Map((await repo.documentsFor(db(), s.id)).map((d) => [d.sample_key, d]));
    for (const [decision, ks] of [["accepted", accepted], ["rejected", rejected]] as const) {
      for (const k of ks) {
        const d = byKey.get(k);
        if (!d || d.status === decision) continue;
        await repo.decideDocument(db(), s.id, d.id, decision, decision === "rejected" ? "Not acceptable as sent." : null);
        await event(s.id, "document_decision", { step: "documents", data: { document: d.label, sample_key: k, decision, fraud_status: d.fraud_status } });
      }
    }
    if (req.body?.call_answered === true) {
      const at = now.toISOString();
      const call = {
        status: "completed", answered_at: at, completed_at: at, duration_seconds: DEMO_DURATION_SECONDS,
        from: app.contact?.name, phone: app.contact?.phone, transcript: CALL_SCRIPT, summary: CALL_SUMMARY,
      };
      const notes = [...(app.notes ?? []).filter((n: { kind?: string }) => n.kind !== "call_summary"),
        { kind: "call_summary", at, author: "AI call summary", body: CALL_SUMMARY.headline, points: CALL_SUMMARY.points, follow_up: CALL_SUMMARY.follow_up }];
      await repo.updateApplication(db(), s.id, { call, notes });
      await event(s.id, "call_completed", { step: "call", data: { guided: true } });
    }
    app = (await repo.applicationFor(db(), s.id))!;
    const summary = buildCreditSummary(app, await repo.documentsFor(db(), s.id));
    await repo.updateApplication(db(), s.id, { financials_reviewed_at: app.financials_reviewed_at ?? now, credit_summary: summary, selected_lenders: lenders });
    await event(s.id, "lenders_selected", { step: "lenders", data: { lenders } });
    app = (await repo.applicationFor(db(), s.id))!;
    res.json(await submitToLenders(s, app));
  }));

  // The sample documents themselves (fictional, the same bytes for everyone), for the guided demo's document preview.
  router.get("/samples/:key", limiter(300, 10 * 60_000), safeHandler(async (req: Request, res: Response) => {
    const def = sampleDoc(req.params.key);
    const sample = def ? await sampleFile(def.key) : null;
    if (!def || !sample) return res.status(404).json({ error: "not_found" });
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Type", sample.mime);
    res.setHeader("Content-Disposition", `inline; filename="${def.filename}"`);
    res.send(sample.bytes);
  }));

  router.get("/staff/package", staff, safeHandler(async (req: DemoReq, res: Response) => {
    const pkg = await repo.packageFor(db(), sess(req).id);
    if (!pkg) return res.status(404).json({ error: "not_submitted" });
    await event(sess(req).id, "package_downloaded", { step: "submit" });
    res.setHeader("Content-Type", pkg.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${pkg.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
    res.send(pkg.content);
  }));

  router.post("/staff/track", staff, safeHandler(async (req: DemoReq, res: Response) => {
    const name = String(req.body?.name ?? "");
    if (!/^[a-z0-9_]{1,40}$/.test(name)) return res.status(400).json({ error: "invalid_name" });
    await event(sess(req).id, "click", { step: isDemoStep(req.body?.step) ? req.body.step : null, data: { name } });
    res.status(204).end();
  }));

  router.post("/staff/heartbeat", staff, safeHandler(async (req: DemoReq, res: Response) => {
    const secs = Math.max(0, Math.min(120, Math.round(Number(req.body?.seconds ?? 60)) || 0));
    await event(sess(req).id, "heartbeat", { data: { seconds: secs } });
    res.status(204).end();
  }));

  // ---------------------------------------------------------------- the prospect playing the borrower
  router.post("/client/session", limiter(30, 15 * 60_000), safeHandler(async (req: Request, res: Response) => {
    const code = normalizeCode(req.body?.code);
    const sid = code.length >= 8 ? await repo.sessionIdByCode(db(), code) : null;
    const s = sid ? await repo.liveSession(db(), sid) : null;
    if (!s) return res.status(404).json({ error: "demo_link_invalid", message: "This demo link is not valid any more. Ask for a new demo on the website." });
    const ua = String(req.headers["user-agent"] ?? "");
    const device = /iPhone/i.test(ua) ? "iPhone" : /iPad/i.test(ua) ? "iPad" : /Android/i.test(ua) ? "Android" : /Mobi/i.test(ua) ? "mobile" : "desktop";
    await repo.markBorrowerDevice(db(), s.id, "phone");
    await event(s.id, "borrower_joined", { step: "borrower", data: { via: "link", device } });
    res.json({ client_token: signDemoToken(s.id, "ks-demo-client", new Date(s.expires_at)) });
  }));

  router.get("/client/state", client, safeHandler(async (req: DemoReq, res: Response) => {
    res.json(await clientState(db(), sess(req)));
  }));

  router.get("/client/samples/:key", client, safeHandler(async (req: DemoReq, res: Response) => {
    const def = sampleDoc(req.params.key);
    const f = def ? await sampleFile(def.key) : null;
    if (!def || !f) return res.status(404).json({ error: "not_found" });
    res.setHeader("Content-Type", f.mime);
    res.setHeader("Content-Disposition", `inline; filename="${f.filename}"`);
    res.send(f.bytes);
  }));

  router.post("/client/documents", client, limiter(60, 10 * 60_000), upload.single("file"), safeHandler(async (req: DemoReq & { file?: Express.Multer.File }, res: Response) => {
    const s = sess(req);
    const def = sampleDoc(req.body?.sample_key);
    if (!def) return res.status(400).json({ error: "unknown_sample" });
    const file = req.file;
    if (!file?.buffer?.length) return res.status(400).json({ error: "file_required" });
    const sample = await sampleFile(def.key);
    // Only the sample files can be uploaded: the demo never stores a prospect's real documents.
    const sha = createHash("sha256").update(file.buffer).digest("hex");
    if (!sample || sha !== sample.sha256) {
      return res.status(400).json({ error: "only_sample_documents", message: "The demo only takes the sample documents shown on this screen." });
    }
    const app = await repo.applicationFor(db(), s.id);
    if (!app) return res.status(404).json({ error: "not_found" });
    if (app.submitted_at) return res.status(409).json({ error: "already_submitted" });
    const scan = await scanDemoDocument(file.buffer, def.category);
    const via = req.body?.via === "screen" ? "screen" : "phone";
    const d = await repo.upsertDocument(db(), s.id, {
      applicationId: app.id, sampleKey: def.key, category: def.category, label: def.label, filename: def.filename,
      mime: sample.mime, content: file.buffer, via, tamper: scan.tamper,
      statementMath: scan.statement_math ? { ...scan.statement_math, totals: scan.totals } : null, fraudStatus: scan.status,
    });
    // The first upload makes the application appear in the prospect's pipeline.
    if (app.status === "draft") await repo.updateApplication(db(), s.id, { status: "in_review" });
    await event(s.id, "document_uploaded", { step: "borrower", data: { document: def.label, sample_key: def.key, fraud_status: scan.status, via } });
    res.status(201).json({ document: publicDocument(d) });
  }));

  router.post("/client/submit", client, safeHandler(async (req: DemoReq, res: Response) => {
    const s = sess(req);
    const app = await repo.applicationFor(db(), s.id);
    if (!app) return res.status(404).json({ error: "not_found" });
    if (!app.borrower_submitted_at) {
      await repo.updateApplication(db(), s.id, { borrower_submitted_at: new Date(), ...(app.status === "draft" ? { status: "in_review" } : {}) });
      const docs = await repo.documentsFor(db(), s.id);
      await event(s.id, "borrower_submitted", { step: "borrower", data: { documents: docs.length } });
    }
    res.json(await clientState(db(), (await repo.liveSession(db(), s.id))!));
  }));

  router.post("/client/assistant", client, limiter(20, 10 * 60_000), safeHandler(async (req: DemoReq, res: Response) => {
    const s = sess(req);
    const question = clean(req.body?.message, MAX_QUESTION_CHARS);
    if (!question) return res.status(400).json({ error: "message_required" });
    if (!(await repo.takeAssistantQuestion(db(), s.id, demoAssistantLimit()))) {
      return res.status(429).json({ error: "assistant_limit", message: "That's all the questions this demo allows. Your broker can answer anything else." });
    }
    await repo.addMessage(db(), s.id, "borrower", question);
    const { answer, source } = await answerQuestion(question, deps.ask);
    await repo.addMessage(db(), s.id, "assistant", answer);
    await event(s.id, "assistant_question", { step: "borrower", data: { source, chars: question.length } });
    res.json({ reply: answer, source, messages: (await repo.messagesFor(db(), s.id)).map((m) => ({ role: m.role, body: m.body, at: m.created_at })) });
  }));

  return router;
}
