// KS_SERVER_SKIP_TEXTED_v1 - "Skip contacts who got a marketing text in the last 7 days" (parity with BF-Server v923).
import { describe, expect, it, vi } from "vitest";
import { answerBySql } from "./helpers/answerBySql.js";
import { countEmailRecipients } from "../services/marketingSendRunner.js";
import { skipTextedDaysOf } from "../routes/marketing.js";

describe("skip recently texted contacts", () => {
  it("passes the window and filters on delivered marketing texts", async () => {
    const pool = { query: vi.fn(answerBySql([[/SELECT count\(\*\)::int AS n/, { rows: [{ n: 3 }] }]])) };
    expect(await countEmailRecipients(pool as any, "BF", null, ["a"], null, null, 7)).toBe(3);
    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(params[5]).toBe(7);
    expect(sql).toContain("FROM sms_campaign_sends x");
    expect(sql).toContain("x.message_sid IS NOT NULL");
  });
  it("reads the checkbox", () => {
    expect(skipTextedDaysOf(true)).toBe(7);
    expect(skipTextedDaysOf(undefined)).toBeNull();
  });
});
