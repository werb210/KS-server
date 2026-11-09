// BF_SERVER_REPORTS15_18_v786
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { bootIndex } from "./helpers/bootIndex.js";

const sqls: string[] = [];
vi.mock("../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: async (sql: string) => { sqls.push(sql); return { rows: [], rowCount: 0 }; } } }));
import { customReport, CUSTOM } from "../services/reports/data8.js";
import { DATA } from "../services/reports/data.js";
import { reportByKey } from "../services/reports/catalog.js";

describe("reports 15-18", () => {
  it("are registered", () => {
    for (const k of ["pipeline_snapshot", "issues_report", "custom_report"]) expect(typeof (DATA as any)[k], k).toBe("function");
    expect(reportByKey("bi_insurance")).toBeUndefined(); // KS_SERVER_v1_NO_BI - no insurance reports in Keystone
  });
  it("the custom builder only runs groupings and measures from its fixed menu", async () => {
    const bad = await customReport({ entity: "applications", groupBy: "id; DROP TABLE applications", measure: "count" });
    expect(bad.error).toBe("unknown_grouping_or_measure");
    // KS_SERVER_CUSTOM_EVERYWHERE_v1 - only the property-definition lookups ran; no report query, nothing injected.
    expect(sqls.filter((q) => !q.includes("custom_field_definitions"))).toHaveLength(0);
    expect(sqls.join("\n")).not.toContain("DROP TABLE");
    const unknown = await customReport({ entity: "users" });
    expect(unknown.error).toBe("unknown_record_type");
    sqls.length = 0;
    await customReport({ entity: "tasks", groupBy: "assignee", measure: "overdue", days: 30 });
    const run = sqls.filter((q) => !q.includes("custom_field_definitions"));
    expect(run[0]).toContain(CUSTOM.tasks!.measures.overdue);
    expect(run[0]).toContain("t.deleted_at IS NULL");
  });
  it("groups by one of the brokerage's own properties, passing its name as a parameter", async () => {
    const params: unknown[][] = [];
    sqls.length = 0;
    const { pool } = await import("../db.js");
    const orig = (pool as any).query;
    (pool as any).query = async (sql: string, p: unknown[] = []) => {
      sqls.push(sql); params.push(p);
      if (sql.includes("custom_field_definitions")) return { rows: [{ id: "1", object_type: "application", name: "equipment_type", label: "Equipment type", field_type: "single_select", options: [], required: false, sort_order: 0, archived_at: null }] };
      return { rows: [{ label: "Excavator", value: 3 }] };
    };
    try {
      const r: any = await customReport({ entity: "applications", groupBy: "cf:equipment_type", measure: "count" });
      expect(r.rows).toEqual([{ label: "Excavator", value: 3 }]);
      const i = sqls.findIndex((q) => q.includes("GROUP BY 1"));
      expect(sqls[i]).toContain("custom_fields->>$2");
      expect(params[i]).toContain("equipment_type");
      expect((await customReport({ entity: "applications", groupBy: "cf:not_a_property" })).error).toBe("unknown_grouping_or_measure");
    } finally { (pool as any).query = orig; }
  });
  it("snapshots are taken hourly by a background worker that starts in the staggered sequence", async () => {
    const boot = await bootIndex({ env: { WORKER_STAGGER_MS: "1500" } });
    try {
      await boot.workersDone();
      expect(boot.workerCalls.get("startPipelineSnapshotWorker")).toEqual([[boot.pool]]);
      const ev = boot.events;
      const at = ev.indexOf("start:startPipelineSnapshotWorker");
      expect(at).toBeGreaterThan(ev.indexOf("listen")); // background, after the server is up
      const prev = ev.slice(0, at).map((e, i) => (e.startsWith("start:") ? i : -1)).filter((i) => i >= 0).pop()!;
      expect(ev.slice(prev, at)).toContain("timeout:1500"); // paused before it like every other worker
    } finally { boot.restore(); }
    expect(readFileSync("migrations/2026_10_08_v786_pipeline_snapshots.sql", "utf8")).toContain("CREATE TABLE IF NOT EXISTS pipeline_snapshots");
  });
});
