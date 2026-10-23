// KS_SERVER_v11_PGI - the referral lifecycle: record the client's PGI tick, send the referral to the partner,
// forward matching documents, keep status / checklist / messages in step, and tell the brokerage when the partner
// writes. Every function takes the database and its outside calls as arguments (tests pass fakes) and never throws
// to the caller that triggered it (a client submit, a document accept, the worker).
import { createHash, randomUUID } from "node:crypto";
import type { Q } from "../plans/state.js";
import { PGI_PARTNER_NAME } from "./partner.js";
import { getPartnerLink, partnerCall, type PartnerFetch, type PartnerLink } from "./link.js";
import {
  buildChecklist, documentsToForward, missingFields, partnerReferralBody, pgiInputFromApplication, PGI_SLOT_LABELS,
  type KsDocument, type PartnerDoc, type PgiInput,
} from "./checklist.js";

export const MAX_FORWARD_BYTES = 5 * 1024 * 1024; // the insurer's per-file limit
export const FINAL_STATUSES = ["policy_issued", "declined", "not_eligible"];
export const PGI_CTA_LABEL = "Complete PGI Application";

export type LoadFile = (doc: { id: string; application_id: string; category: string | null; storage_key: string | null; blob_name: string | null; storage_path: string | null }) => Promise<Buffer | null>;
export type Notify = (n: { userIds: string[]; applicationId: string; title: string; body: string; emailSubject: string; emailLines: string[] }) => Promise<void>;
export type Deps = { fetchImpl?: PartnerFetch; loadFile?: LoadFile; notify?: Notify; link?: PartnerLink | null };

export type ReferralRow = {
  id: string; application_id: string; status: string; partner_status: string | null; bi_application_id: string | null;
  bi_application_code: string | null; completion_url: string | null; referring_user_id: string | null; input: PgiInput;
  checklist: any; missing_count: number; unread_count: number; referral_fee_amount: string | null;
  referral_fee_currency: string | null; referral_fee_status: string | null; last_error: string | null;
  last_synced_at: string | null; created_at: string; updated_at: string;
};

async function defaultLoadFile(doc: Parameters<LoadFile>[0]): Promise<Buffer | null> {
  const m = await import("../fraud/documents.js");
  return m.defaultLoadFile(doc);
}

async function defaultNotify(n: Parameters<Notify>[0]): Promise<void> {
  const { createNotification } = await import("../modules/notifications/notifications.repo.js");
  for (const userId of n.userIds) {
    try {
      await createNotification({
        notificationId: randomUUID(), userId, applicationId: n.applicationId, type: "pgi_partner_update",
        title: n.title, body: n.body, metadata: { url: `/applications/${n.applicationId}/pgi` },
      });
    } catch (err) {
      console.warn("[pgi] notification failed", { userId, message: (err as Error)?.message });
    }
  }
  try {
    const [{ supportEmail }, mail] = await Promise.all([import("../licensee/brand.js"), import("../plans/email.js")]);
    const to = supportEmail();
    if (to) {
      const r = await mail.sendPlanMail({ to: [to], subject: n.emailSubject, ...mail.bodies(n.emailLines) });
      if (!r.ok) console.warn("[pgi] support email not sent", r.error);
    }
  } catch (err) {
    console.warn("[pgi] support email failed", (err as Error)?.message ?? String(err));
  }
}

async function link(db: Q, deps: Deps): Promise<PartnerLink | null> {
  return deps.link !== undefined ? deps.link : getPartnerLink(db);
}

export async function getReferral(db: Q, applicationId: string): Promise<ReferralRow | null> {
  const r = await db.query(`SELECT * FROM pgi_referrals WHERE application_id = $1 LIMIT 1`, [applicationId]);
  return (r.rows[0] as ReferralRow) ?? null;
}

/**
 * The client ticked PGI and submitted: keep what they told us, then send it in the background so the client's submit
 * never waits for the partner (sendReferral never throws; the worker retries anything that did not go through).
 */
