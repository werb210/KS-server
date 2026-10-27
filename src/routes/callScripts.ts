// KS_HUBSPOT_GAPS_1_CALL_SCRIPTS - /api/call-scripts: call scripts (playbooks), Growth and Pro (call_scripts).
//   GET    /                        staff: active scripts (Admins: ?include_archived=1), question types, custom fields to map to
//   POST   /                        Admin: create                { name, description, use_for, sections }
//   POST   /starters                Admin: add the starter intake scripts (term loan, line of credit, equipment)
//   PUT    /:id                     Admin: replace
//   POST   /:id/archive | /unarchive | /duplicate    Admin
//   GET    /runs?contact_id=|application_id=          staff who may see the record: past runs (newest first)
//   POST   /runs                    staff: start or save a run   { script_id, contact_id?, application_id?, call_sid?, answers, finish? }
//   PUT    /runs/:id                staff: save answers          { answers, finish? }
// Finishing a run puts a summary on the contact's timeline and writes mapped answers to custom fields.
import { Router } from "express";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { requireFeature } from "../plans/requireFeature.js";
import { pool } from "../db.js";
import { actorId, auditFor } from "../settingsPack/common.js";
import { canSeeRecord, scopeForRequest } from "../visibility/scope.js";
import { listDefinitions } from "../customFields/service.js";
import {
  QUESTION_TYPES, QUESTION_TYPE_LABEL, applyMappings, cleanAnswers, missingRequired, rowToScript, starterScripts, summaryText, validateScript, type Q, type Section,
} from "../callScripts/scripts.js";

const router = Router();
const db = (): Q => pool as unknown as Q;
const FEATURE = "call_scripts";
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }), requireFeature(FEATURE)];
const admin = [auth, requireAuthorization({ roles: [ROLES.ADMIN] }), requireFeature(FEATURE)];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function scriptRow(id: string) {
  if (!UUID.test(id)) return null;
  return (await db().query(`SELECT * FROM call_scripts WHERE id = $1::uuid`, [id])).rows[0] ?? null;
}

router.get("/", ...staff, safeHandler(async (req: any, res: any) => {
  const all = req.user?.role === "Admin" && ["1", "true"].includes(String(req.query?.include_archived ?? ""));
  const r = await db().query(`SELECT * FROM call_scripts WHERE ($1::boolean OR archived_at IS NULL) ORDER BY archived_at NULLS FIRST, position, lower(name)`, [all]);
  const fields: Record<string, Array<{ name: string; label: string; field_type: string }>> = {};
  for (const o of ["contact", "application"] as const) {
    fields[o] = (await listDefinitions(db() as any, o)).filter((d) => !d.archived_at).map((d) => ({ name: d.name, label: d.label, field_type: d.field_type }));
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, scripts: r.rows.map(rowToScript), question_types: QUESTION_TYPES.map((t) => ({ value: t, label: QUESTION_TYPE_LABEL[t] })), custom_fields: fields });
}));

async function save(req: any, res: any, id: string | null) {
  const v = await validateScript(db(), req.body ?? {});
  if (!v.ok) return res.status(400).json({ ok: false, error: "validation_error", message: Object.values(v.errors)[0], errors: v.errors });
  const s = v.value;
  try {
    const r = id
      ? await db().query(`UPDATE call_scripts SET name = $2, description = $3, use_for = $4, sections = $5::jsonb, updated_by = $6::uuid, updated_at = now() WHERE id = $1::uuid RETURNING *`,
        [id, s.name, s.description, s.use_for, JSON.stringify(s.sections), actorId(req)])
      : await db().query(`INSERT INTO call_scripts (name, description, use_for, sections, position, created_by, updated_by)
          VALUES ($1, $2, $3, $4::jsonb, (SELECT COALESCE(max(position), 0) + 1 FROM call_scripts), $5::uuid, $5::uuid) RETURNING *`,
        [s.name, s.description, s.use_for, JSON.stringify(s.sections), actorId(req)]);
    const script = rowToScript(r.rows[0]);
    await auditFor(req, id ? "call_script.updated" : "call_script.created", { name: script.name, sections: script.sections.length }, { type: "call_script", id: script.id });
    return res.status(id ? 200 : 201).json({ ok: true, script });
  } catch (err: any) {
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "duplicate_name", message: "There is already a script with that name.", errors: { name: "There is already a script with that name." } });
    throw err;
  }
}

router.post("/", ...admin, safeHandler((req: any, res: any) => save(req, res, null)));

