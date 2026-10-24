// KS_STAFF_DIRECTORY_v1 - tells Keystone operations (KS-Ops) who this brokerage's staff are, so the Keystone dialler
// and iPad portal can find the right server from a person's work email or mobile number (no company code).
//
// What is sent: the FULL list of active staff identifiers (Admin, Staff, Ops, Marketing; not lenders, referrers or
// clients) as hashes only:
//   SHA-256("ks-staff-directory:v1:" + kind + ":" + value)
//   kind "email": trimmed, lower-cased; kind "phone": North American, as +1 and ten digits
//   POST {KS_OPS_URL}/api/licensees/{KS_LICENSEE_ID}/staff-directory { entries: [{ kind, hash }] }
// The same function is in KS-Ops (src/staffDirectory.ts); both sides test the same fixed value.
//
// When: requestStaffDirectorySync() after a user is created, changed or removed (a few seconds later, so a burst of
// edits is one push), and every 15 minutes from the worker. A push happens only when the list changed since the last
// one from this instance, or six hours have passed. Each push replaces the whole list on KS-Ops, so a missed push, or
// a user changed outside the normal screens (an import, SQL), is corrected by the next tick.
import { createHash } from "node:crypto";
import { opsConfig, postToOps, type OpsFetch } from "../plans/opsLink.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export type StaffKind = "email" | "phone";
export type StaffEntry = { kind: StaffKind; hash: string };

const HASH_PREFIX = "ks-staff-directory:v1:";
export const STAFF_DIRECTORY_ROLES = ["Admin", "Staff", "Ops", "Marketing"];
export const REFRESH_MS = 6 * 60 * 60 * 1000;
export const NUDGE_DELAY_MS = 5_000;

export function normalizeStaffEmail(raw: unknown): string | null {
  const email = String(raw ?? "").trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function normalizeStaffPhone(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export function staffHash(kind: StaffKind, value: string): string {
  return createHash("sha256").update(`${HASH_PREFIX}${kind}:${value}`).digest("hex");
}

/** Hashes for every active staff member's email and phone numbers, sorted and without repeats. */
export async function collectStaffEntries(db: Q): Promise<StaffEntry[]> {
  const r = await db.query(
    `SELECT email, phone, phone_number
       FROM users
      WHERE role = ANY($1::text[])
        AND COALESCE(active, true) = true
        AND COALESCE(disabled, false) = false
        AND deleted_at IS NULL`,
    [STAFF_DIRECTORY_ROLES],
  );
  const out = new Map<string, StaffEntry>();
  for (const row of r.rows) {
    const email = normalizeStaffEmail(row.email);
    if (email) { const hash = staffHash("email", email); out.set(`email:${hash}`, { kind: "email", hash }); }
    for (const p of [row.phone_number, row.phone]) {
      const phone = normalizeStaffPhone(p);
      if (phone) { const hash = staffHash("phone", phone); out.set(`phone:${hash}`, { kind: "phone", hash }); }
    }
  }
  return [...out.values()].sort((a, b) => (a.kind + a.hash).localeCompare(b.kind + b.hash));
}

export function entriesDigest(entries: StaffEntry[]): string {
  return createHash("sha256").update(entries.map((e) => `${e.kind}:${e.hash}`).join("\n")).digest("hex");
}

// What this instance last sent (a restart sends once more; KS-Ops replaces the list, so that is harmless).
let last: { digest: string; at: number } | null = null;
export function resetStaffDirectoryState(): void {
  last = null;
}

export type SyncResult =
  | { pushed: true; count: number }
  | { pushed: false; reason: "ops_not_configured" | "unchanged" | "failed"; count?: number; error?: string };

export async function syncStaffDirectory(
  db: Q,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: OpsFetch; now?: number; force?: boolean } = {},
): Promise<SyncResult> {
  const env = opts.env ?? process.env;
  if (!opsConfig(env)) return { pushed: false, reason: "ops_not_configured" };
  const now = opts.now ?? Date.now();
  const entries = await collectStaffEntries(db);
  const digest = entriesDigest(entries);
  if (!opts.force && last && last.digest === digest && now - last.at < REFRESH_MS) {
    return { pushed: false, reason: "unchanged", count: entries.length };
  }
  const r = await postToOps("staff-directory", { entries }, { env, fetchImpl: opts.fetchImpl });
  if (!r.ok) {
    console.warn("[staff-directory] push to operations failed", { status: r.status, error: r.error });
    return { pushed: false, reason: "failed", count: entries.length, error: r.error };
  }
  last = { digest, at: now };
  return { pushed: true, count: entries.length };
}

let nudgeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A user was created, changed or removed: push the staff list a few seconds from now (several calls in a row make one
 * push). Never throws and never delays the request that called it.
 */
export function requestStaffDirectorySync(env: NodeJS.ProcessEnv = process.env): void {
  try {
    if (!opsConfig(env) || nudgeTimer) return;
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      void (async () => {
        try {
          const { pool } = await import("../db.js");
          await syncStaffDirectory(pool as unknown as Q, { env });
        } catch (err) {
          console.error("[staff-directory] sync after a user change failed:", (err as { message?: string })?.message ?? err);
        }
      })();
    }, NUDGE_DELAY_MS);
    nudgeTimer.unref?.();
  } catch (err) {
    console.error("[staff-directory] could not schedule a sync:", (err as { message?: string })?.message ?? err);
  }
}
