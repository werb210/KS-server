// KS_SERVER_v20_WEBHOOKS - signing, retry and backoff, disabling with an Admin alert, SSRF blocking, payloads.
import { describe, expect, it } from "vitest";
import { computeSignature, signatureHeaders, verifySignature, newSecret } from "../signing.js";
import { backoffMs, deliverOne, RETRY, type ClaimedDelivery, type Transport } from "../deliver.js";
import { checkUrlShape, checkWebhookUrl, isBlockedAddress, safeLookup, type Resolver } from "../ssrf.js";
import { buildBody, EVENTS, EVENT_TYPES, sampleBody } from "../events.js";

type Call = { sql: string; params: unknown[] };
function fakeDb(answer: (sql: string, params: unknown[]) => any = () => ({ rows: [] })) {
  const calls: Call[] = [];
  return {
    calls,
    db: { query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return answer(sql, params) ?? { rows: [] }; } },
  };
}

const SECRET = "whsec_test_secret";
const delivery = (over: Partial<ClaimedDelivery> = {}): ClaimedDelivery => ({
  id: "d1", event_id: "e1", endpoint_id: "ep1", event_type: "contact.created", object_type: "contact", occurred_at: "2026-11-03T10:00:00.000Z",
  payload: { object: { id: "c1", email: "a@b.co", ssn_encrypted: "\\x00", custom_fields: { tier: "gold" } }, extra: {} },
  attempts: 0, url: "https://hooks.example.com/x", endpoint_status: "active", secret: SECRET, ...over,
});

describe("signing", () => {
  it("signs timestamp.body with HMAC-SHA256 and verifies it", () => {
    const body = JSON.stringify({ hello: "world" });
    const now = 1_767_225_600_000;
    const h = signatureHeaders(SECRET, body, now);
    expect(h["X-Webhook-Timestamp"]).toBe("1767225600");
    expect(h["X-Webhook-Signature"]).toBe(`t=1767225600,v1=${computeSignature(SECRET, 1767225600, body)}`);
    expect(verifySignature(SECRET, h["X-Webhook-Signature"], body, now + 60_000)).toEqual({ ok: true });
  });

  it("rejects a changed body, the wrong secret, a stale timestamp (replay) and junk", () => {
    const body = "{}";
    const now = 1_767_225_600_000;
    const sig = signatureHeaders(SECRET, body, now)["X-Webhook-Signature"];
    expect(verifySignature(SECRET, sig, "{ }", now)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature("whsec_other", sig, body, now)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature(SECRET, sig, body, now + 301_000)).toEqual({ ok: false, reason: "stale" });
    expect(verifySignature(SECRET, "v1=abc", body, now)).toEqual({ ok: false, reason: "malformed" });
  });

  it("makes long random secrets", () => {
    const a = newSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(newSecret()).not.toBe(a);
  });
});

describe("backoff", () => {
  it("doubles from one minute, caps at six hours and adds +-20% jitter", () => {
    const mid = () => 0.5; // no jitter
    expect([1, 2, 3, 4, 5].map((n) => backoffMs(n, mid))).toEqual([60_000, 120_000, 240_000, 480_000, 960_000]);
    expect(backoffMs(20, mid)).toBe(RETRY.maxMs);
    expect(backoffMs(1, () => 0)).toBe(48_000);
    expect(backoffMs(1, () => 0.999999)).toBeGreaterThan(71_000);
  });
});