export async function recordPgiOptIn(db: Q, src: { applicationId: string; legacyApp?: any; normalized?: any; businessSource?: any; applicantSource?: any }, deps: Deps = {}): Promise<void> {
  const input = pgiInputFromApplication(src);
  await db.query(
    `INSERT INTO pgi_referrals (application_id, input, referring_user_id)
     VALUES ($1, $2::jsonb, (SELECT owner_user_id FROM applications WHERE id::text = $1 LIMIT 1))
     ON CONFLICT (application_id) DO UPDATE SET input = pgi_referrals.input || EXCLUDED.input, updated_at = now()`,
    [src.applicationId, JSON.stringify(input)],
  );
  void sendReferral(db, src.applicationId, deps);
}

/** Staff turn PGI on for an application from the portal: read what the application already has. */
export async function startReferral(db: Q, applicationId: string, userId: string | null, deps: Deps = {}): Promise<ReferralRow | null> {
  const a = await db.query(`SELECT metadata, requested_amount FROM applications WHERE id::text = $1 LIMIT 1`, [applicationId]);
  if (!a.rows[0]) return null;
  const md = a.rows[0].metadata ?? {};
  const legacyApp = md.formData ?? md.app ?? md;
  const input = pgiInputFromApplication({ legacyApp, normalized: md.normalized, requestedAmount: a.rows[0].requested_amount });
  await db.query(
    `INSERT INTO pgi_referrals (application_id, input, referring_user_id) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (application_id) DO NOTHING`,
    [applicationId, JSON.stringify(input), userId],
  );
  await sendReferral(db, applicationId, deps);
  return getReferral(db, applicationId);
}

/** Staff fill in what the insurer still needs; sent again straight away. */
export async function updateReferralInput(db: Q, applicationId: string, patch: PgiInput, deps: Deps = {}): Promise<void> {
  await db.query(`UPDATE pgi_referrals SET input = input || $2::jsonb, updated_at = now() WHERE application_id = $1`,
    [applicationId, JSON.stringify(patch)]);
  await sendReferral(db, applicationId, deps);
}

async function brokerOf(db: Q, ref: ReferralRow): Promise<{ user_id: string | null; name: string | null; email: string | null }> {
  const r = await db.query(
    `SELECT u.id::text AS id, u.email, NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), '') AS name
       FROM users u
      WHERE u.id::text = COALESCE($1, (SELECT owner_user_id::text FROM applications WHERE id::text = $2 LIMIT 1))
      LIMIT 1`,
    [ref.referring_user_id, ref.application_id],
  );
  const u = r.rows[0];
  return { user_id: u?.id ?? null, name: u?.name ?? null, email: u?.email ?? null };
}

/** Applies the partner's view of the referral (status, checklist, fee) to our row. */
async function applyPartnerView(db: Q, ref: ReferralRow, view: any): Promise<void> {
  const checklist = view?.checklist ?? null;
  const missing = Array.isArray(checklist?.missing_documents) ? checklist.missing_documents.length : 0;
  const fee = view?.referral_fee ?? null;
  await db.query(
    `UPDATE pgi_referrals
        SET status = $2, partner_status = $3, bi_application_id = COALESCE($4, bi_application_id),
            bi_application_code = COALESCE($5, bi_application_code), completion_url = COALESCE($6, completion_url),
            checklist = $7::jsonb, missing_count = $8,
            referral_fee_amount = COALESCE($9, referral_fee_amount), referral_fee_currency = COALESCE($10, referral_fee_currency),
            referral_fee_status = COALESCE($11, referral_fee_status), last_error = NULL, last_synced_at = now(), updated_at = now()
      WHERE id = $1`,
    [ref.id, String(view?.status ?? ref.status), view?.bi_status ?? null, view?.bi_application_id ?? null, view?.application_code ?? null,
      view?.completion_url ?? null, JSON.stringify(checklist), missing, fee ? Number(fee.amount) : null, fee?.currency ?? null, fee?.status ?? null],
  );
}

