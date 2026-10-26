// KS_SERVER_TEXTING_REGISTRATION - what Keystone operations told this copy about its texting registration, and the
// Twilio address / bundle it registered, held in memory so the SMS senders (which are synchronous) can ask:
//   - may a text go to this US mobile now, and from which number?
//   - which address and bundle go with a number purchase?
// Loaded at startup and every 5 minutes on every instance, and straight away when KS-Ops pushes a change. A copy KS-Ops
// never pushed anything to (the development copy, a manual setup) keeps the old behaviour: nothing is held.
import type { Q } from "../plans/state.js";

export const REG_KINDS = ["toll_free", "a2p_10dlc"] as const;
export type RegKind = (typeof REG_KINDS)[number];
export const REG_STATUSES = ["needs_info", "submitted", "pending", "approved", "rejected", "not_needed"] as const;
export type RegStatus = (typeof REG_STATUSES)[number];
export type TextingReg = { kind: RegKind; status: RegStatus; phone_number: string | null; reason: string | null; message: string | null; updated_at?: string | null };

export type TextingSnapshot = {
  registrations: Partial<Record<RegKind, TextingReg>>;
  addressSid: string | null;
  bundleSid: string | null;
  loadedAt: number | null;
};

const empty = (): TextingSnapshot => ({ registrations: {}, addressSid: null, bundleSid: null, loadedAt: null });
let snapshot: TextingSnapshot = empty();

export function textingSnapshot(): TextingSnapshot {
  return snapshot;
}

/** Tests set the snapshot directly (null = nothing pushed). */
export function setTextingSnapshotForTests(s: Partial<TextingSnapshot> | null): void {
  snapshot = s ? { ...empty(), ...s, loadedAt: Date.now() } : empty();
}

/** True when KS-Ops manages this copy's texting registration (it pushed at least one status). */
export function textingManaged(s: TextingSnapshot = snapshot): boolean {
  return Object.keys(s.registrations).length > 0;
}

export async function loadTextingState(db: Q): Promise<TextingSnapshot> {
  try {
    const regs = await db.query(`SELECT kind, status, phone_number, reason, message, updated_at FROM texting_registrations`);
    const comp = await db.query(`SELECT address_sid, bundle_sid FROM twilio_compliance WHERE id = 1`);
    const registrations: TextingSnapshot["registrations"] = {};
    for (const r of regs.rows) {
      if ((REG_KINDS as readonly string[]).includes(r.kind)) {
        registrations[r.kind as RegKind] = { kind: r.kind, status: r.status, phone_number: r.phone_number ?? null, reason: r.reason ?? null, message: r.message ?? null, updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null };
      }
    }
    snapshot = { registrations, addressSid: comp.rows[0]?.address_sid ?? null, bundleSid: comp.rows[0]?.bundle_sid ?? null, loadedAt: Date.now() };
  } catch (err) {
    console.error("[texting] registration state not loaded; keeping the last one", { message: (err as Error)?.message ?? String(err) });
  }
  return snapshot;
}

const E164 = /^\+[1-9]\d{7,14}$/;

export type SaveResult = { ok: true; registrations: TextingReg[] } | { ok: false; error: string; message: string };

