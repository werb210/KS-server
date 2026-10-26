// KS_SERVER_v18_CRM_UNIFY - merges and Keystone's retention rules (src/retention, KS_SERVER_v14_RETENTION).
//   legal hold  A contact or company under a legal hold (on itself, or on its company) is never merged away: its
//               hold would stop covering the records that moved off it, and the record would be deleted. Staff can
//               merge the other record INTO the held one instead, or an admin releases the hold first.
//   retention   A contact linked to files kept on record is merged by MOVING everything to the survivor; the old
//               record is then kept archived (merged_into_id points at the survivor) instead of being deleted.
//               A company's links all move to the survivor; if anything kept on record would still point at the old
//               company afterwards, the merge is refused rather than deleting it.
//   kept tables Rows of the tables that hold kept records are never dropped to make room in a merge (the generic
//               "drop the loser's colliding row" step skips them).
import { pool } from "../../db.js";
import { retentionFor } from "../../retention/retention.js";
import type { Q } from "./tags.js";

/** Tables whose rows are records under the 7-year rule (or the hold/audit trail itself). */
export const RETAINED_TABLES: ReadonlySet<string> = new Set([
  "applications", "documents", "application_packages", "audit_events", "legal_holds", "application_stage_history",
]);

export function isRetainedTable(table: string): boolean {
  return RETAINED_TABLES.has(String(table ?? "").toLowerCase());
}

export type HeldRecord = { id: string; message: string | null };
export type MergeGuard = { held: HeldRecord[]; retained: string[] };

/** Which of the records to be merged away are held (refuse) and which are linked to kept files (keep archived). */
export async function mergeRetentionGuard(entity: "contact" | "company", loserIds: string[], db: Q = pool as unknown as Q): Promise<MergeGuard> {
  const held: HeldRecord[] = [];
  const retained: string[] = [];
  for (const id of loserIds) {
    const s = await retentionFor(entity, id, db as any);
    if (!s?.locked) continue;
    if (s.reason === "hold") held.push({ id, message: s.message ?? null });
    else retained.push(id);
  }
  return { held, retained };
}

export function heldMergeBody(entity: "contact" | "company", held: HeldRecord[]) {
  const noun = entity === "contact" ? "contact" : "company";
  return {
    ok: false,
    code: "legal_hold",
    error: "legal_hold",
    message: `This ${noun} is under a legal hold, so it cannot be merged into another record. Merge the other record into it instead, or ask an admin to release the hold first.`,
    held,
  };
}