describe("deliverOne", () => {
  it("POSTs the signed body with event headers and records success", async () => {
    const { db, calls } = fakeDb();
    let sent: any = null;
    const transport: Transport = async (req) => { sent = req; return { status: 204, body: "" }; };
    expect(await deliverOne(db, delivery(), { transport, now: () => 1_767_225_600_000 })).toBe("succeeded");
    expect(sent.url).toBe("https://hooks.example.com/x");
    expect(sent.headers).toMatchObject({ "Content-Type": "application/json", "X-Webhook-Event": "contact.created", "X-Webhook-Id": "e1", "X-Webhook-Delivery": "d1", "X-Webhook-Attempt": "1" });
    expect(verifySignature(SECRET, sent.headers["X-Webhook-Signature"], sent.body, 1_767_225_600_000)).toEqual({ ok: true });
    const body = JSON.parse(sent.body);
    expect(body).toMatchObject({ id: "e1", type: "contact.created", data: { object: { object: "contact", id: "c1", email: "a@b.co", custom_fields: { tier: "gold" } } } });
    expect(sent.body).not.toContain("ssn");
    expect(calls.some((c) => /status = 'succeeded'/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /consecutive_failures = 0/.test(c.sql))).toBe(true);
  });

  it("schedules a retry with backoff on a 500 or a network error", async () => {
    const { db, calls } = fakeDb();
    const now = 1_767_225_600_000;
    expect(await deliverOne(db, delivery({ attempts: 2 }), { transport: async () => ({ status: 500, body: "oops" }), now: () => now, rand: () => 0.5 })).toBe("retry");
    const upd = calls.find((c) => /status = 'pending'/.test(c.sql))!;
    expect(upd.params[1]).toBe(3); // attempts
    expect(upd.params[2]).toBe(new Date(now + 240_000).toISOString()); // 4 minutes after the third failure
    expect(upd.params[4]).toBe("HTTP 500: oops");
    const { db: db2, calls: c2 } = fakeDb();
    expect(await deliverOne(db2, delivery(), { transport: async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); }, now: () => now })).toBe("retry");
    expect(c2.find((c) => /status = 'pending'/.test(c.sql))!.params[4]).toContain("ECONNREFUSED");
  });

  it("gives up after the last attempt and disables the endpoint after repeated dead deliveries, alerting every Admin", async () => {
    const { db, calls } = fakeDb((sql) => {
      if (/RETURNING consecutive_failures/.test(sql)) return { rows: [{ consecutive_failures: RETRY.disableAfterDead }] };
      if (/SET status = 'disabled'/.test(sql)) return { rows: [{ id: "ep1" }] };
      if (/FROM users/.test(sql)) return { rows: [{ id: "admin-1" }, { id: "admin-2" }] };
      return { rows: [] };
    });
    expect(await deliverOne(db, delivery({ attempts: RETRY.maxAttempts - 1 }), { transport: async () => ({ status: 502, body: "" }) })).toBe("dead");
    expect(calls.some((c) => /status = 'dead'/.test(c.sql))).toBe(true);
    const notes = calls.filter((c) => /INSERT INTO notifications/.test(c.sql));
    expect(notes.map((n) => n.params[1])).toEqual(["admin-1", "admin-2"]);
    expect(String(notes[0].params[2])).toContain("hooks.example.com");
  });

  it("does not disable before the threshold", async () => {
    const { db, calls } = fakeDb((sql) => (/RETURNING consecutive_failures/.test(sql) ? { rows: [{ consecutive_failures: 1 }] } : { rows: [] }));
    expect(await deliverOne(db, delivery({ attempts: RETRY.maxAttempts - 1 }), { transport: async () => ({ status: 500, body: "" }) })).toBe("dead");
    expect(calls.some((c) => /status = 'disabled'/.test(c.sql))).toBe(false);
  });

  it("disables at once on 410 Gone (a Zap turned off) and on a private address at connect time", async () => {
    for (const transport of [
      (async () => ({ status: 410, body: "" })) as Transport,
      (async () => { throw Object.assign(new Error("resolved to 10.0.0.5"), { code: "EWEBHOOK_BLOCKED_ADDRESS" }); }) as Transport,
    ]) {
      const { db, calls } = fakeDb((sql) => (/SET status = 'disabled'/.test(sql) ? { rows: [{ id: "ep1" }] } : /RETURNING consecutive_failures/.test(sql) ? { rows: [{ consecutive_failures: 1 }] } : { rows: [] }));
      expect(await deliverOne(db, delivery(), { transport })).toBe("dead");
      expect(calls.some((c) => /SET status = 'disabled'/.test(c.sql))).toBe(true);
    }
  });

  it("skips a delivery whose endpoint was paused or disabled meanwhile", async () => {
    const { db, calls } = fakeDb();
    let called = false;
    expect(await deliverOne(db, delivery({ endpoint_status: "paused" }), { transport: async () => { called = true; return { status: 200, body: "" }; } })).toBe("skipped");
    expect(called).toBe(false);
    expect(calls[0].sql).toContain("status = 'skipped'");
  });
});