async function fail(db: Q, ref: ReferralRow, status: string, error: string): Promise<void> {
  await db.query(`UPDATE pgi_referrals SET status = $2, last_error = $3, updated_at = now() WHERE id = $1`, [ref.id, status, error.slice(0, 300)]);
}

/** Creates (or updates) the referral at the partner, then forwards documents. Never throws. */
export async function sendReferral(db: Q, applicationId: string, deps: Deps = {}): Promise<{ ok: boolean; error?: string }> {
  try {
    const ref = await getReferral(db, applicationId);
    if (!ref) return { ok: false, error: "no_referral" };
    const l = await link(db, deps);
    if (!l) {
      await fail(db, ref, ref.bi_application_id ? ref.status : "not_configured", "insurance_partner_not_linked");
      return { ok: false, error: "insurance_partner_not_linked" };
    }
    const broker = await brokerOf(db, ref);
    const r = await partnerCall(l, "POST", "/referrals", partnerReferralBody(applicationId, ref.input ?? {}, broker), deps.fetchImpl);
    if (!r.ok) {
      const notEligible = r.error === "quebec_not_eligible";
      const missingBasics = /_required$/.test(r.error) && r.status === 400;
      await fail(db, ref, notEligible ? "not_eligible" : missingBasics ? "needs_details" : ref.bi_application_id ? ref.status : "error", r.error);
      return { ok: false, error: r.error };
    }
    await applyPartnerView(db, ref, r.body);
    const completion = typeof r.body?.completion_url === "string" ? r.body.completion_url : null;
    await db.query(
      `UPDATE applications SET bi_application_id = $2, bi_public_id = $3, bi_completion_url = $4, updated_at = now() WHERE id::text = $1`,
      [applicationId, r.body?.bi_application_id ?? null, r.body?.public_id ?? null, completion],
    );
    if (completion && r.body?.created) await postClientPrompt(db, applicationId, completion);
    await forwardDocuments(db, applicationId, { ...deps, link: l });
    return { ok: true };
  } catch (err) {
    console.warn("[pgi] send referral failed", { applicationId, message: (err as Error)?.message });
    return { ok: false, error: "exception" };
  }
}

/** The client's portal shows the partner's completion link (ID and the declarations are answered there). */
async function postClientPrompt(db: Q, applicationId: string, url: string): Promise<void> {
  const exists = await db.query(
    `SELECT id FROM communications_messages WHERE application_id = $1 AND cta_label = $2 LIMIT 1`,
    [applicationId, PGI_CTA_LABEL],
  );
  if (exists.rows[0]) return;
  await db.query(
    `INSERT INTO communications_messages (id, type, direction, status, application_id, contact_id, silo, body, staff_name, cta_label, cta_action, created_at)
     VALUES ($1, 'message', 'outbound', 'sent', $2, (SELECT contact_id FROM applications WHERE id::text = $2 LIMIT 1), 'BF', $3, $4, $5, $6, now())`,
    [randomUUID(), applicationId,
      `Your Personal Guarantee Insurance application is ready to complete with our insurance partner, ${PGI_PARTNER_NAME}. It takes a few minutes: confirm your ID and answer the insurer's questions.`,
      PGI_PARTNER_NAME, PGI_CTA_LABEL, url],
  );
}

