// KS_SERVER_KB_v1 - the portal's Help Center (Settings > Help and Get help), backed by Keystone's shared knowledge base
// on KS-Ops. This copy only relays: KS-Ops holds the articles and runs "Ask Maya", Keystone's support assistant.
//   - Reads go to POST {KS_OPS_URL}/api/licensees/{KS_LICENSEE_ID}/kb/{search|article|categories} with the ops key and
//     the reader's role (an Admin reads admin articles too; everyone else public and all-staff articles).
//   - Ask Maya sends the conversation, a one-way hash of who is asking (for KS-Ops's per-person limit) and THIS copy's
//     own setup: plan, trial, this month's usage against the allowances, and which connections are set up. Nothing else
//     leaves this server, and Maya never sees another licensee's data. It never counts against the assistant-chat allowance.
//   - "Contact support" opens a normal support ticket (plans/supportTickets.ts) with the conversation and the articles
//     tried, so it reaches Keystone through the existing ticket relay.
import { createHash } from "node:crypto";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { opsConfig, postToOps, type OpsFetch, type OpsResult } from "../plans/opsLink.js";
import { planOverview } from "../plans/overview.js";
import type { Q } from "../plans/state.js";

export type HelpUser = { id: string; role: string | null; email?: string | null; name?: string | null };
export type OpsOpts = { env?: NodeJS.ProcessEnv; fetchImpl?: OpsFetch };

/** A stable, one-way reference for the person asking: KS-Ops limits per person without learning who it is. */
export function userRef(user: HelpUser, env: NodeJS.ProcessEnv = process.env): string {
  return createHash("sha256").update(`${String(env.KS_LICENSEE_ID ?? "")}:${user.id}`).digest("hex").slice(0, 40);
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const gb = (bytes: unknown) => {
  const n = num(bytes);
  return n === null ? null : Math.round((n / 1024 ** 3) * 10) / 10;
};

type Integrations = Record<string, boolean | string>;

/** Which connections are set up on this copy, for this person. Each check stands alone; a failure leaves it out. */
export async function integrationStatus(db: Q, user: HelpUser, env: NodeJS.ProcessEnv = process.env): Promise<Integrations> {
  const out: Integrations = {
    phone: Boolean(String(env.TWILIO_ACCOUNT_SID ?? "").trim()),
    e_signing: Boolean(String(env.SIGNNOW_API_KEY ?? "").trim()),
    bulk_email: Boolean(String(env.SENDGRID_API_KEY ?? "").trim()),
    operations_link: opsConfig(env) !== null,
  };
  try {
    const r = await db.query("SELECT (o365_refresh_token IS NOT NULL) AS connected FROM users WHERE id::text = $1", [user.id]);
    if (r.rows[0]) out.microsoft_365 = Boolean(r.rows[0].connected);
  } catch (err) {
    logWarnSwallowed(err, "helpCenter:microsoft_365");
  }
  try {
    const { googleStatusForUser } = await import("../services/workspace/googleAuth.js");
    const { googleConfigProblem, gmailReadEnabled } = await import("../services/workspace/googleConfig.js");
    const problem = googleConfigProblem(env);
    const g = await googleStatusForUser(db as any, user.id, problem, gmailReadEnabled(env));
    out.google = g.connected ? "connected" : problem ? "not_set_up" : "not_connected";
  } catch (err) {
    logWarnSwallowed(err, "helpCenter:google");
  }
  try {
    const { qboStatus } = await import("../services/quickbooks/qboAuth.js");
    const { qboConfigProblem, qboEnvironment } = await import("../services/quickbooks/qboConfig.js");
    const problem = qboConfigProblem(env);
    const s = await qboStatus(db as any, problem, qboEnvironment(env));
    out.quickbooks = s.connected ? "connected" : problem ? "not_set_up" : "not_connected";
  } catch (err) {
    logWarnSwallowed(err, "helpCenter:quickbooks");
  }
  return out;
}

/** This copy's own setup for Ask Maya: plan, trial, this month's usage vs allowances, connections, the asker's role. */
export async function helpContext(db: Q, user: HelpUser, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const ctx: Record<string, unknown> = { role: user.role ?? undefined };
  try {
    const ov: any = await planOverview(db);
    ctx.trial = { status: ov.trial?.status ?? null, days_left: num(ov.trial?.days_left) };
    const u = ov.usage ?? {};
    const a = u.allowances ?? {};
    ctx.usage = {
      minutes: { used: num(u.minutes), included: num(a.minutes) },
      texts: { used: num(u.texts), included: num(a.texts) },
      assistant_chats: { used: num(u.assistant_chats), included: num(a.assistant_chats) },
      storage_gb: { used: gb(u.storage_bytes), included: gb(a.storage_bytes) },
    };
  } catch (err) {
    logWarnSwallowed(err, "helpCenter:plan");
  }
  ctx.integrations = await integrationStatus(db, user, env);
  return ctx;
}

export const NOT_CONFIGURED = {
  ok: false,
  error: "help_not_available",
  message: "Help articles are not available on this copy yet. You can still send a request to support below.",
};

/** A KS-Ops reply as { status, body } for the route to pass on. */
export function relay(r: OpsResult): { status: number; body: any } {
  if (r.ok) return { status: 200, body: r.body ?? {} };
  if (r.error === "ops_not_configured") return { status: 503, body: NOT_CONFIGURED };
  if (r.status === 404) return { status: 404, body: { ok: false, error: "not_found" } };
  if (r.status === 429) {
    return { status: 429, body: { ok: false, error: "rate_limited", message: "You've asked a lot of questions in a short time. Please wait a little, or contact support." } };
  }
  if (r.status === 400) return { status: 400, body: { ok: false, error: "invalid_request" } };
  console.warn("[help-center] KS-Ops call failed", r.status, r.error);
  return { status: 502, body: { ok: false, error: "help_unavailable", message: "Help is not reachable right now. Please try again, or contact support." } };
}

export async function searchHelp(user: HelpUser, q: string, category: string, opts: OpsOpts = {}) {
  return relay(await postToOps("kb/search", { q: q.slice(0, 300), category: category.slice(0, 80), viewer_role: user.role ?? "" }, opts));
}

export async function helpArticle(user: HelpUser, slug: string, opts: OpsOpts = {}) {
  return relay(await postToOps("kb/article", { slug, viewer_role: user.role ?? "" }, opts));
}

export async function helpCategories(user: HelpUser, opts: OpsOpts = {}) {
  return relay(await postToOps("kb/categories", { viewer_role: user.role ?? "" }, opts));
}

export type Turn = { role: "user" | "assistant"; text: string };

/** A question must end with the user's turn; a conversation sent to support may end with Maya's. */
export function checkTurns(raw: unknown, opts: { endWithUser?: boolean } = { endWithUser: true }): Turn[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 40) return null;
  const out: Turn[] = [];
  for (const t of raw) {
    const role = (t as any)?.role;
    const text = String((t as any)?.text ?? "").trim();
    if ((role !== "user" && role !== "assistant") || !text || text.length > 4000) return null;
    out.push({ role, text });
  }
  return !opts.endWithUser || out[out.length - 1].role === "user" ? out : null;
}

