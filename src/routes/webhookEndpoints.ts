// KS_SERVER_v20_WEBHOOKS - /api/webhook-endpoints (Admin, pro): outgoing webhooks and Zapier Catch Hooks.
//   GET    /events                       the event catalogue with an example body for each (the Settings page docs)
//   GET    /                             endpoints with 30-day delivery counts
//   POST   /                             { url, events[], description? } -> the endpoint and its signing secret (shown once)
//   PATCH  /:id                          { url?, events?, description?, status?: active|paused }  (active re-enables)
//   POST   /:id/rotate-secret            a new secret (shown once); the old one stops working at once
//   DELETE /:id                          removes the endpoint and its log
//   POST   /:id/test                     { event? } queues a test delivery of an example event
//   GET    /:id/deliveries               ?status=&event=&limit= the last 30 days, newest first
//   GET    /deliveries/:deliveryId       one delivery with the exact body sent
//   POST   /deliveries/:deliveryId/resend   queues the same event again (same event id) to the same endpoint
import { randomUUID } from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { auditRequest, actorId } from "../lib/auditRequest.js";
import { EVENTS, EVENT_TYPES, buildBody, eventDef, isEventType, sampleBody } from "../outboundWebhooks/events.js";
import { checkWebhookUrl, systemResolver, type Resolver } from "../outboundWebhooks/ssrf.js";
import { newSecret, SIGNATURE_HEADER, TIMESTAMP_HEADER, DEFAULT_TOLERANCE_SECONDS } from "../outboundWebhooks/signing.js";
import { RETRY } from "../outboundWebhooks/deliver.js";

export const ENDPOINT_LIMIT = 25;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let resolver: Resolver = systemResolver;
/** Tests swap DNS. */
export function setWebhookResolverForTests(r: Resolver | null): void {
  resolver = r ?? systemResolver;
}

const router = Router();
router.use(requireAuth, requireAdmin);
const writeLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false, keyGenerator: rateLimitKeyFromRequest });

const ENDPOINT_COLS = `e.id::text AS id, e.url, e.description, e.events, e.status, e.consecutive_failures, e.disabled_at, e.disabled_reason,
  e.last_success_at, e.last_failure_at, e.created_at, e.updated_at`;

function cleanEvents(raw: unknown): { ok: true; events: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || !raw.length) return { ok: false, error: "Choose at least one event." };
  const out = [...new Set(raw.map(String))];
  const bad = out.filter((e) => !isEventType(e));
  if (bad.length) return { ok: false, error: `Unknown event: ${bad.join(", ")}.` };
  return { ok: true, events: out };
}

router.get("/events", safeHandler(async (_req: any, res: any) => {
  res.json({
    ok: true,
    events: EVENTS.map((e) => ({ ...e, example: sampleBody(e.type) })),
    signing: {
      signature_header: SIGNATURE_HEADER, timestamp_header: TIMESTAMP_HEADER, tolerance_seconds: DEFAULT_TOLERANCE_SECONDS,
      algorithm: "HMAC-SHA256 over `${timestamp}.${raw body}` with the endpoint secret, hex encoded",
    },
    retry: { max_attempts: RETRY.maxAttempts, first_retry_seconds: RETRY.baseMs / 1000, max_delay_hours: RETRY.maxMs / 3_600_000, disable_after_dead: RETRY.disableAfterDead, timeout_seconds: RETRY.timeoutMs / 1000, keep_days: RETRY.keepDays },
    limits: { endpoints: ENDPOINT_LIMIT },
  });
}));

router.get("/", safeHandler(async (_req: any, res: any) => {
  const r = await pool.query(
    `SELECT ${ENDPOINT_COLS},
            (SELECT count(*)::int FROM webhook_deliveries d WHERE d.endpoint_id = e.id AND d.status = 'succeeded') AS delivered_30d,
            (SELECT count(*)::int FROM webhook_deliveries d WHERE d.endpoint_id = e.id AND d.status = 'dead') AS failed_30d,
            (SELECT count(*)::int FROM webhook_deliveries d WHERE d.endpoint_id = e.id AND d.status IN ('pending', 'sending')) AS queued
       FROM webhook_endpoints e ORDER BY e.created_at`,
  );
  res.json({ ok: true, endpoints: r.rows });
}));

async function endpointOr404(req: any, res: any) {
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) { res.status(404).json({ ok: false, error: "not_found" }); return null; }
  const r = await pool.query(`SELECT ${ENDPOINT_COLS} FROM webhook_endpoints e WHERE e.id = $1`, [id]);
  if (!r.rows[0]) { res.status(404).json({ ok: false, error: "not_found" }); return null; }
  return r.rows[0];
}

