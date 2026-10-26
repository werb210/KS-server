// KS_SERVER_v20_CRM_FIELDS - field definitions, value validation, list filters and the importer's custom columns.
import { describe, expect, it } from "vitest";
import {
  customFieldFilters, customFieldSortExpr, displayValue, mergeValues, slugifyName, validateDefinition, validateValue, validateValues,
  type FieldDefinition,
} from "../definitions.js";
import { customValuesOf, guessFieldType, matchCustomColumns, unknownCustomKeys } from "../../import/customFields.js";
import { mappingProblems } from "../../import/fields.js";

const def = (over: Partial<FieldDefinition>): FieldDefinition => ({
  id: "00000000-0000-4000-8000-000000000001", object_type: "contact", name: "f", label: "Field", field_type: "text", options: [],
  required: false, group_name: null, description: null, sort_order: 0, archived_at: null, ...over,
});

describe("field definitions", () => {
  it("derives the internal name from the label", () => {
    expect(slugifyName("Broker licence #")).toBe("broker_licence");
    expect(slugifyName("2nd Guarantor")).toBe("f_2nd_guarantor");
    const v = validateDefinition({ label: "Renewal date", field_type: "date" });
    expect(v).toMatchObject({ ok: true, value: { name: "renewal_date", field_type: "date", required: false } });
  });

  it("rejects a missing label, an unknown type, a bad name and a select without options", () => {
    expect(validateDefinition({ field_type: "text" })).toMatchObject({ ok: false });
    expect(validateDefinition({ label: "X", field_type: "colour" })).toMatchObject({ ok: false });
    expect(validateDefinition({ label: "X", name: "Bad Name", field_type: "text" })).toMatchObject({ ok: false });
    const r = validateDefinition({ label: "Tier", field_type: "single_select", options: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain("Add at least one option.");
  });

  it("cleans options and refuses duplicates", () => {
    const ok = validateDefinition({ label: "Tier", field_type: "single_select", options: ["Gold", { label: "Silver" }, "  "] });
    expect(ok).toMatchObject({ ok: true, value: { options: [{ value: "gold", label: "Gold" }, { value: "silver", label: "Silver" }] } });
    expect(validateDefinition({ label: "Tier", field_type: "single_select", options: ["Gold", "gold"] }).ok).toBe(false);
  });

  it("keeps the internal name, allows only compatible type changes and never drops a used option", () => {
    const existing = def({ name: "tier", label: "Tier", field_type: "single_select", options: [{ value: "gold", label: "Gold" }, { value: "silver", label: "Silver" }] });
    expect(validateDefinition({ name: "other" }, existing).ok).toBe(false);
    expect(validateDefinition({ field_type: "number" }, existing).ok).toBe(false);
    expect(validateDefinition({ field_type: "multi_select" }, existing)).toMatchObject({ ok: true, value: { name: "tier", field_type: "multi_select" } });
    expect(validateDefinition({ options: [{ value: "gold", label: "Gold+" }] }, existing).ok).toBe(false); // silver removed
    expect(validateDefinition({ options: [{ value: "gold", label: "Gold+" }, { value: "silver", label: "Silver" }, "Bronze"] }, existing))
      .toMatchObject({ ok: true, value: { options: [{ value: "gold", label: "Gold+" }, { value: "silver", label: "Silver" }, { value: "bronze", label: "Bronze" }] } });
  });
});

describe("values", () => {
  const sel = def({ name: "tier", label: "Tier", field_type: "single_select", options: [{ value: "gold", label: "Gold" }, { value: "silver", label: "Silver" }] });
  const multi = def({ name: "uses", label: "Uses", field_type: "multi_select", options: [{ value: "equipment", label: "Equipment" }, { value: "payroll", label: "Payroll" }] });

  it("accepts each type in its loose forms and stores a clean value", () => {
    expect(validateValue(def({ field_type: "text" }), "  hello \n world ")).toEqual({ ok: true, value: "hello world" });
    expect(validateValue(def({ field_type: "long_text" }), "a\nb")).toEqual({ ok: true, value: "a\nb" });
    expect(validateValue(def({ field_type: "number" }), "1,234.5")).toEqual({ ok: true, value: 1234.5 });
    expect(validateValue(def({ field_type: "money" }), "$1,200.456")).toEqual({ ok: true, value: 1200.46 });
    expect(validateValue(def({ field_type: "date" }), "3/14/2026")).toEqual({ ok: true, value: "2026-03-14" });
    expect(validateValue(def({ field_type: "date" }), "2026-02-30").ok).toBe(false);
    expect(validateValue(def({ field_type: "checkbox" }), "Yes")).toEqual({ ok: true, value: true });
    expect(validateValue(def({ field_type: "checkbox" }), false)).toEqual({ ok: true, value: false });
    expect(validateValue(sel, "Gold")).toEqual({ ok: true, value: "gold" });
    expect(validateValue(sel, "Platinum").ok).toBe(false);
    expect(validateValue(multi, "Payroll; equipment;payroll")).toEqual({ ok: true, value: ["payroll", "equipment"] });
    expect(validateValue(multi, ["Payroll", "Boats"]).ok).toBe(false);
    expect(validateValue(def({ field_type: "url" }), "example.com/x")).toEqual({ ok: true, value: "https://example.com/x" });
    expect(validateValue(def({ field_type: "url" }), "javascript:alert(1)").ok).toBe(false);
    expect(validateValue(def({ field_type: "email" }), "Jo@Example.COM")).toEqual({ ok: true, value: "jo@example.com" });
    expect(validateValue(def({ field_type: "email" }), "nope").ok).toBe(false);
    expect(validateValue(def({ field_type: "phone" }), "(403) 555-0100")).toEqual({ ok: true, value: "(403) 555-0100" });
    expect(validateValue(def({ field_type: "phone" }), "12").ok).toBe(false);
    expect(validateValue(def({ field_type: "number" }), "")).toEqual({ ok: true, value: null });
  });

  it("checks a set: unknown and archived names, required fields, clearing", () => {
    const req = def({ name: "licence", label: "Licence", required: true });
    const old = def({ name: "old", label: "Old", archived_at: new Date() });
    const r1 = validateValues([req, old, sel], { tier: "Silver", nope: "x", old: "y" }, {}, { requireAll: true });
    expect(r1.changes).toEqual({ tier: "silver" });
    expect(r1.errors.map((e) => e.field).sort()).toEqual(["licence", "nope", "old"]);
    const r2 = validateValues([req], { licence: "" }, { licence: "AB-1" }, { requireAll: true });
    expect(r2.errors).toEqual([{ field: "licence", error: "Licence is required." }]);
    const r3 = validateValues([req], {}, { licence: "AB-1" }, { requireAll: true });
    expect(r3.errors).toEqual([]);
    expect(mergeValues({ a: 1, b: 2 }, { a: null, c: 3 })).toEqual({ b: 2, c: 3 });
  });

  it("shows option labels and Yes/No in exports", () => {
    expect(displayValue(multi, ["payroll", "equipment"])).toBe("Payroll; Equipment");
    expect(displayValue(def({ field_type: "checkbox" }), true)).toBe("Yes");
    expect(displayValue(sel, null)).toBe("");
  });
});

describe("list filters", () => {
  const defs = [
    def({ name: "tier", field_type: "single_select", options: [{ value: "gold", label: "Gold" }] }),
    def({ name: "fleet", field_type: "number" }),
    def({ name: "renews", field_type: "date" }),
    def({ name: "vip", field_type: "checkbox" }),
    def({ name: "notes", field_type: "text" }),
    def({ name: "uses", field_type: "multi_select", options: [{ value: "a", label: "A" }] }),
  ];

  it("turns cf_* parameters into parameterised SQL", () => {
    const params: unknown[] = ["BF"];
    const sql = customFieldFilters(defs, { cf_tier: "gold,silver", cf_fleet_min: "10", cf_fleet_max: "x", cf_renews_min: "2026-01-01", cf_vip: "true", cf_notes: "50%_off", cf_uses: "a", cf_other: "z" }, "c", params);
    expect(sql).toEqual([
      "(c.custom_fields->>'tier') = ANY($2::text[])",
      "(CASE WHEN jsonb_typeof(c.custom_fields->'fleet') = 'number' THEN (c.custom_fields->>'fleet')::numeric END) >= $3",
      "false",
      "(c.custom_fields->>'renews') >= $4",
      "(c.custom_fields->'vip') = 'true'::jsonb",
      "(c.custom_fields->>'notes') ILIKE $5",
      "(c.custom_fields->'uses') ?| $6::text[]",
    ]);
    expect(params).toEqual(["BF", ["gold", "silver"], 10, "2026-01-01", "%50\\%\\_off%", ["a"]]);
  });

  it("supports empty / any and refuses a bad alias", () => {
    const params: unknown[] = [];
    expect(customFieldFilters(defs, { cf_tier: "__empty__", cf_fleet: "__any__" }, "co", params)).toEqual([
      "NOT (co.custom_fields ? 'tier')", "(co.custom_fields ? 'fleet')",
    ]);
    expect(() => customFieldFilters(defs, {}, "c; drop", [])).toThrow();
    expect(customFieldSortExpr(defs, "cf_fleet", "c")).toContain("::numeric");
    expect(customFieldSortExpr(defs, "cf_missing", "c")).toBeNull();
  });
});

describe("importer custom columns (HubSpot custom properties)", () => {
  const defs = [
    def({ name: "broker_licence", label: "Broker Licence" }),
    def({ name: "fleet_size", label: "Fleet size", field_type: "number" }),
    def({ name: "gone", label: "Gone", archived_at: new Date() }),
  ];

  it("matches columns by label or internal name, never one already used", () => {
    const used = new Set(["Email"]);
    expect(matchCustomColumns(defs, ["Email", "Broker licence", "fleet_size", "Gone"], used)).toEqual({ "cf:broker_licence": "Broker licence", "cf:fleet_size": "fleet_size" });
  });

  it("validates row values and reports bad ones as row errors", () => {
    expect(customValuesOf(defs, { email: "a@b.co", "cf:broker_licence": "AB-1", "cf:fleet_size": "12", "cf:gone": "x" })).toEqual({ values: { broker_licence: "AB-1", fleet_size: 12 }, errors: [] });
    expect(customValuesOf(defs, { "cf:fleet_size": "lots" }).errors).toEqual([{ field: "cf:fleet_size", message: "Fleet size: enter a number." }]);
  });

  it("allows cf: keys only for this record type's active fields", () => {
    const keys = new Set(["cf:broker_licence"]);
    expect(mappingProblems("contacts", { email: "Email", "cf:broker_licence": "B" }, keys)).toEqual([]);
    expect(mappingProblems("contacts", { email: "Email", "cf:gone": "G" }, keys)[0]).toMatch(/not a custom field/);
    expect(unknownCustomKeys(defs, { "cf:gone": "G", "cf:fleet_size": "F", email: "E" })).toEqual(["cf:gone"]);
  });

  it("guesses a type for a column it creates a field from", () => {
    expect(guessFieldType(["12", "1,400", ""])).toBe("number");
    expect(guessFieldType(["$1,200.00", "$3"])).toBe("money");
    expect(guessFieldType(["Yes", "no"])).toBe("checkbox");
    expect(guessFieldType(["2026-01-02", "3/4/2025"])).toBe("date");
    expect(guessFieldType(["a@b.co"])).toBe("email");
    expect(guessFieldType(["example.com", "https://x.io/a"])).toBe("url");
    expect(guessFieldType(["Gold", "Silver"])).toBe("text");
    expect(guessFieldType([])).toBe("text");
  });
});