router.post("/starters", ...admin, safeHandler(async (req: any, res: any) => {
  const added: string[] = [];
  for (const s of starterScripts()) {
    const r = await db().query(
      `INSERT INTO call_scripts (name, description, use_for, sections, position, created_by, updated_by)
       SELECT $1, $2, $3, $4::jsonb, (SELECT COALESCE(max(position), 0) + 1 FROM call_scripts), $5::uuid, $5::uuid
        WHERE NOT EXISTS (SELECT 1 FROM call_scripts WHERE lower(name) = lower($1) AND archived_at IS NULL) RETURNING id`,
      [s.name, s.description, s.use_for, JSON.stringify(s.sections), actorId(req)]);
    if (r.rows.length) added.push(s.name);
  }
  await auditFor(req, "call_script.starters_added", { added });
  res.json({ ok: true, added });
}));

router.put("/:id", ...admin, safeHandler(async (req: any, res: any) => {
  if (!(await scriptRow(String(req.params.id)))) return res.status(404).json({ ok: false, error: "not_found" });
  return save(req, res, String(req.params.id));
}));

router.post("/:id/:action(archive|unarchive|duplicate)", ...admin, safeHandler(async (req: any, res: any) => {
  const row = await scriptRow(String(req.params.id));
  if (!row) return res.status(404).json({ ok: false, error: "not_found" });
  const action = String(req.params.action);
  let out;
  try {
    if (action === "duplicate") {
      out = (await db().query(`INSERT INTO call_scripts (name, description, use_for, sections, position, created_by, updated_by)
        VALUES ($1, $2, $3, $4::jsonb, (SELECT COALESCE(max(position), 0) + 1 FROM call_scripts), $5::uuid, $5::uuid) RETURNING *`,
        [`${row.name} (copy)`.slice(0, 120), row.description, row.use_for, JSON.stringify(row.sections), actorId(req)])).rows[0];
    } else {
      out = (await db().query(`UPDATE call_scripts SET archived_at = ${action === "archive" ? "now()" : "NULL"}, updated_by = $2::uuid, updated_at = now() WHERE id = $1::uuid RETURNING *`, [row.id, actorId(req)])).rows[0];
    }
  } catch (err: any) {
    if (err?.code === "23505") return res.status(409).json({ ok: false, error: "duplicate_name", message: "An active script already has that name. Rename one first." });
    throw err;
  }
  await auditFor(req, `call_script.${action}d`, { name: row.name }, { type: "call_script", id: String(out.id) });
  res.status(action === "duplicate" ? 201 : 200).json({ ok: true, script: rowToScript(out) });
}));

// ------------------------------------------------------------------ runs
async function visible(req: any, res: any, contactId: string | null, applicationId: string | null): Promise<boolean> {
  const scope = await scopeForRequest(req, db() as any);
  if ((contactId && !(await canSeeRecord(db() as any, scope, "contact", contactId))) || (applicationId && !(await canSeeRecord(db() as any, scope, "application", applicationId)))) {
    res.status(404).json({ ok: false, error: "not_found", message: "Record not found" });
    return false;
  }
  return true;
}

function runView(r: any) {
  return {
    id: String(r.id), script_id: String(r.script_id), script_name: r.script_name, sections: r.script_snapshot, contact_id: r.contact_id ?? null,
    application_id: r.application_id ?? null, call_sid: r.call_sid ?? null, answers: r.answers ?? {}, status: r.status,
    field_updates: r.field_updates ?? [], field_errors: r.field_errors ?? [], user_id: r.user_id ?? null, user_name: r.user_name ?? null,
    created_at: new Date(r.created_at).toISOString(), completed_at: r.completed_at ? new Date(r.completed_at).toISOString() : null,
  };
}

router.get("/runs", ...staff, safeHandler(async (req: any, res: any) => {
  const contactId = String(req.query?.contact_id ?? "").trim() || null;
  const applicationId = String(req.query?.application_id ?? "").trim() || null;
  if (!contactId && !applicationId) return res.status(400).json({ ok: false, error: "record_required" });
  if (contactId && !UUID.test(contactId)) return res.status(404).json({ ok: false, error: "not_found" });
  if (!(await visible(req, res, contactId, applicationId))) return;
  const r = await db().query(
    `SELECT r.*, NULLIF(btrim(concat_ws(' ', u.first_name, u.last_name)), '') AS user_name
       FROM call_script_runs r LEFT JOIN users u ON u.id = r.user_id
      WHERE ($1::uuid IS NULL OR r.contact_id = $1::uuid) AND ($2::text IS NULL OR r.application_id = $2)
      ORDER BY r.created_at DESC LIMIT 50`, [contactId, applicationId]);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, runs: r.rows.map(runView) });
}));