router.post("/", writeLimiter, safeHandler(async (req: any, res: any) => {
  const b = req.body ?? {};
  const url = await checkWebhookUrl(b.url, resolver);
  if (!url.ok) return res.status(400).json({ ok: false, error: "invalid_url", message: url.error });
  const ev = cleanEvents(b.events);
  if (!ev.ok) return res.status(400).json({ ok: false, error: "invalid_events", message: ev.error });
  const description = String(b.description ?? "").trim().slice(0, 200) || null;
  const n = await pool.query(`SELECT count(*)::int AS n FROM webhook_endpoints`);
  if (Number(n.rows[0]?.n ?? 0) >= ENDPOINT_LIMIT) return res.status(409).json({ ok: false, error: "too_many_endpoints", message: `You can have at most ${ENDPOINT_LIMIT} webhook endpoints.` });
  const secret = newSecret();
  const client = await pool.connect();
  let row: any;
  try {
    await client.query("BEGIN");
    row = (await client.query(
      `INSERT INTO webhook_endpoints (url, description, events, created_by) VALUES ($1, $2, $3::text[], $4)
       RETURNING id::text AS id, url, description, events, status, consecutive_failures, disabled_at, disabled_reason,
                 last_success_at, last_failure_at, created_at, updated_at`,
      [url.url.toString(), description, ev.events, actorId(req)],
    )).rows[0];
    await client.query(`INSERT INTO webhook_endpoint_secrets (endpoint_id, secret) VALUES ($1, $2)`, [row.id, secret]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch((e: unknown) => console.error("[webhooks] rollback failed", (e as Error)?.message));
    throw err;
  } finally {
    client.release();
  }
  await auditRequest(req, "webhook_endpoint", "created", "webhook_endpoint", row.id, { host: url.url.host, events: ev.events });
  res.status(201).json({ ok: true, endpoint: row, secret });
}));

router.patch("/:id", writeLimiter, safeHandler(async (req: any, res: any) => {
  const ep = await endpointOr404(req, res);
  if (!ep) return;
  const b = req.body ?? {};
  const sets: string[] = [];
  const params: unknown[] = [ep.id];
  if (b.url !== undefined) {
    const url = await checkWebhookUrl(b.url, resolver);
    if (!url.ok) return res.status(400).json({ ok: false, error: "invalid_url", message: url.error });
    params.push(url.url.toString()); sets.push(`url = $${params.length}`);
  }
  if (b.events !== undefined) {
    const ev = cleanEvents(b.events);
    if (!ev.ok) return res.status(400).json({ ok: false, error: "invalid_events", message: ev.error });
    params.push(ev.events); sets.push(`events = $${params.length}::text[]`);
  }
  if (b.description !== undefined) { params.push(String(b.description ?? "").trim().slice(0, 200) || null); sets.push(`description = $${params.length}`); }
  if (b.status !== undefined) {
    if (b.status !== "active" && b.status !== "paused") return res.status(400).json({ ok: false, error: "invalid_status", message: "Status is active or paused." });
    params.push(b.status); sets.push(`status = $${params.length}`);
    if (b.status === "active") sets.push(`consecutive_failures = 0, disabled_at = NULL, disabled_reason = NULL`);
  }
  if (!sets.length) return res.json({ ok: true, endpoint: ep });
  const r = await pool.query(`UPDATE webhook_endpoints e SET ${sets.join(", ")}, updated_at = now() WHERE e.id = $1 RETURNING ${ENDPOINT_COLS}`, params);
  await auditRequest(req, "webhook_endpoint", "updated", "webhook_endpoint", ep.id, { changes: Object.keys(b), status: b.status });
  res.json({ ok: true, endpoint: r.rows[0] });
}));

router.post("/:id/rotate-secret", writeLimiter, safeHandler(async (req: any, res: any) => {
  const ep = await endpointOr404(req, res);
  if (!ep) return;
  const secret = newSecret();
  await pool.query(
    `INSERT INTO webhook_endpoint_secrets (endpoint_id, secret) VALUES ($1, $2)
     ON CONFLICT (endpoint_id) DO UPDATE SET secret = EXCLUDED.secret, created_at = now()`,
    [ep.id, secret],
  );
  await auditRequest(req, "webhook_endpoint", "secret_rotated", "webhook_endpoint", ep.id, {});
  res.json({ ok: true, secret });
}));

router.delete("/:id", writeLimiter, safeHandler(async (req: any, res: any) => {
  const ep = await endpointOr404(req, res);
  if (!ep) return;
  await pool.query(`DELETE FROM webhook_endpoints WHERE id = $1`, [ep.id]);
  await auditRequest(req, "webhook_endpoint", "deleted", "webhook_endpoint", ep.id, { url: ep.url });
  res.json({ ok: true });
}));

router.post("/:id/test", writeLimiter, safeHandler(async (req: any, res: any) => {
  const ep = await endpointOr404(req, res);
  if (!ep) return;
  if (ep.status !== "active") return res.status(409).json({ ok: false, error: "endpoint_not_active", message: "Turn the endpoint on before sending a test." });
  const type = isEventType(req.body?.event) ? req.body.event : (ep.events?.[0] ?? EVENT_TYPES[0]);
  const def = eventDef(type)!;
  const sample = sampleBody(type);
  const eventId = randomUUID();
  const r = await pool.query(
    `INSERT INTO webhook_deliveries (event_id, endpoint_id, event_type, object_type, object_id, payload)
     VALUES ($1, $2, $3, $4, NULL, $5::jsonb) RETURNING id::text AS id`,
    [eventId, ep.id, type, def.object, JSON.stringify({ object: unshape((sample as any).data.object), extra: { ...omitObject((sample as any).data), test: true } })],
  );
  await auditRequest(req, "webhook_endpoint", "test_sent", "webhook_endpoint", ep.id, { event: type });
  res.status(202).json({ ok: true, delivery_id: r.rows[0].id, event_id: eventId });
}));

/** The example object back in row form (stage -> pipeline_state, signed_at -> signnow_app_signed_at). */
function unshape(o: Record<string, unknown>): Record<string, unknown> {
  const { object: _kind, stage, signed_at, ...rest } = o as any;
  return { ...rest, ...(stage !== undefined ? { pipeline_state: stage } : {}), ...(signed_at !== undefined ? { signnow_app_signed_at: signed_at } : {}) };
}
function omitObject(d: Record<string, unknown>): Record<string, unknown> {
  const { object: _o, ...rest } = d;
  return rest;
}

const DELIVERY_COLS = `d.id::text AS id, d.event_id::text AS event_id, d.endpoint_id::text AS endpoint_id, d.event_type, d.object_type, d.object_id,
  d.status, d.attempts, d.next_attempt_at, d.last_attempt_at, d.last_status_code, d.last_error, d.last_duration_ms, d.delivered_at,
  d.resend_of::text AS resend_of, d.occurred_at, d.created_at`;

router.get("/:id/deliveries", safeHandler(async (req: any, res: any) => {
  const ep = await endpointOr404(req, res);
  if (!ep) return;
  const params: unknown[] = [ep.id];
  const where = [`d.endpoint_id = $1`, `d.created_at >= now() - interval '${RETRY.keepDays} days'`];
  const status = String(req.query.status ?? "");
  if (["pending", "sending", "succeeded", "dead", "skipped"].includes(status)) { params.push(status); where.push(`d.status = $${params.length}`); }
  if (status === "failed") where.push(`d.status IN ('dead', 'pending') AND d.attempts > 0`);
  const event = String(req.query.event ?? "");
  if (isEventType(event)) { params.push(event); where.push(`d.event_type = $${params.length}`); }
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  params.push(limit);
  const r = await pool.query(`SELECT ${DELIVERY_COLS} FROM webhook_deliveries d WHERE ${where.join(" AND ")} ORDER BY d.created_at DESC LIMIT $${params.length}`, params);
  res.json({ ok: true, deliveries: r.rows });
}));

async function deliveryOr404(req: any, res: any) {
  const id = String(req.params.deliveryId ?? "");
  if (!UUID_RE.test(id)) { res.status(404).json({ ok: false, error: "not_found" }); return null; }
  const r = await pool.query(`SELECT ${DELIVERY_COLS}, d.payload FROM webhook_deliveries d WHERE d.id = $1`, [id]);
  if (!r.rows[0]) { res.status(404).json({ ok: false, error: "not_found" }); return null; }
  return r.rows[0];
}

router.get("/deliveries/:deliveryId", safeHandler(async (req: any, res: any) => {
  const d = await deliveryOr404(req, res);
  if (!d) return;
  const { payload, ...rest } = d;
  res.json({ ok: true, delivery: { ...rest, body: JSON.parse(buildBody({ ...d, payload })) } });
}));

router.post("/deliveries/:deliveryId/resend", writeLimiter, safeHandler(async (req: any, res: any) => {
  const d = await deliveryOr404(req, res);
  if (!d) return;
  const ep = await pool.query(`SELECT status FROM webhook_endpoints WHERE id = $1`, [d.endpoint_id]);
  if (ep.rows[0]?.status !== "active") return res.status(409).json({ ok: false, error: "endpoint_not_active", message: "Turn the endpoint back on before resending." });
  const r = await pool.query(
    `INSERT INTO webhook_deliveries (event_id, endpoint_id, event_type, object_type, object_id, payload, occurred_at, resend_of)
     SELECT event_id, endpoint_id, event_type, object_type, object_id, payload, occurred_at, id FROM webhook_deliveries WHERE id = $1
     RETURNING id::text AS id`,
    [d.id],
  );
  await auditRequest(req, "webhook_endpoint", "delivery_resent", "webhook_delivery", d.id, { endpoint_id: d.endpoint_id, event: d.event_type });
  res.status(202).json({ ok: true, delivery_id: r.rows[0].id });
}));

export default router;
