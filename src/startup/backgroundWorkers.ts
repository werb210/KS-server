// KS_SHARED_HOSTING_v1 - the background workers, moved here unchanged from src/index.ts (same order, same logs, same
// stagger). Single-brokerage mode calls this once at startup, exactly as before. The shared server calls it once per
// brokerage, inside that brokerage's context (src/tenancy/server.ts): the timers each worker creates keep that
// context, so every tick reads and writes that brokerage's database with its own settings.
import type { Pool } from "pg";

export async function startBackgroundWorkers(
  pool: Pool,
  workerStagger: () => Promise<void>,
  workerStops: Array<() => void>,
): Promise<void> {
  const { startOcrWorker } = await import("../modules/ocr/ocr.worker.js");
  const { startBankingAutoWorker } = await import("../workers/bankingAutoWorker.js");
  // KS_SERVER_TEXTING_REGISTRATION - texting registration state in memory on every instance (the SMS senders read it).
  try { const { startTextingStateRefresher } = await import("../phone/textingState.js"); const w = startTextingStateRefresher(pool as any); workerStops.push(w.stop); }
  catch (err) { console.error("[startup] texting state refresher failed to start:", err); }
  try { const w = startOcrWorker(); workerStops.push(w.stop); console.log("[startup] OCR worker started"); }
  catch (err) { console.error("[startup] OCR worker failed to start:", err); }
  await workerStagger();
  try { const w = startBankingAutoWorker(pool); workerStops.push(w.stop); console.log("[startup] banking auto-worker started"); }
  catch (err) { console.error("[startup] banking auto-worker failed to start:", err); }

  // BF_SERVER_v856_CRM_UNIFY - once per database: every application's partners, guarantors and advisors become CRM
  // contacts linked to the application and the company (crm_backfill_runs records the run).
  void import("../modules/crmUnify/peopleSync.js")
    .then((m) => m.backfillCrmPeopleOnce(pool))
    .catch((err) => console.warn("[startup] crm people backfill failed:", (err as Error)?.message ?? err));

  // BF_SERVER_v834_IMPORT_FIXES - fields for files imported from a Boreal package before v828 (once per file).
  void import("../services/brokerImport/packageBackfill.js")
    .then((m) => m.backfillPackagePrefill())
    .catch((err) => console.warn("[startup] package backfill failed:", (err as Error)?.message ?? err));

  // BF_SERVER_BLOCK_v146_LENDER_PACKAGE_WORKER_v1
  const { startLenderPackageWorker } = await import("../workers/lenderPackageWorker.js");
  await workerStagger();
  try { const w = startLenderPackageWorker(pool); workerStops.push(w.stop); console.log("[startup] lender-package worker started"); }
  catch (err) { console.error("[startup] lender-package worker failed to start:", err); }

  // SignNow completion poller — embedded signing has no webhook subscription,
  // so poll document-group status and run the same finalize the webhook would.
  const { startSignNowCompletionPoller } = await import("../workers/signnowCompletionPoller.js");
  await workerStagger();
  try { const w = startSignNowCompletionPoller(pool); workerStops.push(w.stop); console.log("[startup] signnow completion poller started"); }
  catch (err) { console.error("[startup] signnow completion poller failed to start:", err); }

  // Push-based completion: register the SignNow signed-event webhook (reads of
  // signed docs are denied, so the webhook is the only reliable signal).
  try { const { ensureSignnowWebhook } = await import("../signnow/ensureWebhookSubscription.js"); void ensureSignnowWebhook(); console.log("[startup] signnow webhook subscription ensured"); }
  catch (err) { console.error("[startup] signnow webhook subscription failed:", err); }

  // BF_SERVER_BLOCK_v706_READ_RECEIPTS — stamp opened_at from inbox read receipts.
  const { startReadReceiptWorker } = await import("../workers/readReceiptWorker.js");
  await workerStagger();
  try { const w = startReadReceiptWorker(pool); workerStops.push(w.stop); console.log("[startup] read-receipt worker started"); }
  catch (err) { console.error("[startup] read-receipt worker failed to start:", err); }
  // BF_SERVER_AUTO_TAMPER_SCAN_v269 - tamper scan every newly uploaded document.
  const { startTamperScanWorker } = await import("../workers/tamperScanWorker.js");
  await workerStagger();
  try { const w = startTamperScanWorker(pool); workerStops.push(w.stop); console.log("[startup] tamper-scan worker started"); }
  catch (err) { console.error("[startup] tamper-scan worker failed:", err); }

  // BF_INBOUND_ATTACHMENT_WORKER_v1 - auto-file inbound email attachments to the CRM.
  const { startInboundAttachmentWorker } = await import("../workers/inboundAttachmentWorker.js");
  await workerStagger();
  try { const w = startInboundAttachmentWorker(pool); workerStops.push(w.stop); console.log("[startup] inbound-attachment worker started"); }
  catch (err) { console.error("[startup] inbound-attachment worker failed to start:", err); }

  // BF_SERVER_BLOCK_v797_EMAIL_OPEN_TRACKING — alert the sender if a 1:1 email goes unopened for 24 business hours.
  // BF_SERVER_ABANDONED_NUDGE_v61 - 4h SMS then a 2-day call task for anyone
  // who starts an application and does not finish.
  const { startAbandonedApplicationWorker } = await import("../workers/abandonedApplicationWorker.js");
  await workerStagger();
  try { const w = startAbandonedApplicationWorker(pool); workerStops.push(w.stop); console.log("[startup] abandoned-application worker started"); }
  catch (err) { console.warn("[startup] abandoned-application worker failed", err); }

  // BF_SERVER_BLOCK_v618 - automation builder: runs steps that are due (after waits, quiet hours, retries).
  const { startAutomationWorker } = await import("../workers/automationWorker.js");
  await workerStagger();
  try { const w = startAutomationWorker(pool); workerStops.push(w.stop); console.log("[startup] automation worker started"); }
  catch (err) { console.error("[startup] automation worker failed to start:", err); }

  const { startEmailFollowupWorker } = await import("../workers/emailFollowupWorker.js");
  await workerStagger();
  try { const w = startEmailFollowupWorker(pool); workerStops.push(w.stop); console.log("[startup] email follow-up worker started"); }
  catch (err) { console.error("[startup] email follow-up worker failed to start:", err); }

  // BF_SERVER_PRODUCT_KNOWLEDGE_SYNC_v1 - keep Maya product knowledge in sync with lender_products (incl. manual/SQL inserts).
  const { startProductKnowledgeWorker } = await import("../workers/productKnowledgeWorker.js");
  await workerStagger();
  try { const w = startProductKnowledgeWorker(pool); workerStops.push(w.stop); console.log("[startup] product-knowledge worker started"); }
  catch (err) { console.error("[startup] product-knowledge worker failed to start:", err); }

  // BF_SERVER_ADS_WEEKLY_EMAIL_v708
  const { startAdsWeeklyEmailWorker } = await import("../workers/adsWeeklyEmailWorker.js");
  await workerStagger();
  try { const w = startAdsWeeklyEmailWorker(pool); workerStops.push(w.stop); console.log("[startup] ads-weekly-email worker started"); }
  catch (err) { console.error("[startup] ads-weekly-email worker failed to start:", err); }

  // BF_SERVER_ADS_WAREHOUSE_v1 - own Google Ads history locally.
  const { startGoogleAdsWarehouseWorker } = await import("../workers/googleAdsWarehouseWorker.js");
  await workerStagger();
  try { const w = startGoogleAdsWarehouseWorker(pool); workerStops.push(w.stop); console.log("[startup] ads-warehouse worker started"); }
  catch (err) { console.error("[startup] ads-warehouse worker failed to start:", err); }

  // BF_SERVER_MARKETING_KNOWLEDGE_v1 - ingest marketing templates + collateral into Maya knowledge.
  const { startMarketingKnowledgeWorker } = await import("../workers/marketingKnowledgeWorker.js");
  await workerStagger();
  try { const w = startMarketingKnowledgeWorker(pool); workerStops.push(w.stop); console.log("[startup] marketing-knowledge worker started"); }
  catch (err) { console.error("[startup] marketing-knowledge worker failed to start:", err); }

  // BF_SERVER_TEAMS_TRANSCRIPT_POLLER_v1 - pull Teams transcripts + recording links onto the CRM timeline.
  // BF_SERVER_BOOKINGS_TO_CRM_v1 - Microsoft Bookings appointments were displayed on the
  // calendar and nothing else; the prospect never became a CRM record.
  const { startBookingsWorker } = await import("../workers/bookingsWorker.js");
  await workerStagger();
  try { const b = startBookingsWorker(pool); workerStops.push(b.stop); console.log("[startup] bookings worker started"); }
  catch (e: any) { console.error("[startup] bookings worker failed to start", { message: e?.message }); }

  // BF_SERVER_TEAM_PHASE_C_v671 - Team "Remind me" reminders.
  const { startTeamReminderWorker } = await import("../workers/teamReminderWorker.js");
  await workerStagger();
  try { const w = startTeamReminderWorker(); workerStops.push(w.stop); console.log("[startup] team-reminder worker started"); }
  catch (err) { console.error("[startup] team-reminder worker failed to start:", err); }

  const { startTeamsTranscriptWorker } = await import("../workers/teamsTranscriptWorker.js");
  await workerStagger();
  try { const w = startTeamsTranscriptWorker(pool); workerStops.push(w.stop); console.log("[startup] teams-transcript worker started"); }
  catch (err) { console.error("[startup] teams-transcript worker failed to start:", err); }

  // BF_SERVER_GRAPH_WEBHOOKS_v1 - keep Graph mail subscriptions alive.
  const { startGraphSubscriptionWorker } = await import("../workers/graphSubscriptionWorker.js");
  await workerStagger();
  try { const gt = startGraphSubscriptionWorker(); workerStops.push(() => clearInterval(gt)); console.log("[startup] graph-subscription worker started"); }
  catch (err) { console.error("[startup] graph-subscription worker failed to start:", err); }

  const { startScheduledEmailWorker } = await import("../workers/scheduledEmailWorker.js");
  await workerStagger();
  try { const w = startScheduledEmailWorker(pool); workerStops.push(w.stop); console.log("[startup] scheduled-email worker started"); }
  catch (err) { console.error("[startup] scheduled-email worker failed to start:", err); }

  const { startSmsCascadeWorker } = await import("../workers/smsCascadeWorker.js");
  await workerStagger();
  try { const w = startSmsCascadeWorker(pool); workerStops.push(w.stop); console.log("[startup] sms-cascade worker started"); }
  catch (err) { console.error("[startup] sms-cascade worker failed to start:", err); }

  const { startSendQueueWorker } = await import("../workers/sendQueueWorker.js");
  await workerStagger();
  try { const w = startSendQueueWorker(pool); workerStops.push(w.stop); console.log("[startup] send-queue worker started"); }
  catch (err) { console.error("[startup] send-queue worker failed to start:", err); }

  // BF_SERVER_DEAD_LETTER_WORKER_v110
  // failed_jobs has four live producers - sms.service, ocr.provider, aiService
  // and crmWebhook all pushDeadLetter() on failure - and nothing has ever
  // drained it. Every failed SMS, OCR job, AI call and CRM lead push since the
  // table was created has been sitting there unretried, which is invisible:
  // the producer already returned successfully to its caller.
  //
  // Takes no pool argument, unlike the workers around it: it imports the pool
  // directly. Kept as-is rather than changed, so this block only starts the
  // worker and does not also alter how it reaches the database.
  const { startDeadLetterWorker } = await import("../workers/deadLetterWorker.js");
  await workerStagger();
  try { const w = startDeadLetterWorker(); workerStops.push(w.stop); console.log("[startup] dead-letter worker started"); }
  catch (err) { console.error("[startup] dead-letter worker failed to start:", err); }

  // BF_SERVER_BLOCK_v785_SEQUENCES
  const { startSequenceWorker } = await import("../workers/sequenceWorker.js");
  await workerStagger();
  try { const w = startSequenceWorker(pool); workerStops.push(w.stop); console.log("[startup] sequence worker started"); }
  catch (err) { console.error("[startup] sequence worker failed to start:", err); }

  // BF_SERVER_BLOCK_v787_EMAIL_REPLY_STOP_WORKER
  const { startMailReplyWorker } = await import("../workers/mailReplyWorker.js");
  await workerStagger();
  try { const w = startMailReplyWorker(pool); workerStops.push(w.stop); console.log("[startup] mail-reply worker started"); }
  catch (err) { console.error("[startup] mail-reply worker failed to start:", err); }

  // BF_SERVER_AD_CONVERSION_WORKER_v1 - upload offline conversions to Google Ads.
  const { startAdConversionWorker } = await import("../workers/adConversionWorker.js");
  await workerStagger();
  try { const w = startAdConversionWorker(pool); workerStops.push(w.stop); console.log("[startup] ad-conversion worker started"); }
  catch (err) { console.error("[startup] ad-conversion worker failed to start:", err); }

  // BF_SERVER_TODO_RECONCILE_v773 - every task (whatever created it) to and from Microsoft To Do.
  const { startTodoReconcileWorker } = await import("../workers/todoReconcileWorker.js");
  await workerStagger();
  try { const w = startTodoReconcileWorker(pool); workerStops.push(w.stop); console.log("[startup] todo-reconcile worker started"); }
  catch (err) { console.error("[startup] todo-reconcile worker failed to start:", err); }

  // KS_SERVER_v12_GOOGLE_WORKSPACE - every task to and from Google Tasks for staff on Google (no Microsoft sign-in).
  const { startGoogleTasksWorker } = await import("../workers/googleTasksWorker.js");
  await workerStagger();
  try { const w = startGoogleTasksWorker(pool); workerStops.push(w.stop); console.log("[startup] google-tasks worker started"); }
  catch (err) { console.error("[startup] google-tasks worker failed to start:", err); }

  // KS_SERVER_v12_GOOGLE_WORKSPACE - Gmail inbox sync is built but OFF: it starts only with
  // KS_GOOGLE_GMAIL_READ_ENABLED=true (written by KS-Ops after Google's CASA assessment; GOOGLE_GMAIL_READ_ENABLED also works).
  const { gmailReadEnabled } = await import("../services/workspace/googleConfig.js");
  if (gmailReadEnabled()) {
    const { startGmailSyncWorker } = await import("../workers/gmailSyncWorker.js");
    await workerStagger();
    try { const w = startGmailSyncWorker(pool); workerStops.push(w.stop); console.log("[startup] gmail-sync worker started"); }
    catch (err) { console.error("[startup] gmail-sync worker failed to start:", err); }
  }

  // KS_SERVER_v13_QUICKBOOKS - fee invoices to the licensee's QuickBooks (idle while QBO_* is unset or not connected).
  const { startQuickBooksInvoiceWorker } = await import("../workers/quickbooksInvoiceWorker.js");
  await workerStagger();
  try { const w = startQuickBooksInvoiceWorker(pool); workerStops.push(w.stop); console.log("[startup] quickbooks-invoice worker started"); }
  catch (err) { console.error("[startup] quickbooks-invoice worker failed to start:", err); }

  // KS_SERVER_v16_DATA_IMPORT - the Import data wizard's dry runs, runs and undos, one at a time.
  // KS_SERVER_v20_WEBHOOKS - outgoing webhook deliveries (the outbox the row triggers fill).
  const { startOutboundWebhookWorker } = await import("../workers/outboundWebhookWorker.js");
  await workerStagger();
  try { const w = startOutboundWebhookWorker(pool); workerStops.push(w.stop); console.log("[startup] outbound-webhook worker started"); }
  catch (err) { console.error("[startup] outbound-webhook worker failed to start:", err); }
  // KS_SERVER_LENDER_API - lender API submit retries and status polling (growth and up).
  const { startLenderSyncWorker } = await import("../workers/lenderSyncWorker.js");
  await workerStagger();
  try { const w = startLenderSyncWorker(pool); workerStops.push(w.stop); console.log("[startup] lender-sync worker started"); }
  catch (err) { console.error("[startup] lender-sync worker failed to start:", err); }
  const { startDataImportWorker } = await import("../workers/dataImportWorker.js");
  await workerStagger();
  try { const w = startDataImportWorker(pool); workerStops.push(w.stop); console.log("[startup] data-import worker started"); }
  catch (err) { console.error("[startup] data-import worker failed to start:", err); }

  // BF_SERVER_TASKS_M6_v1 - task reminders + recurrence catch-up + daily digest.
  const { startTaskRemindersWorker } = await import("../workers/taskRemindersWorker.js");
  await workerStagger();
  try { const w = startTaskRemindersWorker(pool); workerStops.push(w.stop); console.log("[startup] task-reminders worker started"); }
  catch (err) { console.error("[startup] task-reminders worker failed to start:", err); }

  // KS_SETTINGS_PACK_v1_NPS - post-funding surveys (Growth and Pro).
  const { startNpsSurveyWorker } = await import("../workers/npsSurveyWorker.js");
  await workerStagger();
  try { const w = startNpsSurveyWorker(pool); workerStops.push(w.stop); console.log("[startup] nps-survey worker started"); }
  catch (err) { console.error("[startup] nps-survey worker failed to start:", err); }

  // KS_HUBSPOT_GAPS_1_MEETING_NOTES - Zoom and Google Meet transcripts in, then the AI summary.
  const { startMeetingNotesWorker } = await import("../workers/meetingNotesWorker.js");
  await workerStagger();
  try { const w = startMeetingNotesWorker(pool); workerStops.push(w.stop); console.log("[startup] meeting-notes worker started"); }
  catch (err) { console.error("[startup] meeting-notes worker failed to start:", err); }

  // KS_HUBSPOT_GAPS_1_CALL_QUEUES - call queues: offers nobody answered, callers past the longest wait, dispatch.
  const { startCallQueueWorker } = await import("../workers/callQueueWorker.js");
  await workerStagger();
  try { const w = startCallQueueWorker(pool); workerStops.push(w.stop); console.log("[startup] call-queue worker started"); }
  catch (err) { console.error("[startup] call-queue worker failed to start:", err); }

  // KS_HUBSPOT_GAPS_1_PAYMENTS - payment links: QuickBooks retries and expiry.
  const { startPaymentLinksWorker } = await import("../workers/paymentLinksWorker.js");
  await workerStagger();
  try { const w = startPaymentLinksWorker(pool); workerStops.push(w.stop); console.log("[startup] payment-links worker started"); }
  catch (err) { console.error("[startup] payment-links worker failed to start:", err); }

  // KS_SETTINGS_PACK_v1_BOOKING - booking reminders 24 h and 1 h before.
  const { startBookingRemindersWorker } = await import("../workers/bookingRemindersWorker.js");
  await workerStagger();
  try { const w = startBookingRemindersWorker(pool); workerStops.push(w.stop); console.log("[startup] booking-reminders worker started"); }
  catch (err) { console.error("[startup] booking-reminders worker failed to start:", err); }

  // KS_SERVER_v11_PGI - PGI referrals to the insurance partner: send, forward documents, sync, resend replies.
  const { startPgiReferralWorker } = await import("../workers/pgiReferralWorker.js");
  await workerStagger();
  try { const w = startPgiReferralWorker(pool); workerStops.push(w.stop); console.log("[startup] pgi-referral worker started"); }
  catch (err) { console.error("[startup] pgi-referral worker failed to start:", err); }

  // BF_SERVER_FX_RATE_WORKER_v355 - daily Bank of Canada USD->CAD rate.
  const { startFxRateWorker } = await import("../workers/fxRateWorker.js");
  await workerStagger();
  try { const w = startFxRateWorker(pool); workerStops.push(w.stop); console.log("[startup] fx-rate worker started"); }
  catch (err) { console.error("[startup] fx-rate worker failed to start:", err); }

  // BF_SERVER_BLOCK_v494_LENDER_EMAIL_BOUNCES - read lender bounce notices.
  // BF_SERVER_REPORTS15_18_v786 - daily pipeline snapshots for the Pipeline snapshot report.
  const { startPipelineSnapshotWorker } = await import("../workers/pipelineSnapshotWorker.js");
  await workerStagger();
  try { const w = startPipelineSnapshotWorker(pool); workerStops.push(w.stop); console.log("[startup] pipeline-snapshot worker started"); }
  catch (err) { console.error("[startup] pipeline-snapshot worker failed to start:", err); }
  const { startLenderBounceWorker } = await import("../workers/lenderBounceWorker.js");
  await workerStagger();
  try { const w = startLenderBounceWorker(pool); workerStops.push(w.stop); console.log("[startup] lender-bounce worker started"); }
  catch (err) { console.error("[startup] lender-bounce worker failed to start:", err); }
  // BF_SERVER_v823_LIVE_ACTIVITY - the client app's lock-screen application status.
  const { startClientStatusWorker } = await import("../workers/clientStatusWorker.js");
  await workerStagger();
  try { const w = startClientStatusWorker(pool); workerStops.push(w.stop); console.log("[startup] client-status worker started"); }
  catch (err) { console.error("[startup] client-status worker failed to start:", err); }
  // KS_SERVER_v6_PLANS - trial and storage notices to the licensee's admins.
  const { startPlanNoticesWorker } = await import("../workers/planNoticesWorker.js");
  await workerStagger();
  try { const w = startPlanNoticesWorker(pool); workerStops.push(w.stop); console.log("[startup] plan-notices worker started"); }
  catch (err) { console.error("[startup] plan-notices worker failed to start:", err); }
  // KS_SERVER_PHONE_PROVISIONING - releases phone numbers after their grace period (never silently).
  const { startPhoneNumberWorker } = await import("../workers/phoneNumberWorker.js");
  await workerStagger();
  try { const w = startPhoneNumberWorker(pool); workerStops.push(w.stop); console.log("[startup] phone-number worker started"); }
  catch (err) { console.error("[startup] phone-number worker failed to start:", err); }
  // KS_SERVER_MARKETING_ADDON - lead scores refreshed every 30 minutes while the Marketing add-on is on.
  const { startLeadScoreWorker } = await import("../workers/leadScoreWorker.js");
  await workerStagger();
  try { const w = startLeadScoreWorker(pool); workerStops.push(w.stop); console.log("[startup] lead-score worker started"); }
  catch (err) { console.error("[startup] lead-score worker failed to start:", err); }
  // KS_SERVER_ACTIVE_CONTRACTS - funded files become contracts; renewal engine; lender statement intake (hourly, Growth+ only).
  const { startActiveContractsWorker } = await import("../workers/activeContractsWorker.js");
  await workerStagger();
  try { const w = startActiveContractsWorker(pool); workerStops.push(w.stop); console.log("[startup] active-contracts worker started"); }
  catch (err) { console.error("[startup] active-contracts worker failed to start:", err); }
  // KS_BROKER_TOOLS_2 - invoice equipment onto contracts, credit line expiry reminders, contract signing status.
  const { startBrokerToolsWorker } = await import("../workers/brokerToolsWorker.js");
  await workerStagger();
  try { const w = startBrokerToolsWorker(pool); workerStops.push(w.stop); console.log("[startup] broker-tools worker started"); }
  catch (err) { console.error("[startup] broker-tools worker failed to start:", err); }
  // KS_SERVER_v8_OPS_LINK - daily usage reports to Keystone operations.
  const { startUsageReportWorker } = await import("../workers/usageReportWorker.js");
  await workerStagger();
  try { const w = startUsageReportWorker(pool); workerStops.push(w.stop); if (w.started) console.log("[startup] usage-report worker started"); }
  catch (err) { console.error("[startup] usage-report worker failed to start:", err); }
  // KS_STAFF_DIRECTORY_v1 - the staff list (hashes) to Keystone operations, so the apps find this server by email/phone.
  const { startStaffDirectoryWorker } = await import("../workers/staffDirectoryWorker.js");
  await workerStagger();
  try { const w = startStaffDirectoryWorker(pool); workerStops.push(w.stop); if (w.started) console.log("[startup] staff-directory worker started"); }
  catch (err) { console.error("[startup] staff-directory worker failed to start:", err); }
  // KS_SERVER_v8_PURGE - a cancelled licensee's data is deleted 180 days after cancellation (with warnings).
  // KS_SERVER_v9_FRAUD - the fraud checks queue, the watchlist sync and the inside-job alerts.
  const { startFraudWorker } = await import("../workers/fraudWorker.js");
  await workerStagger();
  try {
    const { getLicenseeSettings } = await import("../licensee/settings.js");
    const w = startFraudWorker(pool, { licenseeCountry: async () => (await getLicenseeSettings(pool as any)).country || null });
    workerStops.push(w.stop); console.log("[startup] fraud worker started");
  }
  catch (err) { console.error("[startup] fraud worker failed to start:", err); }
  const { startLicenseePurgeWorker } = await import("../workers/licenseePurgeWorker.js");
  await workerStagger();
  try { const w = startLicenseePurgeWorker(pool); workerStops.push(w.stop); console.log("[startup] licensee-purge worker started"); }
  catch (err) { console.error("[startup] licensee-purge worker failed to start:", err); }
}
