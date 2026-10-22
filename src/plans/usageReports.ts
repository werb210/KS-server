// KS_SERVER_v8_OPS_LINK - sends this copy's usage to Keystone operations.
//   * once a day (licensee time zone): the current month's UsageReport so far
//   * after a month ends: that month's final UsageReport (normally on the 1st)
// usage_report_posts keeps, per period, when the last daily and the final report got through. A failed post is
// recorded (last_attempt_at, last_error), logged, and simply tried again on the next run.
import { opsConfig, postToOps, type OpsFetch } from "./opsLink.js";
import type { Q } from "./state.js";
import { buildUsageReport, licenseeTimeZone, localDayOf, periodOf, previousPeriod } from "./usage.js";

export type UsageReportRun =
  | { skipped: true }
  | { skipped: false; posted: string[]; failed: string[] };

async function postRow(db: Q, period: string): Promise<Record<string, any> | null> {
  const r = await db.query(
    `SELECT period, last_posted_at, final_posted_at, last_attempt_at, last_error FROM usage_report_posts WHERE period = $1`,
    [period],
  );
  return r.rows[0] ?? null;
}

async function markResult(db: Q, period: string, kind: "daily" | "final", error: string | null): Promise<void> {
  if (error) {
    await db.query(
      `INSERT INTO usage_report_posts (period, last_attempt_at, last_error) VALUES ($1, now(), $2)
       ON CONFLICT (period) DO UPDATE SET last_attempt_at = now(), last_error = $2`,
      [period, error.slice(0, 500)],
    );
    return;
  }
  const col = kind === "final" ? "final_posted_at" : "last_posted_at";
  await db.query(
    `INSERT INTO usage_report_posts (period, ${col}, last_attempt_at, last_error) VALUES ($1, now(), now(), NULL)
     ON CONFLICT (period) DO UPDATE SET ${col} = now(), last_attempt_at = now(), last_error = NULL`,
    [period],
  );
}

export async function runUsageReports(
  db: Q,
  now: Date = new Date(),
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: OpsFetch } = {},
): Promise<UsageReportRun> {
  if (!opsConfig(opts.env)) return { skipped: true };
  const tz = licenseeTimeZone();
  const current = periodOf(now, tz);
  const previous = previousPeriod(current);
  const today = localDayOf(now, tz);
  const out = { skipped: false as const, posted: [] as string[], failed: [] as string[] };

  const send = async (period: string, kind: "daily" | "final") => {
    const report = await buildUsageReport(db, period, now);
    const r = await postToOps("usage-reports", report, opts);
    const label = `${period}:${kind}`;
    if (r.ok) {
      await markResult(db, period, kind, null);
      out.posted.push(label);
    } else {
      console.warn("[usage-reports] post to operations failed; will retry next run", { period, kind, error: r.error });
      await markResult(db, period, kind, r.error);
      out.failed.push(label);
    }
  };

  // The month that just ended: its final report, once.
  const prev = await postRow(db, previous);
  if (!prev?.final_posted_at) await send(previous, "final");

  // This month so far: once per local day.
  const cur = await postRow(db, current);
  const last = cur?.last_posted_at ? new Date(cur.last_posted_at) : null;
  if (!last || localDayOf(last, tz) !== today) await send(current, "daily");
  return out;
}
