// KS_HUBSPOT_GAPS_1_PAYMENTS - payment links on the brokerage's own Stripe account (Growth and Pro).
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { planIncludes } from "../../plans/catalogue.js";
import {
  connectAuthorizeUrl, formEncode, setStripeFetchForTests, signStripePayload, stripeConfigProblem, verifyStripeSignature, type StripeConfig,
} from "../stripe.js";
import { handleStripeEvent, linkMessage, linkView, openCheckout, sendLink, validateCreate, type LinkRow } from "../paymentLinks.js";

const CFG: StripeConfig = { secretKey: "sk_test_x", clientId: "ca_test", webhookSecret: "whsec_test" };
const ACCT = "acct_123ABC";
const CONTACT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LINK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function link(over: Partial<LinkRow> = {}): LinkRow {
  return {
    id: LINK, token: "t".repeat(32), application_id: "app-1", contact_id: CONTACT, description: "Broker fee", amount_cents: 250000,
    currency: "cad", methods: ["card", "acss_debit"], status: "open", stripe_account_id: ACCT, checkout_session_id: null, checkout_url: null,
    checkout_expires_at: null, checkout_count: 0, payment_intent_id: null, payment_method_type: null, amount_received_cents: null, paid_at: null,
    failed_at: null, failure_message: null, cancelled_at: null, sent_channels: [], sent_at: null, expires_at: new Date(Date.now() + 86_400_000 * 10),
    quickbooks_status: "none", quickbooks_payment_id: null, quickbooks_error: null, quickbooks_attempts: 0, created_by: null,
    created_at: new Date(), updated_at: new Date(), ...over,
  };
}

afterEach(() => setStripeFetchForTests(null));

