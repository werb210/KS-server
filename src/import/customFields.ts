// KS_SERVER_v20_CRM_FIELDS - the data importer and custom fields.
//
// A mapping may send a column to a custom field with the key "cf:<internal name>" (contacts, companies and deals /
// applications). The wizard suggests them by the field's label or internal name, which is what a HubSpot export uses
// for a custom property ("Broker licence" or "broker_licence"), and can create a custom field from a column that
// matches nothing. Values are checked with the same rules as the portal; a bad value fails that row with a clear
// message, and an imported value is merged into the record's custom fields (undo restores the previous ones).
import { isEmptyValue, validateValue, type FieldDefinition, type FieldType, type ObjectType } from "../customFields/definitions.js";
import { normaliseColumn, type RecordType } from "./fields.js";
import type { RowIssue } from "./normalise.js";

export const CUSTOM_PREFIX = "cf:";
export const CUSTOM_OBJECT_OF: Partial<Record<RecordType, ObjectType>> = { contacts: "contact", companies: "company", applications: "application" };

export function customKey(name: string): string {
  return `${CUSTOM_PREFIX}${name}`;
}

/** Suggested { "cf:name": column } for columns not already used, matched on internal name or label. */
export function matchCustomColumns(defs: FieldDefinition[], columns: string[], used: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  const byNorm = new Map<string, string>();
  for (const c of columns) if (!used.has(c) && !byNorm.has(normaliseColumn(c))) byNorm.set(normaliseColumn(c), c);
  for (const d of defs) {
    if (d.archived_at) continue;
    for (const n of [d.name, d.label]) {
      const col = byNorm.get(normaliseColumn(n));
      if (col && !used.has(col)) { out[customKey(d.name)] = col; used.add(col); break; }
    }
  }
  return out;
}

/** Mapping keys that are custom fields but not (active) fields of this object. */
export function unknownCustomKeys(defs: FieldDefinition[], mapping: Record<string, string>): string[] {
  const ok = new Set(defs.filter((d) => !d.archived_at).map((d) => customKey(d.name)));
  return Object.keys(mapping).filter((k) => k.startsWith(CUSTOM_PREFIX) && !ok.has(k));
}

/** The custom field values of one row: what to store, and the row's problems (an invalid value is an error). */
export function customValuesOf(defs: FieldDefinition[], input: Record<string, string>): { values: Record<string, unknown>; errors: RowIssue[] } {
  const values: Record<string, unknown> = {};
  const errors: RowIssue[] = [];
  const byKey = new Map(defs.map((d) => [customKey(d.name), d]));
  for (const [k, raw] of Object.entries(input)) {
    if (!k.startsWith(CUSTOM_PREFIX) || isEmptyValue(raw)) continue;
    const def = byKey.get(k);
    if (!def || def.archived_at) continue;
    const r = validateValue(def, raw);
    if (!r.ok) { errors.push({ field: k, message: r.error }); continue; }
    if (r.value !== null) values[def.name] = r.value;
  }
  return { values, errors };
}

/** Field type that fits a column's sample values (for "Create a custom field from this column"). */
export function guessFieldType(samples: unknown[]): FieldType {
  const vals = samples.map((s) => String(s ?? "").trim()).filter(Boolean).slice(0, 200);
  if (!vals.length) return "text";
  const all = (re: RegExp) => vals.every((v) => re.test(v));
  if (all(/^(true|false|yes|no|y|n)$/i)) return "checkbox";
  if (all(/^\$\s?-?[\d,]+(\.\d{1,2})?$/)) return "money";
  if (all(/^-?[\d,]+(\.\d+)?$/)) return "number";
  if (all(/^\d{4}-\d{2}-\d{2}([T ].*)?$|^\d{1,2}\/\d{1,2}\/\d{4}$/)) return "date";
  if (all(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) return "email";
  if (all(/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i)) return "url";
  if (vals.some((v) => v.length > 200 || /[\r\n]/.test(v))) return "long_text";
  return "text";
}
