// KS_SERVER_v16_DATA_IMPORT - /api/data-import (Admin): the "Import data" wizard in Settings.
//   GET    /presets                     record types, fields, sources, Keystone stages, limits
//   GET    /templates/:type             template CSV for a record type
//   GET    /mappings  POST /mappings  DELETE /mappings/:id      saved column mappings
//   POST   /uploads                     multipart file + source + record_type -> a batch, its columns, a suggested mapping
//   GET    /batches  GET /batches/:id   history and progress
//   PUT    /batches/:id/mapping         { mapping, options: { stage_map } }
//   GET    /batches/:id/preview         the first rows as they will be imported, with each row's problems
//   POST   /batches/:id/dry-run | /run | /undo     queue a background job
//   GET    /batches/:id/errors.csv      ?phase=dry_run|run|undo
//   DELETE /batches/:id                 an upload that was never run
import { Router } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { autoMatch, FIELDS, isRecordType, isSource, mappingProblems, presetsSummary, RECORD_TYPE_LABEL, templateCsv, type RecordType } from "../import/fields.js";
import { fileKindOf, openSource, SourceError } from "../import/source.js";
import { KEYSTONE_STAGES, mapStage, normalise } from "../import/normalise.js";
import { loadBatch, openBatchSource } from "../import/engine.js";
import { toCsv } from "../import/parse.js";
import { importFileStore } from "../import/deps.js";
import { recordAuditEvent } from "../modules/audit/audit.service.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { kickDataImportWorker } from "../workers/dataImportWorker.js";

export const IMPORT_LIMITS = {
  /** CSV / XLSX upload. */
  tableBytes: 50 * 1024 * 1024,
  /** A documents zip or a Keystone export zip. */
  zipBytes: 200 * 1024 * 1024,
  /** Rows in one file (all tables of a Keystone export together). */
  rows: 200_000,
  documentBytes: 25 * 1024 * 1024,
};

const router = Router();
const admin = [requireAuth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: IMPORT_LIMITS.zipBytes, files: 1 } });
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: rateLimitKeyFromRequest,
});

const userId = (req: any): string | null => String(req.user?.id ?? req.user?.userId ?? req.user?.sub ?? "") || null;

function publicBatch(b: any) {
  if (!b) return null;
  return {
    id: b.id, silo: b.silo, source: b.source, record_type: b.record_type, file_name: b.file_name, file_kind: b.file_kind,
    file_size: b.file_size === null || b.file_size === undefined ? null : Number(b.file_size), status: b.status, columns: b.columns ?? [],
    mapping: b.mapping ?? {}, options: b.options ?? {}, total_rows: b.total_rows, processed_rows: b.processed_rows,
    created_count: b.created_count, updated_count: b.updated_count, skipped_count: b.skipped_count, error_count: b.error_count,
    dry_run: b.dry_run ?? null, run_summary: b.run_summary ?? null, undo_summary: b.undo_summary ?? null, last_error: b.last_error ?? null,
    created_by_email: b.created_by_email ?? null, started_at: b.started_at ?? null, finished_at: b.finished_at ?? null,
    created_at: b.created_at, updated_at: b.updated_at,
  };
}

async function batchFor(req: any, res: any): Promise<any | null> {
  const id = String(req.params.id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) { res.status(404).json({ error: "Import not found" }); return null; }
  const r = await pool.query(`SELECT * FROM import_batches WHERE id = $1 AND silo = $2`, [id, resolveSiloFromRequest(req)]);
  if (!r.rows[0]) { res.status(404).json({ error: "Import not found" }); return null; }
  return r.rows[0];
}

async function auditEvent(req: any, action: string, batchId: string, metadata: Record<string, unknown>) {
  try {
    const actor = userId(req);
    await recordAuditEvent({
      actorUserId: actor && /^[0-9a-f-]{36}$/i.test(actor) ? actor : null, targetUserId: null, targetType: "import_batch", targetId: batchId,
      action, eventType: "data_import", eventAction: action, success: true, metadata, ip: req.ip ?? null, userAgent: String(req.headers?.["user-agent"] ?? "") || null,
    });
  } catch (err) {
    logWarnSwallowed(err, "routes/dataImport.ts:audit");
  }
}

/** Distinct values of the source stage column (up to 200) with the Keystone stage each maps to. */
function stageValues(src: Awaited<ReturnType<typeof openSource>>, mapping: Record<string, string>, stageMap: Record<string, string>) {
  const seen = new Map<string, number>();
  for (const item of src.items(mapping)) {
    if (item.type !== "applications") continue;
    const s = String(item.input.stage ?? "").trim();
    if (!s) continue;
    if (!seen.has(s) && seen.size >= 200) continue;
    seen.set(s, (seen.get(s) ?? 0) + 1);
  }
  return [...seen.entries()].map(([value, rows]) => { const m = mapStage(value, stageMap); return { value, rows, stage: m.stage, matched: m.matched }; });
}

