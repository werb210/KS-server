// KS_SERVER_SSO_API_KEYS - the versioned public REST API (Pro). Mounted at /api/open/v1.
//
// Authentication: `Authorization: Bearer ks_live_...` (an API key an Admin created in Settings > API). Every request
// is checked in this order: address rate limit -> key -> plan (a key stops working while the plan is below Pro and no
// trial runs) -> per-key rate limit -> scope (read-only keys may only GET). Errors are JSON:
// { error: { code, message } }. Data is this brokerage's own (the same silo filter the staff routes use); Fraud/Hold
// parking stays a staff-only action. GET /api/open/v1/openapi.json needs no key.
import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { pool } from "../db.js";
import { ROLES } from "../auth/roles.js";
import { rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { isAppError } from "../middleware/errors.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { checkFeature } from "../plans/catalogue.js";
import { getPlanState, recordTrialUsage, type Q } from "../plans/state.js";
import { authenticateApiKey, scopeAllows, touchApiKey, type ApiKeyRow } from "../apiKeys/keys.js";
import { createContact } from "../services/contacts.js";
import { transitionPipelineState } from "../modules/applications/applications.service.js";
import { emitAutomationEvent } from "../modules/automation/automationEngine.js";
import { openApiDocument } from "./openapi.js";
import { API_STAGES, isApiStage } from "./stages.js";

const SILO = "BF";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const db = () => pool as unknown as Q;

type Deps = { db: () => Q };

export function apiError(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ error: { code, message } });
}

export function pageParams(query: Record<string, unknown>): { limit: number; offset: number } | { error: string } {
  const rawLimit = query.limit;
  const rawOffset = query.offset;
  const limit = rawLimit === undefined || rawLimit === "" ? 25 : Number(rawLimit);
  const offset = rawOffset === undefined || rawOffset === "" ? 0 : Number(rawOffset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { error: "limit must be a whole number from 1 to 100." };
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) return { error: "offset must be a whole number of 0 or more." };
  return { limit, offset };
}

/** Rows were fetched with limit + 1: trims the extra row and says where the next page starts. */
export function paged<T>(rows: T[], limit: number, offset: number) {
  const more = rows.length > limit;
  return { data: more ? rows.slice(0, limit) : rows, pagination: { limit, offset, next_offset: more ? offset + limit : null } };
}

function str(v: unknown, max = 200): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

declare module "express-serve-static-core" {
  interface Request { apiKey?: ApiKeyRow }
}

function perKeyLimit(): number {
  const n = Number(process.env.KS_API_RATE_LIMIT_PER_MINUTE ?? "");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 120;
}

