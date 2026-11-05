// KS_SERVER_LENDER_API - what happens when a lender tells us something about a deal (from a poll, a webhook or the
// submission answer): the status timeline, the lender's offers in the Offers list, conditions and document requests,
// funding, the application's pipeline stage, a notification to the assigned staff member and an audit entry.
import { randomUUID } from "node:crypto";
import type { Q } from "../plans/state.js";
import { recordAuditEvent } from "../modules/audit/audit.service.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { BUCKET_LABELS, isTerminalBucket, type LenderBucket, type RemoteUpdate } from "./types.js";
import { resolveStatus, type StatusMapEntry } from "./mapping.js";

export type EventKind =
  | "submit_attempt" | "submitted" | "submit_failed" | "retry_scheduled" | "email_fallback" | "status_changed"
  | "offer_received" | "offer_updated" | "condition_added" | "condition_updated" | "document_uploaded"
  | "document_upload_failed" | "webhook_received" | "sync_failed" | "stage_moved" | "stage_not_moved" | "funded";
export type EventSource = "api" | "webhook" | "poll" | "staff" | "system";

export async function logEvent(db: Q, e: {
  submissionId: string | null; applicationId: string; lenderId: string; kind: EventKind; source: EventSource;
  status?: string | null; detail?: string | null; data?: Record<string, unknown> | null; createdBy?: string | null;
}): Promise<void> {
  await db.query(
    `INSERT INTO lender_api_events (id, submission_id, application_id, lender_id, kind, source, status, detail, data, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, now())`,
    [randomUUID(), e.submissionId, e.applicationId, e.lenderId, e.kind, e.source, e.status ?? null, e.detail ? String(e.detail).slice(0, 2000) : null,
      e.data ? JSON.stringify(e.data) : null, e.createdBy ?? null],
  );
}

/** System actions (no person behind them) in the audit log. Best effort. */
export async function auditSystem(action: string, targetId: string | null, metadata: Record<string, unknown>): Promise<void> {
  try {
    await recordAuditEvent({ actorUserId: null, targetUserId: null, targetType: "lender_api", targetId, action, eventType: "lender_api", eventAction: action, success: true, metadata });
  } catch (err) {
    logWarnSwallowed(err, `lenderConnectors/sync.ts:audit:${action}`);
  }
}

/** Tells the application's assigned staff member (or every Admin when nobody is assigned). Best effort. */
export async function notifyStaff(db: Q, applicationId: string, n: { type: string; title: string; body: string; metadata?: Record<string, unknown> }): Promise<void> {
  try {
    const owner = await db.query(`SELECT owner_user_id::text AS owner FROM applications WHERE id::text = $1 LIMIT 1`, [applicationId]);
    let users: string[] = owner.rows[0]?.owner ? [String(owner.rows[0].owner)] : [];
    if (!users.length) {
      const admins = await db.query(`SELECT id::text AS id FROM users WHERE active = true AND upper(coalesce(role, '')) = 'ADMIN'`, []);
      users = admins.rows.map((r: any) => String(r.id));
    }
    const contextUrl = `/applications/${encodeURIComponent(applicationId)}/lenders`;
    for (const userId of users) {
      await db.query(
        `INSERT INTO notifications (id, user_id, application_id, type, title, body, metadata, context_url, created_at, read_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now(), null)`,
        [randomUUID(), userId, applicationId, n.type, n.title, n.body, JSON.stringify(n.metadata ?? {}), contextUrl],
      );
      try {
        const { pushToUser } = await import("../services/notifications/pushToUser.js");
        void pushToUser(userId, n.title, n.body, contextUrl, "lenders"); // KS_NOTIFICATION_TOPICS_v1
      } catch (err) {
        logWarnSwallowed(err, "lenderConnectors/sync.ts:push");
      }
    }
  } catch (err) {
    logWarnSwallowed(err, "lenderConnectors/sync.ts:notifyStaff");
  }
}

export type SubmissionRow = {
  id: string;
  application_id: string;
  lender_id: string;
  connector: string;
  external_id: string | null;
  lender_status: string | null;
  bucket: string | null;
};

export type ApplyResult = {
  statusChanged: boolean; bucket: LenderBucket | null; newOffers: number; newConditions: number; stageMoved: string | null;
  /** KS_LENDER_SYNC_CONTRACTS - conditions added to / cleared on the funding checklist, and a balance recorded. */
  checklist?: { added: number; linked: number; cleared: number; waived: number };
  balanceRecorded?: boolean;
};

