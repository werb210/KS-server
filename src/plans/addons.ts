// KS_SERVER_BANK_CONNECT_ADDON - per-licensee add-ons that are NOT plan features.
//
// An add-on is switched on for one licensee by Keystone operations (KS-Ops pushes { addons } with PUT /api/plan).
// It is never listed in the plan catalogue, never shown as locked and never offered as an upgrade: while it is off the
// capability does not exist on this copy (its routes answer 404, its steps, labels and fraud check are left out).
//
//   bank_connect  the applicant "Connect Bank (View-Only)" step (Flinks), the staff request item, fraud check 3
//                 (uploaded statement vs live bank data) and the FLINKS_* provider. Default off.
import type { PlanState } from "./catalogue.js";

export const ADDONS = ["bank_connect"] as const;
export type AddonKey = (typeof ADDONS)[number];
export type Addons = Partial<Record<AddonKey, boolean>>;

/** Fraud checks that belong to an add-on instead of a plan. */
export const ADDON_FRAUD_CHECKS: Readonly<Record<string, AddonKey>> = { fraud_3: "bank_connect" };

export function isAddon(v: unknown): v is AddonKey {
  return typeof v === "string" && (ADDONS as readonly string[]).includes(v);
}

/** The stored jsonb (or anything else) as { addon: true } for the add-ons that are on. Unknown keys are dropped. */
export function normaliseAddons(raw: unknown): Addons {
  let v: unknown = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { v = null; }
  }
  const out: Addons = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const key of ADDONS) if ((v as Record<string, unknown>)[key] === true) out[key] = true;
  return out;
}

/** Validates the { addons } body of PUT /api/plan: an object of known add-on keys with boolean values. */
export function parseAddonPatch(raw: unknown): { ok: true; value: Partial<Record<AddonKey, boolean>> | undefined } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const value: Partial<Record<AddonKey, boolean>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isAddon(k) || typeof v !== "boolean") return { ok: false };
    value[k] = v;
  }
  return { ok: true, value: Object.keys(value).length ? value : undefined };
}

export function hasAddon(state: Pick<PlanState, "addons"> | null | undefined, key: AddonKey): boolean {
  return state?.addons?.[key] === true;
}

/** The applicant task keys that belong to bank connect ("flinks" is the historical cta_action). */
export function isBankConnectTask(cta: unknown): boolean {
  let k = String(cta ?? "").trim().toLowerCase();
  if (k.startsWith("form:")) k = k.slice(5);
  return k === "flinks";
}