/** Sends every accepted document that fills a PGI slot and has not reached the partner in this exact version. */
export async function forwardDocuments(db: Q, applicationId: string, deps: Deps = {}): Promise<{ sent: number; skipped: number; failed: number }> {
  const out = { sent: 0, skipped: 0, failed: 0 };
  const ref = await getReferral(db, applicationId);
  if (!ref?.bi_application_id) return out;
  const l = await link(db, deps);
  if (!l) return out;
  const docs = await db.query(
    `SELECT id::text AS id, application_id::text AS application_id, category, document_type, status, created_at, filename,
            storage_key, blob_name, storage_path
       FROM documents WHERE application_id::text = $1`,
    [applicationId],
  );
  const done = await db.query(`SELECT document_id, sha256, forwarded_at FROM pgi_referral_documents WHERE referral_id = $1`, [ref.id]);
  const sent = new Map(done.rows.map((d: any) => [String(d.document_id), d]));
  const loadFile = deps.loadFile ?? defaultLoadFile;
  for (const { doc, slot } of documentsToForward(docs.rows as KsDocument[])) {
    const row = docs.rows.find((d: any) => d.id === doc.id);
    let buf: Buffer | null = null;
    try { buf = await loadFile(row); } catch (err) { console.warn("[pgi] document read failed", { id: doc.id, message: (err as Error)?.message }); }
    if (!buf) { out.failed += 1; await recordDoc(db, ref.id, doc.id, slot, null, null, "file_not_found"); continue; }
    const sha = createHash("sha256").update(buf).digest("hex");
    const prev = sent.get(doc.id) as { sha256: string | null; forwarded_at: string | null } | undefined;
    if (prev?.forwarded_at && prev.sha256 === sha) { out.skipped += 1; continue; }
    if (buf.length > MAX_FORWARD_BYTES) { out.failed += 1; await recordDoc(db, ref.id, doc.id, slot, sha, null, "file_too_large"); continue; }
    const form = new FormData();
    form.append("slot", slot);
    form.append("ks_document_id", doc.id);
    form.append("file", new Blob([new Uint8Array(buf)]), doc.filename || `${slot}.pdf`);
    const r = await partnerCall(l, "POST", `/referrals/${encodeURIComponent(applicationId)}/documents`, form, deps.fetchImpl);
    if (r.ok) { out.sent += 1; await recordDoc(db, ref.id, doc.id, slot, sha, String(r.body?.bi_document_id ?? ""), null); }
    else { out.failed += 1; await recordDoc(db, ref.id, doc.id, slot, sha, null, r.error); }
  }
  return out;
}

async function recordDoc(db: Q, referralId: string, documentId: string, slot: string, sha: string | null, biDocumentId: string | null, error: string | null): Promise<void> {
  await db.query(
    `INSERT INTO pgi_referral_documents (referral_id, document_id, slot, sha256, bi_document_id, forwarded_at, attempts, last_error)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::text IS NULL THEN now() ELSE NULL END, 1, $6)
     ON CONFLICT (referral_id, document_id) DO UPDATE SET slot = EXCLUDED.slot, sha256 = EXCLUDED.sha256,
       bi_document_id = COALESCE(EXCLUDED.bi_document_id, pgi_referral_documents.bi_document_id),
       forwarded_at = CASE WHEN EXCLUDED.last_error IS NULL THEN now() ELSE pgi_referral_documents.forwarded_at END,
       attempts = pgi_referral_documents.attempts + 1, last_error = EXCLUDED.last_error`,
    [referralId, documentId, slot, sha, biDocumentId || null, error],
  );
}

