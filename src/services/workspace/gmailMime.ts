// KS_SERVER_v12_GOOGLE_WORKSPACE - builds the RFC 5322 / MIME message Gmail's messages.send takes.
// gmail.send (a sensitive, not restricted, scope) only lets us SEND a complete message, so everything Outlook does
// for us through Graph is done here: UTF-8 subjects (RFC 2047), file attachments (RFC 2231 file names), inline
// images (data: URIs in the body become cid: parts in multipart/related, the shape Outlook and Gmail both render),
// a plain-text alternative, reply threading (In-Reply-To / References) and read-receipt / importance headers.
import { randomBytes } from "node:crypto";

export type MimeAttachment = {
  name: string;
  contentType?: string | null;
  /** base64 (no data: prefix) */
  contentBytes: string;
  /** set for an inline image referenced as cid:<contentId> in the HTML */
  contentId?: string | null;
  isInline?: boolean | null;
};

export type MimeMessageInput = {
  from?: string | null;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html: string;
  attachments?: MimeAttachment[];
  inReplyTo?: string | null;
  references?: string | null;
  importance?: "low" | "normal" | "high";
  readReceiptTo?: string | null;
  extraHeaders?: Record<string, string>;
  /** fixed boundary seed for tests */
  boundarySeed?: string;
};

const CRLF = "\r\n";

const isAscii = (s: string): boolean => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 encoded-word(s) for a header value; ASCII passes through. Splits so no word exceeds 75 chars. */
export function encodeHeaderWord(value: string): string {
  const v = String(value ?? "").replace(/[\r\n]+/g, " ");
  if (isAscii(v)) return v;
  const words: string[] = [];
  let chunk = "";
  for (const ch of Array.from(v)) {
    // 45 bytes of UTF-8 -> 60 base64 chars, + 12 for =?UTF-8?B??= = 72 < 75
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) { words.push(chunk); chunk = ""; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join(CRLF + " ");
}

/** Strips anything that could inject a header line. */
function headerSafe(v: string): string {
  return String(v ?? "").replace(/[\r\n]+/g, " ").trim();
}

function addressList(list: string[] | undefined): string {
  return (list ?? []).map((a) => headerSafe(a)).filter((a) => a.includes("@")).join(", ");
}

/** Content-Disposition / Content-Type file name params: plain when ASCII, RFC 2231 otherwise. */
export function fileNameParams(param: "filename" | "name", name: string): string {
  const n = headerSafe(name).replace(/"/g, "'") || "attachment";
  if (isAscii(n)) return `${param}="${n}"`;
  const encoded = encodeURIComponent(n).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `${param}*=UTF-8''${encoded}`;
}

function wrap76(b64: string): string {
  const clean = String(b64 ?? "").replace(/\s+/g, "");
  const out: string[] = [];
  for (let i = 0; i < clean.length; i += 76) out.push(clean.slice(i, i + 76));
  return out.join(CRLF);
}

export function htmlToText(html: string): string {
  return String(html ?? "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** data:image/...;base64 sources in the HTML -> cid: references plus inline parts. */
export function extractDataUriImages(html: string, seed = ""): { html: string; inline: MimeAttachment[] } {
  const inline: MimeAttachment[] = [];
  let n = 0;
  const out = String(html ?? "").replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)\2/gi, (_m, pre: string, q: string, type: string, data: string) => {
    n += 1;
    const ext = (type.split("/")[1] ?? "png").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "png";
    const cid = `img${n}.${seed || randomBytes(6).toString("hex")}@inline`;
    inline.push({ name: `image${n}.${ext}`, contentType: type.toLowerCase(), contentBytes: data.replace(/\s+/g, ""), contentId: cid, isInline: true });
    return `${pre}${q}cid:${cid}${q}`;
  });
  return { html: out, inline };
}

function boundary(seed: string | undefined, tag: string): string {
  return `----=_ks_${tag}_${seed ?? randomBytes(12).toString("hex")}`;
}

function part(headers: string[], body: string): string {
  return headers.join(CRLF) + CRLF + CRLF + body;
}

function multipart(type: string, b: string, parts: string[]): string {
  return part([`Content-Type: multipart/${type}; boundary="${b}"`], parts.map((p) => `--${b}${CRLF}${p}`).join(CRLF) + `${CRLF}--${b}--`);
}

/** The full message as a string (CRLF line endings). */
export function buildMimeMessage(input: MimeMessageInput): string {
  const seed = input.boundarySeed;
  const extracted = extractDataUriImages(input.html ?? "", seed);
  const given = (input.attachments ?? []).filter((a) => a && typeof a.contentBytes === "string" && a.contentBytes.length > 0);
  const inline = [...extracted.inline, ...given.filter((a) => a.isInline && a.contentId)];
  const files = given.filter((a) => !(a.isInline && a.contentId));
  const html = extracted.html;

  const textPart = part(["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"], wrap76(Buffer.from(htmlToText(html), "utf8").toString("base64")));
  const htmlPart = part(["Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64"], wrap76(Buffer.from(html, "utf8").toString("base64")));
  let body = multipart("alternative", boundary(seed, "alt"), [textPart, htmlPart]);

  if (inline.length) {
    const inlineParts = inline.map((a) => part([
      `Content-Type: ${headerSafe(a.contentType || "application/octet-stream")}; ${fileNameParams("name", a.name)}`,
      "Content-Transfer-Encoding: base64",
      `Content-ID: <${headerSafe(String(a.contentId)).replace(/^<|>$/g, "")}>`,
      `Content-Disposition: inline; ${fileNameParams("filename", a.name)}`,
    ], wrap76(a.contentBytes)));
    body = multipart("related", boundary(seed, "rel"), [body, ...inlineParts]);
  }
  if (files.length) {
    const fileParts = files.map((a) => part([
      `Content-Type: ${headerSafe(a.contentType || "application/octet-stream")}; ${fileNameParams("name", a.name)}`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; ${fileNameParams("filename", a.name)}`,
    ], wrap76(a.contentBytes)));
    body = multipart("mixed", boundary(seed, "mix"), [body, ...fileParts]);
  }

  const headers: string[] = [];
  if (input.from) headers.push(`From: ${headerSafe(input.from)}`);
  headers.push(`To: ${addressList(input.to)}`);
  const cc = addressList(input.cc);
  if (cc) headers.push(`Cc: ${cc}`);
  const bcc = addressList(input.bcc);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  headers.push(`Subject: ${encodeHeaderWord(input.subject ?? "")}`);
  headers.push("MIME-Version: 1.0");
  const irt = headerSafe(input.inReplyTo ?? "");
  if (irt) headers.push(`In-Reply-To: ${irt}`);
  const refs = headerSafe(input.references ?? "") || irt;
  if (refs) headers.push(`References: ${refs}`);
  if (input.importance === "high") headers.push("Importance: High", "X-Priority: 1");
  if (input.importance === "low") headers.push("Importance: Low", "X-Priority: 5");
  if (input.readReceiptTo) headers.push(`Disposition-Notification-To: ${headerSafe(input.readReceiptTo)}`);
  for (const [k, v] of Object.entries(input.extraHeaders ?? {})) {
    if (/^[A-Za-z0-9-]+$/.test(k)) headers.push(`${k}: ${headerSafe(v)}`);
  }
  return headers.join(CRLF) + CRLF + body + CRLF;
}

/** base64url, as Gmail's JSON `raw` field wants it. */
export function toGmailRaw(message: string): string {
  return Buffer.from(message, "utf8").toString("base64url");
}
