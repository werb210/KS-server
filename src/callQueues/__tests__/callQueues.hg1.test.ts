// KS_HUBSPOT_GAPS_1_CALL_QUEUES - call queues (Pro).
import { describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { planIncludes } from "../../plans/catalogue.js";
import { validateMenu } from "../../phoneMenu/menu.js";
import { markConnected, pickOffer, validateQueue } from "../queues.js";

const U1 = "11111111-1111-4111-8111-111111111111", U2 = "22222222-2222-4222-8222-222222222222";
const Q1 = "33333333-3333-4333-8333-333333333333";

describe("call queue settings", () => {
  it("is a Pro feature", () => {
    expect(planIncludes("growth", "call_queues")).toBe(false);
    expect(planIncludes("pro", "call_queues")).toBe(true);
  });

  it("checks name, members, waits, ring time, recordings and the overflow voicemail", () => {
    const bad = validateQueue({ name: "", member_ids: ["nobody"], max_wait_seconds: 5, ring_seconds: 99, hold_audio_id: "x", overflow_user_id: "y" }, { userIds: [U1], audioIds: [] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["hold_audio_id", "max_wait_seconds", "member_ids", "name", "overflow_user_id", "ring_seconds"]);
    const ok = validateQueue({ name: "Sales", member_ids: [U1, U2, U1], overflow: "ask" }, { userIds: [U1, U2], audioIds: [] });
    expect(ok).toMatchObject({ ok: true, value: { name: "Sales", member_ids: [U1, U2], max_wait_seconds: 300, ring_seconds: 20, overflow: "ask", announce_position: true } });
  });

  it("a phone-menu option can go to a queue only when the plan has queues and the queue is active", () => {
    const menu = (target: unknown) => ({ greeting: { mode: "tts", text: "Hi" }, afterHoursGreeting: { mode: "tts", text: "Closed" }, options: [{ digit: "1", label: "sales", target }] });
    const noPlan = validateMenu(menu({ type: "queue", queueId: Q1 }), { userIds: [U1], audioIds: [] });
    expect(noPlan.ok).toBe(false);
    if (!noPlan.ok) expect(noPlan.errors["options.0.target"]).toMatch(/Pro plan/);
    const ok = validateMenu(menu({ type: "queue", queueId: Q1 }), { userIds: [U1], audioIds: [], queueIds: [Q1] });
    expect(ok.ok && ok.value.options[0]!.target).toEqual({ type: "queue", queueId: Q1 });
    const noAnswer = validateMenu({ ...menu({ type: "user", userId: U1 }), noAnswer: { ringSeconds: 20, target: { type: "queue", queueId: Q1 } } }, { userIds: [U1], audioIds: [], queueIds: [Q1] });
    expect(noAnswer.ok).toBe(true);
  });
});

describe("who gets the call", () => {
  it("offers the oldest caller to the longest-idle free member, skipping people who missed this caller", async () => {
    const q = vi.fn(answerBySql([
      [/pg_advisory_xact_lock/, { rows: [] }],
      [/FROM call_queue_calls WHERE queue_id = \$1::uuid AND status = 'waiting' ORDER BY enqueued_at/, { rows: [{ id: "c1", skipped: [U1] }] }],
      [/FROM call_queue_members m/, (_s: string, p?: unknown[]) => ({ rows: (p?.[1] as string[]).includes(U1) ? [{ user_id: U2, identity: "sue", idle_since: "2026-10-26T10:00:00Z" }] : [{ user_id: U1, identity: "sam", idle_since: "2026-10-26T09:00:00Z" }] })],
      [/UPDATE call_queue_calls SET status = 'offered'/, { rows: [{ id: "c1" }] }],
    ]));
    expect(await pickOffer({ query: q } as any, Q1)).toEqual({ callId: "c1", userId: U2, identity: "sue" });
    const [sql] = callsMatching(q, /FROM call_queue_members m/)[0]!;
    expect(String(sql)).toContain("ORDER BY idle_since ASC");
    expect(String(sql)).toContain("ag.available = true");
  });

  it("starts the round again when everyone free has been tried", async () => {
    const q = vi.fn(answerBySql([
      [/FROM call_queue_calls WHERE queue_id = \$1::uuid AND status = 'waiting' ORDER BY enqueued_at/, { rows: [{ id: "c1", skipped: [U1, U2] }] }],
      [/FROM call_queue_members m/, (_s: string, p?: unknown[]) => ({ rows: (p?.[1] as string[]).length ? [] : [{ user_id: U1, identity: "sam", idle_since: null }] })],
      [/UPDATE call_queue_calls SET status = 'offered'/, { rows: [{ id: "c1" }] }],
    ]));
    expect(await pickOffer({ query: q } as any, Q1)).toEqual({ callId: "c1", userId: U1, identity: "sam" });
    expect(callsMatching(q, /UPDATE call_queue_calls SET status = 'offered'/)[0]![1]).toEqual(["c1", U1, []]);
  });

  it("nobody free: the caller keeps waiting", async () => {
    const q = vi.fn(answerBySql([
      [/FROM call_queue_calls WHERE queue_id = \$1::uuid AND status = 'waiting' ORDER BY enqueued_at/, { rows: [{ id: "c1", skipped: [] }] }],
      [/FROM call_queue_members m/, { rows: [] }],
    ]));
    expect(await pickOffer({ query: q } as any, Q1)).toBeNull();
    expect(callsMatching(q, /UPDATE call_queue_calls/)).toHaveLength(0);
  });

  it("when an agent's call dequeues a different caller than offered, the two offers swap", async () => {
    const q = vi.fn(answerBySql([
      [/FROM call_queue_calls WHERE call_sid = \$1/, { rows: [{ id: "front", user_id: U1, offer_call_sid: "CAsam" }] }],
      [/FROM call_queue_calls WHERE offer_call_sid = \$1/, { rows: [{ id: "second", user_id: U2 }] }],
    ]));
    expect(await markConnected({ query: q }, "CAcallerFront", "CAsue")).toEqual({ callId: "front", userId: U2 });
    const updates = callsMatching(q, /UPDATE call_queue_calls/);
    expect(updates[0]![1]).toEqual(["second", U1, "CAsam"]); // Sam's ringing offer now belongs to the second caller
    expect(updates[1]![1]).toEqual(["front", U2, "CAsue"]);
  });
});
