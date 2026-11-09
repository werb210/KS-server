// KS_SERVER_CUSTOM_EVERYWHERE_v1 - a brokerage's own properties (custom fields) and extra pipelines, made available to
// the automation builder, the assistant (Maya) and the custom report builder.
//
// Naming: a property is exposed as <object>_cf_<name>, e.g. contact_cf_broker_licence, company_cf_naics,
// deal_cf_equipment_type. The same keys work as automation conditions, {{tokens}} in messages, assistant answers and
// report groupings. Names are validated against the brokerage's own definitions (NAME_RE in definitions.ts), so a key
// never reaches SQL unchecked; values are always passed as parameters.
import type { FieldDefinition, ObjectType } from "./definitions.js";
import { listDefinitions } from "./service.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export const OBJECT_PREFIX: Record<ObjectType, string> = { contact: "contact", company: "company", application: "deal" };
export const OBJECT_LABEL: Record<ObjectType, string> = { contact: "Contact", company: "Company", application: "Deal" };
const SAFE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

export const cfKey = (object: ObjectType, name: string) => `${OBJECT_PREFIX[object]}_cf_${name}`;

/** "deal_cf_equipment_type" -> { object: "application", name: "equipment_type" }; anything else -> null. */
export function parseCfKey(key: string): { object: ObjectType; name: string } | null {
  const m = /^(contact|company|deal)_cf_([a-z][a-z0-9_]{0,62})$/.exec(String(key ?? ""));
  if (!m) return null;
  const object = (m[1] === "deal" ? "application" : m[1]) as ObjectType;
  return { object, name: m[2]! };
}

/** A stored value as text for messages, conditions and report labels. */
export function cfText(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined || v === "") return null;
  if (Array.isArray(v)) return v.map(String).join(", ");
  if (typeof v === "number" || typeof v === "boolean") return v;
  return String(v);
}

/** Every value a record carries, as <object>_cf_<name> keys (lists stay lists so "contains"/"in" work). */
export function flattenValues(object: ObjectType, values: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!values || typeof values !== "object" || Array.isArray(values)) return out;
  for (const [name, v] of Object.entries(values as Record<string, unknown>)) {
    if (!SAFE_NAME.test(name)) continue;
    out[cfKey(object, name)] = Array.isArray(v) ? v.map(String) : v;
  }
  return out;
}

/** The custom values of a contact, its company and a deal, for an automation run or an assistant answer. */
export async function customFieldContext(q: Q, ids: { contactId?: string | null; applicationId?: string | null }): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  try {
    if (ids.applicationId) {
      const a = await q.query(
        `SELECT a.custom_fields, a.contact_id::text AS contact_id, p.name AS pipeline_name, s.name AS stage_name
           FROM applications a
           LEFT JOIN pipelines p ON p.id = a.pipeline_id
           LEFT JOIN pipeline_stages s ON s.id = a.pipeline_stage_id
          WHERE a.id::text = $1`, [ids.applicationId]);
      const row = a.rows[0];
      if (row) {
        Object.assign(out, flattenValues("application", row.custom_fields));
        out.pipeline_name = row.pipeline_name ?? "Lending";
        out.pipeline_stage = row.stage_name ?? null;
        ids = { ...ids, contactId: ids.contactId ?? row.contact_id ?? null };
      }
    }
    if (ids.contactId) {
      const c = await q.query(
        `SELECT c.custom_fields, co.custom_fields AS company_fields
           FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
          WHERE c.id::text = $1`, [ids.contactId]);
      const row = c.rows[0];
      if (row) {
        Object.assign(out, flattenValues("contact", row.custom_fields));
        Object.assign(out, flattenValues("company", row.company_fields));
      }
    }
  } catch (err) {
    console.warn("[custom-fields] context lookup failed", String((err as Error)?.message ?? err)); // never blocks a run
  }
  return out;
}

export type BuilderField = { key: string; label: string; type: "text" | "number" | "list" | "boolean" | "date"; options?: string[]; group: string };

function builderType(d: FieldDefinition): BuilderField["type"] {
  if (d.field_type === "number" || d.field_type === "money") return "number";
  if (d.field_type === "checkbox") return "boolean";
  if (d.field_type === "date") return "date";
  if (d.field_type === "multi_select") return "list";
  return "text";
}

/** The brokerage's live (not archived) properties, as fields the automation builder and report builder can offer. */
export async function customBuilderFields(db: Q): Promise<BuilderField[]> {
  const out: BuilderField[] = [];
  for (const object of ["contact", "company", "application"] as ObjectType[]) {
    let defs: FieldDefinition[] = [];
    try { defs = await listDefinitions(db as any, object); } catch (err) { console.warn("[custom-fields] list failed", object, String(err)); }
    for (const d of defs) {
      if (d.archived_at || !SAFE_NAME.test(d.name)) continue;
      out.push({
        key: cfKey(object, d.name), label: `${OBJECT_LABEL[object]}: ${d.label}`, type: builderType(d), group: `${OBJECT_LABEL[object]} properties`,
        ...(d.options?.length ? { options: d.options.map((o) => o.value) } : {}),
      });
    }
  }
  return out;
}

export type PipelineSummary = { id: string; name: string; stages: string[] };

/** The brokerage's extra pipelines and their stage names (archived ones left out). */
export async function extraPipelineSummaries(db: Q): Promise<PipelineSummary[]> {
  try {
    const r = await db.query(
      `SELECT p.id::text AS id, p.name, COALESCE(array_agg(s.name ORDER BY s.position) FILTER (WHERE s.id IS NOT NULL AND s.archived_at IS NULL), '{}') AS stages
         FROM pipelines p LEFT JOIN pipeline_stages s ON s.pipeline_id = p.id
        WHERE p.archived_at IS NULL
        GROUP BY p.id, p.name, p.position ORDER BY p.position, p.name`);
    return r.rows.map((x: any) => ({ id: String(x.id), name: String(x.name), stages: (x.stages ?? []).map(String) }));
  } catch (err) {
    console.warn("[custom-fields] pipelines lookup failed", String(err));
    return [];
  }
}
