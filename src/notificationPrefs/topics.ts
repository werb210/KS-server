// KS_NOTIFICATION_TOPICS_v1 - notification settings per topic (HubSpot gaps batch 2).
// Every notification type belongs to one topic. Each person chooses, per topic, whether it reaches them in the bell
// (in-app), as a push (phone, tablet, desktop, watch) and as a text message. Everything is on until they turn it off.
// Types that match no topic are "other" and always arrive.

export type Channel = "bell" | "push" | "text";
export const CHANNELS: readonly Channel[] = ["bell", "push", "text"];

export type Topic = {
  key: string;
  label: string;
  description: string;
  /** Exact notification types. */
  types: readonly string[];
  /** Type prefixes (e.g. "lender_" matches lender_offer). */
  prefixes: readonly string[];
  /** Channels a person cannot turn off for this topic. */
  locked?: readonly Channel[];
};

export const TOPICS: readonly Topic[] = [
  {
    key: "mentions", label: "Mentions and team chat", description: "Someone @mentions you, or posts in a team channel you follow.",
    types: ["mention"], prefixes: ["team_"],
  },
  {
    key: "tasks", label: "Tasks and reminders", description: "Tasks assigned to you, due dates and the daily task digest.",
    types: ["task"], prefixes: ["task_"],
  },
  {
    key: "client_messages", label: "Client texts and emails", description: "A client or prospect texts, emails or fills in a website form.",
    types: ["client_message", "sms_inbound", "email_received", "email_unopened", "crm_email_log", "website_contact"], prefixes: [],
  },
  {
    key: "calls", label: "Missed calls and voicemail", description: "Calls you missed, new voicemail and call recordings.",
    types: ["call_missed", "missed_call", "voicemail", "no_transcript"], prefixes: ["call_"],
  },
  {
    key: "maya", label: "Maya hand-offs", description: "Maya passes a conversation to a person, or a visitor finishes a readiness check.",
    types: ["maya_handoff", "maya_escalation", "website_readiness"], prefixes: ["maya_"],
  },
  {
    key: "applications", label: "Applications and documents", description: "New applications, uploaded documents, credit summaries and document checks.",
    types: ["credit_summary_ready", "OCR_WARNING", "PRODUCT_QUESTIONS_ANSWERED", "library_upload", "library_file_requests",
      "new_document", "needs_review", "analysis_complete"],
    prefixes: ["application_", "document_"],
  },
  {
    key: "lenders", label: "Lender updates and offers", description: "Lender status changes, offers, conditions and term sheets.",
    types: ["pgi_partner_update"], prefixes: ["lender_", "offer_"],
  },
  {
    key: "deals", label: "Quotes, payments and contracts", description: "Quotes accepted, payments received and active contracts coming up for renewal.",
    types: ["paid_out", "pending_acceptance"], prefixes: ["quote", "active_contract", "payment_"],
  },
  {
    key: "security", label: "Security alerts", description: "Possible fraud and unusual account activity. These always appear in the bell.",
    types: ["fraud_staff_alert", "off_hours_write", "webhook_disabled"], prefixes: ["fraud_"],
    locked: ["bell"],
  },
];

const BY_KEY = new Map(TOPICS.map((t) => [t.key, t]));

export function topicByKey(key: string): Topic | undefined {
  return BY_KEY.get(key);
}

/** The topic a notification type belongs to, or "other". */
export function topicForType(type: string | null | undefined): string {
  const t = String(type ?? "");
  if (!t) return "other";
  for (const topic of TOPICS) {
    if (topic.types.includes(t)) return topic.key;
    if (topic.prefixes.some((p) => t.startsWith(p))) return topic.key;
  }
  return "other";
}

/** Staff alert categories (iPhone/Android dialler pushes) and their topic. */
export const STAFF_ALERT_TOPIC: Record<string, string> = {
  MISSED_CALL: "calls",
  VOICEMAIL: "calls",
  CLIENT_MESSAGE: "client_messages",
  SMS: "client_messages",
  HANDOFF: "maya",
  TASK: "tasks",
};

export function isLocked(topicKey: string, channel: Channel): boolean {
  return Boolean(topicByKey(topicKey)?.locked?.includes(channel));
}

/** SQL pieces matching every type of the given topics: exact types and LIKE patterns. */
export function typeMatchers(topicKeys: readonly string[]): { exact: string[]; like: string[] } {
  const exact: string[] = [];
  const like: string[] = [];
  for (const key of topicKeys) {
    const t = topicByKey(key);
    if (!t) continue;
    exact.push(...t.types);
    like.push(...t.prefixes.map((p) => p.replace(/[\\%_]/g, (c) => "\\" + c) + "%"));
  }
  return { exact, like };
}
