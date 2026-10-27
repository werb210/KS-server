// KS_HUBSPOT_GAPS_1_CALL_SCRIPTS - call scripts (playbooks), Growth and Pro.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js";
import { planIncludes } from "../../plans/catalogue.js";
import { clearCustomFieldCache } from "../../customFields/service.js";
import { cleanAnswers, missingRequired, starterScripts, summaryText, validateScript, applyMappings, type Section } from "../scripts.js";

const defRow = (object: string, name: string, field_type: string, extra: Record<string, unknown> = {}) => ({
  id: `${object}-${name}`, object_type: object, name, label: name, field_type, options: [], required: false, group_name: null, description: null,
  sort_order: 0, archived_at: null, created_at: new Date(), updated_at: new Date(), ...extra,
});

function db(values: Record<string, unknown> = {}) {
  return {
    query: vi.fn(answerBySql([
      [/FROM custom_field_definitions WHERE object_type = \$1/, (_s: string, p?: unknown[]) => ({
        rows: p?.[0] === "contact" ? [defRow("contact", "credit_band", "single_select", { options: [{ value: "good", label: "Good" }, { value: "fair", label: "Fair" }] })]
          : [defRow("application", "monthly_revenue", "money")],
      })],
      [/SELECT custom_fields FROM/, { rows: [{ custom_fields: values }] }],
      [/UPDATE (contacts|applications) SET custom_fields/, (_s: string, p?: unknown[]) => ({ rows: [{ custom_fields: { ...values, ...JSON.parse(String(p?.[2])) } }] })],
    ])),
  };
}

const sections: Section[] = [
  { id: "s1", title: "The business", body: "", questions: [
    { id: "rev", label: "Average monthly revenue", type: "money", options: [], required: true, help: "", maps_to: { object: "application", field: "monthly_revenue" } },
    { id: "profit", label: "Profitable last year?", type: "yes_no", options: [], required: false, help: "", maps_to: null },
    { id: "credit", label: "Credit", type: "single_select", options: ["Good", "Fair", "Poor"], required: false, help: "", maps_to: { object: "contact", field: "credit_band" } },
    { id: "uses", label: "Uses", type: "multi_select", options: ["Payroll", "Inventory"], required: false, help: "", maps_to: null },
  ] },
];

beforeEach(() => clearCustomFieldCache());

describe("call scripts", () => {
  it("is a Growth and Pro feature", () => {
    expect(planIncludes("starter", "call_scripts")).toBe(false);
    expect(planIncludes("growth", "call_scripts")).toBe(true);
  });

  it("checks names, sections, questions, choices and custom field mappings", async () => {
    const bad = await validateScript(db() as any, { name: "", sections: [{ title: "", questions: [{ label: "", type: "single_select", options: ["Only one"] }, { label: "Revenue", type: "money", maps_to: { object: "application", field: "nope" } }] }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["name", "sections.0.questions.0.label", "sections.0.questions.0.options", "sections.0.questions.1.maps_to", "sections.0.title"]);
    const good = await validateScript(db() as any, { name: "Intake", use_for: "calls", sections: [{ title: "Opening", body: "Say hello", questions: [{ label: "Revenue", type: "money", maps_to: { object: "application", field: "monthly_revenue" } }] }] });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.value.sections[0]!.questions[0]).toMatchObject({ label: "Revenue", type: "money", maps_to: { object: "application", field: "monthly_revenue" } });
  });

  it("starter intake scripts are valid as they come", async () => {
    const starters = starterScripts();
    expect(starters.map((s) => s.name)).toEqual(["Intake - term loan", "Intake - line of credit", "Intake - equipment"]);
    for (const s of starters) expect((await validateScript(db() as any, s)).ok).toBe(true);
    expect(JSON.stringify(starters)).not.toMatch(/587.?888.?1837/);
  });

  it("keeps only answers to the script's questions, typed", () => {
    const a = cleanAnswers(sections, { rev: "$12,500", profit: "yes", credit: "Good", uses: ["Payroll", "Bitcoin"], other: "x", blank: "" });
    expect(a).toEqual({ rev: 12500, profit: true, credit: "Good", uses: ["Payroll"] });
    expect(missingRequired(sections, {})).toEqual(["Average monthly revenue"]);
    expect(summaryText(sections, a)).toBe("The business\nAverage monthly revenue: $12,500.00\nProfitable last year?: Yes\nCredit: Good\nUses: Payroll");
  });

  it("writes mapped answers to custom fields one by one and reports what could not be saved", async () => {
    const d = db();
    const r = await applyMappings(d as any, sections, { rev: 12500, credit: "Poor" }, { contactId: "c1", applicationId: "a1" });
    expect(r.updates).toEqual([{ object: "application", field: "monthly_revenue" }]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ object: "contact", field: "credit_band" });
    const none = await applyMappings(db() as any, sections, { rev: 1 }, { contactId: "c1", applicationId: null });
    expect(none.errors[0]!.error).toMatch(/no application/);
  });
});
