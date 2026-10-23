// KS_SERVER_v12_GOOGLE_WORKSPACE - provider selection, Gmail MIME building, Calendar event + Meet request body,
// Google Tasks body, token encryption, the company setting, and the Gmail read switch (sync never runs when off).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ graph: null as any, google: null as any, queries: [] as string[] }));
vi.mock("../modules/o365/graphClient.js", () => ({ getGraphForUser: vi.fn(async () => h.graph) }));
vi.mock("../services/workspace/googleAuth.js", async (orig) => {
  const real: any = await orig();
  return { ...real, getGoogleForUser: vi.fn(async () => h.google) };
});
vi.mock("../db.js", () => ({ pool: { query: vi.fn(async (sql: string) => { h.queries.push(sql); return { rows: [], rowCount: 0 }; }) } }));

import { getWorkspaceForUser, normalizeWorkspaceMode } from "../services/workspace/index.js";
import { buildMimeMessage, encodeHeaderWord, extractDataUriImages, toGmailRaw } from "../services/workspace/gmailMime.js";
import { availabilityView, googleEventBody, googleTaskBody, normalizeGoogleEvent, sendGmail, workspaceDomain } from "../services/workspace/google.js";
import { decryptToken, encryptToken } from "../services/workspace/tokenCrypto.js";
import { checkField, LICENSEE_FIELDS } from "../licensee/settings.js";
import { syncGmailOnce } from "../workers/gmailSyncWorker.js";
import { googleConfigProblem } from "../services/workspace/googleConfig.js";

const fakeGoogle = (over: Partial<any> = {}) => ({ provider: "google", userId: "u1", email: "pat@acme.example", scopes: [], accessToken: "AT", fetch: vi.fn(async () => new Response(JSON.stringify({ id: "g1", threadId: "t1" }), { status: 200 })), ...over });

beforeEach(() => { h.graph = null; h.google = null; h.queries.length = 0; });
afterEach(() => { vi.unstubAllGlobals(); delete process.env.GOOGLE_GMAIL_READ_ENABLED; });

describe("provider selection", () => {
  it("Microsoft 365 when connected (existing behaviour), Google when only Google is connected, null when neither", async () => {
    h.graph = { fetch: vi.fn(), accessToken: "ms" };
    h.google = fakeGoogle();
    expect((await getWorkspaceForUser({} as any, "u1"))?.provider).toBe("o365");
    h.graph = null;
    expect((await getWorkspaceForUser({} as any, "u1"))?.provider).toBe("google");
    h.google = null;
    expect(await getWorkspaceForUser({} as any, "u1")).toBeNull();
    expect(await getWorkspaceForUser({} as any, null)).toBeNull();
  });
  it("an explicit preference wins when that provider is connected", async () => {
    h.graph = { fetch: vi.fn(), accessToken: "ms" };
    h.google = fakeGoogle();
    expect((await getWorkspaceForUser({} as any, "u1", { prefer: "google" }))?.provider).toBe("google");
    h.google = null;
    expect((await getWorkspaceForUser({} as any, "u1", { prefer: "google" }))?.provider).toBe("o365");
  });
  it("company setting: m365 (default), google or both", () => {
    expect(normalizeWorkspaceMode(undefined)).toBe("m365");
    expect(normalizeWorkspaceMode("")).toBe("m365");
    expect(normalizeWorkspaceMode("GOOGLE")).toBe("google");
    expect(normalizeWorkspaceMode("both")).toBe("both");
    expect(normalizeWorkspaceMode("nonsense")).toBe("m365");
    expect(LICENSEE_FIELDS).toContain("workspace_provider");
    expect(checkField("workspace_provider", "Google")).toEqual({ ok: true, value: "google" });
    expect(checkField("workspace_provider", "both")).toEqual({ ok: true, value: "both" });
    expect(checkField("workspace_provider", "gmail").ok).toBe(false);
  });
});