/** KS_LENDER_SYNC_CONTRACTS - whether this lender is the one the file is going with: the application names it, or the
 *  client accepted its offer. Only then do its conditions belong on the funding checklist. */
async function chosenLender(db: Q, applicationId: string, lenderId: string): Promise<{ chosen: boolean; funded: boolean }> {
  const r = await db.query(
    `SELECT (a.lender_id::text = $2 OR EXISTS (SELECT 1 FROM offers o WHERE o.application_id::text = $1 AND o.lender_id::text = $2 AND o.status = 'accepted')) AS chosen,
            lower(COALESCE(a.pipeline_state, '')) = 'funded' AS funded
       FROM applications a WHERE a.id::text = $1 LIMIT 1`, [applicationId, lenderId]);
  return { chosen: r.rows[0]?.chosen === true, funded: r.rows[0]?.funded === true };
}

/** Moves the application's pipeline stage when the move is a legal one; otherwise records why it did not. */
async function moveStage(db: Q, sub: SubmissionRow, stage: string, lenderName: string, source: EventSource): Promise<string | null> {
  try {
    const cur = await db.query(`SELECT pipeline_state FROM applications WHERE id::text = $1 LIMIT 1`, [sub.application_id]);
    const from = cur.rows[0]?.pipeline_state ?? null;
    if (!from || from === stage) return null;
    const { transitionPipelineState } = await import("../modules/applications/applications.service.js");
    const { isPipelineState } = await import("../modules/applications/pipelineState.js");
    if (!isPipelineState(stage)) {
      await logEvent(db, { submissionId: sub.id, applicationId: sub.application_id, lenderId: sub.lender_id, kind: "stage_not_moved", source, detail: `"${stage}" is not a pipeline stage.` });
      return null;
    }
    await transitionPipelineState({ applicationId: sub.application_id, nextState: stage, actorUserId: null, actorRole: null, trigger: "lender_api", reason: `${lenderName} status update` });
    await logEvent(db, { submissionId: sub.id, applicationId: sub.application_id, lenderId: sub.lender_id, kind: "stage_moved", source, status: stage, detail: `Moved from ${from} to ${stage}.` });
    return stage;
  } catch (err) {
    await logEvent(db, {
      submissionId: sub.id, applicationId: sub.application_id, lenderId: sub.lender_id, kind: "stage_not_moved", source, status: stage,
      detail: `Left the file where it is: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
    });
    return null;
  }
}

export async function applyRemoteUpdate(db: Q, args: {
  submission: SubmissionRow;
  lenderName: string;
  update: RemoteUpdate;
  source: EventSource;
  adminStatusMap: Record<string, StatusMapEntry>;
  connectorDefaults: Record<string, LenderBucket>;
  pollIntervalMinutes: number;
}): Promise<ApplyResult> {
  const { submission: sub, update, source, lenderName } = args;
  const result: ApplyResult = { statusChanged: false, bucket: (sub.bucket as LenderBucket | null) ?? null, newOffers: 0, newConditions: 0, stageMoved: null };

  // ── status ──
  if (update.status && update.status !== sub.lender_status && sub.bucket === "funded"
      && resolveStatus(update.status, args.adminStatusMap, args.connectorDefaults).bucket !== "funded") {
    // KS_LENDER_SYNC_CONTRACTS - after funding the lender's status describes the contract ("Active", "Paid off"): it is
    // recorded, but the deal stays funded and the pipeline stage is never moved by it.
    result.statusChanged = true;
    await logEvent(db, {
      submissionId: sub.id, applicationId: sub.application_id, lenderId: sub.lender_id, kind: "status_changed", source,
      status: update.status, detail: `${lenderName}: ${update.statusLabel || update.status} (after funding)`,
      data: { from: sub.lender_status, to: update.status, bucket: "funded", after_funding: true },
    });
  } else if (update.status && update.status !== sub.lender_status) {
    const resolved = resolveStatus(update.status, args.adminStatusMap, args.connectorDefaults);
    result.statusChanged = true;
    result.bucket = resolved.bucket;
    await logEvent(db, {
      submissionId: sub.id, applicationId: sub.application_id, lenderId: sub.lender_id, kind: "status_changed", source,
      status: update.status, detail: `${lenderName}: ${update.statusLabel || update.status} (${BUCKET_LABELS[resolved.bucket]})`,
      data: { from: sub.lender_status, to: update.status, bucket: resolved.bucket, mapped_by: resolved.source },
    });
    await notifyStaff(db, sub.application_id, {
      type: "lender_status", title: `${lenderName}: ${BUCKET_LABELS[resolved.bucket]}`,
      body: `${lenderName} moved this deal to "${update.statusLabel || update.status}".`,
      metadata: { lender_id: sub.lender_id, submission_id: sub.id, status: update.status, bucket: resolved.bucket },
    });
    await auditSystem("lender_status_changed", sub.application_id, { lender_id: sub.lender_id, from: sub.lender_status, to: update.status, bucket: resolved.bucket, source });
    if (resolved.stage) result.stageMoved = await moveStage(db, sub, resolved.stage, lenderName, source);
  }

  // ── offers ──
  for (const o of update.offers ?? []) {
    const existing = await db.query(`SELECT id::text AS id, amount, status FROM offers WHERE lender_id::text = $1 AND lender_external_id = $2 LIMIT 1`, [sub.lender_id, o.externalId]);
    const notes = [o.notes, `From ${lenderName} by API`].filter(Boolean).join(" · ");
    if (!existing.rows[0]) {
      await db.query(
        `INSERT INTO offers (id, application_id, lender_name, amount, rate_factor, term, payment_frequency, expiry_date, status, notes, lender_id, lender_external_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11, now(), now())
         ON CONFLICT DO NOTHING`,
        [randomUUID(), sub.application_id, lenderName, o.amount, o.rateFactor, o.term, o.paymentFrequency, /^\d{4}-\d{2}-\d{2}/.test(o.expiryDate ?? "") ? o.expiryDate!.slice(0, 10) : null, notes, sub.lender_id, o.externalId],
      );
      result.newOffers += 1;
      await logEvent(db, {
        submissionId: sub.id, applicationId: sub.application_id, lenderId: sub.lender_id, kind: "offer_received", source,
        detail: `${lenderName} offer${o.amount !== null ? ` of $${o.amount.toLocaleString("en-CA")}` : ""}${o.term ? `, ${o.term}` : ""}${o.rateFactor ? `, ${o.rateFactor}` : ""}`,
        data: { ...o },
      });
      await notifyStaff(db, sub.application_id, {
        type: "lender_offer", title: `New offer from ${lenderName}`,
        body: `${lenderName} sent an offer${o.amount !== null ? ` of $${o.amount.toLocaleString("en-CA")}` : ""}. It is in the Offers list.`,
        metadata: { lender_id: sub.lender_id, external_offer_id: o.externalId },
      });
    } else if (Number(existing.rows[0].amount ?? NaN) !== (o.amount ?? NaN)) {
      await db.query(
        `UPDATE offers SET amount = $1, rate_factor = $2, term = $3, payment_frequency = $4, updated_at = now()
          WHERE lender_id::text = $5 AND lender_external_id = $6`,
        [o.amount, o.rateFactor, o.term, o.paymentFrequency, sub.lender_id, o.externalId],
      );
      await logEvent(db, { submissionId: sub.id, applicationId: sub.application_id, lenderId: sub.lender_id, kind: "offer_updated", source, detail: `${lenderName} changed an offer.`, data: { ...o } });
    }
  }

  // ── conditions and document requests ──
  for (const c of update.conditions ?? []) {
    const r = await db.query(
      `INSERT INTO lender_api_conditions (id, submission_id, application_id, lender_id, external_id, kind, description, document_type, status, first_seen_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())
       ON CONFLICT (submission_id, external_id) DO UPDATE
         SET description = EXCLUDED.description, document_type = EXCLUDED.document_type, status = EXCLUDED.status, kind = EXCLUDED.kind,
             updated_at = CASE WHEN lender_api_conditions.status IS DISTINCT FROM EXCLUDED.status THEN now() ELSE lender_api_conditions.updated_at END
       RETURNING (xmax = 0) AS inserted, status`,
      [randomUUID(), sub.id, sub.application_id, sub.lender_id, c.externalId, c.kind, c.description.slice(0, 1000), c.documentType, c.status],
    );
    if (r.rows[0]?.inserted) {
      result.newConditions += 1;
      await logEvent(db, {
        submissionId: sub.id, applicationId: sub.application_id, lenderId: sub.lender_id, kind: "condition_added", source,
        detail: `${lenderName} ${c.kind === "document_request" ? "asked for a document" : "added a condition"}: ${c.description}`.slice(0, 500), data: { ...c },
      });
    }
  }
  if (result.newConditions > 0) {
    await notifyStaff(db, sub.application_id, {
      type: "lender_conditions", title: `${lenderName} needs something`,
      body: `${lenderName} added ${result.newConditions} condition${result.newConditions === 1 ? "" : "s"} or document request${result.newConditions === 1 ? "" : "s"}. See the Lenders tab.`,
      metadata: { lender_id: sub.lender_id, submission_id: sub.id },
    });
  }

  // ── KS_LENDER_SYNC_CONTRACTS: the lender's conditions onto the funding checklist ──
  // Every condition this lender has reported on the deal (stored above), so ones reported before the client accepted
  // the offer arrive too. New ones are not added once the file is funded; clearing still applies.
  try {
    const stored = await db.query(
      `SELECT external_id, kind, description, document_type, status FROM lender_api_conditions WHERE submission_id = $1 ORDER BY first_seen_at`, [sub.id]);
    if (stored.rows.length) {
      const who = await chosenLender(db, sub.application_id, sub.lender_id);
      if (who.chosen) {
        const { syncLenderConditions } = await import("../brokerTools/conditions.js");
        result.checklist = await syncLenderConditions(db, sub.application_id, { id: sub.lender_id, name: lenderName },
          stored.rows.map((r: any) => ({ externalId: String(r.external_id), kind: r.kind === "document_request" ? "document_request" : "condition",
            description: String(r.description ?? ""), documentType: r.document_type ?? null, status: r.status === "satisfied" || r.status === "waived" ? r.status : "open" })),
          { addNew: !who.funded });
        if (result.checklist.added || result.checklist.cleared || result.checklist.waived) {
          await auditSystem("funding_conditions_lender_sync", sub.application_id, { lender_id: sub.lender_id, ...result.checklist, source });
        }
      }
    }
  } catch (err) {
    logWarnSwallowed(err, "lenderConnectors/sync.ts:fundingChecklist");
  }

  // ── funding and commission ──
  if (update.fundedAmount !== undefined && update.fundedAmount !== null && result.bucket === "funded") {
    await logEvent(db, { submissionId: sub.id, applicationId: sub.application_id, lenderId: sub.lender_id, kind: "funded", source, detail: `${lenderName} reports $${update.fundedAmount.toLocaleString("en-CA")} funded.`, data: { funded_amount: update.fundedAmount, commission_amount: update.commissionAmount ?? null } });
  }

  // ── KS_LENDER_SYNC_CONTRACTS: balance, payments and next payment onto the Active Contract ──
  let lenderClosed = false;
  if (update.servicing) {
    try {
      const { applyLenderServicing } = await import("../activeContracts/lenderReported.js");
      const s = await applyLenderServicing(db, { applicationId: sub.application_id, lenderId: sub.lender_id, lenderName, submissionId: sub.id, servicing: update.servicing });
      result.balanceRecorded = s.recorded;
      lenderClosed = s.lenderClosed;
    } catch (err) {
      logWarnSwallowed(err, "lenderConnectors/sync.ts:servicing");
    }
  }

  const bucket = result.bucket;
  // KS_LENDER_SYNC_CONTRACTS - a funded deal keeps being read daily while its Active Contract is open.
  let terminal = isTerminalBucket(bucket);
  let interval = Math.max(5, args.pollIntervalMinutes);
  if (bucket === "funded") {
    try {
      const { keepPollingFunded, FUNDED_POLL_MINUTES } = await import("../activeContracts/lenderReported.js");
      const seen = await db.query(`SELECT funded_seen_at FROM lender_api_submissions WHERE id = $1`, [sub.id]);
      if (await keepPollingFunded(db, { applicationId: sub.application_id, lenderId: sub.lender_id, lenderClosed, fundedSeenAt: seen.rows[0]?.funded_seen_at ?? null })) {
        terminal = false;
        interval = FUNDED_POLL_MINUTES;
      }
    } catch (err) {
      logWarnSwallowed(err, "lenderConnectors/sync.ts:fundedPolling");
    }
  }
  await db.query(
    `UPDATE lender_api_submissions
        SET lender_status = COALESCE($2, lender_status), lender_status_label = COALESCE($3, lender_status_label), bucket = COALESCE($4, bucket),
            funded_amount = COALESCE($5, funded_amount), commission_amount = COALESCE($6, commission_amount),
            linked_record_id = COALESCE($7, linked_record_id), last_synced_at = now(),
            next_poll_at = CASE WHEN $8 THEN NULL ELSE now() + ($9 || ' minutes')::interval END,
            funded_seen_at = CASE WHEN $4 = 'funded' THEN COALESCE(funded_seen_at, now()) ELSE funded_seen_at END, updated_at = now()
      WHERE id = $1`,
    [sub.id, update.status ?? null, update.statusLabel ?? null, bucket, update.fundedAmount ?? null, update.commissionAmount ?? null, update.linkedRecordId ?? null, terminal, String(interval)],
  );
  return result;
}