describe("SSRF guard", () => {
  it("blocks private, loopback, link-local, metadata, CGNAT, multicast and mapped addresses", () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "0.0.0.0", "169.254.169.254", "172.16.5.4", "172.31.255.255", "192.168.1.1", "100.64.0.1",
      "168.63.129.16", "224.0.0.1", "255.255.255.255", "::1", "::", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "not-an-ip"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "52.1.2.3", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it("accepts only public https URLs without credentials", () => {
    expect(checkUrlShape("https://hooks.zapier.com/hooks/catch/1/abc/").ok).toBe(true);
    for (const bad of ["http://hooks.example.com", "ftp://x.example.com", "https://user:pw@hooks.example.com", "https://localhost/x",
      "https://db.internal/x", "https://printer.local", "https://intranet", "https://127.0.0.1/", "https://[::1]/", "https://169.254.169.254/latest", "not a url"]) {
      expect(checkUrlShape(bad).ok, bad).toBe(false);
    }
  });

  it("refuses a host that resolves to a private address when saving", async () => {
    const resolver = (map: Record<string, string[]>): Resolver => async (h) => (map[h] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    const r = resolver({ "good.example.com": ["93.184.216.34"], "evil.example.com": ["93.184.216.34", "10.0.0.7"], "meta.example.com": ["169.254.169.254"] });
    expect((await checkWebhookUrl("https://good.example.com/h", r)).ok).toBe(true);
    expect(await checkWebhookUrl("https://evil.example.com/h", r)).toMatchObject({ ok: false });
    expect(await checkWebhookUrl("https://meta.example.com/h", r)).toMatchObject({ ok: false });
    expect(await checkWebhookUrl("https://nowhere.example.com/h", r)).toMatchObject({ ok: false, error: "That host name could not be found." });
  });

  it("re-checks at connect time: a host re-pointed at a private address (DNS rebinding) is refused", async () => {
    let answer = "93.184.216.34";
    const resolver: Resolver = async () => [{ address: answer, family: 4 }];
    expect((await checkWebhookUrl("https://rebind.example.com/h", resolver)).ok).toBe(true);
    answer = "127.0.0.1";
    const lookup = safeLookup(resolver);
    const err = await new Promise<any>((resolve) => lookup("rebind.example.com", {}, (e) => resolve(e)));
    expect(err?.code).toBe("EWEBHOOK_BLOCKED_ADDRESS");
    answer = "93.184.216.34";
    const ok = await new Promise<any>((resolve) => lookup("rebind.example.com", { all: true }, (e, addrs) => resolve({ e, addrs })));
    expect(ok.e).toBeNull();
    expect(ok.addrs).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });
});

describe("events and payloads", () => {
  it("documents every event with an example body", () => {
    expect(EVENTS.map((e) => e.type)).toEqual([...EVENT_TYPES]);
    const stage = sampleBody("application.stage_changed");
    expect(stage).toMatchObject({ type: "application.stage_changed", data: { from_stage: "DOCUMENTS_REQUIRED", to_stage: "IN_REVIEW", object: { object: "application", stage: "IN_REVIEW" } } });
    expect(sampleBody("deal.funded")).toMatchObject({ data: { object: { funded_amount: 240000 } } });
  });

  it("sends only listed fields, the same bytes every attempt", () => {
    const row = { event_id: "e", event_type: "application.signed", object_type: "application", occurred_at: new Date("2026-01-01T00:00:00Z"),
      payload: { object: { id: "a1", pipeline_state: "Received", signnow_app_signed_at: "2026-01-01T00:00:00Z", metadata: { sin: "123" }, requested_amount: "5000" }, extra: {} } };
    const a = buildBody(row);
    expect(a).toBe(buildBody(row));
    const body = JSON.parse(a);
    expect(body.data.object).toMatchObject({ id: "a1", stage: "Received", signed_at: "2026-01-01T00:00:00Z", custom_fields: {} });
    expect(a).not.toContain("metadata");
    expect(a).not.toContain("123");
  });
});
