// KS_SERVER_GMAIL_INBOX - the Gmail sync's SQL against real Postgres: the migration (twice), inbound mail on the
// contact's timeline with its application, Gmail-sent mail in crm_email_log with the thread, an attachment filed,
// and a second run logging nothing twice. Gmail itself is faked (no network).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({ google: null as any }));
vi.mock("../services/workspace/googleAuth.js", () => ({ getGoogleForUser: vi.fn(async () => h.google) }));
vi.mock("../lib/storage/index.js", () => ({ getStorage: () => ({ put: async (o: any) => ({ blobName: `test/${o.filename}`, url: null }) }) }));

import { pool } from "../db.js";
import { syncGmailAccount } from "../modules/gmail/gmailSync.js";
import { clearNeverLogCache } from "../neverLog/neverLog.js";

const MIGRATION = "migrations/2026_11_06_ks_gmail_inbox.sql";
const tag = randomUUID().slice(0, 8);
const USER = randomUUID(), CONTACT = randomUUID(), APP = randomUUID();
const OWN = `pat-${tag}@broker.example`, CLIENT = `client-${tag}@acme.example`;
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

function message(id: string, labels: string[], from: string, to: string, attach = false) {
  const parts: any[] = [{ mimeType: "text/plain", body: { data: b64("Hello") } }];
  if (attach) parts.push({ mimeType: "application/pdf", filename: `doc-${tag}.pdf`, headers: [{ name: "Content-Disposition", value: "attachment" }], body: { attachmentId: "a1", size: 4 } });
  return {
    id, threadId: `thread-${tag}`, labelIds: labels, snippet: "Hello", internalDate: String(Date.now()),
    payload: { mimeType: "multipart/mixed", headers: [{ name: "From", value: from }, { name: "To", value: to }, { name: "Subject", value: "Docs" }, { name: "Message-ID", value: `<${id}@x>` }], parts },
  };
}

describe("Gmail inbox sync (real Postgres)", () => {
  beforeAll(async () => {
    await pool.query(readFileSync(MIGRATION, "utf8"));
    await pool.query(readFileSync(MIGRATION, "utf8")); // safe to run again
    clearNeverLogCache();
    await pool.query(`INSERT INTO users (id, email, active, role, silo) VALUES ($1, $2, true, 'Staff', 'BF')`, [USER, OWN]);
    await pool.query(`INSERT INTO contacts (id, name, email, owner_id, silo) VALUES ($1, 'Gmail Client', $2, $3, 'BF')`, [CONTACT, CLIENT, USER]);
    await pool.query(
      `INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, contact_id, owner_user_id, silo) VALUES ($1, $2, now(), now(), 'Received', 'RECEIVED', $3, $4, 'BF')`,
      [APP, `Gmail app ${tag}`, CONTACT, USER],
    );
    await pool.query(`INSERT INTO google_workspace_accounts (user_id, google_email, scopes) VALUES ($1, $2, $3)`, [USER, OWN, "openid https://www.googleapis.com/auth/gmail.readonly"]);
    const box: Record<string, any> = {
      [`in-${tag}`]: message(`in-${tag}`, ["INBOX"], `Client <${CLIENT}>`, OWN, true),
      [`out-${tag}`]: message(`out-${tag}`, ["SENT"], OWN, CLIENT),
    };
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    h.google = {
      email: OWN, scopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly"],
      fetch: async (url: string) => {
        const p = url.replace("https://gmail.googleapis.com/gmail/v1/users/me", "");
        if (p === "/profile") return json({ historyId: "42" });
        if (p.startsWith("/messages?")) return json({ messages: Object.keys(box).map((id) => ({ id })) });
        if (/\/attachments\//.test(p)) return json({ data: b64("%PDF") });
        const m = /^\/messages\/([^?]+)\?format=full$/.exec(p);
        return m && box[decodeURIComponent(m[1]!)] ? json(box[decodeURIComponent(m[1]!)]) : json({}, 404);
      },
    };
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM communications_messages WHERE contact_id = $1`, [CONTACT]);
    await pool.query(`DELETE FROM crm_email_log WHERE contact_id = $1`, [CONTACT]);
    await pool.query(`DELETE FROM contact_documents WHERE contact_id = $1`, [CONTACT]);
    await pool.query(`DELETE FROM gmail_messages WHERE user_id = $1`, [USER]);
    await pool.query(`DELETE FROM inbound_attachment_attempts WHERE message_id LIKE $1`, [`gmail:%${tag}`]);
    await pool.query(`DELETE FROM google_workspace_accounts WHERE user_id = $1`, [USER]);
    await pool.query(`DELETE FROM applications WHERE id = $1`, [APP]);
    await pool.query(`DELETE FROM contacts WHERE id = $1`, [CONTACT]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [USER]);
  });

  it("logs client mail, Gmail-sent mail and attachments once", async () => {
    const stats = await syncGmailAccount(pool as any, USER);
    expect(stats).toMatchObject({ mode: "first", inbound: 1, outbound: 1, attachments: 1 });
    const inbound = (await pool.query(`SELECT application_id, channel, direction FROM communications_messages WHERE contact_id = $1`, [CONTACT])).rows;
    expect(inbound).toEqual([{ application_id: APP, channel: "gmail", direction: "inbound" }]);
    const sent = (await pool.query(`SELECT gmail_message_id, gmail_thread_id FROM crm_email_log WHERE contact_id = $1`, [CONTACT])).rows;
    expect(sent).toEqual([{ gmail_message_id: `out-${tag}`, gmail_thread_id: `thread-${tag}` }]);
    expect((await pool.query(`SELECT filename FROM contact_documents WHERE contact_id = $1`, [CONTACT])).rows).toEqual([{ filename: `doc-${tag}.pdf` }]);
    expect((await pool.query(`SELECT gmail_history_id FROM google_workspace_accounts WHERE user_id = $1`, [USER])).rows[0].gmail_history_id).toBe("42");
    // The history sync again (history id cleared): nothing new.
    await pool.query(`UPDATE google_workspace_accounts SET gmail_history_id = NULL WHERE user_id = $1`, [USER]);
    const again = await syncGmailAccount(pool as any, USER);
    expect(again).toMatchObject({ inbound: 0, outbound: 0, attachments: 0 });
    expect(Number((await pool.query(`SELECT count(*) FROM gmail_messages WHERE user_id = $1`, [USER])).rows[0].count)).toBe(2);
  });
});
