// BF_SERVER_REPORTS15_18_v786 - pipeline snapshots, issues, and the custom report builder. Boreal Financial silo.
import { pool } from "../../db.js";
import type { Ctx } from "./data2.js";
import { brokerageTimeZone } from "../../lib/brokerageTime.js"; // KS_SETTINGS_PACK_v1_TIME_ZONE - the brokerage's zone (Settings > Company)

function days(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1095) : fallback;
}
const r1 = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
const STAFF = (alias: string) => `COALESCE(NULLIF(TRIM(COALESCE(${alias}.first_name, '') || ' ' || COALESCE(${alias}.last_name, '')), ''), ${alias}.email, 'Unassigned')`;

/** Store today's pipeline by stage (open files only). Safe to run many times a day: the latest run wins. */
export async function takePipelineSnapshot(): Promise<number> {
  const r = await pool.query(
    `INSERT INTO pipeline_snapshots (snapshot_date, stage, files, amount, taken_at)
     SELECT (now() AT TIME ZONE $1)::date, COALESCE(NULLIF(a.pipeline_state, ''), 'Unknown'), count(*)::int, COALESCE(sum(a.requested_amount), 0), now()
       FROM applications a
      WHERE a.silo = 'BF' AND a.funded_at IS NULL AND COALESCE(a.status, '') <> 'DECLINED'
        AND COALESCE(a.pipeline_state, '') NOT ILIKE 'reject%' AND COALESCE(a.is_completed, false) = false
      GROUP BY 2
     ON CONFLICT (snapshot_date, stage) DO UPDATE SET files = EXCLUDED.files, amount = EXCLUDED.amount, taken_at = now()`, [brokerageTimeZone()]); // KS_SETTINGS_PACK_v1_TIME_ZONE
  return r.rowCount ?? 0;
}

/** 15. The pipeline on a chosen past day (default: the earliest of the last 30 days), next to today. */
export async function pipelineSnapshot(q: Record<string, unknown>) {
  const dates = (await pool.query(`SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS d FROM pipeline_snapshots GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT 400`)).rows.map((r: any) => r.d as string);
  const wanted = typeof q.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : (dates.find((d) => d <= new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)) ?? dates[dates.length - 1] ?? null);
  const today = dates[0] ?? null;
  const at = async (d: string | null) => d ? (await pool.query(`SELECT stage, files, amount FROM pipeline_snapshots WHERE snapshot_date = $1::date`, [d])).rows : [];
  const [then, now] = await Promise.all([at(wanted), at(today)]);
  const stages = Array.from(new Set([...then, ...now].map((r: any) => r.stage)));
  return {
    date: wanted, today, dates,
    note: dates.length ? `History starts ${dates[dates.length - 1]}.` : "The first snapshot is taken within an hour of this report going live.",
    rows: stages.map((s) => {
      const a: any = then.find((r: any) => r.stage === s); const b: any = now.find((r: any) => r.stage === s);
      return { stage: s, then_files: a?.files ?? 0, then_amount: Math.round(Number(a?.amount ?? 0)), now_files: b?.files ?? 0, now_amount: Math.round(Number(b?.amount ?? 0)) };
    }),
  };
}

/** 16. Issues: opened and resolved per month, median days to resolve, and what is open now. */
export async function issuesReport(q: Record<string, unknown>) {
  const d = days(q.days, 180);
  const byMonth = (await pool.query(
    `SELECT to_char(date_trunc('month', i.created_at), 'YYYY-MM') AS label, count(*)::int AS opened,
            count(*) FILTER (WHERE i.status = 'resolved')::int AS resolved,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (i.updated_at - i.created_at)) / 86400) FILTER (WHERE i.status = 'resolved') AS median_days
       FROM issues i WHERE COALESCE(i.silo, 'BF') = 'BF' AND i.created_at >= now() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY 1`, [d])).rows.map((r: any) => ({ label: r.label, opened: r.opened, resolved: r.resolved, median_days: r1(r.median_days) }));
  const open = (await pool.query(
    `SELECT COALESCE(NULLIF(i.kind, ''), NULLIF(i.source, ''), 'Other') AS label, count(*)::int AS open,
            count(*) FILTER (WHERE i.status = 'in_progress')::int AS in_progress,
            max(EXTRACT(EPOCH FROM (now() - i.created_at)) / 86400)::int AS oldest_days
       FROM issues i WHERE COALESCE(i.silo, 'BF') = 'BF' AND COALESCE(i.status, 'open') <> 'resolved'
      GROUP BY 1 ORDER BY 2 DESC`)).rows;
  return { days: d, note: "Time to resolve uses the issue's last update, so a resolved issue edited later shows longer.", byMonth, open };
}

