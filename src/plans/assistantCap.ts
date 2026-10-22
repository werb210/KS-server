// KS_SERVER_v8_ASSISTANT_CAP - the monthly assistant-conversation limit (starter 200, growth 1,000; pro and trial
// unlimited). When the month's conversations reach it, a NEW conversation gets a polite reply from the assistant
// saying so (not an error); conversations already under way carry on. Only the assistant's chat entry points check
// it - other AI features (call summaries, document reading, ...) are not limited here.
import { assistantName, brandName } from "../licensee/brand.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { allowancesFor } from "./catalogue.js";
import { getPlanState, type Q } from "./state.js";
import { licenseeTimeZone, periodOf, usageCounts } from "./usage.js";

export type AssistantCap = { limit: number | null; used: number; reached: boolean };

/** This month's limit and use. A read failure is logged and never blocks the assistant. */
export async function assistantCap(db: Q, now: Date = new Date()): Promise<AssistantCap> {
  try {
    const state = await getPlanState(db, now.getTime());
    const limit = allowancesFor(state, now).assistant_chats;
    if (limit === null) return { limit: null, used: 0, reached: false };
    const tz = licenseeTimeZone();
    const used = (await usageCounts(db, periodOf(now, tz), tz)).assistant_chats;
    return { limit, used, reached: used >= limit };
  } catch (err) {
    return logWarnSwallowed(err, "plans/assistantCap.ts:assistantCap", { limit: null, used: 0, reached: false });
  }
}

/** Is there already a conversation with this id? A read failure counts as "yes" (never block on an error). */
export async function conversationExists(db: Q, sessionId: string | null | undefined): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const r = await db.query(`SELECT 1 FROM chat_sessions WHERE id = $1::uuid LIMIT 1`, [sessionId]);
    return r.rows.length > 0;
  } catch (err) {
    return logWarnSwallowed(err, "plans/assistantCap.ts:conversationExists", true);
  }
}

export function assistantLimitReply(): string {
  return `Thanks for reaching out. ${assistantName()} has reached ${brandName()}'s monthly limit for new assistant conversations, `
    + "so I can't start a new chat right now. Conversations already under way can carry on, and the limit resets on the 1st. "
    + `If you work at ${brandName()}, an admin can request an upgrade from the Plan page in the staff portal for more assistant conversations.`;
}

/** The body sent instead of the assistant's answer when a new conversation is over the limit. */
export function assistantLimitBody(sessionId: string | null) {
  return {
    reply: assistantLimitReply(),
    message: assistantLimitReply(),
    sessionId,
    limit_reached: true,
    reason: "assistant_monthly_limit",
    upgrade_request: { path: "/api/plan/upgrade-request", who: "Admin" },
  };
}