/** Pulls the partner's view (status, checklist, fee, messages) and forwards any new documents. */
export async function syncReferral(db: Q, applicationId: string, deps: Deps = {}): Promise<{ ok: boolean; error?: string }> {
  try {
    const ref = await getReferral(db, applicationId);
    if (!ref) return { ok: false, error: "no_referral" };
    if (!ref.bi_application_id) return sendReferral(db, applicationId, deps);
    const l = await link(db, deps);
    if (!l) return { ok: false, error: "insurance_partner_not_linked" };
    await forwardDocuments(db, applicationId, { ...deps, link: l });
    const r = await partnerCall(l, "GET", `/referrals/${encodeURIComponent(applicationId)}`, undefined, deps.fetchImpl);
    if (!r.ok) {
      await db.query(`UPDATE pgi_referrals SET last_error = $2, updated_at = now() WHERE id = $1`, [ref.id, r.error.slice(0, 300)]);
      return { ok: false, error: r.error };
    }
    await applyPartnerView(db, ref, r.body);
    for (const m of Array.isArray(r.body?.messages) ? r.body.messages : []) {
      if (m?.direction !== "to_broker") continue;
      await storePartnerMessage(db, ref, {
        event_id: String(m.id), type: String(m.kind ?? "message"), body: String(m.body ?? ""), author_name: m.author_name ?? null,
        status: m.status ?? null, missing: m.missing_items ?? null, at: m.created_at,
      }, deps);
    }
    return { ok: true };
  } catch (err) {
    console.warn("[pgi] sync failed", { applicationId, message: (err as Error)?.message });
    return { ok: false, error: "exception" };
  }
}

export type PartnerEvent = {
  event_id: string; type: string; body: string; author_name?: string | null; status?: string | null;
  missing?: any; at?: string | null; referral_fee?: { amount: number; currency: string; status: string } | null;
};

const TITLES: Record<string, string> = {
  message: "New message from the insurance partner",
  doc_request: "The insurance partner needs documents",
  reminder: "Reminder: documents still needed for PGI",
  status: "PGI update",
};

/** Stores one partner message (once per event id); notifies the referring seat, the admins and the support inbox. */
export async function storePartnerMessage(db: Q, ref: ReferralRow, e: PartnerEvent, deps: Deps = {}): Promise<boolean> {
  const missing = e.missing && typeof e.missing === "object" ? e.missing : null;
  const ins = await db.query(
    `INSERT INTO pgi_referral_messages (referral_id, direction, kind, body, author_name, missing, status, bi_event_id, created_at)
     VALUES ($1, 'from_partner', $2, $3, $4, $5::jsonb, $6, $7, COALESCE($8::timestamptz, now()))
     ON CONFLICT (bi_event_id) DO NOTHING
     RETURNING id`,
    [ref.id, ["message", "doc_request", "reminder", "status"].includes(e.type) ? e.type : "message", e.body.slice(0, 5000),
      e.author_name ?? PGI_PARTNER_NAME, missing ? JSON.stringify(missing) : null, e.status ?? null, e.event_id, e.at ?? null],
  );
  if (!ins.rows[0]) return false;
  const fee = e.referral_fee ?? null;
  await db.query(
    `UPDATE pgi_referrals
        SET unread_count = unread_count + 1,
            status = COALESCE($2, status),
            referral_fee_amount = COALESCE($3, referral_fee_amount),
            referral_fee_currency = COALESCE($4, referral_fee_currency),
            referral_fee_status = COALESCE($5, referral_fee_status),
            updated_at = now()
      WHERE id = $1`,
    [ref.id, e.type === "status" ? e.status ?? null : null, fee ? Number(fee.amount) : null, fee?.currency ?? null, fee?.status ?? null],
  );
  const app = await db.query(`SELECT name FROM applications WHERE id::text = $1 LIMIT 1`, [ref.application_id]);
  const appName = String(app.rows[0]?.name ?? "an application");
  const admins = await db.query(
    `SELECT id::text AS id FROM users WHERE role = 'Admin' AND COALESCE(is_active, active, true) = true AND deleted_at IS NULL`,
  );
  const userIds = [...new Set([ref.referring_user_id, ...admins.rows.map((u: any) => u.id)].filter(Boolean) as string[])];
  const missingDocs: any[] = Array.isArray(missing?.documents) ? missing.documents : [];
  const title = TITLES[e.type] ?? TITLES.message;
  const notify = deps.notify ?? defaultNotify;
  await notify({
    userIds,
    applicationId: ref.application_id,
    title,
    body: `${appName}: ${e.body.replace(/\s+/g, " ").slice(0, 140)}`,
    emailSubject: `${title}: ${appName}`,
    emailLines: [
      `${PGI_PARTNER_NAME} wrote about the Personal Guarantee Insurance referral for ${appName}.`,
      e.body,
      ...(missingDocs.length ? ["Still needed:\n" + missingDocs.map((d) => `- ${d.label ?? PGI_SLOT_LABELS[d.slot as keyof typeof PGI_SLOT_LABELS] ?? d.slot}`).join("\n")] : []),
      "Open the application's PGI tab in the portal to reply or upload documents.",
    ],
  });
  return true;
}

