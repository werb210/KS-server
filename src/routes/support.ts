import express from "express";
import rateLimit from "express-rate-limit";
import { pool } from "../db.js";
import { rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { auth, requireAuthorization } from "../middleware/auth.js"; // KS_SERVER_v8_SUPPORT_TICKETS
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { addTicketMessage, checkMessage, checkTicket, createTicket, getTicket, listTickets } from "../plans/supportTickets.js";
import type { Q } from "../plans/state.js";

const router = express.Router();

// BF_SERVER_v789_PUBLIC_RATE_LIMITS - public and unauthenticated: 5 a minute per IP.
const supportLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "RATE_LIMITED" },
  keyGenerator: rateLimitKeyFromRequest, // BF_SERVER_v791_RATE_LIMIT_KEYS - no validate overrides
});

// BF_SERVER_BLOCK_v332_SETTINGS_AND_AUDIT_HARDENING_v1 -- Edit 12
// Pre-fix this router declared its route as router.post("/support"), and
// routeRegistry.ts:153 mounts the router at "/support", so the resulting
// URL was /api/support/support -- inaccessible. No production UI hits
// /api/support/support and no caller hits the intended /api/support path
// either (verified across BF-portal, BF-client, BF-Website). The route is
// effectively dead. Renaming the internal path to "/" makes the live URL
// /api/support, matching the mount point.
router.post("/", supportLimiter, async (req, res) => {
  try {
    const { name, email, message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    const result = await pool.query(
      `INSERT INTO live_chat_requests (name, email, message)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name || null, email || null, message]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Support route error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// KS_SERVER_v8_SUPPORT_TICKETS - the licensee's staff ask Keystone operations for help.
//   POST /api/support/tickets  Admin, Staff: { subject, body, priority?: "normal" | "urgent" } -> 201 { ok, ticket, relayed }
//   GET  /api/support/tickets  Admin, Staff: the tickets, newest first
// KS_SERVER_v17_TICKET_FOLLOW_UPS
//   GET  /api/support/tickets/:id           Admin, Staff: { ok, ticket, messages } (follow-ups oldest first)
//   POST /api/support/tickets/:id/messages  Admin, Staff: { body } -> 201 { ok, message, relayed, relay_error }
const ticketStaff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] })];

router.post("/tickets", ...ticketStaff, safeHandler(async (req: any, res) => {
  const c = checkTicket(req.body);
  if (!c.ok) return res.status(400).json({ ok: false, error: "invalid_ticket", errors: c.errors });
  const u = req.user ?? {};
  const r = await createTicket(pool as unknown as Q, c.value, {
    id: String(u.userId ?? u.id ?? u.sub ?? ""), email: u.email ?? null, name: u.name ?? null, role: u.role ?? null,
  });
  return res.status(201).json({ ok: true, ticket: r.ticket, relayed: r.relayed, relay_error: r.relay_error });
}));

router.get("/tickets", ...ticketStaff, safeHandler(async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, tickets: await listTickets(pool as unknown as Q) });
}));

router.get("/tickets/:id", ...ticketStaff, safeHandler(async (req: any, res) => {
  res.setHeader("Cache-Control", "no-store");
  const r = await getTicket(pool as unknown as Q, String(req.params.id));
  if (!r) return res.status(404).json({ ok: false, error: "not_found" });
  return res.json({ ok: true, ...r });
}));

router.post("/tickets/:id/messages", ...ticketStaff, safeHandler(async (req: any, res) => {
  const c = checkMessage(req.body);
  if (!c.ok) return res.status(400).json({ ok: false, error: "invalid_message", errors: c.errors });
  const u = req.user ?? {};
  const r = await addTicketMessage(pool as unknown as Q, String(req.params.id), c.value.body, {
    id: String(u.userId ?? u.id ?? u.sub ?? ""), email: u.email ?? null, name: u.name ?? null, role: u.role ?? null,
  });
  if (!r) return res.status(404).json({ ok: false, error: "not_found" });
  return res.status(201).json({ ok: true, message: r.message, relayed: r.relayed, relay_error: r.relay_error });
}));

export default router;
