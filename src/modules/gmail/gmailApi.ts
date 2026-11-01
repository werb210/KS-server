// KS_SERVER_GMAIL_INBOX - the Gmail API calls inbox reading uses (gmail.readonly), over the user's GoogleClient, plus
// the pure helpers that read a Gmail message (headers, addresses, body, attachments, direction).
import type { GoogleClient } from "../../services/workspace/googleAuth.js";

export const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

export type GmailHeader = { name?: string; value?: string };
export type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
};
export type GmailMessage = {
  id?: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  historyId?: string;
  payload?: GmailPart;
};
export type GmailAttachmentRef = { attachmentId: string; filename: string; mimeType: string; size: number; inline: boolean };

export class GmailApiError extends Error {
  constructor(public status: number, public path: string, public bodyText = "") {
    super(`gmail_${status} ${path.split("?")[0]}`);
    this.name = "GmailApiError";
  }
}

export async function gmailJson<T>(g: GoogleClient, path: string, init: RequestInit = {}): Promise<T> {
  const r = await g.fetch(`${GMAIL}${path}`, init);
  if (!r.ok) {
    const text = await r.text().catch((err: unknown) => { console.warn("[gmail] error body unreadable", { message: (err as Error)?.message }); return ""; });
    throw new GmailApiError(r.status, path, text.slice(0, 500));
  }
  const text = await r.text();
  return (text ? JSON.parse(text) : {}) as T;
}

const qs = (o: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== "") as [string, string][]).toString();

export function getProfile(g: GoogleClient): Promise<{ emailAddress?: string; historyId?: string }> {
  return gmailJson(g, "/profile");
}

export function getMessage(g: GoogleClient, id: string): Promise<GmailMessage> {
  return gmailJson(g, `/messages/${encodeURIComponent(id)}?format=full`);
}

export function getThread(g: GoogleClient, id: string): Promise<{ id?: string; messages?: GmailMessage[] }> {
  return gmailJson(g, `/threads/${encodeURIComponent(id)}?format=full`);
}

export function listThreads(g: GoogleClient, opts: { q?: string; label?: string; pageToken?: string; max?: number }): Promise<{ threads?: Array<{ id: string; snippet?: string; historyId?: string }>; nextPageToken?: string }> {
  return gmailJson(g, `/threads?${qs({ q: opts.q, labelIds: opts.label, pageToken: opts.pageToken, maxResults: String(opts.max ?? 25) })}`);
}

/** Message ids matching a search, newest first, at most `cap`. */
export async function listMessageIds(g: GoogleClient, q: string, cap: number): Promise<string[]> {
  const out: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await gmailJson<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(
      g, `/messages?${qs({ q, pageToken, maxResults: String(Math.min(100, cap - out.length)) })}`,
    );
    for (const m of page.messages ?? []) out.push(m.id);
    pageToken = page.nextPageToken;
  } while (pageToken && out.length < cap);
  return out;
}

/**
 * Message ids added since a history id (incremental sync). Returns the new history id to store. Throws GmailApiError
 * 404 when Google no longer has history that old (about a week): the caller re-syncs from a date instead.
 */
export async function listHistory(g: GoogleClient, startHistoryId: string, cap = 1000): Promise<{ ids: string[]; historyId: string }> {
  const ids = new Set<string>();
  let pageToken: string | undefined;
  let latest = startHistoryId;
  do {
    const page = await gmailJson<{ history?: Array<{ messagesAdded?: Array<{ message?: { id?: string } }> }>; historyId?: string; nextPageToken?: string }>(
      g, `/history?${qs({ startHistoryId, historyTypes: "messageAdded", pageToken, maxResults: "500" })}`,
    );
    for (const h of page.history ?? []) for (const a of h.messagesAdded ?? []) if (a.message?.id) ids.add(a.message.id);
    if (page.historyId) latest = page.historyId;
    pageToken = page.nextPageToken;
  } while (pageToken && ids.size < cap);
  return { ids: [...ids], historyId: latest };
}

