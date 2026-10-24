// KS_SERVER_v8_PURGE - a cancelled licensee's data is kept for 180 days after cancelled_at, then deleted.
//   173 days: "your data will be deleted in 7 days" to the admins and support address (once)
//   179 days: "... in 1 day" (once)
//   180 days: every table is emptied (except schema_migrations, licensee_settings and licensee_plan, which record what
//             happened) and every file in this copy's blob containers is deleted; purged_at is recorded and logged.
// Nothing happens unless service_status is 'cancelled' - checked when the run starts and again just before deleting.
// Operations reinstating the licensee (any other status) clears cancelled_at and the warnings (see state.ts setPlan).
//
// KS_SERVER_v14_RETENTION - records still inside the 7-year retention period, or under a legal hold, are NOT
// destroyed by the purge. Why this design: the brokerage is the regulated lender/broker and must be able to produce a
// file for 7 years after it closes (or for as long as a hold lasts), whether or not it still uses Keystone. An auditor
// expects the records to exist, be unchanged and be retrievable for that period - and everything else to be gone on
// schedule. So, at day 180, in one transaction:
//   1. the records to keep are copied into the retention_archive schema: each application still in retention or held
//      (an open file counts as closed on the cancellation date), its documents, document versions, lender packages,
//      stage history, lender submissions and linked contacts / companies; audit events younger than 7 years; and every
//      legal hold. Each archive table gets a trigger that refuses UPDATE and DELETE, so the copy is read-only.
//   2. every public table is emptied as before (the live copy holds nothing), and every stored file is deleted EXCEPT
//      the files of the archived applications.
//   3. licensee_plan records what was kept (counts, the last keep-until date) as the attestation of the purge.
// The database and the blob storage are encrypted at rest by Azure; nothing in the archive is reachable through the
// API (users are gone), so Keystone retrieves a file for the licensee or an auditor on written request.
// Each later run finishes the purge as records come due: archived files past their 7 years and not held (and their
// stored files) are deleted; when nothing is left the archive schema is dropped and retention_released_at is set.
// The export stays available to the licensee's admins for the whole 180 days, as before.
import { brandName, supportEmail } from "../licensee/brand.js";
import { bodies, sendPlanMail, type PlanMailer } from "./email.js";
import { readPlanRow, clearPlanCache, type Q } from "./state.js";
import { adminEmails } from "./storage.js";

export const PURGE_AFTER_DAYS = 180;
const DAY = 86_400_000;
/** Kept through a purge: the migration ledger (so the server still starts) and the records of the purge itself. */
export const PURGE_KEEP_TABLES: ReadonlySet<string> = new Set(["schema_migrations", "licensee_settings", "licensee_plan"]);

/** The blob containers this server writes to (same settings and defaults as the code that writes them). */
export function purgeContainers(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set([
    env.AZURE_STORAGE_CONTAINER_BF || "bf-documents",
    env.VOICEMAIL_BLOB_CONTAINER || "voicemails",
    env.SIGNNOW_BLOB_CONTAINER || "signed-applications",
    env.AZURE_STORAGE_CONTAINER_MMS || "mms-inbound",
    env.AZURE_STORAGE_CONTAINER_MARKETING || "marketing-assets",
  ].map((c) => String(c).trim()).filter(Boolean))];
}

export type PurgeDeps = {
  send?: PlanMailer;
  /** Deletes every blob in the container except those keep() says to keep; returns how many were deleted. */
  emptyContainer?: (container: string, keep: (blobName: string) => boolean) => Promise<number>;
  env?: NodeJS.ProcessEnv;
};

export type PurgeRun =
  | { action: "none"; reason: string }
  | { action: "warned"; days_left: 7 | 1 }
  | { action: "would_purge"; tables: string[]; containers: string[] }
  | { action: "purged"; tables: string[]; containers: Record<string, number>; retained: RetentionArchiveSummary }
  | { action: "retention_released"; applications: number; audit_events: number; containers: Record<string, number>; archive_dropped: boolean };

