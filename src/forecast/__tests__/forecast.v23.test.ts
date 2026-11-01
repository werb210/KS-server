// KS_SERVER_v23_FORECAST - periods, categories and the roll-up maths.
import { describe, expect, it } from "vitest";
import { buildPeriods, categoryFor, computeForecast, monthsIn, sumBuckets, DEFAULT_PROBABILITIES } from "../forecast.js";

describe("periods", () => {
  it("months and quarters, across a year end", () => {
    expect(buildPeriods("month", "2026-11", 3).map((p) => [p.key, p.label, p.start, p.end])).toEqual([
      ["2026-11", "Nov 2026", "2026-11-01", "2026-12-01"], ["2026-12", "Dec 2026", "2026-12-01", "2027-01-01"], ["2027-01", "Jan 2027", "2027-01-01", "2027-02-01"],
    ]);
    const q = buildPeriods("quarter", "2026-11", 2);
    expect(q.map((p) => [p.key, p.start, p.end])).toEqual([["2026-Q4", "2026-10-01", "2027-01-01"], ["2027-Q1", "2027-01-01", "2027-04-01"]]);
    expect(monthsIn(q[0]!)).toEqual(["2026-10-01", "2026-11-01", "2026-12-01"]);
  });

  it("category: staff choice wins, else from the stage's chance", () => {
    expect(categoryFor(85, null)).toBe("commit");
    expect(categoryFor(40, null)).toBe("best_case");
    expect(categoryFor(10, null)).toBe("pipeline");
    expect(categoryFor(10, "commit")).toBe("commit");
    expect(categoryFor(85, "omit")).toBe("omit");
    expect(categoryFor(85, "bogus")).toBe("commit");
  });
});

describe("the forecast roll-up", () => {
  const periods = buildPeriods("month", "2026-11", 2);
  const r = computeForecast({
    periods, today: "2026-11-10", probabilities: DEFAULT_PROBABILITIES,
    closed: [{ owner: "u1", day: "2026-11-03", commission: 2000, amount: 100000 }, { owner: "u1", day: "2026-10-30", commission: 999, amount: 1 }],
    open: [
      { id: "a", name: "A", owner: "u1", stage: "Accepted", close: "2026-11-20", category_override: null, commission: 1000, amount: 50000 }, // commit 85%
      { id: "b", name: "B", owner: "u1", stage: "Off to Lender", close: "2026-11-25", category_override: null, commission: 1000, amount: 50000 }, // best case 40%
      { id: "c", name: "C", owner: "u1", stage: "Received", close: "2026-12-05", category_override: null, commission: 1000, amount: 50000 }, // pipeline 10%
      { id: "d", name: "D", owner: "u2", stage: "Offer", close: "2026-10-15", category_override: null, commission: 500, amount: 1 }, // overdue -> Nov
      { id: "e", name: "E", owner: "u2", stage: "Offer", close: null, category_override: null, commission: 700, amount: 1 }, // not scheduled
      { id: "f", name: "F", owner: "u2", stage: "Offer", close: "2026-11-15", category_override: "omit", commission: 900, amount: 1 }, // left out
      { id: "g", name: "G", owner: "u3", stage: "Signed LOI", close: "2026-12-10", category_override: null, commission: 1000, amount: 1, probability: 50 }, // custom pipeline stage
    ],
    goals: [{ user_id: "u1", month: "2026-11-01", commission: 5000, funding: 250000 }],
  });
  const u1 = r.byOwner.find((o) => o.owner === "u1")!;
  const u2 = r.byOwner.find((o) => o.owner === "u2")!;

  it("each category includes the ones before it", () => {
    expect(u1.periods[0]).toMatchObject({ closed: 2000, commit: 3000, best_case: 4000, pipeline: 4000, weighted: 2000 + 850 + 400, closed_amount: 100000, files: 2, goal_commission: 5000, goal_funding: 250000 });
    expect(u1.periods[1]).toMatchObject({ closed: 0, commit: 0, best_case: 0, pipeline: 1000, weighted: 100, goal_commission: null });
  });

  it("overdue counts now; no date is not scheduled; omit is left out but still listed", () => {
    expect(u2.periods[0]).toMatchObject({ commit: 500, pipeline: 500, weighted: 350, files: 1 });
    expect(r.overdue).toBe(1);
    expect(r.unscheduled).toEqual({ files: 1, pipeline: 700, weighted: 490 });
    expect(r.deals.find((d) => d.id === "f")).toMatchObject({ category: "omit" });
    expect(r.deals.find((d) => d.id === "d")).toMatchObject({ overdue: true, period: "2026-11" });
  });

  it("a custom pipeline stage uses its own chance", () => {
    expect(r.deals.find((d) => d.id === "g")).toMatchObject({ probability: 50, category: "best_case", weighted: 500 });
    expect(r.byOwner.find((o) => o.owner === "u3")!.periods[1]).toMatchObject({ best_case: 1000, weighted: 500 });
  });

  it("sums for teams and totals", () => {
    const t = sumBuckets([u1.periods[0]!, u2.periods[0]!]);
    expect(t).toMatchObject({ closed: 2000, commit: 3500, pipeline: 4500, goal_commission: 5000 });
  });
});