export function createPublicApiRouter(deps: Deps = { db }): Router {
  const router = Router();

  router.get("/openapi.json", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(openApiDocument());
  });

  // Before the key is looked up: caps how fast one address can try keys at all.
  router.use(rateLimit({
    windowMs: 60_000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKeyFromRequest,
    handler: (_req, res) => { apiError(res, 429, "rate_limited", "Too many requests from this address. Slow down and retry."); },
  }));

  router.use(safeHandler(async (req: Request, res: Response, next: NextFunction) => {
    const header = String(req.headers.authorization ?? "");
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    if (!m) return apiError(res, 401, "unauthorized", "Send your API key as: Authorization: Bearer ks_live_...");
    const auth = await authenticateApiKey(deps.db(), m[1]);
    if (!auth.ok) {
      return apiError(res, 401, auth.reason === "revoked" ? "api_key_revoked" : "invalid_api_key",
        auth.reason === "revoked" ? "This API key has been revoked." : "This API key is not valid.");
    }
    const plan = checkFeature(await getPlanState(deps.db()), "api_access");
    if (!plan.allowed) {
      return apiError(res, 402, "feature_not_in_plan", "API access is part of the Pro plan. An Admin can upgrade on the Plan page.");
    }
    if (plan.viaTrial) await recordTrialUsage(deps.db(), "api_access");
    req.apiKey = auth.key;
    try {
      await touchApiKey(deps.db(), auth.key.id);
    } catch (err) {
      logWarnSwallowed(err, "publicApi/router.ts:touchApiKey");
    }
    next();
  }));

  router.use(rateLimit({
    windowMs: 60_000,
    max: perKeyLimit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `api_key:${req.apiKey?.id ?? rateLimitKeyFromRequest(req)}`,
    handler: (_req, res) => { apiError(res, 429, "rate_limited", `This key is limited to ${perKeyLimit()} requests a minute. Retry after the Retry-After seconds.`); },
  }));

  router.use((req, res, next) => {
    if (!scopeAllows(String(req.apiKey?.scope ?? ""), req.method)) {
      return apiError(res, 403, "insufficient_scope", "This API key is read-only. Create a read-write key to make changes.");
    }
    next();
  });

  // ---- contacts -------------------------------------------------------------------------------------------------
  const CONTACT_COLS = `c.id::text AS id, c.first_name, c.last_name, c.name, c.email, c.phone, c.company_id::text AS company_id,
    COALESCE(co.name, c.company_name) AS company_name, c.job_title, c.lead_status, c.lifecycle_stage,
    COALESCE(c.tags, '{}'::text[]) AS tags, c.owner_id::text AS owner_id, c.created_at, c.updated_at`;
  const CONTACT_FROM = `FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
    WHERE c.silo = $1 AND c.merged_into_id IS NULL AND COALESCE(c.status, 'active') <> 'archived'`;

  router.get("/contacts", safeHandler(async (req: Request, res: Response) => {
    const p = pageParams(req.query as Record<string, unknown>);
    if ("error" in p) return apiError(res, 400, "invalid_request", p.error);
    const params: unknown[] = [SILO];
    let where = "";
    const q = str(req.query.q, 100);
    if (q) { params.push(`%${q}%`); where += ` AND (c.name ILIKE $${params.length} OR c.email ILIKE $${params.length})`; }
    const email = str(req.query.email, 200);
    if (email) { params.push(email.toLowerCase()); where += ` AND lower(c.email) = $${params.length}`; }
    params.push(p.limit + 1, p.offset);
    const r = await deps.db().query(
      `SELECT ${CONTACT_COLS} ${CONTACT_FROM}${where} ORDER BY c.created_at DESC, c.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json(paged(r.rows, p.limit, p.offset));
  }));

  router.get("/contacts/:id", safeHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    if (!UUID.test(id)) return apiError(res, 404, "not_found", "No contact with that id.");
    const r = await deps.db().query(`SELECT ${CONTACT_COLS} ${CONTACT_FROM} AND c.id = $2::uuid LIMIT 1`, [SILO, id]);
    if (!r.rows[0]) return apiError(res, 404, "not_found", "No contact with that id.");
    res.json({ data: r.rows[0] });
  }));

  router.post("/contacts", safeHandler(async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const first = str(b.first_name, 100);
    const last = str(b.last_name, 100);
    if (!first || !last) return apiError(res, 400, "invalid_request", "first_name and last_name are required.");
    const email = str(b.email, 200);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return apiError(res, 400, "invalid_request", "email is not an email address.");
    const companyId = str(b.company_id, 64);
    if (companyId) {
      if (!UUID.test(companyId)) return apiError(res, 400, "invalid_request", "company_id must be a company id.");
      const co = await deps.db().query(`SELECT 1 FROM companies WHERE id = $1::uuid AND silo = $2 LIMIT 1`, [companyId, SILO]);
      if (!co.rows[0]) return apiError(res, 400, "invalid_request", "company_id does not match a company.");
    }
    const owner = req.apiKey?.created_by && UUID.test(req.apiKey.created_by) ? req.apiKey.created_by : null;
    const row = await createContact(pool, {
      first_name: first, last_name: last, email, phone: str(b.phone, 40), company_id: companyId, silo: SILO, owner_id: owner,
    });
    const jobTitle = str(b.job_title, 120);
    if (jobTitle) await deps.db().query(`UPDATE contacts SET job_title = $1 WHERE id = $2::uuid`, [jobTitle, row.id]);
    void emitAutomationEvent("contact.created", { silo: SILO, contactId: String(row.id), data: { source: "api" } });
    const r = await deps.db().query(`SELECT ${CONTACT_COLS} ${CONTACT_FROM} AND c.id = $2::uuid LIMIT 1`, [SILO, row.id]);
    res.status(201).json({ data: r.rows[0] ?? row });
  }));

  // ---- companies ------------------------------------------------------------------------------------------------
  const COMPANY_COLS = `id::text AS id, name, legal_name, dba_name, website, email, phone, industry, city, province, country,
    created_at, updated_at`;

  router.get("/companies", safeHandler(async (req: Request, res: Response) => {
    const p = pageParams(req.query as Record<string, unknown>);
    if ("error" in p) return apiError(res, 400, "invalid_request", p.error);
    const params: unknown[] = [SILO];
    let where = "";
    const q = str(req.query.q, 100);
    if (q) { params.push(`%${q}%`); where += ` AND (name ILIKE $${params.length} OR legal_name ILIKE $${params.length})`; }
    params.push(p.limit + 1, p.offset);
    const r = await deps.db().query(
      `SELECT ${COMPANY_COLS} FROM companies WHERE silo = $1${where} ORDER BY created_at DESC, id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json(paged(r.rows, p.limit, p.offset));
  }));

  router.get("/companies/:id", safeHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    if (!UUID.test(id)) return apiError(res, 404, "not_found", "No company with that id.");
    const r = await deps.db().query(`SELECT ${COMPANY_COLS} FROM companies WHERE silo = $1 AND id = $2::uuid LIMIT 1`, [SILO, id]);
    if (!r.rows[0]) return apiError(res, 404, "not_found", "No company with that id.");
    res.json({ data: r.rows[0] });
  }));

  // ---- applications ---------------------------------------------------------------------------------------------
  const APP_COLS = `id::text AS id, name, pipeline_state AS stage, business_legal_name, requested_amount, product_category,
    company_id::text AS company_id, contact_id::text AS contact_id, lender_id::text AS lender_id, submitted_at,
    funded_amount, funded_at, created_at, updated_at`;
  const appId = (v: unknown) => { const s = String(v ?? "").trim(); return s && s.length <= 100 ? s : ""; };
  async function findApp(id: string) {
    const r = await deps.db().query(`SELECT ${APP_COLS} FROM applications WHERE silo = $1 AND id::text = $2 LIMIT 1`, [SILO, id]);
    return r.rows[0] ?? null;
  }

  router.get("/applications", safeHandler(async (req: Request, res: Response) => {
    const p = pageParams(req.query as Record<string, unknown>);
    if ("error" in p) return apiError(res, 400, "invalid_request", p.error);
    const params: unknown[] = [SILO];
    let where = "";
    const stage = str(req.query.stage, 60);
    if (stage) { params.push(stage); where += ` AND pipeline_state = $${params.length}`; }
    params.push(p.limit + 1, p.offset);
    const r = await deps.db().query(
      `SELECT ${APP_COLS} FROM applications WHERE silo = $1${where} ORDER BY created_at DESC, id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json(paged(r.rows, p.limit, p.offset));
  }));

  router.get("/applications/:id", safeHandler(async (req: Request, res: Response) => {
    const app = await findApp(appId(req.params.id));
    if (!app) return apiError(res, 404, "not_found", "No application with that id.");
    res.json({ data: app });
  }));

  router.patch("/applications/:id/stage", safeHandler(async (req: Request, res: Response) => {
    const id = appId(req.params.id);
    const stage = (req.body ?? {}).stage;
    if (!isApiStage(stage)) return apiError(res, 400, "invalid_request", `stage must be one of: ${API_STAGES.join(", ")}.`);
    const app = await findApp(id);
    if (!app) return apiError(res, 404, "not_found", "No application with that id.");
    await transitionPipelineState({
      applicationId: id,
      nextState: stage as any,
      actorUserId: req.apiKey?.created_by && UUID.test(req.apiKey.created_by) ? req.apiKey.created_by : null,
      actorRole: ROLES.ADMIN,
      trigger: "api",
      reason: `api_key:${req.apiKey?.key_prefix ?? ""}`,
    });
    res.json({ data: await findApp(id) });
  }));

  // ---- notes ----------------------------------------------------------------------------------------------------
  const NOTE_COLS = `n.id::text AS id, n.application_id::text AS application_id, n.body, n.owner_id::text AS owner_id,
    COALESCE(NULLIF(trim(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''), u.email) AS owner_name,
    n.created_at, n.updated_at`;

  router.get("/applications/:id/notes", safeHandler(async (req: Request, res: Response) => {
    const p = pageParams(req.query as Record<string, unknown>);
    if ("error" in p) return apiError(res, 400, "invalid_request", p.error);
    const id = appId(req.params.id);
    if (!(await findApp(id))) return apiError(res, 404, "not_found", "No application with that id.");
    const r = await deps.db().query(
      `SELECT ${NOTE_COLS} FROM crm_notes n LEFT JOIN users u ON u.id = n.owner_id
        WHERE n.application_id = $1 AND n.silo = $2 AND n.is_deleted = false
        ORDER BY n.created_at DESC, n.id LIMIT $3 OFFSET $4`,
      [id, SILO, p.limit + 1, p.offset],
    );
    res.json(paged(r.rows, p.limit, p.offset));
  }));

  router.post("/applications/:id/notes", safeHandler(async (req: Request, res: Response) => {
    const id = appId(req.params.id);
    const body = String((req.body ?? {}).body ?? "").trim();
    if (!body) return apiError(res, 400, "invalid_request", "body is required.");
    if (body.length > 10_000) return apiError(res, 400, "invalid_request", "body is too long (10,000 characters at most).");
    if (!(await findApp(id))) return apiError(res, 404, "not_found", "No application with that id.");
    const owner = req.apiKey?.created_by && UUID.test(req.apiKey.created_by) ? req.apiKey.created_by : null;
    const ins = await deps.db().query(
      `INSERT INTO crm_notes (body, owner_id, application_id, silo, mentions, created_at, updated_at)
       VALUES ($1, $2, $3, $4, '{}', now(), now()) RETURNING id::text AS id`,
      [body, owner, id, SILO],
    );
    const r = await deps.db().query(
      `SELECT ${NOTE_COLS} FROM crm_notes n LEFT JOIN users u ON u.id = n.owner_id WHERE n.id::text = $1 LIMIT 1`,
      [ins.rows[0]?.id],
    );
    res.status(201).json({ data: r.rows[0] ?? { id: ins.rows[0]?.id, application_id: id, body } });
  }));

  // ---- lenders --------------------------------------------------------------------------------------------------
  const LENDER_COLS = `id::text AS id, name, active, website, phone, email, country, region, city, contact_name, contact_email,
    contact_phone, created_at, updated_at`;

  router.get("/lenders", safeHandler(async (req: Request, res: Response) => {
    const p = pageParams(req.query as Record<string, unknown>);
    if ("error" in p) return apiError(res, 400, "invalid_request", p.error);
    const params: unknown[] = [SILO];
    let where = "";
    if (req.query.active === "true" || req.query.active === "false") { params.push(req.query.active === "true"); where += ` AND active = $${params.length}`; }
    params.push(p.limit + 1, p.offset);
    const r = await deps.db().query(
      `SELECT ${LENDER_COLS} FROM lenders WHERE COALESCE(silo, 'BF') = $1${where} ORDER BY lower(name), id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json(paged(r.rows, p.limit, p.offset));
  }));

  router.get("/lenders/:id", safeHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    if (!UUID.test(id)) return apiError(res, 404, "not_found", "No lender with that id.");
    const r = await deps.db().query(`SELECT ${LENDER_COLS} FROM lenders WHERE COALESCE(silo, 'BF') = $1 AND id = $2::uuid LIMIT 1`, [SILO, id]);
    if (!r.rows[0]) return apiError(res, 404, "not_found", "No lender with that id.");
    res.json({ data: r.rows[0] });
  }));

  router.use((_req, res) => apiError(res, 404, "not_found", "No such endpoint. See /api/open/v1/openapi.json."));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (isAppError(err)) {
      const status = (err as any).status ?? 400;
      return apiError(res, status, String((err as any).code ?? "error"), String((err as any).message ?? "Request failed."));
    }
    console.error("[public-api] request failed", (err as Error)?.message ?? String(err));
    return apiError(res, 500, "server_error", "Something went wrong. Try again.");
  });

  return router;
}

export default createPublicApiRouter();