/** A partner callback: find the referral, store the message, and (for document requests) refresh the checklist. */
export async function handlePartnerEvent(db: Q, raw: any, deps: Deps = {}): Promise<{ ok: boolean; error?: string; stored?: boolean }> {
  const applicationId = String(raw?.ks_application_id ?? "");
  const eventId = String(raw?.event_id ?? "");
  if (!applicationId || !eventId) return { ok: false, error: "invalid_event" };
  const ref = await getReferral(db, applicationId);
  if (!ref) return { ok: false, error: "unknown_referral" };
  const stored = await storePartnerMessage(db, ref, {
    event_id: eventId, type: String(raw?.type ?? "message"), body: String(raw?.message?.body ?? ""),
    author_name: raw?.message?.author_name ?? null, status: raw?.status ?? null,
    missing: { documents: raw?.missing_documents ?? [], fields: raw?.missing_fields ?? [] }, at: raw?.at ?? null,
    referral_fee: raw?.referral_fee ?? null,
  }, deps);
  if (stored && (raw?.type === "doc_request" || raw?.type === "reminder")) {
    const docs = Array.isArray(raw?.missing_documents) ? raw.missing_documents : [];
    await db.query(`UPDATE pgi_referrals SET missing_count = $2 WHERE id = $1`, [ref.id, docs.length]);
  }
  return { ok: true, stored };
}

/** A reply from this brokerage to the partner. Stored first; sent now (the worker resends a failed one). */
export async function sendMessageToPartner(db: Q, applicationId: string, user: { id: string | null; name: string | null }, body: string, deps: Deps = {}): Promise<{ ok: boolean; error?: string; id?: string }> {
  const ref = await getReferral(db, applicationId);
  if (!ref) return { ok: false, error: "no_referral" };
  const ins = await db.query(
    `INSERT INTO pgi_referral_messages (referral_id, direction, kind, body, author_name, author_user_id)
     VALUES ($1, 'to_partner', 'message', $2, $3, $4) RETURNING id`,
    [ref.id, body, user.name, user.id],
  );
  const id = String(ins.rows[0].id);
  const r = await deliverReply(db, ref, { id, body, author_name: user.name, author_user_id: user.id }, deps);
  return r.ok ? { ok: true, id } : { ok: false, error: r.error, id };
}

