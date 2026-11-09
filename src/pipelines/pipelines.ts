// KS_HUBSPOT_GAPS_1_PIPELINES - extra pipelines with their own ordered stages, colours and win probability (plan
// feature custom_pipelines: Growth 3 pipelines in all, the lending pipeline included; Pro unlimited).
//
// The lending pipeline ("lending") is built in: its stages are the system stages (Received ... Hold) with their rules,
// and they are locked (names, order and colours never change; an Admin may set each stage's probability for the
// weighted figures). Extra pipelines (Renewals, Equipment, ...) are fully custom. A deal moved to an extra pipeline
// leaves the lending board and keeps its lending stage, so moving it back puts it where it was.
import { PIPELINE_STATES } from "../modules/applications/pipelineState.js";
import type { Plan } from "../plans/catalogue.js";
import { readSetting, writeSetting } from "../settingsPack/common.js";

export type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const LENDING_ID = "lending";
export const OUTCOMES = ["open", "won", "lost"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const MAX_STAGES = 20;
/** Pipelines in all (lending included) per plan; null = unlimited. */
export const PIPELINE_LIMIT: Record<Plan, number | null> = { starter: 1, growth: 3, pro: null };

export type Stage = { id: string; name: string; position: number; color: string; probability: number; outcome: Outcome; locked: boolean; deals?: number; key?: string; label?: string; hidden?: boolean };
export type Pipeline = { id: string; name: string; system: boolean; position: number; stages: Stage[]; archived_at: string | null };

// The lending pipeline's colours (as on the board) and default probabilities.
const LENDING_COLORS: Record<string, string> = {
  Received: "#6366f1", "In Review": "#b45309", "Documents Required": "#dc2626", "Additional Steps Required": "#c2410c",
  "Off to Lender": "#1d4ed8", Offer: "#15803d", Accepted: "#166534", Rejected: "#4b5563", Fraud: "#b91c1c", Hold: "#6d28d9",
};
export const LENDING_DEFAULT_PROBABILITY: Record<string, number> = {
  Received: 10, "In Review": 20, "Documents Required": 30, "Additional Steps Required": 40, "Off to Lender": 60, Offer: 75,
  Accepted: 100, Rejected: 0, Fraud: 0, Hold: 0,
};
const LENDING_OUTCOME: Record<string, Outcome> = { Accepted: "won", Rejected: "lost", Fraud: "lost" };

export function normalizeLendingProbabilities(raw: unknown): Record<string, number> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const s of PIPELINE_STATES) {
    const n = Math.round(Number(r[s]));
    out[s] = Number.isFinite(n) && n >= 0 && n <= 100 ? n : LENDING_DEFAULT_PROBABILITY[s] ?? 0;
  }
  return out;
}

// BF_SERVER_v909_LENDING_STAGE_DISPLAY - Admins can rename, hide and reorder the lending stages on the board. Only the
// display changes: each stage keeps its internal key (id / name, e.g. "Off to Lender"), which reports, lender sending
// and every rule still use. A hidden stage's column is left off the board while it is empty.
export type LendingStageDisplay = { label: string | null; hidden: boolean; position: number };
export function normalizeLendingDisplay(raw: unknown): Record<string, LendingStageDisplay> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const out: Record<string, LendingStageDisplay> = {};
  PIPELINE_STATES.forEach((s, i) => {
    const v = r[s] && typeof r[s] === "object" ? r[s] : {};
    const label = typeof v.label === "string" ? v.label.replace(/\s+/g, " ").trim().slice(0, 40) : "";
    const pos = Math.round(Number(v.position));
    out[s] = { label: label && label !== s ? label : null, hidden: v.hidden === true, position: Number.isFinite(pos) && pos >= 0 && pos < 100 ? pos : i };
  });
  return out;
}

export async function saveLendingDisplay(db: Q, raw: unknown, actor: string | null): Promise<Record<string, LendingStageDisplay>> {
  const v = normalizeLendingDisplay(raw);
  await writeSetting(db, "lending_pipeline_display", v, actor);
  return v;
}

export async function lendingPipeline(db: Q): Promise<Pipeline> {
  const prob = await readSetting(db, "lending_pipeline_probabilities", normalizeLendingProbabilities);
  const display = await readSetting(db, "lending_pipeline_display", normalizeLendingDisplay);
  const stages = PIPELINE_STATES.map((name, i) => ({
    id: name, name, key: name, label: display[name]?.label ?? name, hidden: display[name]?.hidden ?? false,
    position: display[name]?.position ?? i, color: LENDING_COLORS[name] ?? "#4b5563", probability: prob[name] ?? 0,
    outcome: LENDING_OUTCOME[name] ?? "open", locked: true,
  }));
  stages.sort((a, b) => a.position - b.position || PIPELINE_STATES.indexOf(a.name) - PIPELINE_STATES.indexOf(b.name));
  return { id: LENDING_ID, name: "Lending", system: true, position: 0, archived_at: null, stages };
}

