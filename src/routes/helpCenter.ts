// KS_SERVER_KB_v1 - the portal's Help Center (src/helpCenter/helpCenter.ts). Signed-in staff (Admin, Staff, Ops,
// Marketing) read; Admins also read the admin-only articles. Contact support is Admin and Staff (and Marketing,
// which the auth middleware treats as Staff), like tickets.
//   GET  /api/help-center/categories
//   GET  /api/help-center/articles?q=&category=        -> { articles: [{ slug, title, category, summary, plans_label, on_your_plan }] }
//   GET  /api/help-center/articles/:slug               -> { article } with body_html | 404
//   POST /api/help-center/ask { messages: [{ role, text }] }
//        -> { answer, citations, related, offer_support, outcome }   20 per 10 minutes per address here; KS-Ops also
//        limits per person and per licensee (429). Keystone's cost: no assistant-chat allowance is used.
//   POST /api/help-center/contact-support { messages, articles: [{ slug, title }], subject?, note?, priority? }
//        -> 201 { ok, ticket, relayed } - a normal support ticket with the conversation and the articles tried
// Without the KS-Ops link (KS_OPS_URL, KS_LICENSEE_ID, KS_OPS_KEY) reads and Ask Maya answer 503 help_not_available.
import express from "express";
import rateLimit from "express-rate-limit";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { ROLES } from "../auth/roles.js";
import { createTicket } from "../plans/supportTickets.js";
import type { Q } from "../plans/state.js";
import {
  askMaya, checkArticles, checkTurns, escalationBody, helpArticle, helpCategories, searchHelp, type HelpUser,
} from "../helpCenter/helpCenter.js";

const router = express.Router();
const readers = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF, ROLES.OPS, ROLES.MARKETING] })];
const ticketStaff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] })];

const askLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "rate_limited", message: "You've asked a lot of questions in a short time. Please wait a few minutes, or contact support." },
  keyGenerator: rateLimitKeyFromRequest,
});

const userOf = (req: any): HelpUser => {
  const u = req.user ?? {};
  return { id: String(u.userId ?? u.id ?? u.sub ?? ""), role: u.role ?? null, email: u.email ?? null, name: u.name ?? null };
};
const send = (res: any, r: { status: number; body: any }) => {
  res.setHeader("Cache-Control", "no-store");
  return res.status(r.status).json(r.body);
};

router.get("/categories", ...readers, safeHandler(async (req: any, res) => send(res, await helpCategories(userOf(req)))));

router.get("/articles", ...readers, safeHandler(async (req: any, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const category = typeof req.query.category === "string" ? req.query.category : "";
  return send(res, await searchHelp(userOf(req), q, category));
}));

router.get("/articles/:slug", ...readers, safeHandler(async (req: any, res) => {
  const slug = String(req.params.slug ?? "").toLowerCase();
  if (!/^[a-z0-9-]{1,120}$/.test(slug)) return res.status(404).json({ ok: false, error: "not_found" });
  return send(res, await helpArticle(userOf(req), slug));
}));

router.post("/ask", ...readers, askLimiter, safeHandler(async (req: any, res) => {
  const turns = checkTurns(req.body?.messages);
  if (!turns) return res.status(400).json({ ok: false, error: "invalid_messages" });
  return send(res, await askMaya(pool as unknown as Q, userOf(req), turns));
}));

router.post("/contact-support", ...ticketStaff, safeHandler(async (req: any, res) => {
  const turns = checkTurns(req.body?.messages, { endWithUser: false }) ?? [];
  const articles = checkArticles(req.body?.articles);
  const firstQuestion = turns.find((t) => t.role === "user")?.text ?? "";
  const subject = String(req.body?.subject ?? "").trim().slice(0, 200) || `Help request: ${firstQuestion.replace(/\s+/g, " ").slice(0, 160) || "from the Help Center"}`;
  const note = String(req.body?.note ?? "").slice(0, 2000);
  if (!turns.length && !note.trim()) return res.status(400).json({ ok: false, error: "invalid_ticket", errors: { body: "required" } });
  const priority = req.body?.priority === "urgent" ? "urgent" : "normal";
  const u = userOf(req);
  const r = await createTicket(pool as unknown as Q, { subject, body: escalationBody(turns, articles, note), priority }, u);
  return res.status(201).json({ ok: true, ticket: r.ticket, relayed: r.relayed, relay_error: r.relay_error });
}));

export default router;