/** PUT /api/provision/texting body: { registrations: [{ kind, status, phone_number?, reason?, message? }] }. */
export async function saveTexting(db: Q, body: unknown, actor: string): Promise<SaveResult> {
  const list = (body as { registrations?: unknown })?.registrations;
  if (!Array.isArray(list) || !list.length || list.length > 2) return { ok: false, error: "invalid_registrations", message: "Send 1 or 2 registrations." };
  const clean: TextingReg[] = [];
  for (const raw of list as Array<Record<string, unknown>>) {
    const kind = String(raw?.kind ?? "");
    const status = String(raw?.status ?? "");
    if (!(REG_KINDS as readonly string[]).includes(kind)) return { ok: false, error: "invalid_kind", message: "kind must be toll_free or a2p_10dlc." };
    if (!(REG_STATUSES as readonly string[]).includes(status)) return { ok: false, error: "invalid_status", message: `Unknown status ${status.slice(0, 40)}.` };
    const phone = raw.phone_number == null || raw.phone_number === "" ? null : String(raw.phone_number);
    if (phone && !E164.test(phone)) return { ok: false, error: "invalid_phone_number", message: "phone_number must be in +1 format." };
    clean.push({
      kind: kind as RegKind, status: status as RegStatus, phone_number: phone,
      reason: raw.reason == null ? null : String(raw.reason).slice(0, 1000),
      message: raw.message == null ? null : String(raw.message).slice(0, 1000),
    });
  }
  for (const r of clean) {
    await db.query(
      `INSERT INTO texting_registrations (kind, status, phone_number, reason, message, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (kind) DO UPDATE SET status = EXCLUDED.status, phone_number = EXCLUDED.phone_number, reason = EXCLUDED.reason,
         message = EXCLUDED.message, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [r.kind, r.status, r.phone_number, r.reason, r.message, actor],
    );
  }
  await loadTextingState(db);
  console.log(`[texting] registration status from ${actor}: ${clean.map((r) => `${r.kind} ${r.status}`).join(", ")}`);
  return { ok: true, registrations: clean };
}

/** The address and bundle KS-Ops registered (sent with POST /api/provision/phone-numbers). */
export async function saveCompliance(db: Q, input: { address_sid?: unknown; bundle_sid?: unknown }, actor: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const address = input.address_sid == null || input.address_sid === "" ? null : String(input.address_sid);
  const bundle = input.bundle_sid == null || input.bundle_sid === "" ? null : String(input.bundle_sid);
  if (address && !/^AD[0-9a-fA-F]{32}$/.test(address)) return { ok: false, error: "invalid_address_sid" };
  if (bundle && !/^BU[0-9a-fA-F]{32}$/.test(bundle)) return { ok: false, error: "invalid_bundle_sid" };
  if (!address && !bundle) return { ok: true };
  await db.query(
    `INSERT INTO twilio_compliance (id, address_sid, bundle_sid, updated_by, updated_at) VALUES (1, $1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE SET address_sid = COALESCE(EXCLUDED.address_sid, twilio_compliance.address_sid),
       bundle_sid = COALESCE(EXCLUDED.bundle_sid, twilio_compliance.bundle_sid), updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [address, bundle, actor],
  );
  await loadTextingState(db);
  return { ok: true };
}

/** The address / bundle for purchases: the App Service setting wins, then what KS-Ops registered. */
export function addressSidFor(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.TWILIO_ADDRESS_SID ?? "").trim() || snapshot.addressSid || "";
}
export function bundleSidFor(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.TWILIO_BUNDLE_SID ?? "").trim() || snapshot.bundleSid || "";
}

export const CARRIER_TIME = "usually 3-10 business days";

/** The plain sentences Settings > Phone lines shows about texting. */
export function textingMessages(s: TextingSnapshot = snapshot): string[] {
  if (!textingManaged(s)) {
    return ["Texting from a toll-free number needs toll-free verification, and texting US numbers from a local line needs A2P 10DLC registration. Keystone support sets these up. Calls work straight away."];
  }
  const out: string[] = [];
  for (const kind of REG_KINDS) {
    const r = s.registrations[kind];
    if (!r) continue;
    if (r.message) out.push(r.message);
    else if (r.status === "approved") out.push(kind === "toll_free" ? `Texting from your toll-free line ${r.phone_number ?? ""} is approved.`.replace("  ", " ") : "US texting from your business line is approved.");
    else if (r.status === "pending" || r.status === "submitted") out.push(`Texting approval pending with carriers (${CARRIER_TIME}).`);
    else if (r.reason) out.push(r.reason);
  }
  return out;
}

export function startTextingStateRefresher(db: Q, intervalMs = 5 * 60_000): { stop: () => void } {
  void loadTextingState(db);
  const t = setInterval(() => { void loadTextingState(db); }, intervalMs);
  t.unref?.();
  return { stop: () => clearInterval(t) };
}