async function deliverReply(db: Q, ref: ReferralRow, m: { id: string; body: string; author_name: string | null; author_user_id: string | null }, deps: Deps): Promise<{ ok: boolean; error?: string }> {
  const l = await link(db, deps);
  if (!l || !ref.bi_application_id) {
    await db.query(`UPDATE pgi_referral_messages SET send_error = $2 WHERE id = $1`, [m.id, "not_sent_yet"]);
    return { ok: false, error: "not_sent_yet" };
  }
  const r = await partnerCall(l, "POST", `/referrals/${encodeURIComponent(ref.application_id)}/messages`,
    { body: m.body, author_name: m.author_name, author_user_id: m.author_user_id, ks_message_id: m.id }, deps.fetchImpl);
  await db.query(
    `UPDATE pgi_referral_messages SET sent_at = CASE WHEN $2::boolean THEN now() ELSE sent_at END, send_error = $3 WHERE id = $1`,
    [m.id, r.ok, r.ok ? null : r.error.slice(0, 300)],
  );
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** The worker: send referrals not yet at the partner, resend unsent replies, and sync open ones. */
export async function runPgiTick(db: Q, deps: Deps = {}, limit = 50): Promise<{ synced: number; resent: number }> {
  const l = await link(db, deps);
  if (!l) return { synced: 0, resent: 0 };
  const d = { ...deps, link: l };
  const open = await db.query(
    `SELECT application_id FROM pgi_referrals
      WHERE status <> ALL($1::text[])
        AND (last_synced_at IS NULL OR last_synced_at < now() - interval '10 minutes')
      ORDER BY COALESCE(last_synced_at, created_at) LIMIT $2`,
    [FINAL_STATUSES, limit],
  );
  let synced = 0;
  for (const r of open.rows) if ((await syncReferral(db, String(r.application_id), d)).ok) synced += 1;
  const unsent = await db.query(
    `SELECT m.id::text AS id, m.body, m.author_name, m.author_user_id::text AS author_user_id, p.application_id
       FROM pgi_referral_messages m JOIN pgi_referrals p ON p.id = m.referral_id
      WHERE m.direction = 'to_partner' AND m.sent_at IS NULL AND m.created_at > now() - interval '7 days'
      ORDER BY m.created_at LIMIT 50`,
  );
  let resent = 0;
  for (const m of unsent.rows) {
    const ref = await getReferral(db, String(m.application_id));
    if (ref && (await deliverReply(db, ref, m as any, d)).ok) resent += 1;
  }
  return { synced, resent };
}

/** The view the portal shows: our referral row, the checklist mapped onto this file, the thread, missing fields. */
export async function referralView(db: Q, applicationId: string) {
  const ref = await getReferral(db, applicationId);
  if (!ref) return null;
  const docs = await db.query(
    `SELECT id::text AS id, category, document_type, status, created_at, filename FROM documents WHERE application_id::text = $1`,
    [applicationId],
  );
  const fwd = await db.query(`SELECT document_id, slot, forwarded_at, last_error FROM pgi_referral_documents WHERE referral_id = $1`, [ref.id]);
  const partnerDocs: PartnerDoc[] = Array.isArray(ref.checklist?.documents) ? ref.checklist.documents : [];
  const list = buildChecklist({
    formationDate: ref.input?.formation_date,
    documents: docs.rows as KsDocument[],
    forwardedSlots: new Set(fwd.rows.filter((f: any) => f.forwarded_at).map((f: any) => String(f.slot))),
    partnerDocs,
  });
  const messages = await db.query(
    `SELECT id, direction, kind, body, author_name, missing, status, created_at, sent_at, send_error, read_at
       FROM pgi_referral_messages WHERE referral_id = $1 ORDER BY created_at ASC LIMIT 500`,
    [ref.id],
  );
  const partnerFields = Array.isArray(ref.checklist?.missing_fields) ? ref.checklist.missing_fields : null;
  return {
    referral: {
      application_id: ref.application_id, status: ref.status, partner_status: ref.partner_status,
      application_code: ref.bi_application_code, completion_url: ref.completion_url, missing_count: ref.missing_count,
      unread_count: ref.unread_count, last_error: ref.last_error, last_synced_at: ref.last_synced_at, created_at: ref.created_at,
      referral_fee: ref.referral_fee_amount != null ? { amount: Number(ref.referral_fee_amount), currency: ref.referral_fee_currency ?? "CAD", status: ref.referral_fee_status } : null,
    },
    input: ref.input ?? {},
    checklist: list.rows,
    startup: list.startup,
    missing_fields: partnerFields ?? missingFields(ref.input ?? {}).map((f) => ({ ...f, completed_by: "broker" })),
    documents_forwarded: fwd.rows,
    messages: messages.rows,
    partner_name: PGI_PARTNER_NAME,
  };
}