export async function askMaya(db: Q, user: HelpUser, turns: Turn[], opts: OpsOpts = {}) {
  const env = opts.env ?? process.env;
  if (!opsConfig(env)) return { status: 503, body: NOT_CONFIGURED };
  const context = await helpContext(db, user, env);
  return relay(await postToOps("kb/ask", { messages: turns, viewer: { role: user.role ?? "", user_ref: userRef(user, env) }, context }, opts));
}

/** The support ticket body for "Contact support": what they asked, Maya's answers, and the articles tried. */
export function escalationBody(turns: Turn[], articles: Array<{ slug: string; title: string }>, note: string): string {
  const lines: string[] = [];
  if (note.trim()) lines.push(note.trim(), "");
  lines.push("Conversation with Maya (Keystone support assistant):");
  for (const t of turns.slice(-20)) lines.push(`${t.role === "user" ? "Me" : "Maya"}: ${t.text}`);
  lines.push("", "Help articles tried:");
  if (articles.length) for (const a of articles.slice(0, 10)) lines.push(`- ${a.title} (${a.slug})`);
  else lines.push("- none");
  return lines.join("\n").slice(0, 10_000);
}

export function checkArticles(raw: unknown): Array<{ slug: string; title: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a: any) => ({ slug: String(a?.slug ?? "").slice(0, 120), title: String(a?.title ?? "").replace(/\s+/g, " ").slice(0, 200) }))
    .filter((a) => /^[a-z0-9-]{1,120}$/.test(a.slug) && a.title)
    .slice(0, 10);
}