const decodeParts = (mime: string) => mime;
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("Gmail MIME", () => {
  it("encodes a UTF-8 subject as RFC 2047 words of at most 75 characters; ASCII stays plain", () => {
    expect(encodeHeaderWord("Hello there")).toBe("Hello there");
    const enc = encodeHeaderWord("Prêt approuvé — félicitations, voilà votre dossier complet 🎉");
    for (const word of enc.split("\r\n ")) {
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      expect(word.length).toBeLessThanOrEqual(75);
    }
    const decoded = enc.split("\r\n ").map((w) => Buffer.from(w.slice(10, -2), "base64").toString("utf8")).join("");
    expect(decoded).toBe("Prêt approuvé — félicitations, voilà votre dossier complet 🎉");
  });

  it("builds multipart/mixed with the attachment, a text alternative, threading headers and the logged-at-send header", () => {
    const mime = buildMimeMessage({
      from: "pat@acme.example", to: ["client@example.com"], cc: ["cc@example.com"], bcc: ["bcc@example.com"],
      subject: "Your term sheet", html: "<p>Hi <b>Sam</b></p>",
      attachments: [{ name: "Term sheet é.pdf", contentType: "application/pdf", contentBytes: b64("%PDF-1.4 test") }],
      inReplyTo: "<abc@mail.example>", importance: "high", readReceiptTo: "pat@acme.example",
      extraHeaders: { "X-Logged": "1", "Bad Header": "x" }, boundarySeed: "T",
    });
    const head = mime.split("\r\n\r\n")[0]!;
    expect(head).toContain("From: pat@acme.example");
    expect(head).toContain("To: client@example.com");
    expect(head).toContain("Cc: cc@example.com");
    expect(head).toContain("Bcc: bcc@example.com");
    expect(head).toContain("Subject: Your term sheet");
    expect(head).toContain("In-Reply-To: <abc@mail.example>");
    expect(head).toContain("References: <abc@mail.example>");
    expect(head).toContain("Importance: High");
    expect(head).toContain("Disposition-Notification-To: pat@acme.example");
    expect(head).toContain("X-Logged: 1");
    expect(head).not.toContain("Bad Header");
    expect(head).toContain('Content-Type: multipart/mixed; boundary="----=_ks_mix_T"');
    expect(mime).toContain('Content-Type: multipart/alternative; boundary="----=_ks_alt_T"');
    expect(mime).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(mime).toContain(b64("Hi Sam"));
    expect(mime).toContain(b64("<p>Hi <b>Sam</b></p>"));
    expect(mime).toContain("Content-Disposition: attachment; filename*=UTF-8''Term%20sheet%20%C3%A9.pdf");
    expect(mime).toContain(b64("%PDF-1.4 test"));
    expect(mime.trimEnd().endsWith("------=_ks_mix_T--")).toBe(true);
  });

  it("turns data: images into cid: inline parts inside multipart/related", () => {
    const png = b64("PNGDATA");
    const { html, inline } = extractDataUriImages(`<p>Logo</p><img alt="x" src="data:image/png;base64,${png}">`, "S");
    expect(html).toBe('<p>Logo</p><img alt="x" src="cid:img1.S@inline">');
    expect(inline).toEqual([{ name: "image1.png", contentType: "image/png", contentBytes: png, contentId: "img1.S@inline", isInline: true }]);
    const mime = buildMimeMessage({ to: ["a@b.co"], subject: "s", html: `<img src="data:image/png;base64,${png}">`, boundarySeed: "S" });
    expect(mime).toContain('Content-Type: multipart/related; boundary="----=_ks_rel_S"');
    expect(mime).toContain("Content-ID: <img1.S@inline>");
    expect(mime).toContain('Content-Disposition: inline; filename="image1.png"');
    expect(mime).not.toContain("data:image/png");
  });

  it("keeps a caller's inline attachment (contentId) inline and refuses header injection", () => {
    const mime = buildMimeMessage({ to: ["a@b.co\r\nBcc: evil@x.co"], subject: "Hi\r\nBcc: evil@x.co", html: '<img src="cid:sig1">', attachments: [{ name: "sig.png", contentType: "image/png", contentBytes: b64("x"), contentId: "sig1", isInline: true }], boundarySeed: "Q" });
    const head = mime.split("\r\n\r\n")[0]!;
    expect(head.split("\r\n").filter((l) => l.startsWith("Bcc:"))).toEqual([]);
    expect(mime).toContain("Content-ID: <sig1>");
    expect(mime).not.toContain("multipart/mixed");
  });

  it("sends through Gmail's JSON endpoint as base64url with the thread id", async () => {
    const g = fakeGoogle();
    const r = await sendGmail(g as any, { to: ["a@b.co"], subject: "s", html: "<p>x</p>" }, { threadId: "t-9" });
    expect(r).toEqual({ id: "g1", threadId: "t1" });
    const [url, init] = (g.fetch as any).mock.calls[0];
    expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    const body = JSON.parse(init.body);
    expect(body.threadId).toBe("t-9");
    expect(body.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(body.raw, "base64url").toString("utf8")).toContain("From: pat@acme.example");
    expect(toGmailRaw("a?b>")).not.toMatch(/[+/=]/);
  });

  it("large messages go through the media upload endpoint", async () => {
    const g = fakeGoogle();
    await sendGmail(g as any, { to: ["a@b.co"], subject: "s", html: "x", attachments: [{ name: "big.bin", contentBytes: Buffer.alloc(5 * 1024 * 1024).toString("base64") }] });
    const [url, init] = (g.fetch as any).mock.calls[0];
    expect(url).toContain("/upload/gmail/v1/users/me/messages/send?uploadType=media");
    expect(init.headers["Content-Type"]).toBe("message/rfc822");
  });
});

