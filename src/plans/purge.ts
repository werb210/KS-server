// KS_SERVER_v8_PURGE - a cancelled licensee's data is kept for 180 days after cancelled_at, then deleted.
//   173 days: "your data will be deleted in 7 days" to the admins and support address (once)
//   179 days: "... in 1 day" (once)
//   180 days: every table is emptied (except schema_migrations, licensee_settings and licensee_plan, which record what
//             happened) and every file in this copy's blob containers is deleted; purged_at is recorded and logged.
// Nothing happens unless service_status is 'cancelled' - checked when the run starts and again just before deleting.
// Operations reinstating the licensee (any other status) clears cancelled_at and the warnings (see state.ts setPlan).
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
  /** Deletes every blob in the container; returns how many. */
  emptyContainer?: (container: string) => Promise<number>;
  env?: NodeJS.ProcessEnv;
};

export type PurgeRun =
  | { action: "none"; reason: string }
  | { action: "warned"; days_left: 7 | 1 }
  | { action: "would_purge"; tables: string[]; containers: string[] }
  | { action: "purged"; tables: string[]; containers: Record<string, number> };

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
      `${company}'s service was cancelled, and its data has been kept for 180 days. On ${when} all of it - contacts, applications, messages, call records and uploaded documents - will be permanently deleted.`,
      "To keep a copy, an admin can sign in to the staff portal and download the data export from the Plan page before then.",
      "To restore the service instead, contact support.",
    ]),
  };
}

async function emptyAzureContainer(container: string): Promise<number> {
  const conn = String(process.env.AZURE_STORAGE_CONNECTION_STRING ?? "");
  if (!conn) return 0;
  const { BlobServiceClient } = await import("@azure/storage-blob");
  const client = BlobServiceClient.fromConnectionString(conn).getContainerClient(container);
  if (!(await client.exists())) return 0;
  let n = 0;
  for await (const blob of client.listBlobsFlat()) {
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
  if (row.purged_at) return { action: "none", reason: "already_purged" };
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

  console.warn("[licensee-purge] deleting all licensee data", { cancelled_at: cancelledAt.toISOString(), tables: tables.length, containers });
  if (tables.length) await db.query(`TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  const emptied: Record<string, number> = {};
  const empty = opts.emptyContainer ?? emptyAzureContainer;
  for (const c of containers) {
    try {
      emptied[c] = await empty(c);
    } catch (err) {
      console.error("[licensee-purge] container not emptied; will retry next run", c, (err as Error)?.message ?? String(err));
      return { action: "none", reason: `container_failed:${c}` };
    }
  }
  await db.query(`UPDATE licensee_plan SET purged_at = now() WHERE id = 1`);
  clearPlanCache();
  console.warn("[licensee-purge] done: all licensee data and stored documents deleted", { tables: tables.length, files: emptied });
  return { action: "purged", tables, containers: emptied };
}
