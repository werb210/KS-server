// KS_SERVER_v21_VISIBILITY_GAPS - the activity views and the assistant's verified acting staff member.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import type { Request } from "express";
import { actingStaffFromRequest, viewSql } from "../scopedDb.js";
import { narrowToOwners } from "../scope.js";
import { signMayaContext } from "../../services/mayaContext.js";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const SECRET = "v21-unit-secret-min-10";

function req(headers: Record<string, string>, body: Record<string, unknown> = {}): Request {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { body, header: (name: string) => h[name.toLowerCase()] } as unknown as Request;
}
const ctx = (id: string) => signMayaContext({ audience: "staff", staff: { id, name: null, email: null, role: "Staff" }, silo: "BF" });

let saved: string | undefined;
beforeEach(() => { saved = process.env.JWT_SECRET; process.env.JWT_SECRET = SECRET; });
afterEach(() => { if (saved === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = saved; });

describe("activity views", () => {
  it("filter messages, conversations, calls, call events, voicemails and tasks by the linked records", () => {
    const names = viewSql([U1], U1).map((s) => /TEMP VIEW (\w+)/.exec(s)?.[1]);
    expect(names).toEqual(["applications", "contacts", "companies", "communications_messages", "communications_conversations", "call_logs", "call_events", "voicemails", "crm_call_log", "tasks"]);
  });

  it("keeps tasks assigned to the user, but not for a team filter (no user)", () => {
    expect(viewSql([U1], U1).at(-1)).toContain(`t.assignee_user_id = '${U1}'::uuid OR`);
    expect(viewSql([U1], null).at(-1)).not.toContain("assignee_user_id");
    expect(narrowToOwners({ mode: "restricted", visibility: "own", userId: U1, ownerIds: [U1] }, [U1])).toMatchObject({ teamFilter: true });
  });

  it("never inlines anything but uuids", () => {
    const all = viewSql([U1, "x'); DROP TABLE users; --"], "y'; DROP TABLE tasks; --").join(" ");
    expect(all).not.toContain("DROP TABLE");
  });
});

describe("the assistant's acting staff member", () => {
  it("comes from the context this server signed", () => {
    expect(actingStaffFromRequest(req({ "X-Maya-Context": ctx(U1) }, { staff_user_id: U1 }))).toEqual({ id: U1, mismatch: false });
    expect(actingStaffFromRequest(req({ "X-Maya-Context": ctx(U1) }))).toEqual({ id: U1, mismatch: false });
  });

  it("a different staff_user_id is a mismatch", () => {
    expect(actingStaffFromRequest(req({ "X-Maya-Context": ctx(U1) }, { staff_user_id: U2 }))).toEqual({ id: U1, mismatch: true });
  });

  it("an unsigned, wrongly signed or non-staff context names nobody", () => {
    expect(actingStaffFromRequest(req({}, { staff_user_id: U1 }))).toEqual({ id: null, mismatch: false });
    const forged = jwt.sign({ kind: "maya_context", audience: "staff", staff: { id: U1 } }, "other-secret", { issuer: "bf-server", audience: "agent" });
    expect(actingStaffFromRequest(req({ "X-Maya-Context": forged }, { staff_user_id: U1 })).id).toBeNull();
    const wrongAud = jwt.sign({ kind: "maya_context", audience: "staff", staff: { id: U1 } }, SECRET, { issuer: "bf-server", audience: "bf-server" });
    expect(actingStaffFromRequest(req({ "X-Maya-Context": wrongAud })).id).toBeNull();
    const client = signMayaContext({ audience: "client", phone: "+17805550100", silo: "BF" });
    expect(actingStaffFromRequest(req({ "X-Maya-Context": client })).id).toBeNull();
    const service = jwt.sign({ kind: "service", audience: "staff", staff: { id: U1 } }, SECRET, { issuer: "bf-server", audience: "agent" });
    expect(actingStaffFromRequest(req({ "X-Maya-Context": service })).id).toBeNull();
  });
});