async function finish(req: any, run: any): Promise<any> {
  const sections = run.script_snapshot as Section[];
  const mapped = await applyMappings(db(), sections, run.answers, { contactId: run.contact_id ?? null, applicationId: run.application_id ?? null });
  const done = (await db().query(
    `UPDATE call_script_runs SET status = 'completed', completed_at = now(), field_updates = $2::jsonb, field_errors = $3::jsonb, updated_at = now()
      WHERE id = $1::uuid RETURNING *`, [run.id, JSON.stringify(mapped.updates), JSON.stringify(mapped.errors)])).rows[0];
  if (run.contact_id) {
    await db().query(
      `INSERT INTO crm_timeline_events (contact_id, application_id, event_type, payload, actor_user_id) VALUES ($1::uuid, $2, 'call_script', $3::jsonb, $4::uuid)`,
      [run.contact_id, run.application_id ?? null, JSON.stringify({ title: `Call script: ${run.script_name}`, detail: summaryText(sections, run.answers), run_id: run.id }), actorId(req)]);
  }
  return done;
}

router.post("/runs", ...staff, safeHandler(async (req: any, res: any) => {
  const script = await scriptRow(String(req.body?.script_id ?? ""));
  if (!script || script.archived_at) return res.status(404).json({ ok: false, error: "not_found", message: "That script is not available." });
  let contactId = String(req.body?.contact_id ?? "").trim() || null;
  const applicationId = String(req.body?.application_id ?? "").trim() || null;
  if (contactId && !UUID.test(contactId)) return res.status(404).json({ ok: false, error: "not_found" });
  if (!contactId && applicationId) contactId = (await db().query(`SELECT contact_id::text AS c FROM applications WHERE id::text = $1`, [applicationId])).rows[0]?.c ?? null;
  if (!(await visible(req, res, contactId, applicationId))) return;
  const sections = script.sections as Section[];
  const answers = cleanAnswers(sections, req.body?.answers);
  if (req.body?.finish === true) {
    const missing = missingRequired(sections, answers);
    if (missing.length) return res.status(400).json({ ok: false, error: "required_missing", message: `Answer: ${missing.join("; ")}`, missing });
  }
  const callSid = /^CA[0-9a-f]{32}$/i.test(String(req.body?.call_sid ?? "")) ? String(req.body.call_sid) : null;
  let run = (await db().query(
    `INSERT INTO call_script_runs (script_id, script_name, script_snapshot, contact_id, application_id, call_sid, answers, user_id)
     VALUES ($1::uuid, $2, $3::jsonb, $4::uuid, $5, $6, $7::jsonb, $8::uuid) RETURNING *`,
    [script.id, script.name, JSON.stringify(sections), contactId, applicationId, callSid, JSON.stringify(answers), actorId(req)])).rows[0];
  if (req.body?.finish === true) run = await finish(req, run);
  res.status(201).json({ ok: true, run: runView(run) });
}));

router.put("/runs/:id", ...staff, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "");
  const run = UUID.test(id) ? (await db().query(`SELECT * FROM call_script_runs WHERE id = $1::uuid`, [id])).rows[0] : null;
  if (!run) return res.status(404).json({ ok: false, error: "not_found" });
  if (!(await visible(req, res, run.contact_id ?? null, run.application_id ?? null))) return;
  if (run.status === "completed") return res.status(409).json({ ok: false, error: "already_finished", message: "This script was already finished. Start a new one to record more answers." });
  const sections = run.script_snapshot as Section[];
  const answers = cleanAnswers(sections, req.body?.answers);
  if (req.body?.finish === true) {
    const missing = missingRequired(sections, answers);
    if (missing.length) return res.status(400).json({ ok: false, error: "required_missing", message: `Answer: ${missing.join("; ")}`, missing });
  }
  let saved = (await db().query(`UPDATE call_script_runs SET answers = $2::jsonb, updated_at = now() WHERE id = $1::uuid RETURNING *`, [id, JSON.stringify(answers)])).rows[0];
  if (req.body?.finish === true) saved = await finish(req, saved);
  res.json({ ok: true, run: runView(saved) });
}));

export default router;
