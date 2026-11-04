// KS_SETUP_WIZARD - the set-up wizard: each role's list, detection from existing data, manual done / skip, dismiss.
// The database fake answers by SQL content (not call order).
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching, type SqlRule } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn(), warn: vi.fn() }));
vi.mock("../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../db.js")>("../../db.js");
  return { ...actual, pool: { query: h.query }, db: { query: h.query }, runQuery: h.query, dbQuery: h.query, query: h.query };
});
vi.mock("../../lib/logWarnSwallowed.js", () => ({ logWarnSwallowed: (err: unknown, where: string, fallback: unknown) => { h.warn(where, err); return fallback; } }));

import { clearPlanCache } from "../../plans/state.js";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const BROKER = "22222222-2222-4222-8222-222222222222";
const MKT = "33333333-3333-4333-8333-333333333333";
const OPS = "44444444-4444-4444-8444-444444444444";
const ROLE_OF: Record<string, string> = { [ADMIN]: "Admin", [BROKER]: "Staff", [MKT]: "Marketing", [OPS]: "Ops" };
const token = (id: string) => jwt.sign({ sub: id, id, role: ROLE_OF[id], tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));

type World = {
  plan?: string;
  progress?: Array<{ user_id: string; step_key: string; status: string }>;
  ok?: Record<string, boolean>; // detection answers by fact name
  myContacts?: number;
  fail?: RegExp; // a detection query that throws
};

let world: World;
const ok = (name: string) => ({ rows: world.ok?.[name] ? [{ ok: true }] : [{ ok: false }] });

function rules(): SqlRule[] {
  const failing: SqlRule[] = world.fail ? [[world.fail, new Error("relation does not exist")]] : [];
  return [
    ...failing,
    [/FROM users\s+WHERE id = \$1|FROM users WHERE id/, (sql: string, p?: unknown[]) => {
      if (/first_name\), ''\) <> ''/.test(sql)) return ok("profile");
      if (/o365_refresh_token IS NOT NULL/.test(sql)) return ok("ownMicrosoft");
      const id = String(p?.[0]);
      return { rows: [{ id, role: ROLE_OF[id] ?? "Staff", active: true, status: "ACTIVE", token_version: 0, disabled: false }] };
    }],
    [/FROM licensee_plan/, () => ({ rows: [{ plan: world.plan ?? "growth", service_status: "active", addons: {} }] })],
    [/FROM setup_progress WHERE user_id = \$1$/, (_s: string, p?: unknown[]) => ({ rows: (world.progress ?? []).filter((r) => r.user_id === p?.[0]) })],
    [/INSERT INTO setup_progress/, (_s: string, p?: unknown[]) => {
      world.progress = (world.progress ?? []).filter((r) => !(r.user_id === p?.[0] && r.step_key === p?.[1]));
      world.progress.push({ user_id: String(p?.[0]), step_key: String(p?.[1]), status: String(p?.[2]) });
      return { rows: [] };
    }],
    [/DELETE FROM setup_progress/, (_s: string, p?: unknown[]) => {
      world.progress = (world.progress ?? []).filter((r) => !(r.user_id === p?.[0] && r.step_key === p?.[1]));
      return { rows: [] };
    }],
    [/email_signature_html\), ''\) <> ''\) AS ok FROM user_settings/, () => ok("signature")],
    [/booking_url\), ''\) <> ''/, () => ok("bookingLink")],
    [/FROM google_workspace_accounts/, () => ok("ownGoogle")],
    [/office365_tenant_id/, () => ok("companyMicrosoft")],
    [/logo_url/, () => ok("brand")],
    [/count\(\*\) > 1\) AS ok FROM users/, () => ok("team")],
    [/FROM phone_numbers/, () => ok("phoneNumber")],
    [/FROM lenders/, () => ok("lender")],
    [/FROM import_batches/, () => ok("imported")],
    [/FROM contacts WHERE owner_id/, () => ({ rows: [{ n: world.myContacts ?? 0 }] })],
    [/FROM stripe_connection/, () => ok("stripe")],
    [/FROM quickbooks_connection/, () => ok("quickbooks")],
    [/FROM applications WHERE owner_user_id/, () => ok("myApplication")],
    [/FROM applications LIMIT 1/, () => ok("application")],
    [/FROM staff_push_tokens/, () => ok("dialler")],
    [/mailing_address/, () => ok("sender")],
    [/website_kit_forms/, () => ok("websiteKit")],
    [/marketing_send_jobs/, () => ok("campaign")],
  ];
}