export async function saveLendingProbabilities(db: Q, raw: unknown, actor: string | null): Promise<Record<string, number>> {
  const v = normalizeLendingProbabilities(raw);
  await writeSetting(db, "lending_pipeline_probabilities", v, actor);
  return v;
}

const HEX = /^#[0-9a-f]{6}$/i;
export type StageInput = { id?: unknown; name?: unknown; color?: unknown; probability?: unknown; outcome?: unknown };
export type CleanStage = { id: string | null; name: string; color: string; probability: number; outcome: Outcome };

/** Checks a pipeline's name and stages (in order). */
export function validatePipeline(raw: any): { ok: true; name: string; stages: CleanStage[] } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const name = String(raw?.name ?? "").trim();
  if (!name) errors.name = "Give the pipeline a name (for example: Renewals).";
  else if (name.length > 60) errors.name = "Keep the name under 60 characters.";
  else if (name.toLowerCase() === "lending") errors.name = "\"Lending\" is the built-in pipeline. Choose another name.";
  const list = Array.isArray(raw?.stages) ? raw.stages : [];
  if (list.length < 2) errors.stages = "A pipeline needs at least two stages.";
  if (list.length > MAX_STAGES) errors.stages = `A pipeline can have at most ${MAX_STAGES} stages.`;
  const seen = new Set<string>();
  const stages: CleanStage[] = list.slice(0, MAX_STAGES).map((s: StageInput, i: number) => {
    const n = String(s?.name ?? "").trim();
    if (!n) errors[`stages.${i}.name`] = "Name the stage.";
    else if (n.length > 40) errors[`stages.${i}.name`] = "Keep stage names under 40 characters.";
    else if (seen.has(n.toLowerCase())) errors[`stages.${i}.name`] = `"${n}" is used twice.`;
    seen.add(n.toLowerCase());
    const color = HEX.test(String(s?.color ?? "")) ? String(s.color).toLowerCase() : "#1d4ed8";
    const p = Math.round(Number(s?.probability ?? 0));
    if (!Number.isFinite(p) || p < 0 || p > 100) errors[`stages.${i}.probability`] = "Probability is 0 to 100%.";
    const outcome = (OUTCOMES as readonly string[]).includes(String(s?.outcome)) ? (String(s.outcome) as Outcome) : "open";
    const id = /^[0-9a-f-]{36}$/i.test(String(s?.id ?? "")) ? String(s.id) : null;
    return { id, name: n, color, probability: Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : 0, outcome };
  });
  if (stages.length >= 2 && !stages.some((s) => s.outcome === "open")) errors.stages = "Keep at least one open (working) stage.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, name, stages };
}

export function canAddPipeline(plan: Plan, activeExtra: number): boolean {
  const limit = PIPELINE_LIMIT[plan];
  return limit === null || activeExtra + 1 < limit;
}

export async function extraPipelines(db: Q, opts: { includeArchived?: boolean } = {}): Promise<Pipeline[]> {
  const p = await db.query(`SELECT * FROM pipelines WHERE ($1::boolean OR archived_at IS NULL) ORDER BY archived_at NULLS FIRST, position, created_at`, [opts.includeArchived === true]);
  if (!p.rows.length) return [];
  const s = await db.query(
    `SELECT s.*, (SELECT count(*)::int FROM applications a WHERE a.pipeline_stage_id = s.id) AS deals
       FROM pipeline_stages s WHERE s.pipeline_id = ANY($1::uuid[]) AND s.archived_at IS NULL ORDER BY s.position, s.created_at`,
    [p.rows.map((r: any) => r.id)]);
  return p.rows.map((r: any) => ({
    id: String(r.id), name: r.name, system: false, position: Number(r.position), archived_at: r.archived_at ? new Date(r.archived_at).toISOString() : null,
    stages: s.rows.filter((x: any) => String(x.pipeline_id) === String(r.id)).map((x: any) => ({
      id: String(x.id), name: x.name, position: Number(x.position), color: x.color, probability: Number(x.probability), outcome: x.outcome, locked: false, deals: Number(x.deals ?? 0),
    })),
  }));
}

export async function pipelineById(db: Q, id: string): Promise<Pipeline | null> {
  if (id === LENDING_ID) return lendingPipeline(db);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return (await extraPipelines(db, { includeArchived: true })).find((p) => p.id === id) ?? null;
}

