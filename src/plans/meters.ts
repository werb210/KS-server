// KS_SERVER_MARKETING_ADDON - the usage meters added with the Marketing add-on and the e-signing allowance, recorded in
// usage_events (kind, ref, quantity; unique per kind and ref, so recording the same thing twice counts it once):
//   campaign_email   one marketing email sent to one person
//   marketing_text   one marketing text sent (it is also a 'text' in the plan's texts; the add-on's bonus covers it)
//   signing          one signature request sent to one signer (SignNow), whatever the document
// Recording never throws: the email, text or signing request has already gone, so a failed insert is logged and the
// work goes on. Nothing here ever blocks a signing.
import { randomUUID } from "node:crypto";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import type { Q } from "./state.js";

export const METER_KINDS = ["campaign_email", "marketing_text", "signing"] as const;
export type MeterKind = (typeof METER_KINDS)[number];

export async function recordMeter(db: Q, kind: MeterKind, ref: string | null | undefined, quantity = 1): Promise<boolean> {
  try {
    const r = String(ref ?? "").trim() || randomUUID();
    const q = Math.max(1, Math.floor(Number(quantity) || 1));
    const res = await db.query(
      `INSERT INTO usage_events (kind, ref, quantity) VALUES ($1, $2, $3) ON CONFLICT (kind, ref) DO NOTHING`,
      [kind, r.slice(0, 300), q],
    );
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    logWarnSwallowed(err, `plans/meters.ts:recordMeter:${kind}`);
    return false;
  }
}

/** recordMeter against the server's pool (loaded lazily, so senders need not import the database). */
export async function meter(kind: MeterKind, ref: string | null | undefined, quantity = 1): Promise<boolean> {
  try {
    const { pool } = await import("../db.js");
    return await recordMeter(pool as unknown as Q, kind, ref, quantity);
  } catch (err) {
    logWarnSwallowed(err, `plans/meters.ts:meter:${kind}`);
    return false;
  }
}

export type SigningRequest = { document: string; email: string; role?: string | null };

/**
 * One signing per signer of a signature request. The ref is the SignNow document or document group, the signer's
 * email and their role, so a new link or a re-sent invite for the same signer on the same documents is not counted
 * again, while two owners who share an inbox (two roles) are two signings.
 */
export function signingRefs(requests: SigningRequest[]): string[] {
  const out = new Set<string>();
  for (const r of requests) {
    const doc = String(r.document ?? "").trim();
    const email = String(r.email ?? "").trim().toLowerCase();
    if (!doc || !email) continue;
    out.add(`${doc}:${email}:${String(r.role ?? "").trim().toLowerCase()}`);
  }
  return [...out];
}

/** Counts the signings of a signature request that SignNow accepted. Never throws, never blocks. */
export async function countSignings(requests: SigningRequest[]): Promise<number> {
  let n = 0;
  for (const ref of signingRefs(requests)) if (await meter("signing", ref)) n += 1;
  return n;
}