// 18. Custom report builder: a fixed menu of record types, groupings and measures (no free-form SQL).
type Entity = { from: string; where: string; date: string; groups: Record<string, string>; measures: Record<string, string> };
const MONTH = (col: string) => `to_char(date_trunc('month', ${col}), 'YYYY-MM')`;
export const CUSTOM: Record<string, Entity> = {
  applications: {
    // KS_SERVER_CUSTOM_EVERYWHERE_v1 - the deal's extra pipeline and its stage there.
    from: "applications a LEFT JOIN users u ON u.id = a.owner_user_id LEFT JOIN pipelines pl ON pl.id = a.pipeline_id LEFT JOIN pipeline_stages ps ON ps.id = a.pipeline_stage_id", where: "a.silo = 'BF'", date: "a.created_at",
    groups: { stage: "COALESCE(NULLIF(a.pipeline_state, ''), 'Unknown')", product: "COALESCE(NULLIF(a.product_category, ''), 'Other')", source: "COALESCE(NULLIF(a.source, ''), 'Direct')", owner: STAFF("u"), month: MONTH("a.created_at"),
      pipeline: "COALESCE(pl.name, 'Lending')", pipeline_stage: "COALESCE(pl.name, 'Lending') || ': ' || COALESCE(ps.name, NULLIF(a.pipeline_state, ''), 'Unknown')" },
    measures: { count: "count(*)", amount: "COALESCE(sum(a.requested_amount), 0)", funded: "count(*) FILTER (WHERE a.funded_at IS NOT NULL)", average_amount: "COALESCE(avg(a.requested_amount), 0)" },
  },
  contacts: {
    from: "contacts c LEFT JOIN users u ON u.id = c.owner_id", where: "c.silo = 'BF'", date: "c.created_at",
    groups: { lifecycle: "COALESCE(NULLIF(c.lifecycle_stage, ''), 'lead')", owner: STAFF("u"), month: MONTH("c.created_at") },
    measures: { count: "count(*)", opted_out: "count(*) FILTER (WHERE c.sms_opt_out = true)" },
  },
  // KS_SERVER_CUSTOM_EVERYWHERE_v1
  companies: {
    from: "companies co LEFT JOIN users u ON u.id = co.owner_id", where: "true", date: "co.created_at",
    groups: { owner: STAFF("u"), month: MONTH("co.created_at") },
    measures: { count: "count(*)" },
  },
  tasks: {
    from: "tasks t LEFT JOIN users u ON u.id = t.assignee_user_id", where: "t.deleted_at IS NULL AND COALESCE(t.silo, 'BF') = 'BF'", date: "t.created_at",
    groups: { status: "COALESCE(NULLIF(t.status, ''), 'open')", assignee: STAFF("u"), type: "COALESCE(NULLIF(t.type, ''), 'task')", month: MONTH("t.created_at") },
    measures: { count: "count(*)", overdue: "count(*) FILTER (WHERE t.completed_at IS NULL AND t.due_at < now())", completed: "count(*) FILTER (WHERE t.completed_at IS NOT NULL)" },
  },
};

// KS_SERVER_CUSTOM_EVERYWHERE_v1 - the brokerage's own properties as groupings ("cf:<name>") and, for number and money
// properties, as measures ("sum_cf:<name>", "avg_cf:<name>"). The name is checked against the brokerage's definitions
// and passed as a query parameter, never written into the SQL.
const CF_OBJECT: Record<string, { object: "contact" | "company" | "application"; alias: string }> = {
  applications: { object: "application", alias: "a" }, contacts: { object: "contact", alias: "c" }, companies: { object: "company", alias: "co" },
};
async function customFieldMenu(entityKey: string) {
  const cfo = CF_OBJECT[entityKey];
  if (!cfo) return { groups: [] as Array<{ key: string; label: string }>, measures: [] as Array<{ key: string; label: string }>, names: new Map<string, string>() };
  const { listDefinitions } = await import("../../customFields/service.js");
  let defs: any[] = [];
  try { defs = await listDefinitions(pool as any, cfo.object); } catch (err) { console.warn("[reports] custom fields unavailable", String(err)); }
  const live = defs.filter((d) => !d.archived_at && /^[a-z][a-z0-9_]{0,62}$/.test(d.name));
  return {
    groups: live.filter((d) => d.field_type !== "long_text").map((d) => ({ key: `cf:${d.name}`, label: d.label })),
    measures: live.filter((d) => d.field_type === "number" || d.field_type === "money").flatMap((d) => [
      { key: `sum_cf:${d.name}`, label: `Total ${d.label}` }, { key: `avg_cf:${d.name}`, label: `Average ${d.label}` }]),
    names: new Map(live.map((d) => [d.name, d.field_type])),
  };
}

