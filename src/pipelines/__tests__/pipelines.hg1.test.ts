// KS_HUBSPOT_GAPS_1_PIPELINES - extra pipelines and custom stages (Growth 3 pipelines in all, Pro unlimited).
import { describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { planIncludes } from "../../plans/catalogue.js";
import { PIPELINE_STATES } from "../../modules/applications/pipelineState.js";
import { canAddPipeline, lendingPipeline, moveApplication, normalizeLendingProbabilities, validatePipeline, weighted, writeStages } from "../pipelines.js";

describe("plans and limits", () => {
  it("is Growth and up; Growth has 3 pipelines in all (Lending and 2 more), Pro unlimited", () => {
    expect(planIncludes("starter", "custom_pipelines")).toBe(false);
    expect(planIncludes("growth", "custom_pipelines")).toBe(true);
    expect([0, 1, 2].map((n) => canAddPipeline("growth", n))).toEqual([true, true, false]);
    expect(canAddPipeline("pro", 50)).toBe(true);
    expect(canAddPipeline("starter", 0)).toBe(false);
  });
});

describe("the lending pipeline", () => {
  it("keeps every system stage, locked, in order", async () => {
    const p = await lendingPipeline({ query: vi.fn(answerBySql([])) });
    expect(p).toMatchObject({ id: "lending", system: true });
    expect(p.stages.map((s) => s.name)).toEqual(PIPELINE_STATES);
    expect(p.stages.every((s) => s.locked)).toBe(true);
    expect(p.stages.find((s) => s.name === "Accepted")).toMatchObject({ outcome: "won", probability: 100 });
    expect(p.stages.find((s) => s.name === "Rejected")).toMatchObject({ outcome: "lost" });
  });

  it("only its probabilities can be set (0 to 100)", () => {
    expect(normalizeLendingProbabilities({ Received: 15, Offer: 900, Bogus: 5 })).toMatchObject({ Received: 15, Offer: 75 });
    expect(Object.keys(normalizeLendingProbabilities({}))).toEqual(PIPELINE_STATES);
  });
});

describe("extra pipelines", () => {
  it("checks the name and stages", () => {
    const bad = validatePipeline({ name: "Lending", stages: [{ name: "A", probability: 120 }, { name: "a" }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["name", "stages.0.probability", "stages.1.name"]);
    expect(validatePipeline({ name: "Renewals", stages: [{ name: "Won", outcome: "won" }, { name: "Lost", outcome: "lost" }] }).ok).toBe(false);
    const ok = validatePipeline({ name: "Renewals", stages: [{ name: "Due soon", color: "#0F766E", probability: 20 }, { name: "Renewed", outcome: "won", probability: 100 }] });
    expect(ok).toEqual({ ok: true, name: "Renewals", stages: [
      { id: null, name: "Due soon", color: "#0f766e", probability: 20, outcome: "open" },
      { id: null, name: "Renewed", color: "#1d4ed8", probability: 100, outcome: "won" },
    ] });
  });

  it("never removes a stage that still has deals", async () => {
    const q = vi.fn(answerBySql([[/FROM pipeline_stages s WHERE s.pipeline_id = \$1::uuid/, { rows: [{ id: "11111111-1111-4111-8111-111111111111", name: "Due soon", deals: 3 }] }]]));
    const r = await writeStages({ query: q }, "p1", [{ id: null, name: "New", color: "#1d4ed8", probability: 0, outcome: "open" }]);
    expect(r).toEqual({ ok: false, error: `Move the deals out of "Due soon" (3) before removing that stage.` });
    expect(callsMatching(q, /UPDATE pipeline_stages|INSERT INTO pipeline_stages/)).toHaveLength(0);
  });

  it("moving back to lending keeps the deal's lending stage", async () => {
    const q = vi.fn(answerBySql([[/FROM applications a LEFT JOIN pipeline_stages/, { rows: [{ id: "a1", pipeline_id: "22222222-2222-4222-8222-222222222222", pipeline_state: "Offer", stage_name: "Due soon" }] }]]));
    expect(await moveApplication({ query: q }, "a1", "lending", null, null)).toEqual({ ok: true, pipeline_id: "lending", stage: "Offer" });
    expect(String(callsMatching(q, /UPDATE applications/)[0]![0])).toContain("pipeline_id = NULL");
    const [, p] = callsMatching(q, /INSERT INTO pipeline_moves/)[0]!;
    expect(p).toEqual(["a1", "22222222-2222-4222-8222-222222222222", "Due soon", "Offer", null]);
  });

  it("weights amounts by probability", () => {
    expect(weighted(100000, 25)).toBe(25000);
  });
});