/** KS_SERVER_v14_RETENTION - what the purge kept, stored on licensee_plan.retention_archive. */
export type RetentionArchiveSummary = {
  applications: number;
  documents: number;
  audit_events: number;
  holds: number;
  files: number;
  /** The last date anything in the archive is kept until (null when the archive is empty or only holds remain). */
  kept_until: string | null;
};

export const RETENTION_ARCHIVE_SCHEMA = "retention_archive";
const A = RETENTION_ARCHIVE_SCHEMA;
/** Child tables copied with an archived application (each has application_id). */
const ARCHIVE_APPLICATION_TABLES = [
  "application_packages", "application_stage_history", "application_stage_events", "lender_submissions", "application_contacts",
] as const;
const ARCHIVE_TABLES = [
  "kept_applications", "applications", "documents", "document_versions", ...ARCHIVE_APPLICATION_TABLES,
  "contacts", "companies", "audit_events", "legal_holds", "blobs",
] as const;

function isoLiteral(d: Date): string {
  const iso = d.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(iso)) throw new Error("bad_timestamp");
  return `'${iso}'::timestamptz`;
}

/**
 * The SQL that copies what must be kept into retention_archive, read-only, in one transaction. Open files count as
 * closed on the cancellation date. CREATE TABLE IF NOT EXISTS: a re-run after a partial purge keeps the first copy.
 */
export function retentionArchiveSql(cancelledAt: Date, now: Date): string {
  const C = isoLiteral(cancelledAt);
  const N = isoLiteral(now);
  const kept = `(SELECT application_id FROM ${A}.kept_applications)`;
  const keepUntil = `GREATEST(ra.created_at, COALESCE(ra.last_upload_at, ra.created_at), COALESCE(ra.closed_at, ${C})) + interval '7 years'`;
  const stmts = [
    "BEGIN",
    `CREATE SCHEMA IF NOT EXISTS ${A}`,
    `CREATE TABLE IF NOT EXISTS ${A}.kept_applications AS
       SELECT ra.application_id, ra.held, ${keepUntil} AS retain_until
         FROM public.retention_applications ra
        WHERE ra.is_record AND (ra.held OR ${keepUntil} > ${N})`,
    `CREATE TABLE IF NOT EXISTS ${A}.applications AS SELECT a.* FROM public.applications a WHERE a.id::text IN ${kept}`,
    `CREATE TABLE IF NOT EXISTS ${A}.documents AS SELECT d.* FROM public.documents d WHERE d.application_id::text IN ${kept}`,
    `CREATE TABLE IF NOT EXISTS ${A}.document_versions AS
       SELECT v.* FROM public.document_versions v WHERE v.document_id::text IN (SELECT id::text FROM ${A}.documents)`,
    ...ARCHIVE_APPLICATION_TABLES.map((t) => `CREATE TABLE IF NOT EXISTS ${A}.${t} AS SELECT x.* FROM public.${t} x WHERE x.application_id::text IN ${kept}`),
    `CREATE TABLE IF NOT EXISTS ${A}.legal_holds AS SELECT h.* FROM public.legal_holds h`,
    `CREATE TABLE IF NOT EXISTS ${A}.contacts AS
       SELECT c.* FROM public.contacts c
        WHERE c.id IN (SELECT contact_id FROM ${A}.applications WHERE contact_id IS NOT NULL
                       UNION SELECT contact_id FROM ${A}.application_contacts)
           OR c.id::text IN (SELECT target_id FROM ${A}.legal_holds WHERE released_at IS NULL AND target_type = 'contact')
           OR c.company_id::text IN (SELECT target_id FROM ${A}.legal_holds WHERE released_at IS NULL AND target_type = 'company')`,
    `CREATE TABLE IF NOT EXISTS ${A}.companies AS
       SELECT co.* FROM public.companies co
        WHERE co.id IN (SELECT company_id FROM ${A}.applications WHERE company_id IS NOT NULL
                        UNION SELECT company_id FROM ${A}.contacts WHERE company_id IS NOT NULL)
           OR co.id::text IN (SELECT target_id FROM ${A}.legal_holds WHERE released_at IS NULL AND target_type = 'company')`,
    `CREATE TABLE IF NOT EXISTS ${A}.audit_events AS SELECT e.* FROM public.audit_events e WHERE e.created_at > ${N} - interval '7 years'`,
    `CREATE TABLE IF NOT EXISTS ${A}.blobs AS
       SELECT DISTINCT x.application_id, x.blob_name FROM (
         SELECT d.application_id::text AS application_id, unnest(ARRAY[d.blob_name, d.storage_key, d.object_key, d.storage_path]) AS blob_name
           FROM ${A}.documents d
         UNION ALL
         SELECT d.application_id::text, v.blob_name FROM ${A}.document_versions v JOIN ${A}.documents d ON d.id::text = v.document_id::text
         UNION ALL
         SELECT p.application_id::text, p.blob_name FROM ${A}.application_packages p
       ) x WHERE x.blob_name IS NOT NULL AND x.blob_name <> ''`,
    `CREATE OR REPLACE FUNCTION ${A}.read_only() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF current_setting('ks.retention_release', true) = 'on' THEN
         RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
       END IF;
       RAISE EXCEPTION 'retention archive is read-only';
     END
     $$`,
    ...ARCHIVE_TABLES.flatMap((t) => [
      `DROP TRIGGER IF EXISTS read_only ON ${A}.${t}`,
      `CREATE TRIGGER read_only BEFORE UPDATE OR DELETE ON ${A}.${t} FOR EACH ROW EXECUTE FUNCTION ${A}.read_only()`,
    ]),
    "COMMIT",
  ];
  return stmts.join(";\n") + ";";
}

