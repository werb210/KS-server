// KS_SERVER_v8_USAGE_NOTICES - the monthly 80% / 100% emails for pooled call minutes and texts, to the licensee's
// admins and support address. Each (month, metric, level) is sent once: the marker row in usage_notices is claimed
// before the send and deleted again if the send fails, so two instances never both send and a failed send is retried
// on the next run. A new month has no markers, so the notices reset by themselves. Calls and texts are never cut off.
// KS_SERVER_MARKETING_ADDON - the same 80% / 100% notices for signings (4 included; never blocked, $2.50 each over) and
// campaign emails (without the add-on sends stop at the allowance; with it extra emails are billed).
import { brandName, supportEmail } from "../licensee/brand.js";
import { bodies, salesEmail, sendPlanMail, type PlanMailer } from "./email.js";
import { getPlanState, type Q } from "./state.js";
import { adminEmails } from "./storage.js";
import { OVERAGE_RATES, currentUsage } from "./usage.js";
import { MARKETING_ADDON, SIGNINGS } from "./marketing.js"; // KS_SERVER_MARKETING_ADDON

export type UsageMetric = "minutes" | "texts" | "signings" | "campaign_emails";
export const USAGE_METRICS: readonly UsageMetric[] = ["minutes", "texts", "signings", "campaign_emails"];
export type UsageLevel = 80 | 100;

/** The levels reached and not yet sent. 100 also covers 80 (no 80% email after a 100% one). */
export function usageNoticeDue(used: number, allowance: number, sent: Set<UsageLevel>): UsageLevel | null {
  if (!(allowance > 0)) return null;
  const pct = (used / allowance) * 100;
  if (pct >= 100 && !sent.has(100)) return 100;
  if (pct >= 80 && pct < 100 && !sent.has(80) && !sent.has(100)) return 80;
  return null;
}

const money = (n: number) => `$${n.toFixed(2)}`;

const WHAT: Record<UsageMetric, string> = { minutes: "call minutes", texts: "texts", signings: "e-signings", campaign_emails: "campaign emails" };

/** The second paragraph: what happens over the allowance. */
function overLine(metric: UsageMetric, addon: boolean): string {
  if (metric === "signings") {
    return `Signings are never blocked. Each signing after the ${SIGNINGS.included} included is ${money(SIGNINGS.overage_price)}, added to next month's bill automatically. A signing is one signature request sent to one signer.`;
  }
  if (metric === "campaign_emails") {
    return addon
      ? `Campaign emails keep going. With the Marketing add-on, extra campaign emails are $${MARKETING_ADDON.campaign_email_block_price} for each ${MARKETING_ADDON.campaign_email_block.toLocaleString("en-CA")} (or part), added to next month's bill.`
      : `When the allowance is used up, campaign emails stop until the 1st. The Marketing add-on ($${MARKETING_ADDON.price} a month) adds ${MARKETING_ADDON.extra_campaign_emails.toLocaleString("en-CA")} campaign emails a month.`;
  }
  const rate = metric === "minutes" ? `${money(OVERAGE_RATES.minute)} a minute` : `${money(OVERAGE_RATES.text)} a text`;
  return `Calls and texts are never cut off. Anything over the allowance is billed at ${rate}.`;
}

export function usageMail(company: string, metric: UsageMetric, level: UsageLevel, used: number, allowance: number, period: string, addon = false) {
  const what = WHAT[metric];
  const pooled = metric === "minutes" || metric === "texts" ? `pooled ${what}` : what;
  const pct = Math.floor((used / allowance) * 100);
  const head = level >= 100
    ? `${company} has used all of this month's ${pooled} (${used} of ${allowance}, ${period}).`
    : `${company} has used ${pct}% of this month's ${pooled} (${used} of ${allowance}, ${period}).`;
  const last = metric === "signings"
    ? `Every plan includes ${SIGNINGS.included} signings a month. Questions: ${salesEmail()}. The allowance starts again on the 1st.`
    : metric === "campaign_emails" && !addon
      ? `An admin can ask for the Marketing add-on on the Plan page in the staff portal, or email ${salesEmail()}. The allowance starts again on the 1st.`
      : `For a larger monthly allowance, an admin can press "Request upgrade" on the Plan page in the staff portal, or email ${salesEmail()}. The allowance starts again on the 1st.`;
  return {
    subject: level >= 100 ? `${company}: this month's ${what} are used up` : `${company}: ${pct}% of this month's ${what} used`,
    ...bodies([
      head,
      overLine(metric, addon),
      last,
    ]),
  };
}

async function recipients(db: Q): Promise<string[]> {
  const list = await adminEmails(db);
  const support = supportEmail();
  if (support) list.push(support);
  return [...new Set(list.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")))];
}

async function sentLevels(db: Q, period: string, metric: UsageMetric): Promise<Set<UsageLevel>> {
  const r = await db.query(`SELECT level FROM usage_notices WHERE period = $1 AND metric = $2`, [period, metric]);
  return new Set(r.rows.map((x: any) => Number(x.level) as UsageLevel));
}

async function claim(db: Q, period: string, metric: UsageMetric, level: UsageLevel): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO usage_notices (period, metric, level) VALUES ($1, $2, $3) ON CONFLICT (period, metric, level) DO NOTHING RETURNING level`,
    [period, metric, level],
  );
  return (r.rowCount ?? r.rows.length) > 0;
}

async function release(db: Q, period: string, metric: UsageMetric, level: UsageLevel): Promise<void> {
  await db.query(`DELETE FROM usage_notices WHERE period = $1 AND metric = $2 AND level = $3`, [period, metric, level]);
}

export type UsageNoticeResult = { sent: string[]; failed: string[] };

export async function runUsageNotices(db: Q, now: Date = new Date(), send: PlanMailer = sendPlanMail): Promise<UsageNoticeResult> {
  const out: UsageNoticeResult = { sent: [], failed: [] };
  const state = await getPlanState(db, now.getTime());
  const u = await currentUsage(db, now, state);
  const company = brandName();
  for (const metric of USAGE_METRICS) {
    const used = u[metric];
    // Texts: the add-on's bonus marketing texts (up to 1,000, marketing texts only) are part of the allowance.
    const allowance = metric === "texts" ? u.allowances.texts + Math.min(u.marketing_texts, u.allowances.bonus_marketing_texts) : u.allowances[metric];
    const level = usageNoticeDue(used, allowance, await sentLevels(db, u.period, metric));
    if (!level) continue;
    if (!(await claim(db, u.period, metric, level))) continue;
    // 100% also stands for 80%, so a later run never sends the 80% one this month.
    const claimed80 = level === 100 ? await claim(db, u.period, metric, 80) : false;
    const to = await recipients(db);
    const r = to.length ? await send({ to, ...usageMail(company, metric, level, used, allowance, u.period, u.marketing_addon) }) : { ok: false, error: "no_recipients" };
    const label = `${u.period}:${metric}:${level}`;
    if (r.ok) { out.sent.push(label); continue; }
    console.warn("[usage-notices] send failed", label, r.error);
    out.failed.push(label);
    await release(db, u.period, metric, level);
    if (claimed80) await release(db, u.period, metric, 80);
  }
  return out;
}
