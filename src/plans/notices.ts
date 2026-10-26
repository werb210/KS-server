// KS_SERVER_v6_PLANS - the once-only plan emails to the licensee's admins and support address:
//   * the trial has 3 days left        (trial_warning_sent_at)
//   * the trial has ended              (trial_ended_sent_at)
//   * storage reached 80% / 100%       (storage_80_sent_at / storage_100_sent_at, cleared when usage drops back below)
// Each marker is claimed with a conditional UPDATE before the send, and released again if the send fails, so two
// instances never both send and a failed send is retried on the next run. Uploads are never blocked.
import { brandName, supportEmail } from "../licensee/brand.js";
import {
  STORAGE_BLOCK_GB, STORAGE_BLOCK_PRICE, TRIAL_WARNING_DAYS, featureDef, storageNoticeDue, trialActive, trialOffered,
} from "./catalogue.js";
import { bodies, salesEmail, sendPlanMail, type PlanMailer } from "./email.js";
import { storageFor } from "./overview.js";
import { readPlanRow, rowToState, trialUsage, type Q } from "./state.js";
import { adminEmails } from "./storage.js";

type Marker = "trial_warning_sent_at" | "trial_ended_sent_at" | "storage_80_sent_at" | "storage_100_sent_at";

async function claim(db: Q, marker: Marker, extra = ""): Promise<boolean> {
  const r = await db.query(
    `UPDATE licensee_plan SET ${marker} = now()${extra} WHERE id = 1 AND ${marker} IS NULL RETURNING id`,
  );
  return (r.rowCount ?? r.rows.length) > 0;
}

async function release(db: Q, marker: Marker): Promise<void> {
  await db.query(`UPDATE licensee_plan SET ${marker} = NULL WHERE id = 1`);
}

async function recipients(db: Q): Promise<string[]> {
  const list = await adminEmails(db);
  const support = supportEmail();
  if (support) list.push(support);
  return [...new Set(list.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")))];
}

async function usedFeatureLabels(db: Q): Promise<string[]> {
  const usage = await trialUsage(db);
  return Object.keys(usage).filter((k) => usage[k] > 0).map((k) => featureDef(k)?.label ?? k);
}

function keepLine(): string {
  return `To keep them, an admin can press "Request upgrade" on the Plan page in the staff portal, or email ${salesEmail()}.`;
}

const PLAN_TITLE: Record<string, string> = { starter: "Starter", growth: "Growth", pro: "Pro" };

export function trialWarningMail(company: string, daysLeft: number, used: string[], plan: string = "starter") {
  const usedLine = used.length
    ? `During the trial your team used: ${used.join(", ")}.`
    : "Your team has not used the trial features yet - there is still time to try call recording playback, AI call summaries, templates and the rest.";
  return {
    subject: `${company}: your free trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
    ...bodies([
      `Your free trial of every feature ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}. After that ${company} goes back to the ${PLAN_TITLE[plan] ?? "Starter"} plan.`,
      usedLine,
      keepLine(),
    ]),
  };
}

export function trialEndedMail(company: string, used: string[], plan: string = "starter") {
  return {
    subject: `${company}: your free trial has ended`,
    ...bodies([
      `Your free trial has ended and ${company} is back on the ${PLAN_TITLE[plan] ?? "Starter"} plan. Your data is all still there.`,
      used.length ? `During the trial your team used: ${used.join(", ")}. These are now switched off.` : "The trial features are now switched off.",
      keepLine(),
    ]),
  };
}

export function storageMail(company: string, level: 80 | 100, percent: number) {
  const head = level >= 100
    ? `${company} has used all of its document storage (${percent}%). Uploads keep working - nothing is blocked - but please add storage soon.`
    : `${company} has used ${percent}% of its document storage.`;
  return {
    subject: level >= 100 ? `${company}: document storage is full` : `${company}: document storage is ${Math.floor(percent)}% used`,
    ...bodies([
      head,
      `Extra storage is ${STORAGE_BLOCK_PRICE} for each ${STORAGE_BLOCK_GB} GB. An admin can press "Add ${STORAGE_BLOCK_GB} GB" on the Plan page in the staff portal, or request a plan upgrade there (a higher plan includes more storage per seat).`,
      `Questions: ${salesEmail()}.`,
    ]),
  };
}

export type NoticeResult = { sent: string[]; failed: string[] };

export async function runPlanNotices(db: Q, now: Date = new Date(), send: PlanMailer = sendPlanMail): Promise<NoticeResult> {
  const out: NoticeResult = { sent: [], failed: [] };
  const row = await readPlanRow(db);
  if (!row) return out;
  const state = rowToState(row);
  const company = brandName();

  const deliver = async (marker: Marker, mail: { subject: string; html: string; text: string }, extra = "") => {
    if (!(await claim(db, marker, extra))) return;
    const to = await recipients(db);
    const r = to.length ? await send({ to, ...mail }) : { ok: false, error: "no_recipients" };
    if (r.ok) { out.sent.push(marker); return; }
    console.warn("[plan-notices] send failed", marker, r.error);
    out.failed.push(marker);
    await release(db, marker);
  };

  // Trial: 3 days left, then ended (only if still on starter or growth - moving to pro ends a trial without this email).
  if (trialOffered(state.plan) && state.trial_started_at && state.trial_ends_at) {
    const msLeft = state.trial_ends_at.getTime() - now.getTime();
    if (trialActive(state, now) && msLeft <= TRIAL_WARNING_DAYS * 86_400_000 && !row.trial_warning_sent_at) {
      await deliver("trial_warning_sent_at", trialWarningMail(company, Math.max(1, Math.ceil(msLeft / 86_400_000)), await usedFeatureLabels(db), state.plan));
    }
    if (!trialActive(state, now) && !row.trial_ended_sent_at) {
      await deliver("trial_ended_sent_at", trialEndedMail(company, await usedFeatureLabels(db), state.plan));
    }
  }

  // Storage: 80% and 100%, each once until usage drops back below it.
  const storage = await storageFor(db, state, now);
  const due = storageNoticeDue(storage.percent, !!row.storage_80_sent_at, !!row.storage_100_sent_at);
  if (due.clear100) await release(db, "storage_100_sent_at");
  if (due.clear80) await release(db, "storage_80_sent_at");
  if (due.send === 100) {
    // Reaching 100% also counts as the 80% notice, so no 80% email follows when it dips to 90%.
    await deliver("storage_100_sent_at", storageMail(company, 100, storage.percent), ", storage_80_sent_at = COALESCE(storage_80_sent_at, now())");
  } else if (due.send === 80) {
    await deliver("storage_80_sent_at", storageMail(company, 80, storage.percent));
  }
  return out;
}