async function archiveSummary(db: Q): Promise<RetentionArchiveSummary> {
  const r = await db.query(
    `SELECT (SELECT count(*) FROM ${A}.kept_applications)::int AS applications,
            (SELECT count(*) FROM ${A}.documents)::int AS documents,
            (SELECT count(*) FROM ${A}.audit_events)::int AS audit_events,
            (SELECT count(*) FROM ${A}.legal_holds WHERE released_at IS NULL)::int AS holds,
            (SELECT count(*) FROM ${A}.blobs)::int AS files,
            GREATEST((SELECT max(retain_until) FROM ${A}.kept_applications),
                     (SELECT max(created_at) + interval '7 years' FROM ${A}.audit_events)) AS kept_until`,
  );
  const x = r.rows[0] ?? {};
  const until = x.kept_until ? new Date(x.kept_until) : null;
  return {
    applications: Number(x.applications ?? 0), documents: Number(x.documents ?? 0), audit_events: Number(x.audit_events ?? 0),
    holds: Number(x.holds ?? 0), files: Number(x.files ?? 0),
    kept_until: until && !Number.isNaN(until.getTime()) ? until.toISOString().slice(0, 10) : null,
  };
}

/** Whether a stored file belongs to one of these applications: listed by name, or under the application's folder. */
export function blobKeeper(names: Iterable<string>, applicationIds: Iterable<string>): (blobName: string) => boolean {
  const keepNames = new Set(names);
  const ids = [...applicationIds].filter(Boolean);
  return (blobName: string) => {
    if (keepNames.has(blobName)) return true;
    const parts = blobName.split("/");
    return ids.some((id) => parts.includes(id));
  };
}

