// KS_SERVER_CUSTOM_EVERYWHERE_v1
import { describe, expect, it } from "vitest";
import { cfKey, cfText, customFieldContext, flattenValues, parseCfKey } from "../everywhere.js";
import { evaluate, renderTokens } from "../../modules/automation/conditions.js";
import { ACTION_TYPES, TRIGGER_TYPES } from "../../modules/automation/graph.js";

describe("properties everywhere", () => {
  it("names properties <object>_cf_<name> and reads them back", () => {
    expect(cfKey("application", "equipment_type")).toBe("deal_cf_equipment_type");
    expect(parseCfKey("deal_cf_equipment_type")).toEqual({ object: "application", name: "equipment_type" });
    expect(parseCfKey("company_cf_naics")).toEqual({ object: "company", name: "naics" });
    expect(parseCfKey("deal_cf_bad name")).toBeNull();
    expect(parseCfKey("pipeline_state")).toBeNull();
  });

  it("flattens values, keeping lists as lists and dropping unsafe names", () => {
    expect(flattenValues("contact", { licence: "AB-123", regions: ["AB", "BC"], "bad key": 1 }))
      .toEqual({ contact_cf_licence: "AB-123", contact_cf_regions: ["AB", "BC"] });
    expect(cfText(["AB", "BC"])).toBe("AB, BC");
    expect(cfText("")).toBeNull();
  });

  it("works in workflow conditions and message tokens", () => {
    const ctx = { deal_cf_equipment_type: "Excavator", contact_cf_regions: ["AB", "BC"], deal_cf_fleet_size: 12 };
    expect(evaluate({ field: "deal_cf_equipment_type", op: "eq", value: "excavator" }, ctx)).toBe(true);
    expect(evaluate({ field: "contact_cf_regions", op: "in", value: ["BC"] }, ctx)).toBe(true);
    expect(evaluate({ field: "deal_cf_fleet_size", op: "gte", value: 10 }, ctx)).toBe(true);
    expect(renderTokens("Your {{deal_cf_equipment_type}} quote", ctx)).toBe("Your Excavator quote");
  });

  it("loads a deal's, contact's and company's values with the deal's pipeline", async () => {
    const q = { query: async (sql: string) => sql.includes("FROM applications")
      ? { rows: [{ custom_fields: { equipment_type: "Truck" }, contact_id: "c1", pipeline_name: "Renewals", stage_name: "Quoted" }] }
      : { rows: [{ custom_fields: { licence: "X1" }, company_fields: { naics: "484110" } }] } };
    expect(await customFieldContext(q, { applicationId: "a1" })).toEqual({
      deal_cf_equipment_type: "Truck", pipeline_name: "Renewals", pipeline_stage: "Quoted", contact_cf_licence: "X1", company_cf_naics: "484110",
    });
  });

  it("never lets a lookup failure stop a workflow", async () => {
    const q = { query: async () => { throw new Error("db down"); } };
    expect(await customFieldContext(q, { contactId: "c1" })).toEqual({});
  });

  it("adds the new triggers and actions", () => {
    expect(TRIGGER_TYPES).toEqual(expect.arrayContaining(["application.pipeline_stage_changed", "record.custom_field_changed"]));
    expect(ACTION_TYPES).toEqual(expect.arrayContaining(["set_custom_field", "move_pipeline_stage"]));
  });
});