export async function customReport(q: Record<string, unknown>, _ctx?: Ctx) {
  const entityKey = String(q.entity ?? "applications");
  const e = CUSTOM[entityKey];
  const cf = await customFieldMenu(entityKey);
  const menu = Object.fromEntries(await Promise.all(Object.entries(CUSTOM).map(async ([k, v]) => {
    const m = k === entityKey ? cf : await customFieldMenu(k);
    return [k, { groups: [...Object.keys(v.groups), ...m.groups.map((g) => g.key)], measures: [...Object.keys(v.measures), ...m.measures.map((x) => x.key)],
      custom: { groups: m.groups, measures: m.measures } }];
  })));
  if (!e) return { error: "unknown_record_type", menu, rows: [] };
  const groupKey = String(q.groupBy ?? Object.keys(e.groups)[0]);
  const measureKey = String(q.measure ?? "count");
  const alias = CF_OBJECT[entityKey]?.alias ?? "";
  const params: unknown[] = [days(q.days, 90)];
  let g = e.groups[groupKey];
  let m = e.measures[measureKey];
  const cfGroup = /^cf:([a-z][a-z0-9_]{0,62})$/.exec(groupKey);
  if (!g && cfGroup && alias && cf.names.has(cfGroup[1]!)) {
    params.push(cfGroup[1]);
    const ft = cf.names.get(cfGroup[1]!);
    g = ft === "multi_select"
      ? `COALESCE(NULLIF(array_to_string(ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(${alias}.custom_fields->$${params.length}) = 'array' THEN ${alias}.custom_fields->$${params.length} ELSE '[]'::jsonb END)), ', '), ''), '(none)')`
      : `COALESCE(NULLIF(${alias}.custom_fields->>$${params.length}, ''), '(none)')`;
  }
  const cfMeasure = /^(sum|avg)_cf:([a-z][a-z0-9_]{0,62})$/.exec(measureKey);
  if (!m && cfMeasure && alias && ["number", "money"].includes(String(cf.names.get(cfMeasure[2]!)))) {
    params.push(cfMeasure[2]);
    const num = `CASE WHEN (${alias}.custom_fields->>$${params.length}) ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (${alias}.custom_fields->>$${params.length})::numeric END`;
    m = cfMeasure[1] === "sum" ? `COALESCE(sum(${num}), 0)` : `COALESCE(avg(${num}), 0)`;
  }
  if (!g || !m) return { error: "unknown_grouping_or_measure", menu, rows: [] };
  const { rows } = await pool.query(
    `SELECT ${g} AS label, ${m} AS value FROM ${e.from} WHERE ${e.where} AND ${e.date} >= now() - ($1 || ' days')::interval GROUP BY 1 ORDER BY ${groupKey === "month" ? "1" : "2 DESC"} LIMIT 50`, params);
  return { entity: entityKey, groupBy: groupKey, measure: measureKey, days: params[0], menu, rows: rows.map((r: any) => ({ label: String(r.label), value: Math.round(Number(r.value) * 100) / 100 })) };
}

// KS_SERVER_CUSTOM_EVERYWHERE_v1 - every extra pipeline: open deals, amount and weighted amount per stage.
export async function yourPipelines(_q: Record<string, unknown>) {
  const { extraPipelines, weighted } = await import("../../pipelines/pipelines.js");
  const pipelines = await extraPipelines(pool as any);
  const out = [];
  for (const p of pipelines) {
    const r = await pool.query(
      `SELECT a.pipeline_stage_id::text AS stage, count(*)::int AS deals, COALESCE(sum(COALESCE(a.funded_amount, a.requested_amount)), 0)::float AS amount
         FROM applications a WHERE a.pipeline_id = $1::uuid GROUP BY 1`, [p.id]);
    const by = new Map(r.rows.map((x: any) => [String(x.stage), x]));
    const stages = p.stages.map((s: any) => {
      const row: any = by.get(s.id) ?? { deals: 0, amount: 0 };
      return { name: s.name, outcome: s.outcome, probability: s.probability, deals: Number(row.deals), amount: Number(row.amount), weighted: weighted(Number(row.amount), s.probability) };
    });
    out.push({ pipeline: p.name, stages, open_deals: stages.filter((s: any) => s.outcome === "open").reduce((n: number, s: any) => n + s.deals, 0),
      weighted_amount: Math.round(stages.filter((s: any) => s.outcome === "open").reduce((n: number, s: any) => n + s.weighted, 0) * 100) / 100 });
  }
  return { pipelines: out, note: out.length ? undefined : "You have not created any pipelines beyond the lending pipeline yet (Settings > CRM set-up)." };
}