async function archivedBlobs(db: Q, exceptApplications?: string): Promise<{ names: string[]; ids: string[] }> {
  const where = exceptApplications ? ` WHERE application_id NOT IN ${exceptApplications}` : "";
  const b = await db.query(`SELECT blob_name FROM ${A}.blobs${where}`);
  const k = await db.query(`SELECT application_id FROM ${A}.kept_applications${where}`);
  return { names: b.rows.map((r: any) => String(r.blob_name)), ids: k.rows.map((r: any) => String(r.application_id)) };
}

async function purgeTables(db: Q): Promise<string[]> {
  const r = await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  return r.rows.map((x: any) => String(x.table_name)).filter((t: string) => /^[a-z_][a-z0-9_]*$/.test(t) && !PURGE_KEEP_TABLES.has(t));
}

async function recipients(db: Q): Promise<string[]> {
  const list = await adminEmails(db);
  const support = supportEmail();
  if (support) list.push(support);
  return [...new Set(list.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")))];
}

export function purgeWarningMail(company: string, daysLeft: 7 | 1, purgeOn: Date) {
  const when = purgeOn.toISOString().slice(0, 10);
  return {
    subject: `${company}: your data will be deleted in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
    ...bodies([
      `${company}'s service was cancelled, and its data has been kept for 180 days. On ${when} it will be permanently deleted - contacts, applications, messages, call records and uploaded documents.`,
      "Lending records still inside the 7-year retention period, or under a legal hold, are not destroyed: they are kept read-only and encrypted, out of use, and deleted when their 7 years are up. Ask support for a copy at any time.",
      "To keep a copy of everything, an admin can sign in to the staff portal and download the data export from the Plan page before then.",
      "To restore the service instead, contact support.",
    ]),
  };
}

async function emptyAzureContainer(container: string, keep: (blobName: string) => boolean = () => false): Promise<number> {
  const conn = String(process.env.AZURE_STORAGE_CONNECTION_STRING ?? "");
  if (!conn) return 0;
  const { BlobServiceClient } = await import("@azure/storage-blob");
  const client = BlobServiceClient.fromConnectionString(conn).getContainerClient(container);
  if (!(await client.exists())) return 0;
  let n = 0;
  for await (const blob of client.listBlobsFlat()) {
    if (keep(blob.name)) continue;
    await client.getBlockBlobClient(blob.name).deleteIfExists();
    n += 1;
  }
  return n;
}

