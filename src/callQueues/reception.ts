// KS_HUBSPOT_GAPS_1_CALL_QUEUES - the phone menu's way into a call queue (used by routes/reception.ts).
import { pool } from "../db.js";
import { checkFeature } from "../plans/catalogue.js";
import { getPlanState } from "../plans/state.js";
import { readSetting } from "../settingsPack/common.js";
import { callerCardForCall } from "../voice/callerCard.js";
import { RECORDING_NOTICE } from "../voice/recordedDial.js";
import { openInboundRecord } from "../voice/staffRing.js";
import { enqueueCaller, getQueue } from "./queues.js";

const VOICE = "Polly.Joanna";

async function queuesInPlan(): Promise<boolean> {
  return checkFeature(await getPlanState(pool as any), "call_queues").allowed;
}

/** The queue the main line goes straight into, when one is set and the plan has queues. */
export async function mainLineQueueId(): Promise<string | null> {
  try {
    const v = await readSetting(pool as any, "call_queue_main_line", (raw) => String((raw as any)?.queue_id ?? "") || null);
    return v && (await queuesInPlan()) ? v : null;
  } catch (err) {
    console.error("[call-queue] main-line queue lookup failed; using the phone menu", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Whether a queue can take calls right now (plan includes queues, queue active). */
export async function queueUsable(queueId: string): Promise<boolean> {
  try {
    if (!(await queuesInPlan())) return false;
    const q = await getQueue(pool as any, queueId);
    return Boolean(q && !q.archived_at);
  } catch (err) {
    console.error("[call-queue] queue check failed", err instanceof Error ? err.message : err);
    return false;
  }
}

/** Says the recording notice and puts the caller in the queue. False (nothing added to the TwiML) when the plan has no
 *  queues, the queue is archived or missing, or the call cannot be tracked; the caller then takes the no-answer route. */
export async function routeToQueue(v: any, call: { callSid: string; from: string }, queueId: string): Promise<boolean> {
  try {
    if (!call.callSid || !(await queuesInPlan())) return false;
    const queue = await getQueue(pool as any, queueId);
    if (!queue || queue.archived_at) return false;
    const card = await callerCardForCall(pool as any, call.from);
    const rec = await openInboundRecord(pool as any, { callSid: call.callSid, from: call.from, card });
    if (rec) v.say({ voice: VOICE }, RECORDING_NOTICE);
    return await enqueueCaller(pool, v, queue, { callSid: call.callSid, from: call.from || null, callerName: card?.name ?? null, contactId: card?.contactId ?? null });
  } catch (err) {
    console.error("[call-queue] could not put the caller in the queue; using the no-answer route", { queueId, message: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
