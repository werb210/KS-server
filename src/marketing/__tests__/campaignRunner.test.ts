// KS_SERVER_MARKETING_ADDON - the A/B subject test runs in two phases (a sample, then the winner to everyone else),
// best-time sending schedules people for their usual hour, and every email is metered and kept in campaign_sends.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const { sendOne } = vi.hoisted(() => ({ sendOne: vi.fn() }));
vi.mock("../../services/sendgridService.js", async (orig) => ({ ...(await orig<any>()), sendOne }));
vi.mock("../../db.js", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { runCampaignEmailJob } from "../campaignRunner.js";
import { clearPlanCache } from "../../plans/state.js";

type Send = { id: string; contact_id: string; variant: string; status: string; subject: string; opened_at: Date | null; scheduled_for: string | null };
let sends: Send[];
let people: Array<{ id: string; email: string; name: string; company: null }>;
let opens: Array<{ contact_id: string; created_at: Date }>;

function fakePool() {
  let n = 0;
  return {
    query: vi.fn(answerBySql([
      [/FROM licensee_plan WHERE id = 1/, { rows: [{ plan: "growth", addons: { marketing: true } }] }],
      [/kind = 'campaign_email' AND occurred_at/, { rows: [{ n: 0 }] }],
      [/SELECT contact_id::text AS contact_id FROM campaign_sends WHERE job_id/, () => ({ rows: sends.map((s) => ({ contact_id: s.contact_id })) })],
      [/FROM contacts c LEFT JOIN companies co ON co.id = c.company_id\s+WHERE c.silo/, () => ({ rows: people })],
      [/INSERT INTO campaign_sends[\s\S]*'scheduled'/, (_s: string, p?: unknown[]) => {
        sends.push({ id: `cs${++n}`, contact_id: String(p![1]), variant: "A", status: "scheduled", subject: String(p![3]), opened_at: null, scheduled_for: String(p![4]) });
        return { rows: [], rowCount: 1 };
      }],
      [/INSERT INTO campaign_sends/, (_s: string, p?: unknown[]) => {
        const s = { id: `cs${++n}`, contact_id: String(p![1]), variant: String(p![3]), status: "sent", subject: String(p![4]), opened_at: null, scheduled_for: null };
        sends.push(s);
        return { rows: [{ id: s.id }], rowCount: 1 };
      }],
      [/SELECT variant, COUNT/, () => {
        const by = (v: string) => sends.filter((s) => s.variant === v);
        return { rows: ["A", "B"].map((v) => ({ variant: v, sent: by(v).length, opened: by(v).filter((s) => s.opened_at).length, clicked: 0 })) };
      }],
      [/COUNT\(\*\) FILTER \(WHERE status = 'sent'\)::int AS sent, COUNT\(\*\) FILTER \(WHERE status = 'failed'\)/, () => ({
        rows: [{ sent: sends.filter((s) => s.status === "sent").length, failed: 0, scheduled: sends.filter((s) => s.status === "scheduled").length }],
      })],
      [/FROM crm_timeline_events\s+WHERE contact_id::text = ANY/, () => ({ rows: opens })],
      [/SELECT MIN\(scheduled_for\)/, () => {
        const due = sends.filter((s) => s.status === "scheduled").map((s) => s.scheduled_for!).sort();
        return { rows: [{ at: due[0] ?? null }] };
      }],
    ])),
  };
}

const row = (payload: Record<string, unknown>) => ({ id: "job-1", silo: "BF", tag: "vip", payload: { subject: "Subject A", html: "<p>Hi {{first_name}}</p>", ...payload } });

beforeEach(() => {
  sends = [];
  opens = [];
  people = Array.from({ length: 20 }, (_, i) => ({ id: `c${String(i).padStart(2, "0")}`, email: `p${i}@ex.ca`, name: `P ${i}`, company: null }));
  sendOne.mockReset();
  sendOne.mockResolvedValue({ ok: true, status: 202 });
  clearPlanCache();
});

describe("subject-line A/B test", () => {
  it("sends the sample half A, half B, waits, then sends the winner to everyone else", async () => {
    const pool = fakePool();
    const ab = { subjectB: "Subject B", testPercent: 20, waitHours: 4, phase: "test" };
    const now = new Date("2026-10-26T18:00:00Z");
    const first = await runCampaignEmailJob(pool as any, row({ ab }), undefined, undefined, now);
    expect(first).toMatchObject({ status: "waiting", sent: 4 });
    expect(first.notBefore!.toISOString()).toBe("2026-10-26T22:00:00.000Z");
    expect(sends.map((s) => s.variant).sort()).toEqual(["A", "A", "B", "B"]);
    expect(sendOne.mock.calls.map((c) => c[0].subject).sort()).toEqual(["Subject A", "Subject A", "Subject B", "Subject B"]);
    expect(sendOne.mock.calls[0][0].customArgs.cs_id).toMatch(/^cs\d+$/);
    expect(callsMatching(pool.query, /INSERT INTO usage_events/).map((c) => (c[1] as unknown[])[0])).toEqual(Array(4).fill("campaign_email"));

    // B wins on opens.
    for (const s of sends) if (s.variant === "B") s.opened_at = new Date();
    const second = await runCampaignEmailJob(pool as any, row({ ab: { ...ab, ...(first.payloadPatch!.ab as object) } }), undefined, undefined, now);
    expect(second).toMatchObject({ status: "done", sent: 20 });
    expect((second.payloadPatch!.ab as any).winner).toBe("B");
    const rest = sendOne.mock.calls.slice(4).map((c) => c[0].subject);
    expect(rest).toHaveLength(16);
    expect(new Set(rest)).toEqual(new Set(["Subject B"]));
  });
});

describe("each person's best time", () => {
  it("sends now to people without history and schedules the rest for their usual hour", async () => {
    const pool = fakePool();
    const now = new Date("2026-10-26T18:00:00Z"); // 12:00 Alberta
    opens = [{ contact_id: "c00", created_at: new Date("2026-10-20T14:15:00Z") }, { contact_id: "c00", created_at: new Date("2026-10-21T14:45:00Z") }];
    const step = await runCampaignEmailJob(pool as any, row({ sendTime: "best" }), undefined, undefined, now);
    expect(step.status).toBe("waiting");
    expect(step.notBefore!.toISOString()).toBe("2026-10-27T14:00:00.000Z"); // 08:00 tomorrow
    expect(step.payloadPatch).toEqual({ phase: "deliver" });
    expect(sendOne).toHaveBeenCalledTimes(19);
    expect(sends.find((s) => s.contact_id === "c00")).toMatchObject({ status: "scheduled" });
    expect(callsMatching(pool.query, /INSERT INTO campaign_sends[\s\S]*'scheduled'/)).toHaveLength(1);
  });
});