router.use(...admin);

router.get("/presets", (_req, res) => {
  res.json({ ok: true, ...presetsSummary(), stages: KEYSTONE_STAGES, limits: IMPORT_LIMITS });
});

router.get("/templates/:type", (req, res) => {
  const type = String(req.params.type ?? "").replace(/\.csv$/, "");
  if (!isRecordType(type)) return res.status(404).json({ error: "Unknown record type" });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="keystone-${type.replace(/_/g, "-")}-template.csv"`);
  return res.send(templateCsv(type));
});

router.get("/mappings", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const type = String(req.query.record_type ?? "");
  const r = await pool.query(
    `SELECT id, name, source, record_type, mapping, options, updated_at FROM import_mappings WHERE silo = $1 AND ($2 = '' OR record_type = $2) ORDER BY lower(name)`,
    [silo, type]);
  res.json({ ok: true, mappings: r.rows });
}));

router.post("/mappings", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const name = String(req.body?.name ?? "").trim().slice(0, 100);
  const source = String(req.body?.source ?? "spreadsheet");
  const type = String(req.body?.record_type ?? "");
  const mapping = req.body?.mapping && typeof req.body.mapping === "object" ? req.body.mapping : null;
  if (!name) return res.status(400).json({ error: "Give the mapping a name." });
  if (!isRecordType(type) || !isSource(source) || !mapping) return res.status(400).json({ error: "A record type, a source and a mapping are required." });
  const clean: Record<string, string> = {};
  const known = new Set(FIELDS[type].map((f) => f.key));
  for (const [k, v] of Object.entries(mapping)) if (known.has(k) && typeof v === "string" && v.trim()) clean[k] = v.slice(0, 300);
  const options = req.body?.options && typeof req.body.options === "object" ? { stage_map: req.body.options.stage_map ?? {} } : {};
  const r = await pool.query(
    `INSERT INTO import_mappings (id, silo, name, source, record_type, mapping, options, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
     ON CONFLICT (silo, record_type, lower(name)) DO UPDATE SET source = EXCLUDED.source, mapping = EXCLUDED.mapping, options = EXCLUDED.options, updated_at = now()
     RETURNING id, name, source, record_type, mapping, options, updated_at`,
    [randomUUID(), silo, name, source, type, JSON.stringify(clean), JSON.stringify(options), userId(req)]);
  res.json({ ok: true, mapping: r.rows[0] });
}));

router.delete("/mappings/:id", safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(404).json({ error: "Mapping not found" });
  await pool.query(`DELETE FROM import_mappings WHERE id = $1 AND silo = $2`, [id, resolveSiloFromRequest(req)]);
  return res.json({ ok: true });
}));

router.post("/uploads", uploadLimiter, upload.single("file"), safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const file = req.file as Express.Multer.File | undefined;
  const source = String(req.body?.source ?? "spreadsheet");
  const recordType = source === "keystone" ? "keystone" : String(req.body?.record_type ?? "");
  if (!file) return res.status(400).json({ error: "Choose a file to upload." });
  if (!isSource(source)) return res.status(400).json({ error: "Unknown source system." });
  if (recordType !== "keystone" && !isRecordType(recordType)) return res.status(400).json({ error: "Choose what the file holds." });
  const kind = fileKindOf(file.originalname, file.mimetype);
  if (!kind) return res.status(400).json({ error: "Upload a .csv, .xlsx or .zip file." });
  if (kind !== "zip" && file.size > IMPORT_LIMITS.tableBytes) return res.status(400).json({ error: "CSV and Excel files can be up to 50 MB. Split the file and import each part." });
  let src;
  try {
    src = await openSource(kind, file.buffer, { recordType: recordType as RecordType | "keystone" });
  } catch (err) {
    if (err instanceof SourceError) return res.status(400).json({ error: err.message });
    console.warn("[data-import] upload could not be read", { message: (err as Error)?.message });
    return res.status(400).json({ error: "The file could not be read. Save it as CSV (UTF-8) or .xlsx and try again." });
  }
  const total = Object.values(src.counts).reduce((a, b) => a + (b ?? 0), 0);
  if (total === 0) return res.status(400).json({ error: "The file has a header row but no records." });
  if (total > IMPORT_LIMITS.rows) return res.status(400).json({ error: `A file can hold up to ${IMPORT_LIMITS.rows.toLocaleString("en-US")} rows; this one has ${total.toLocaleString("en-US")}. Split it and import each part.` });

  const id = randomUUID();
  const put = await importFileStore().put({ buffer: file.buffer, filename: file.originalname.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || `import.${kind}`, contentType: file.mimetype || "application/octet-stream", pathPrefix: `imports/${id}` });
  const type = recordType === "keystone" ? "keystone" : recordType;
  const suggested = recordType === "keystone" ? {} : autoMatch(source, recordType as RecordType, src.columns);
  const email = (await pool.query(`SELECT email FROM users WHERE id::text = $1`, [userId(req) ?? ""])).rows[0]?.email ?? null;
  await pool.query(
    `INSERT INTO import_batches (id, silo, source, record_type, file_name, file_key, file_kind, file_size, status, columns, mapping, options, total_rows, created_by, created_by_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'uploaded', $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14)`,
    [id, silo, source, type, file.originalname.slice(0, 300), put.blobName, kind, file.size, JSON.stringify(src.columns), JSON.stringify(suggested),
      JSON.stringify({ counts: src.counts }), total, userId(req), email]);
  await auditEvent(req, "data_import.uploaded", id, { file: file.originalname, source, record_type: type, rows: total, silo });
  const batch = (await pool.query(`SELECT * FROM import_batches WHERE id = $1`, [id])).rows[0];
  return res.status(201).json({
    ok: true, batch: publicBatch(batch), columns: src.columns, suggested_mapping: suggested, counts: src.counts, total_rows: total,
    sample: src.sample(5), record_label: recordType === "keystone" ? "Keystone export" : RECORD_TYPE_LABEL[recordType as RecordType],
  });
}));

router.get("/batches", safeHandler(async (req: any, res: any) => {
  const r = await pool.query(`SELECT * FROM import_batches WHERE silo = $1 ORDER BY created_at DESC LIMIT 50`, [resolveSiloFromRequest(req)]);
  res.json({ ok: true, batches: r.rows.map(publicBatch) });
}));

router.get("/batches/:id", safeHandler(async (req: any, res: any) => {
  const b = await batchFor(req, res);
  if (!b) return;
  const errs = await pool.query(
    `SELECT phase, level, count(*)::int AS n FROM import_batch_errors WHERE batch_id = $1 GROUP BY phase, level`, [b.id]);
  res.json({ ok: true, batch: publicBatch(b), error_counts: errs.rows });
}));

const EDITABLE = ["uploaded", "ready", "failed"];

router.put("/batches/:id/mapping", safeHandler(async (req: any, res: any) => {
  const b = await batchFor(req, res);
  if (!b) return;
  if (!EDITABLE.includes(b.status) || (b.status === "failed" && Number(b.processed_rows) > 0)) {
    return res.status(409).json({ error: "This import has already started; its mapping can no longer change." });
  }
  const stageMap: Record<string, string> = {};
  const rawMap = req.body?.options?.stage_map;
  if (rawMap && typeof rawMap === "object") {
    for (const [k, v] of Object.entries(rawMap)) if (typeof v === "string" && (KEYSTONE_STAGES as readonly string[]).includes(v)) stageMap[String(k).slice(0, 200)] = v;
  }
  let mapping: Record<string, string> = {};
  if (b.record_type !== "keystone") {
    const raw = req.body?.mapping && typeof req.body.mapping === "object" ? req.body.mapping : {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && v.trim()) mapping[k] = v;
    const cols = new Set<string>(b.columns ?? []);
    const missing = Object.values(mapping).filter((c) => !cols.has(c));
    const problems = [...mappingProblems(b.record_type as RecordType, mapping), ...missing.map((c) => `The file has no column "${c}".`)];
    if (problems.length) return res.status(400).json({ error: problems[0], problems });
  } else {
    mapping = {};
  }
  const options = { ...(b.options ?? {}), stage_map: stageMap };
  const r = await pool.query(
    `UPDATE import_batches SET mapping = $2::jsonb, options = $3::jsonb, status = 'uploaded', dry_run = NULL, processed_rows = 0, last_error = NULL, updated_at = now()
      WHERE id = $1 RETURNING *`, [b.id, JSON.stringify(mapping), JSON.stringify(options)]);
  await pool.query(`DELETE FROM import_batch_errors WHERE batch_id = $1 AND phase = 'dry_run'`, [b.id]);
  return res.json({ ok: true, batch: publicBatch(r.rows[0]) });
}));

router.get("/batches/:id/preview", safeHandler(async (req: any, res: any) => {
  const b = await batchFor(req, res);
  if (!b) return;
  const limit = Math.min(Math.max(Number(req.query.limit ?? 25) || 25, 1), 100);
  const batch = await loadBatch(pool, b.id);
  let src;
  try { src = await openBatchSource(batch!, importFileStore()); } catch (err) {
    console.warn("[data-import] preview could not read the file", { batch: b.id, message: (err as Error)?.message });
    return res.status(409).json({ error: "The uploaded file could not be read again. Upload it once more." });
  }
  const stageMap = (b.options?.stage_map ?? {}) as Record<string, string>;
  const rows: unknown[] = [];
  let errorRows = 0;
  let scanned = 0;
  for (const item of src.items(b.mapping ?? {})) {
    const n = normalise(item.type, item.input, { stageMap });
    scanned++;
    if (n.errors.length) errorRows++;
    if (rows.length < limit) rows.push({ row_number: item.rowNumber, record_type: item.type, values: n.values, errors: n.errors, warnings: n.warnings });
    if (scanned >= 5000 && rows.length >= limit) break;
  }
  const stages = src.types.includes("applications") ? stageValues(src, b.mapping ?? {}, stageMap) : [];
  return res.json({ ok: true, rows, scanned, error_rows_in_scanned: errorRows, stages });
}));

async function queue(req: any, res: any, from: string[], to: string, action: string) {
  const b = await batchFor(req, res);
  if (!b) return;
  if (!from.includes(b.status)) {
    return res.status(409).json({ error: `This import is ${String(b.status).replace(/_/g, " ")}; that step is not available now.` });
  }
  const extra = to === "dry_run_queued" ? ", processed_rows = 0, dry_run = NULL" : "";
  const r = await pool.query(
    `UPDATE import_batches SET status = $2, last_error = NULL, heartbeat_at = NULL, finished_at = NULL, updated_at = now()${extra}
      WHERE id = $1 AND status = ANY($3::text[]) RETURNING *`, [b.id, to, from]);
  if (!r.rows[0]) return res.status(409).json({ error: "This import changed in the meantime; reload and try again." });
  await auditEvent(req, action, b.id, { file: b.file_name, source: b.source, record_type: b.record_type, silo: b.silo });
  kickDataImportWorker();
  return res.status(202).json({ ok: true, batch: publicBatch(r.rows[0]) });
}

router.post("/batches/:id/dry-run", safeHandler(async (req: any, res: any) => {
  const b = await batchFor(req, res);
  if (!b) return;
  if (b.record_type !== "keystone") {
    const problems = mappingProblems(b.record_type as RecordType, b.mapping ?? {});
    if (problems.length) return res.status(400).json({ error: problems[0], problems });
  }
  return queue(req, res, ["uploaded", "ready"], "dry_run_queued", "data_import.dry_run_requested");
}));

// A run needs a finished dry run; a failed run is started again and carries on after the last saved chunk.
router.post("/batches/:id/run", safeHandler(async (req: any, res: any) => queue(req, res, ["ready", "failed"], "queued", "data_import.run_requested")));

router.post("/batches/:id/undo", safeHandler(async (req: any, res: any) => queue(req, res, ["completed", "failed"], "undo_queued", "data_import.undo_requested")));

router.get("/batches/:id/errors.csv", safeHandler(async (req: any, res: any) => {
  const b = await batchFor(req, res);
  if (!b) return;
  const phase = ["dry_run", "run", "undo"].includes(String(req.query.phase)) ? String(req.query.phase) : (b.status === "ready" ? "dry_run" : "run");
  const r = await pool.query(
    `SELECT level, record_type, row_number, field, message, raw FROM import_batch_errors WHERE batch_id = $1 AND phase = $2 ORDER BY row_number NULLS LAST, id LIMIT 20000`,
    [b.id, phase]);
  const rawCols = new Set<string>();
  for (const row of r.rows) if (row.raw && typeof row.raw === "object") for (const k of Object.keys(row.raw)) if (rawCols.size < 80) rawCols.add(k);
  const headers = ["row", "level", "record_type", "field", "problem", ...[...rawCols]];
  const rows = r.rows.map((x: any) => ({ row: x.row_number ?? "", level: x.level, record_type: x.record_type ?? "", field: x.field ?? "", problem: x.message, ...(x.raw ?? {}) }));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="import-problems-${phase.replace("_", "-")}.csv"`);
  res.send("﻿" + toCsv(headers, rows));
}));

router.delete("/batches/:id", safeHandler(async (req: any, res: any) => {
  const b = await batchFor(req, res);
  if (!b) return;
  if (!["uploaded", "ready"].includes(b.status)) return res.status(409).json({ error: "Only an import that was never run can be removed. Use Undo instead." });
  await pool.query(`DELETE FROM import_batches WHERE id = $1`, [b.id]);
  if (b.file_key) await importFileStore().delete(String(b.file_key)).catch((e: unknown) => logWarnSwallowed(e, "routes/dataImport.ts:delete_upload"));
  return res.json({ ok: true });
}));

export default router;