export function getAttachment(g: GoogleClient, messageId: string, attachmentId: string): Promise<{ data?: string; size?: number }> {
  return gmailJson(g, `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
}

/** Gmail push: watch INBOX and SENT, publishing to a Pub/Sub topic. Lasts 7 days; renew daily. */
export function watchMailbox(g: GoogleClient, topicName: string): Promise<{ historyId?: string; expiration?: string }> {
  return gmailJson(g, "/watch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topicName, labelIds: ["INBOX", "SENT"], labelFilterBehavior: "INCLUDE" }),
  });
}

// ---------------------------------------------------------------- pure helpers

export function header(m: GmailMessage | GmailPart | undefined, name: string): string {
  const headers = (m as GmailMessage)?.payload?.headers ?? (m as GmailPart)?.headers ?? [];
  const h = headers.find((x) => String(x?.name ?? "").toLowerCase() === name.toLowerCase());
  return String(h?.value ?? "");
}

/** Bare lower-case addresses from a header like `"Pat Lee" <pat@x.com>, sam@y.com`. */
export function addresses(value: string): string[] {
  const out: string[] = [];
  for (const m of String(value ?? "").matchAll(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) out.push(m[0].toLowerCase());
  return Array.from(new Set(out));
}

/** The display name in `"Pat Lee" <pat@x.com>` (or ""). */
export function displayName(value: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<[^>]+>/.exec(String(value ?? ""));
  return m ? m[1].trim() : "";
}

const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br/>");

/** The HTML body (or the plain-text body, escaped) of a Gmail message. */
export function bodyHtml(part: GmailPart | undefined): string {
  const find = (p: GmailPart | undefined, type: string): string | null => {
    if (!p) return null;
    if (p.mimeType === type && p.body?.data && !p.filename) return Buffer.from(p.body.data, "base64url").toString("utf8");
    for (const c of p.parts ?? []) { const r = find(c, type); if (r !== null) return r; }
    return null;
  };
  const html = find(part, "text/html");
  if (html !== null) return html;
  return escapeHtml(find(part, "text/plain") ?? "");
}

/** File attachments (a filename and an attachment id). Inline images are flagged so they are not filed. */
export function attachmentsOf(part: GmailPart | undefined): GmailAttachmentRef[] {
  const out: GmailAttachmentRef[] = [];
  const walk = (p: GmailPart | undefined) => {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) {
      const disposition = header(p, "Content-Disposition").toLowerCase();
      const inline = disposition.startsWith("inline") || (Boolean(header(p, "Content-ID")) && /^image\//i.test(p.mimeType ?? "") && !disposition.startsWith("attachment"));
      out.push({ attachmentId: p.body.attachmentId, filename: p.filename, mimeType: p.mimeType || "application/octet-stream", size: Number(p.body.size ?? 0), inline });
    }
    for (const c of p.parts ?? []) walk(c);
  };
  walk(part);
  return out;
}

/** The non-inline attachments, in order (index = the portal's attachment id). */
export function fileAttachments(m: GmailMessage): GmailAttachmentRef[] {
  return attachmentsOf(m.payload).filter((a) => !a.inline);
}

const SKIP_LABELS = new Set(["SPAM", "TRASH", "DRAFT", "CHAT"]);

/** inbound (in the inbox), outbound (sent by the user), or null (drafts, spam, trash, chats, archived-only mail). */
export function directionOf(m: GmailMessage): "inbound" | "outbound" | null {
  const labels = new Set(m.labelIds ?? []);
  for (const l of labels) if (SKIP_LABELS.has(l)) return null;
  if (labels.has("SENT")) return "outbound";
  if (labels.has("INBOX")) return "inbound";
  return null;
}

/** A Gmail message in the shape the portal's inbox reads. */
export function toPortalMessage(m: GmailMessage) {
  return {
    id: m.id ?? "",
    threadId: m.threadId ?? "",
    subject: header(m, "Subject"),
    from: header(m, "From"),
    fromAddress: addresses(header(m, "From"))[0] ?? "",
    to: addresses(header(m, "To")),
    cc: addresses(header(m, "Cc")),
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
    snippet: m.snippet ?? "",
    unread: (m.labelIds ?? []).includes("UNREAD"),
    labels: m.labelIds ?? [],
    messageId: header(m, "Message-ID"),
    bodyHtml: bodyHtml(m.payload),
    // Gmail's attachment ids change between fetches, so the portal addresses an attachment by its position.
    attachments: fileAttachments(m).map((a, i) => ({ id: String(i), name: a.filename, contentType: a.mimeType, size: a.size })),
  };
}