/** One run of the purge job. dryRun: report what would be deleted, delete nothing, send nothing. */
export async function runLicenseePurge(db: Q, now: Date = new Date(), opts: PurgeDeps & { dryRun?: boolean } = {}): Promise<PurgeRun> {
  const row = await readPlanRow(db);
  if (!row || row.service_status !== "cancelled") return { action: "none", reason: "not_cancelled" };
  if (!row.cancelled_at) return { action: "none", reason: "no_cancelled_at" };
  if (row.purged_at) {
    if (row.retention_archived_at && !row.retention_released_at && !opts.dryRun) return releaseRetentionArchive(db, now, opts);
    return { action: "none", reason: "already_purged" };
  }
  const cancelledAt = new Date(row.cancelled_at);
  const purgeOn = new Date(cancelledAt.getTime() + PURGE_AFTER_DAYS * DAY);
  const msLeft = purgeOn.getTime() - now.getTime();

  if (msLeft > 0) {
    if (opts.dryRun) return { action: "none", reason: "not_due" };
    const level: 7 | 1 | null = msLeft <= DAY && !row.purge_warning_1_sent_at ? 1
      : msLeft <= 7 * DAY && !row.purge_warning_7_sent_at && !row.purge_warning_1_sent_at ? 7 : null;
    if (!level) return { action: "none", reason: "not_due" };
    const col = level === 1 ? "purge_warning_1_sent_at" : "purge_warning_7_sent_at";
    const claimed = await db.query(
      `UPDATE licensee_plan SET ${col} = now() WHERE id = 1 AND ${col} IS NULL AND service_status = 'cancelled' RETURNING id`,
    );
    if (!(claimed.rowCount ?? claimed.rows.length)) return { action: "none", reason: "not_due" };
    const to = await recipients(db);
    const send = opts.send ?? sendPlanMail;
    const r = to.length ? await send({ to, ...purgeWarningMail(brandName(), level, purgeOn) }) : { ok: false, error: "no_recipients" };
    if (!r.ok) {
      console.warn("[licensee-purge] warning email failed; will retry", { level, error: r.error });
      await db.query(`UPDATE licensee_plan SET ${col} = NULL WHERE id = 1`);
      return { action: "none", reason: "warning_failed" };
    }
    return { action: "warned", days_left: level };
  }

  const tables = await purgeTables(db);
  const containers = purgeContainers(opts.env);
  if (opts.dryRun) return { action: "would_purge", tables, containers };

  // Last check right before deleting: operations may have reinstated the licensee since the run began.
  const again = await readPlanRow(db);
  if (again?.service_status !== "cancelled" || !again?.cancelled_at || again?.purged_at) return { action: "none", reason: "not_cancelled" };

  // KS_SERVER_v14_RETENTION - keep what retention and legal holds require, read-only, before anything is deleted.
  await db.query(retentionArchiveSql(cancelledAt, now));
  const retained = await archiveSummary(db);
  const kept = await archivedBlobs(db);
  const keep = blobKeeper(kept.names, kept.ids);
  console.warn("[licensee-purge] kept for retention", retained);

  console.warn("[licensee-purge] deleting all licensee data", { cancelled_at: cancelledAt.toISOString(), tables: tables.length, containers });
  if (tables.length) await db.query(`TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  const emptied: Record<string, number> = {};
  const empty = opts.emptyContainer ?? emptyAzureContainer;
  for (const c of containers) {
    try {
      emptied[c] = await empty(c, keep);
    } catch (err) {
      console.error("[licensee-purge] container not emptied; will retry next run", c, (err as Error)?.message ?? String(err));
      return { action: "none", reason: `container_failed:${c}` };
    }
  }
  await db.query(
    `UPDATE licensee_plan SET purged_at = now(), retention_archived_at = now(), retention_archive = $1::jsonb WHERE id = 1`,
    [JSON.stringify({ ...retained, cancelled_at: cancelledAt.toISOString(), purged_at: now.toISOString(), deleted_files: emptied })],
  );
  clearPlanCache();
  console.warn("[licensee-purge] done: licensee data and stored documents deleted; retained records archived", { tables: tables.length, files: emptied, retained });
  return { action: "purged", tables, containers: emptied, retained };
}

/**
 * KS_SERVER_v14_RETENTION - finishes the purge as archived records come due: an archived file past its 7 years with no
 * active hold (on it, a linked contact or company) is deleted with its stored files; audit events past 7 years go;
 * contacts and companies go once no archived file or hold needs them. When nothing is left the schema is dropped.
 */
export async function releaseRetentionArchive(db: Q, now: Date = new Date(), opts: PurgeDeps = {}): Promise<PurgeRun> {
  const N = isoLiteral(now);
  const activeHold = (type: string, idSql: string) =>
    `EXISTS (SELECT 1 FROM ${A}.legal_holds h WHERE h.released_at IS NULL AND h.target_type = '${type}' AND h.target_id = (${idSql})::text)`;
  const dueSelect = `SELECT k.application_id FROM ${A}.kept_applications k LEFT JOIN ${A}.applications a ON a.id::text = k.application_id
                 WHERE k.retain_until <= ${N}
                   AND NOT ${activeHold("application", "k.application_id")}
                   AND NOT ${activeHold("contact", "a.contact_id")}
                   AND NOT ${activeHold("company", "a.company_id")}
                   AND NOT EXISTS (SELECT 1 FROM ${A}.application_contacts ac JOIN ${A}.legal_holds h ON h.released_at IS NULL
                                     AND h.target_type = 'contact' AND h.target_id = ac.contact_id::text
                                    WHERE ac.application_id::text = k.application_id)`;
  const due = `(${dueSelect})`;
  const dueRows = await db.query(dueSelect);
  const dueIds = dueRows.rows.map((r: any) => String(r.application_id));
  const oldAudit = await db.query(`SELECT count(*)::int AS n FROM ${A}.audit_events WHERE created_at <= ${N} - interval '7 years'`);
  const auditDue = Number(oldAudit.rows[0]?.n ?? 0);
  if (!dueIds.length && !auditDue) {
    const left = await archiveSummary(db);
    if (left.applications || left.audit_events || left.holds) return { action: "none", reason: "retention_archive_kept" };
  }

  // Stored files first (deleting is idempotent), keeping those of every archived file that is not due.
  const emptied: Record<string, number> = {};
  if (dueIds.length) {
    const still = await archivedBlobs(db, due);
    const keep = blobKeeper(still.names, still.ids);
    const empty = opts.emptyContainer ?? emptyAzureContainer;
    for (const c of purgeContainers(opts.env)) {
      try {
        emptied[c] = await empty(c, keep);
      } catch (err) {
        console.error("[licensee-purge] retained files not released; will retry next run", c, (err as Error)?.message ?? String(err));
        return { action: "none", reason: `container_failed:${c}` };
      }
    }
  }

  await db.query([
    "BEGIN",
    "SET LOCAL ks.retention_release = 'on'",
    `CREATE TEMP TABLE released_now ON COMMIT DROP AS ${dueSelect}`,
    `DELETE FROM ${A}.document_versions WHERE document_id::text IN (SELECT id::text FROM ${A}.documents WHERE application_id::text IN (SELECT application_id FROM released_now))`,
    `DELETE FROM ${A}.documents WHERE application_id::text IN (SELECT application_id FROM released_now)`,
    ...ARCHIVE_APPLICATION_TABLES.map((t) => `DELETE FROM ${A}.${t} WHERE application_id::text IN (SELECT application_id FROM released_now)`),
    `DELETE FROM ${A}.blobs WHERE application_id IN (SELECT application_id FROM released_now)`,
    `DELETE FROM ${A}.applications WHERE id::text IN (SELECT application_id FROM released_now)`,
    `DELETE FROM ${A}.kept_applications WHERE application_id IN (SELECT application_id FROM released_now)`,
    `DELETE FROM ${A}.contacts c
      WHERE NOT EXISTS (SELECT 1 FROM ${A}.applications a WHERE a.contact_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM ${A}.application_contacts ac WHERE ac.contact_id = c.id)
        AND NOT ${activeHold("contact", "c.id")} AND NOT ${activeHold("company", "c.company_id")}`,
    `DELETE FROM ${A}.companies co
      WHERE NOT EXISTS (SELECT 1 FROM ${A}.applications a WHERE a.company_id = co.id)
        AND NOT EXISTS (SELECT 1 FROM ${A}.contacts c WHERE c.company_id = co.id)
        AND NOT ${activeHold("company", "co.id")}`,
    `DELETE FROM ${A}.audit_events WHERE created_at <= ${N} - interval '7 years'`,
    "COMMIT",
  ].join(";\n") + ";");

  const left = await archiveSummary(db);
  const dropped = !left.applications && !left.audit_events && !left.holds;
  if (dropped) {
    await db.query(`DROP SCHEMA IF EXISTS ${A} CASCADE`);
    await db.query(`UPDATE licensee_plan SET retention_released_at = now() WHERE id = 1`);
  }
  clearPlanCache();
  console.warn("[licensee-purge] retained records released", { applications: dueIds.length, audit_events: auditDue, files: emptied, archive_dropped: dropped });
  return { action: "retention_released", applications: dueIds.length, audit_events: auditDue, containers: emptied, archive_dropped: dropped };
}