describe("Google Calendar", () => {
  it("an online meeting carries a Google Meet createRequest (where Teams would be created)", () => {
    const body: any = googleEventBody({ title: "Review", start: "2026-11-02T16:00:00Z", end: "2026-11-02T16:30:00Z", attendees: ["sam@client.example", { email: "kim@x.example", name: "Kim", optional: true }, "not-an-email"], meet: true, requestId: "req-1", notes: "Agenda", location: "Online", reminderMinutes: 15 });
    expect(body).toEqual({
      summary: "Review",
      start: { dateTime: "2026-11-02T16:00:00.000Z", timeZone: "UTC" },
      end: { dateTime: "2026-11-02T16:30:00.000Z", timeZone: "UTC" },
      description: "Agenda",
      location: "Online",
      attendees: [{ email: "sam@client.example" }, { email: "kim@x.example", displayName: "Kim", optional: true }],
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 15 }] },
      conferenceData: { createRequest: { requestId: "req-1", conferenceSolutionKey: { type: "hangoutsMeet" } } },
    });
    expect((googleEventBody({ title: "x", start: "2026-11-02T16:00:00Z", end: "2026-11-02T17:00:00Z" }) as any).conferenceData).toBeUndefined();
  });

  it("maps a Google event to the portal's flat shape with the Meet link as the join link", () => {
    expect(normalizeGoogleEvent({ id: "e1", summary: "Call", start: { dateTime: "2026-11-02T16:00:00Z" }, end: { dateTime: "2026-11-02T16:30:00Z" }, attendees: [{ email: "a@b.co" }], hangoutLink: "https://meet.google.com/abc-defg-hij", htmlLink: "https://calendar.google.com/e1" }))
      .toMatchObject({ id: "e1", title: "Call", start: "2026-11-02T16:00:00Z", attendees: ["a@b.co"], teamsLink: "https://meet.google.com/abc-defg-hij", webLink: "https://calendar.google.com/e1", provider: "google" });
  });

  it("free/busy view marks busy 30-minute slots like Graph's availabilityView", () => {
    const from = new Date("2026-11-02T15:00:00Z");
    const to = new Date("2026-11-02T17:00:00Z");
    expect(availabilityView([{ start: new Date("2026-11-02T15:30:00Z"), end: new Date("2026-11-02T16:15:00Z") }], from, to)).toBe("0220");
  });

  it("Google Tasks keep a due date only; completion maps to status", () => {
    expect(googleTaskBody({ title: "Call Sam", notes: "re: docs", due: "2026-11-05T22:30:00Z" })).toEqual({ title: "Call Sam", notes: "re: docs", status: "needsAction", due: "2026-11-05T00:00:00.000Z", completed: null });
    expect(googleTaskBody({ title: "Done", completed: true })).toMatchObject({ status: "completed", due: null });
  });

  it("Drive folders are shared with the Workspace domain, never with all of gmail.com", () => {
    expect(workspaceDomain("pat@acme.example")).toBe("acme.example");
    expect(workspaceDomain("someone@gmail.com")).toBeNull();
  });
});

describe("token encryption", () => {
  it("round-trips, uses a fresh IV each time, and fails closed with another key", () => {
    const env = { GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } as any;
    const a = encryptToken("refresh-123", env);
    const b = encryptToken("refresh-123", env);
    expect(a).not.toBe(b);
    expect(a).not.toContain("refresh-123");
    expect(decryptToken(a, env)).toBe("refresh-123");
    expect(decryptToken(a, { GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64") } as any)).toBeNull();
    expect(decryptToken("plaintext", env)).toBeNull();
  });
  it("Google is 'not configured' without a dedicated encryption key", () => {
    expect(googleConfigProblem({ GOOGLE_OAUTH_CLIENT_ID: "x", GOOGLE_OAUTH_CLIENT_SECRET: "y" } as any)).toMatch(/GOOGLE_TOKEN_ENCRYPTION_KEY/);
    expect(googleConfigProblem({ GOOGLE_OAUTH_CLIENT_ID: "x", GOOGLE_OAUTH_CLIENT_SECRET: "y", GOOGLE_TOKEN_ENCRYPTION_KEY: "k" } as any)).toBeNull();
  });
});

describe("Gmail inbox sync switch", () => {
  const configured = { GOOGLE_OAUTH_CLIENT_ID: "x", GOOGLE_OAUTH_CLIENT_SECRET: "y", GOOGLE_TOKEN_ENCRYPTION_KEY: "k" } as any;
  it("does nothing at all while GOOGLE_GMAIL_READ_ENABLED is off - no database, no Google", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const pool = { query: vi.fn() };
    for (const v of [undefined, "", "false", "0"]) {
      const r = await syncGmailOnce(pool as any, { ...configured, ...(v === undefined ? {} : { GOOGLE_GMAIL_READ_ENABLED: v }) });
      expect(r).toEqual({ ran: false, users: 0 });
    }
    expect(pool.query).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("runs only for accounts that granted gmail.readonly once switched on", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) };
    const r = await syncGmailOnce(pool as any, { ...configured, GOOGLE_GMAIL_READ_ENABLED: "true" });
    expect(r).toEqual({ ran: true, users: 0 });
    const [sql, params] = (pool.query as any).mock.calls[0];
    expect(sql).toMatch(/FROM google_workspace_accounts/);
    expect(params).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
  });
});
void decodeParts;