/** Applies an edited stage list: updates kept stages, adds new ones, archives removed ones (only when empty). */
export async function writeStages(db: Q, pipelineId: string, stages: CleanStage[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const current = (await db.query(
    `SELECT s.id::text AS id, s.name, (SELECT count(*)::int FROM applications a WHERE a.pipeline_stage_id = s.id) AS deals
       FROM pipeline_stages s WHERE s.pipeline_id = $1::uuid AND s.archived_at IS NULL`, [pipelineId])).rows as Array<{ id: string; name: string; deals: number }>;
  const keep = new Set(stages.map((s) => s.id).filter(Boolean) as string[]);
  const removed = current.filter((c) => !keep.has(c.id));
  const busy = removed.filter((c) => c.deals > 0);
  if (busy.length) return { ok: false, error: `Move the deals out of ${busy.map((b) => `"${b.name}" (${b.deals})`).join(", ")} before removing ${busy.length === 1 ? "that stage" : "those stages"}.` };
  const known = new Set(current.map((c) => c.id));
  for (const r of removed) await db.query(`UPDATE pipeline_stages SET archived_at = now(), updated_at = now() WHERE id = $1::uuid`, [r.id]);
  for (const [i, s] of stages.entries()) {
    if (s.id && known.has(s.id)) {
      await db.query(`UPDATE pipeline_stages SET name = $2, position = $3, color = $4, probability = $5, outcome = $6, updated_at = now() WHERE id = $1::uuid`,
        [s.id, s.name, i, s.color, s.probability, s.outcome]);
    } else {
      await db.query(`INSERT INTO pipeline_stages (pipeline_id, name, position, color, probability, outcome) VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
        [pipelineId, s.name, i, s.color, s.probability, s.outcome]);
    }
  }
  return { ok: true };
}

export type MoveResult = { ok: true; pipeline_id: string; stage: string } | { ok: false; status: number; error: string; message: string };

/** Moves a deal to a stage of another (or the same) extra pipeline, or back to the lending pipeline. */
export async function moveApplication(db: Q, applicationId: string, toPipeline: string, toStage: string | null, actor: string | null): Promise<MoveResult> {
  const app = (await db.query(
    `SELECT a.id::text AS id, a.pipeline_id::text AS pipeline_id, a.pipeline_state, s.name AS stage_name
       FROM applications a LEFT JOIN pipeline_stages s ON s.id = a.pipeline_stage_id WHERE a.id::text = $1`, [applicationId])).rows[0];
  if (!app) return { ok: false, status: 404, error: "not_found", message: "Application not found" };
  const fromStage = app.pipeline_id ? app.stage_name : app.pipeline_state;
  if (toPipeline === LENDING_ID) {
    if (!app.pipeline_id) return { ok: true, pipeline_id: LENDING_ID, stage: String(app.pipeline_state ?? "") };
    await db.query(`UPDATE applications SET pipeline_id = NULL, pipeline_stage_id = NULL, pipeline_stage_entered_at = NULL, updated_at = now() WHERE id::text = $1`, [applicationId]);
    await db.query(`INSERT INTO pipeline_moves (application_id, from_pipeline_id, from_stage, to_pipeline_id, to_stage, moved_by) VALUES ($1, $2::uuid, $3, NULL, $4, $5::uuid)`,
      [applicationId, app.pipeline_id, fromStage, app.pipeline_state, actor]);
    return { ok: true, pipeline_id: LENDING_ID, stage: String(app.pipeline_state ?? "") };
  }
  const p = await pipelineById(db, toPipeline);
  if (!p || p.system || p.archived_at) return { ok: false, status: 404, error: "pipeline_not_found", message: "That pipeline does not exist." };
  const stage = toStage ? p.stages.find((s) => s.id === toStage) : p.stages[0];
  if (!stage) return { ok: false, status: 400, error: "stage_not_found", message: "Choose a stage in that pipeline." };
  await db.query(
    `UPDATE applications SET pipeline_id = $2::uuid, pipeline_stage_id = $3::uuid,
            pipeline_stage_entered_at = CASE WHEN pipeline_stage_id IS DISTINCT FROM $3::uuid THEN now() ELSE pipeline_stage_entered_at END, updated_at = now()
      WHERE id::text = $1`, [applicationId, p.id, stage.id]);
  await db.query(`INSERT INTO pipeline_moves (application_id, from_pipeline_id, from_stage, to_pipeline_id, to_stage, moved_by) VALUES ($1, $2::uuid, $3, $4::uuid, $5, $6::uuid)`,
    [applicationId, app.pipeline_id, fromStage, p.id, stage.name, actor]);
  // KS_SERVER_CUSTOM_EVERYWHERE_v1 - workflows can start on a stage change in an extra pipeline.
  if (fromStage !== stage.name || app.pipeline_id !== p.id) {
    void import("../modules/automation/automationEngine.js")
      .then((m) => m.emitAutomationEvent("application.pipeline_stage_changed", {
        silo: "BF", applicationId, data: { pipeline_name: p.name, from_stage: app.pipeline_id === p.id ? fromStage : null, to_stage: stage.name },
      } as any))
      .catch((err) => console.warn("[pipelines] automation event failed", String(err?.message ?? err)));
  }
  return { ok: true, pipeline_id: p.id, stage: stage.name };
}

/** Weighted value of a set of cards: amount x stage probability. */
export function weighted(amount: number, probability: number): number {
  return Math.round(amount * probability) / 100;
}