async function app() {
  const router = (await import("../../routes/setup.js")).default;
  const a = express();
  a.use(express.json());
  a.use("/api/setup", router);
  return a;
}
const get = async (id: string) => request(await app()).get("/api/setup").set("Authorization", `Bearer ${token(id)}`);
const put = async (id: string, path: string, body: unknown = {}) => request(await app()).put(`/api/setup${path}`).set("Authorization", `Bearer ${token(id)}`).send(body as object);
const keys = (body: any) => body.steps.map((s: any) => s.key);
const step = (body: any, key: string) => body.steps.find((s: any) => s.key === key);

beforeEach(() => {
  world = {};
  clearPlanCache();
  h.query.mockReset();
  h.warn.mockReset();
  h.query.mockImplementation((sql: unknown, params?: unknown[]) => answerBySql(rules())(sql, params));
});

describe("each role's list", () => {
  it("Admin: the nine brokerage set-up steps in order, each linking to an existing page with a help article", async () => {
    const r = await get(ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.role).toBe("admin");
    expect(keys(r.body)).toEqual(["profile", "brand", "team", "phone", "email", "lenders", "import", "payments", "test_link"]);
    expect(r.body.steps.map((s: any) => s.link)).toEqual([
      "/settings/profile", "/settings/company", "/settings/users", "/settings/phone", "/settings/connections", "/lenders",
      "/settings/import", "/settings/payments", "/crm/contacts",
    ]);
    expect(step(r.body, "brand").help_slug).toBe("brand-your-portal");
    expect(step(r.body, "payments")).toMatchObject({ title: "Payments and QuickBooks", optional: true });
    expect(step(r.body, "test_link").external_url).toMatch(/^https:\/\//);
    expect(r.body).toMatchObject({ done: 0, total: 9, complete: false, dismissed: false });
    for (const s of r.body.steps) {
      expect(s.status).toBe("todo");
      expect(s.title).not.toMatch(/[A-Z_]{4,}|_/);
    }
  });

  it("Admin on Starter: payment links are not in the plan, so the step is QuickBooks alone on the Company page", async () => {
    world.plan = "starter";
    const r = await get(ADMIN);
    expect(step(r.body, "payments")).toMatchObject({ title: "Connect QuickBooks", link: "/settings/company" });
    world.ok = { stripe: true };
    clearPlanCache();
    expect(step((await get(ADMIN)).body, "payments").status).toBe("todo"); // Stripe does not count on Starter
  });

  it("Broker (the Staff role): profile, email, booking link, the apps and a first contact", async () => {
    const r = await get(BROKER);
    expect(r.body.role).toBe("broker");
    expect(keys(r.body)).toEqual(["profile", "email", "booking", "apps", "first_contact"]);
    expect(step(r.body, "apps")).toMatchObject({ link: null, help_slug: "iphone-dialler", can_mark_done: true });
    // A Broker never reads the brokerage-wide set-up tables.
    expect(callsMatching(h.query, /FROM phone_numbers|FROM lenders|FROM stripe_connection/)).toHaveLength(0);
  });

  it("Ops follows the Broker list", async () => {
    expect((await get(OPS)).body.role).toBe("broker");
  });

  it("Marketing: profile, email, sender details, website, a contact list and the first campaign", async () => {
    const r = await get(MKT);
    expect(r.body.role).toBe("marketing");
    expect(keys(r.body)).toEqual(["profile", "email", "sender", "website", "import", "campaign"]);
    expect(step(r.body, "website").link).toBe("/marketing?tab=kit");
    expect(step(r.body, "import").link).toBe("/crm/contacts?import=1");
    expect(step(r.body, "sender")).toMatchObject({ link: null, auto: true, can_mark_done: false });
  });
});

describe("detection from existing data", () => {
  it("Admin steps tick themselves off from the brokerage's data", async () => {
    world.ok = { profile: true, brand: true, team: true, phoneNumber: true, ownMicrosoft: true, companyMicrosoft: true, lender: true, imported: true, quickbooks: true, application: true };
    const r = await get(ADMIN);
    expect(r.body.steps.map((s: any) => s.status)).toEqual(Array(9).fill("done"));
    expect(r.body).toMatchObject({ done: 9, total: 9, complete: true });
  });

  it("Microsoft needs the company approval as well as your own sign-in; Google is enough on its own", async () => {
    world.ok = { ownMicrosoft: true };
    expect(step((await get(ADMIN)).body, "email").status).toBe("todo");
    world.ok = { ownMicrosoft: true, companyMicrosoft: true };
    expect(step((await get(ADMIN)).body, "email").status).toBe("done");
    world.ok = { ownGoogle: true };
    expect(step((await get(ADMIN)).body, "email").status).toBe("done");
  });

  it("Broker: profile needs the signature too; a contact they own counts as the first contact; the dialler sign-in counts", async () => {
    world.ok = { profile: true };
    expect(step((await get(BROKER)).body, "profile").status).toBe("todo");
    world.ok = { profile: true, signature: true, ownGoogle: true, dialler: true, bookingLink: true };
    world.myContacts = 1;
    const r = await get(BROKER);
    expect(r.body.steps.map((s: any) => s.status)).toEqual(["done", "done", "done", "done", "done"]);
    expect(r.body.complete).toBe(true);
  });

  it("Marketing: sender details, website kit, five of your own contacts and a campaign", async () => {
    world.ok = { sender: true, websiteKit: true, campaign: true };
    world.myContacts = 5;
    const r = await get(MKT);
    expect(r.body.steps.map((s: any) => [s.key, s.status])).toEqual([
      ["profile", "todo"], ["email", "todo"], ["sender", "done"], ["website", "done"], ["import", "done"], ["campaign", "done"],
    ]);
  });

  it("a detection query that fails is logged and that step just shows To do", async () => {
    world.ok = { lender: true, brand: true };
    world.fail = /FROM lenders/;
    const r = await get(ADMIN);
    expect(r.status).toBe(200);
    expect(step(r.body, "lenders").status).toBe("todo");
    expect(step(r.body, "brand").status).toBe("done");
    expect(h.warn).toHaveBeenCalledWith("setup/setupWizard.ts:lender", expect.any(Error));
  });
});

describe("status changes", () => {
  it("skip, mark done (where offered) and back to to do", async () => {
    let r = await put(ADMIN, "/steps/import", { status: "skipped" });
    expect(r.status).toBe(200);
    expect(step(r.body, "import").status).toBe("skipped");
    r = await put(ADMIN, "/steps/test_link", { status: "done" });
    expect(step(r.body, "test_link").status).toBe("done");
    r = await put(ADMIN, "/steps/import", { status: "todo" });
    expect(step(r.body, "import").status).toBe("todo");
    expect(callsMatching(h.query, /DELETE FROM setup_progress/)[0]?.[1]).toEqual([ADMIN, "import"]);
  });

  it("a detected-only step cannot be marked done by hand, but can be skipped", async () => {
    const r = await put(ADMIN, "/steps/lenders", { status: "done" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("detected_step");
    expect(r.body.message).toMatch(/ticked off by itself/);
    expect((await put(ADMIN, "/steps/lenders", { status: "skipped" })).status).toBe(200);
  });

  it("skipping every remaining step completes the wizard; a detected step overrides a skip", async () => {
    world.progress = ["profile", "brand", "team", "phone", "email", "lenders", "import", "payments", "test_link"].map((k) => ({ user_id: ADMIN, step_key: k, status: "skipped" }));
    world.ok = { lender: true };
    const r = await get(ADMIN);
    expect(r.body.complete).toBe(true);
    expect(step(r.body, "lenders").status).toBe("done");
    expect(r.body.done).toBe(1);
  });

  it("answers are per person: the Broker's skips do not touch the Admin's list", async () => {
    await put(BROKER, "/steps/email", { status: "skipped" });
    expect(step((await get(ADMIN)).body, "email").status).toBe("todo");
    expect(step((await get(BROKER)).body, "email").status).toBe("skipped");
  });

  it("unknown steps and statuses are refused in plain words", async () => {
    const a = await put(BROKER, "/steps/brand", { status: "skipped" }); // an Admin step
    expect(a.status).toBe(404);
    expect(a.body.message).toBe("That step is not in your set-up list.");
    const b = await put(BROKER, "/steps/email", { status: "finished" });
    expect(b.status).toBe(400);
    expect(b.body.message).toBe("Choose done, skipped or to do.");
  });

  it("dismiss closes the wizard for good", async () => {
    const r = await put(MKT, "/dismiss");
    expect(r.status).toBe(200);
    expect(r.body.dismissed).toBe(true);
    expect((await get(MKT)).body.dismissed).toBe(true);
    expect(world.progress).toEqual([{ user_id: MKT, step_key: "_wizard", status: "skipped" }]);
  });

  it("needs a signed-in staff member", async () => {
    const r = await request(await app()).get("/api/setup");
    expect(r.status).toBe(401);
  });
});

describe("the Staff role reads as Broker", () => {
  it("roleLabel shows Broker for Staff and leaves the stored value alone", async () => {
    const { roleLabel, ROLES } = await import("../../auth/roles.js");
    expect(ROLES.STAFF).toBe("Staff");
    expect(roleLabel("Staff")).toBe("Broker");
    expect(roleLabel("staff")).toBe("Broker");
    expect(roleLabel("Marketing")).toBe("Marketing");
    expect(roleLabel("Admin")).toBe("Admin");
  });
});