describe("plan and platform settings", () => {
  it("is a Growth and Pro feature", () => {
    expect(planIncludes("starter", "payment_links")).toBe(false);
    expect(planIncludes("growth", "payment_links")).toBe(true);
    expect(planIncludes("pro", "payment_links")).toBe(true);
  });

  it("names every missing platform setting", () => {
    expect(stripeConfigProblem({})).toContain("STRIPE_SECRET_KEY, STRIPE_CONNECT_CLIENT_ID, STRIPE_CONNECT_WEBHOOK_SECRET");
    expect(stripeConfigProblem({ STRIPE_SECRET_KEY: "a", STRIPE_CONNECT_CLIENT_ID: "b", STRIPE_CONNECT_WEBHOOK_SECRET: "c" })).toBeNull();
  });

  it("sends the Admin to Stripe's Standard connect screen with a one-time state", () => {
    const u = new URL(connectAuthorizeUrl(CFG, "state123", "https://server.example/api/payments/stripe/callback", { email: "a@b.test" }));
    expect(u.origin + u.pathname).toBe("https://connect.stripe.com/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("ca_test");
    expect(u.searchParams.get("scope")).toBe("read_write");
    expect(u.searchParams.get("state")).toBe("state123");
    expect(u.searchParams.get("stripe_user[country]")).toBe("CA");
  });
});

describe("Stripe plumbing", () => {
  it("form-encodes nested objects and arrays the way Stripe reads them", () => {
    const s = decodeURIComponent(formEncode({ a: 1, b: { c: "x", d: [1, 2] }, e: ["card", "acss_debit"], skip: undefined }));
    expect(s).toBe("a=1&b[c]=x&b[d][0]=1&b[d][1]=2&e[0]=card&e[1]=acss_debit");
  });

  it("accepts a correct webhook signature and refuses a wrong, missing or stale one", () => {
    const body = JSON.stringify({ id: "evt_1" });
    const now = 1_800_000_000;
    expect(verifyStripeSignature(body, signStripePayload(body, "whsec_test", now), "whsec_test", now)).toBe(true);
    expect(verifyStripeSignature(body, signStripePayload(body, "whsec_other", now), "whsec_test", now)).toBe(false);
    expect(verifyStripeSignature(body + " ", signStripePayload(body, "whsec_test", now), "whsec_test", now)).toBe(false);
    expect(verifyStripeSignature(body, undefined, "whsec_test", now)).toBe(false);
    expect(verifyStripeSignature(body, signStripePayload(body, "whsec_test", now - 3600), "whsec_test", now)).toBe(false);
  });
});

describe("creating a link", () => {
  it("checks the amount, description, methods and record", () => {
    const bad = validateCreate({ amount: "0.5", description: "", methods: [], expires_days: 200 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["amount", "description", "expires_days", "methods", "record"]);
    const good = validateCreate({ application_id: "app-1", amount: "$2,500.00", description: "Broker fee", methods: ["acss_debit"] });
    expect(good).toEqual({ ok: true, value: { applicationId: "app-1", contactId: null, amountCents: 250000, description: "Broker fee", methods: ["acss_debit"], expiresDays: 30 } });
  });

  it("writes a readable email and text with the link and no number of ours", () => {
    const m = linkMessage(link(), "Pat");
    expect(m.subject).toContain("$2,500.00");
    expect(m.text).toContain("/api/payments/pay/" + "t".repeat(32));
    expect(m.text).toContain("by card or by pre-authorized debit");
    expect(m.sms).toContain("Reply STOP");
    expect(m.html + m.text + m.sms).not.toMatch(/587.?888.?1837/);
  });

  it("texts only with consent and reports why not", async () => {
    let contact = { first_name: "Pat", email: "pat@x.test", phone: "+14035550100", sms_out: false, sms_ok: false };
    const q = vi.fn(answerBySql([[/FROM contacts c WHERE c.id = \$1::uuid/, () => ({ rows: [contact] })]]));
    const email = vi.fn(async () => ({ ok: true })), sms = vi.fn(async () => ({ ok: true }));
    const r = await sendLink({ query: q }, link(), { email: true, sms: true }, { email, sms }, null);
    expect(r.sent).toEqual(["email"]);
    expect(r.refused.sms).toMatch(/not agreed to texts/);
    expect(sms).not.toHaveBeenCalled();
    expect(callsMatching(q, /INSERT INTO crm_timeline_events/)).toHaveLength(1);
    contact = { ...contact, sms_ok: true, sms_out: true };
    expect((await sendLink({ query: q }, link(), { sms: true }, { email, sms }, null)).refused.sms).toMatch(/STOP/);
    contact = { ...contact, sms_out: false };
    expect((await sendLink({ query: q }, link(), { sms: true }, { email, sms }, null)).sent).toEqual(["sms"]);
  });
});

describe("the client opens the link", () => {
  const db = (accountId: string | null = ACCT) => ({ query: vi.fn(answerBySql([[/FROM stripe_connection/, { rows: accountId ? [{ account_id: accountId, status: "connected" }] : [] }]])) });

  it("creates a Checkout session on the brokerage's account with card and pre-authorized debit", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    setStripeFetchForTests(async (url, init) => { calls.push({ url, init: init! }); return new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1", expires_at: 1_900_000_000 }), { status: 200 }); });
    const d = db();
    const r = await openCheckout(d, CFG, link(), { customerEmail: "pat@x.test" });
    expect(r).toEqual({ kind: "redirect", url: "https://checkout.stripe.com/c/cs_1" });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Stripe-Account"]).toBe(ACCT);
    expect(headers["Idempotency-Key"]).toBe(`ks-pl-${LINK}-1`);
    const body = decodeURIComponent(String(calls[0]!.init.body));
    expect(body).toContain("payment_method_types[0]=card&payment_method_types[1]=acss_debit");
    expect(body).toContain("payment_method_options[acss_debit][mandate_options][payment_schedule]=sporadic");
    expect(body).toContain("payment_method_options[acss_debit][mandate_options][transaction_type]=business");
    expect(body).toContain("line_items[0][price_data][unit_amount]=250000");
    expect(body).not.toContain("application_fee");
    expect(callsMatching(d.query, /UPDATE payment_links SET checkout_session_id/)).toHaveLength(1);
  });

  it("reuses a Checkout page that is still open, and explains paid, expired and disconnected links", async () => {
    setStripeFetchForTests(async () => { throw new Error("should not call Stripe"); });
    const open = link({ checkout_url: "https://checkout.stripe.com/c/old", checkout_expires_at: new Date(Date.now() + 3_600_000) });
    expect(await openCheckout(db(), CFG, open)).toEqual({ kind: "redirect", url: "https://checkout.stripe.com/c/old" });
    expect(await openCheckout(db(), CFG, link({ status: "paid" }))).toMatchObject({ kind: "page", title: "Already paid" });
    expect(await openCheckout(db(), CFG, link({ expires_at: new Date(Date.now() - 1000) }))).toMatchObject({ kind: "page", status: 410 });
    expect(await openCheckout(db(null), CFG, link())).toMatchObject({ kind: "page", status: 503 });
    expect(await openCheckout(db("acct_OTHER"), CFG, link())).toMatchObject({ kind: "page", status: 503 });
  });
});

describe("Stripe events", () => {
  function store(l: LinkRow) {
    const state = { link: { ...l } };
    const q = vi.fn(answerBySql([
      [/FROM payment_links WHERE id = \$1::uuid/, () => ({ rows: [state.link] })],
      [/UPDATE payment_links SET status = 'paid'/, () => { state.link = { ...state.link, status: "paid" }; return { rows: [] }; }],
      [/UPDATE payment_links SET status = 'processing'/, () => { state.link = { ...state.link, status: "processing" }; return { rows: [] }; }],
      [/UPDATE payment_links SET status = 'failed'/, () => { state.link = { ...state.link, status: "failed" }; return { rows: [] }; }],
    ]));
    return { q, state };
  }
  const session = (over: Record<string, unknown> = {}) => ({ id: "cs_1", client_reference_id: LINK, metadata: { keystone_payment_link: LINK }, amount_total: 250000, payment_intent: "pi_1", ...over });

  it("a card payment is paid at once, goes on the timeline and is recorded in QuickBooks", async () => {
    const { q, state } = store(link());
    const qbo = vi.fn(async () => {});
    const r = await handleStripeEvent({ query: q }, { type: "checkout.session.completed", account: ACCT, data: { object: session({ payment_status: "paid" }) } }, { recordInQuickBooks: qbo });
    expect(r).toEqual({ handled: true, linkId: LINK, status: "paid" });
    expect(state.link.status).toBe("paid");
    expect(callsMatching(q, /UPDATE payment_links SET status = 'paid'/)[0]![1]).toEqual([LINK, "pi_1", "card", 250000]);
    const [, tl] = callsMatching(q, /INSERT INTO crm_timeline_events/)[0]!;
    expect((tl as unknown[])[2]).toBe("payment_received");
    expect(qbo).toHaveBeenCalledWith(LINK);
  });

  it("a bank debit is processing, then paid (or failed and open to retry)", async () => {
    const { q, state } = store(link());
    await handleStripeEvent({ query: q }, { type: "checkout.session.completed", account: ACCT, data: { object: session({ payment_status: "unpaid" }) } });
    expect(state.link.status).toBe("processing");
    await handleStripeEvent({ query: q }, { type: "checkout.session.async_payment_succeeded", account: ACCT, data: { object: session({ payment_status: "paid" }) } });
    expect(state.link.status).toBe("paid");
    expect(callsMatching(q, /UPDATE payment_links SET status = 'paid'/)[0]![1]).toEqual([LINK, "pi_1", "acss_debit", 250000]);
    const failed = store(link());
    await handleStripeEvent({ query: failed.q }, { type: "checkout.session.async_payment_failed", account: ACCT, data: { object: session() } });
    expect(failed.state.link.status).toBe("failed");
  });

  it("ignores an event from another Stripe account", async () => {
    const { q, state } = store(link());
    const r = await handleStripeEvent({ query: q }, { type: "checkout.session.completed", account: "acct_EVIL", data: { object: session({ payment_status: "paid" }) } });
    expect(r.handled).toBe(false);
    expect(state.link.status).toBe("open");
  });

  it("shows an open link past its date as expired", () => {
    expect(linkView(link({ expires_at: new Date(Date.now() - 1) })).status).toBe("expired");
    expect(linkView(link()).url).toContain("/api/payments/pay/");
  });
});
