// BF_SERVER_REPORTS15_18_v786 - refresh today's pipeline snapshot every hour (and once at start).
import type { Pool } from "pg";
import { serialAcrossTenants } from "../tenancy/jobs.js"; // KS_SHARED_HOSTING_v1 - one brokerage at a time

export function startPipelineSnapshotWorker(_pool: Pool, everyMs = 60 * 60 * 1000): { stop: () => void } {
  const run = async () => {
    try {
      const { takePipelineSnapshot } = await import("../services/reports/data8.js");
      const n = await takePipelineSnapshot();
      console.info("[pipeline-snapshot] stored", { stages: n });
    } catch (err: unknown) {
      console.warn("[pipeline-snapshot] failed", err instanceof Error ? err.message : String(err));
    }
  };
  void serialAcrossTenants("pipeline_snapshot", run);
  const t = setInterval(() => { void serialAcrossTenants("pipeline_snapshot", run); }, everyMs);
  t.unref();
  return { stop: () => clearInterval(t) };
}
