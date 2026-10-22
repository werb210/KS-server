// KS_SERVER_v6_PLANS_STORAGE - pooled document storage: what is stored, and how many seats share it.
//
// Counted (every place this server records a stored file's size in bytes):
//   documents.size_bytes            application documents uploaded by clients and staff
//   contact_documents.size_bytes    files kept on CRM contacts
//   collateral_assets.size_bytes    the marketing / collateral library
//   application_packages.size_bytes lender packages built from an application's documents
// Not counted: call recordings and voicemails (only their duration is recorded, not their size), lender_documents
// (no size column), and lender_package_links (a download link to a package already counted above).
import type { Q } from "./state.js";

export const STORAGE_USED_SQL = `SELECT
  COALESCE((SELECT SUM(size_bytes) FROM documents WHERE size_bytes > 0), 0)::bigint
  + COALESCE((SELECT SUM(size_bytes) FROM contact_documents WHERE size_bytes > 0), 0)::bigint
  + COALESCE((SELECT SUM(size_bytes) FROM collateral_assets WHERE size_bytes > 0), 0)::bigint
  + COALESCE((SELECT SUM(size_bytes) FROM application_packages WHERE size_bytes > 0), 0)::bigint AS used_bytes`;

/** A seat is an active, not deleted Admin or Staff user. */
export const ACTIVE_STAFF_WHERE = `role IN ('Admin', 'Staff') AND active = true AND COALESCE(is_active, true) = true
   AND COALESCE(disabled, false) = false AND deleted_at IS NULL AND COALESCE(status, 'ACTIVE') = 'ACTIVE'`;

export const SEATS_SQL = `SELECT COUNT(*)::int AS seats FROM users WHERE ${ACTIVE_STAFF_WHERE}`;

export async function storageUsedBytes(db: Q): Promise<number> {
  const r = await db.query(STORAGE_USED_SQL);
  return Number(r.rows[0]?.used_bytes ?? 0) || 0;
}

/** At least 1. */
export async function seatCount(db: Q): Promise<number> {
  const r = await db.query(SEATS_SQL);
  return Math.max(1, Number(r.rows[0]?.seats ?? 0) || 0);
}

/** The emails of the active Admin users. */
export async function adminEmails(db: Q): Promise<string[]> {
  const r = await db.query(
    `SELECT email FROM users WHERE role = 'Admin' AND ${ACTIVE_STAFF_WHERE} AND email IS NOT NULL ORDER BY email`,
  );
  return r.rows.map((x: any) => String(x.email ?? "").trim()).filter((e: string) => e.includes("@"));
}
