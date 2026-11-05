// KS_LANDING_PAGES_v1 - landing-page builder: block cleaning, rendering, saving and the public form.
import request from "supertest";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn(), lead: vi.fn() }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: h.query }, dbQuery: h.query, runQuery: h.query }));
vi.mock("../marketing/kitLead.js", () => ({ submitKitLead: h.lead }));
vi.mock("../routes/websiteKit.js", () => ({ formLimit: async () => ({ limit: null, extras: true }) }));

import { accentColour, normalizeBlocks, renderPage, safeLink, savePage } from "../landingPages/pages.js";
import publicRoutes, { PAGE_CSP } from "../routes/landingPagesPublic.js";

const FORM = "55555555-5555-4555-8555-555555555555";
const PAGE = "66666666-6666-4666-8666-666666666666";
const kitForm = { id: FORM, name: "Apply", fields: [{ key: "full_name", label: "Full name", required: true }, { key: "email", label: "Email", required: true }],
  button_label: "Get started", thank_you: "Thanks, we will call you.", tag: "lp", active: true, submissions: 0, created_at: "2026-11-01" };
const pageRow = { id: PAGE, slug: "equipment-loans", title: "Equipment loans", description: null, status: "published", views: 0, submissions: 0,
  published_at: null, updated_at: "2026-11-04", silo: "BF",
  blocks: [{ type: "hero", heading: "Finance your next truck", text: "Fast answers.", button_text: "Apply", button_link: "#form" }, { type: "form", form_id: FORM, heading: "Apply now" }] };

function app() {
  const a = express();
  a.use("/api/public/pages", publicRoutes);
  return a;
}

beforeEach(() => {
  h.query.mockReset(); h.lead.mockReset(); h.lead.mockResolvedValue({ contactId: "c1", created: true });
  h.query.mockImplementation(answerBySql([
    [/FROM landing_pages WHERE slug/, (_s: string, p?: unknown[]) => ({ rows: p![0] === "equipment-loans" ? [pageRow] : [] })],
    [/FROM website_kit_forms/, { rows: [kitForm] }],
  ]));
});

describe("blocks", () => {
  it("keeps safe blocks, drops unsafe links and images and extra forms", () => {
    const b = normalizeBlocks([
      { type: "hero", heading: "Hi", image_url: "http://insecure.example/x.png", button_text: "Go", button_link: "javascript:alert(1)" },
      { type: "image", url: "https://cdn.example/a.png", alt: "Truck" },
      { type: "button", text: "Call", link: "tel:+1 780 555 0100" },
      { type: "text", text: "" },
      { type: "form", form_id: FORM }, { type: "form", form_id: FORM },
      { type: "script", html: "<script>" },
    ]);
    expect(b.map((x) => x.type)).toEqual(["hero", "image", "button", "form"]);
    expect((b[0] as any).image_url).toBe("");
    expect((b[0] as any).button_link).toBe("");
    expect(safeLink("#form")).toBe("#form");
  });
  it("uses a readable button colour", () => {
    expect(accentColour("#0B1F3A")).toBe("#0B1F3A");
    expect(accentColour("#FFEE00")).toBe("#0B1F3A");
    expect(accentColour("red")).toBe("#0B1F3A");
  });
  it("escapes text when rendering", () => {
    const html = renderPage({ title: "<x>", description: null, blocks: [{ type: "text", heading: "", text: "<script>alert(1)</script>" }] },
      { brand: "Sample Capital", colour: "#0B1F3A", logoUrl: "", forms: new Map(), formAction: () => "#" });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("saving", () => {
  it("refuses a web address another page uses", async () => {
    const db = { query: vi.fn(answerBySql([[/SELECT id::text AS id FROM landing_pages WHERE slug/, { rows: [{ id: "x" }] }]])) };
    await expect(savePage(db, "BF", { title: "Equipment loans" }, null)).rejects.toMatchObject({ code: "slug_taken", status: 409 });
  });
  it("makes the web address from the title", async () => {
    const db = { query: vi.fn(answerBySql([[/INSERT INTO landing_pages/, (_s: string, p?: unknown[]) => ({ rows: [{ ...pageRow, slug: p![2] }] })]])) };
    const p = await savePage(db, "BF", { title: "Équipement & trucks!", blocks: [] }, null);
    expect(p.slug).toBe("equipement-trucks");
  });
});

describe("public page", () => {
  it("serves a published page with its own security policy and the form", async () => {
    const res = await request(app()).get("/api/public/pages/equipment-loans");
    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toBe(PAGE_CSP);
    expect(res.text).toContain("Finance your next truck");
    expect(res.text).toContain(`action="/api/public/pages/equipment-loans/forms/${FORM}#form"`);
    expect(callsMatching(h.query, /SET views = views \+ 1/)).toHaveLength(1);
  });
  it("404s an unknown or draft page", async () => {
    expect((await request(app()).get("/api/public/pages/nope")).status).toBe(404);
  });
  it("turns a submission into a lead and shows the thank-you", async () => {
    const res = await request(app()).post(`/api/public/pages/equipment-loans/forms/${FORM}`).type("form")
      .send({ full_name: "Pat Sample", email: "pat@example.com", consent: "1", consentText: "Yes" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("Thanks, we will call you.");
    expect(h.lead).toHaveBeenCalledTimes(1);
    expect(h.lead.mock.calls[0][2]).toMatchObject({ values: { full_name: "Pat Sample", email: "pat@example.com" }, consent: true });
    expect(callsMatching(h.query, /SET submissions = submissions \+ 1/)).toHaveLength(1);
  });
  it("shows the problem for a bad submission and ignores bots", async () => {
    const bad = await request(app()).post(`/api/public/pages/equipment-loans/forms/${FORM}`).type("form").send({ full_name: "Pat" });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain("Please fill in email.");
    const bot = await request(app()).post(`/api/public/pages/equipment-loans/forms/${FORM}`).type("form").send({ company_website: "x" });
    expect(bot.status).toBe(200);
    expect(h.lead).not.toHaveBeenCalled();
  });
});
