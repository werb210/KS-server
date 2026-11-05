// KS_META_LEAD_ADS_v1 - Facebook lead ads: webhook signature, lead parsing, one CRM lead per lead id.
import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { encryptToken } from "../services/workspace/tokenCrypto.js";

const h = vi.hoisted(() => ({ query: vi.fn(), submit: vi.fn() }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: h.query }, dbQuery: h.query, runQuery: h.query }));
vi.mock("../marketing/kitLead.js", () => ({ submitKitLead: h.submit }));

import { authUrl, handleLead, leadEvents, leadValues, signatureValid, type MetaConfig } from "../metaLeads/meta.js";
import { metaWebhookRoutes } from "../routes/metaLeads.js";

process.env.META_TOKEN_ENCRYPTION_KEY = "test-meta-key";
process.env.META_APP_SECRET = "app-secret";
process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-me";
const PAGE = "1234567890";
const LEAD = "9876543210";
const body = { object: "page", entry: [{ id: PAGE, changes: [{ field: "leadgen", value: { leadgen_id: LEAD, page_id: PAGE, form_id: "555555" } }] }] };
const sign = (raw: string) => "sha256=" + createHmac("sha256", "app-secret").update(raw).digest("hex");

function app() {
  const a = express();
  a.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
  a.use("/api/webhooks/meta", metaWebhookRoutes);
  return a;
}

const graph = vi.fn(async (url: string) => ({
  ok: true, status: 200,
  json: async () => url.includes(LEAD)
    ? { field_data: [{ name: "first_name", values: ["Pat"] }, { name: "last_name", values: ["Sample"] }, { name: "email", values: ["PAT@Example.com"] },
        { name: "how_much_do_you_need?", values: ["$50,000"] }], campaign_name: "Fall trucks" }
    : {},
}));

beforeEach(() => {
  h.query.mockReset(); h.submit.mockReset(); graph.mockClear();
  h.submit.mockResolvedValue({ contactId: "11111111-1111-4111-8111-111111111111", created: true });
  h.query.mockImplementation(answerBySql([
    [/FROM meta_lead_pages WHERE page_id/, { rows: [{ page_id: PAGE, page_name: "Sample Capital", page_token_enc: encryptToken("page-token", process.env, "META_TOKEN_ENCRYPTION_KEY"), active: true, tag: null }] }],
    [/INSERT INTO meta_leads/, { rows: [{ leadgen_id: LEAD }] }],
  ]));
});

describe("parsing", () => {
  it("reads lead events and maps answers", () => {
    expect(leadEvents(body)).toEqual([{ leadgenId: LEAD, pageId: PAGE, formId: "555555", adId: null }]);
    expect(leadEvents({ object: "user", entry: [] })).toEqual([]);
    expect(leadValues([{ name: "full_name", values: ["Pat Sample"] }, { name: "phone_number", values: ["+17805550100"] }, { name: "company_name", values: ["Sample Haulage"] }]))
      .toEqual({ full_name: "Pat Sample", phone: "+17805550100", company: "Sample Haulage" });
  });
  it("checks the signature over the raw body", () => {
    const raw = JSON.stringify(body);
    expect(signatureValid(raw, sign(raw), "app-secret")).toBe(true);
    expect(signatureValid(raw, sign(raw + " "), "app-secret")).toBe(false);
    expect(signatureValid(raw, undefined, "app-secret")).toBe(false);
  });
  it("asks for the lead permissions", () => {
    const cfg: MetaConfig = { appId: "1", appSecret: "s", redirectUri: "https://ops.example/api/oauth/callback/meta", returnUrl: "https://portal.example" };
    expect(authUrl(cfg, "st")).toContain("leads_retrieval");
  });
});

describe("one lead", () => {
  it("fetches the answers with the Page token and makes a tagged CRM lead", async () => {
    const out = await handleLead({ query: h.query } as any, leadEvents(body)[0]!, { fetch: graph as any });
    expect(out).toBe("created");
    expect(String(graph.mock.calls[0]![0])).toContain("access_token=page-token");
    const [, form, sub] = h.submit.mock.calls[0]!;
    expect(form.tag).toBe("facebook_lead");
    expect(form.name).toBe("Facebook lead ad: Fall trucks");
    expect(sub.values).toEqual({ full_name: "Pat Sample", email: "pat@example.com", message: "how much do you need?: $50,000" });
  });
  it("skips a lead already handled and a paused Page", async () => {
    h.query.mockImplementation(answerBySql([
      [/FROM meta_lead_pages WHERE page_id/, { rows: [{ page_id: PAGE, page_name: "P", page_token_enc: "x", active: true }] }],
      [/INSERT INTO meta_leads/, { rows: [] }],
    ]));
    expect(await handleLead({ query: h.query } as any, leadEvents(body)[0]!, { fetch: graph as any })).toBe("duplicate");
    h.query.mockImplementation(answerBySql([[/FROM meta_lead_pages WHERE page_id/, { rows: [{ page_id: PAGE, active: false }] }]]));
    expect(await handleLead({ query: h.query } as any, leadEvents(body)[0]!, { fetch: graph as any })).toBe("paused");
    expect(h.submit).not.toHaveBeenCalled();
  });
  it("releases the claim when the lead cannot be fetched, so a retry works", async () => {
    const broken = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "expired" } }) }));
    await expect(handleLead({ query: h.query } as any, leadEvents(body)[0]!, { fetch: broken as any })).rejects.toThrow(/expired/);
    expect(callsMatching(h.query, /DELETE FROM meta_leads/)).toHaveLength(1);
  });
});

describe("webhook", () => {
  it("answers Meta's check only with the right token", async () => {
    const ok = await request(app()).get("/api/webhooks/meta/leadgen").query({ "hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "42" });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe("42");
    expect((await request(app()).get("/api/webhooks/meta/leadgen").query({ "hub.mode": "subscribe", "hub.verify_token": "no" })).status).toBe(403);
  });
  it("refuses an unsigned post", async () => {
    const res = await request(app()).post("/api/webhooks/meta/leadgen").send(body);
    expect(res.status).toBe(401);
  });
});
