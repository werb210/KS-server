// BF_SERVER_v789_SERVICE_TOKENS - every outbound service token comes from the
// shared helper: iss "bf-server", aud by receiver ("bi-server" / "agent"), the
// identity claim each receiver checks, and BI_SERVICE_JWT_SECRET for BI when set.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import type { Request } from "express";

vi.mock("../db.js", () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      if (/SELECT bi_public_id FROM applications/i.test(sql)) return { rows: [{ bi_public_id: "PUB-1" }] };
      return { rows: [] };
    }),
  },
}));
vi.mock("../observability/logger.js", () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }));

const JWT_SECRET = "jwt-secret-v789-shared";
const BI_SECRET = "bi-secret-v789-dedicated";
const calls: { url: string; token: string }[] = [];

function respond(url: string): Response {
  if (url.includes("/maya/staff/pgi-readiness")) {
    return new Response(JSON.stringify({ ok: true, result: { applicationId: "bi-42", stage: "submitted" } }), { status: 200 });
  }
  if (url.includes("/maya/staff/person-summary")) return new Response(JSON.stringify({ ok: true, contact: null, applications: [] }), { status: 200 });
  if (url.includes("/companies/by-ids/from-bf")) return new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 });
  if (url.includes("/applications/from-bf")) return new Response(JSON.stringify({ ok: true, publicId: "PUB-1", completionUrl: "x" }), { status: 200 });
  if (url.includes("/documents/from-bf")) return new Response(JSON.stringify({ ok: true, documentId: "d1", applicationId: "a1" }), { status: 200 });
  if (url.includes("/submit-pgi")) return new Response(JSON.stringify({ status: "submitted" }), { status: 200 });
  return new Response("not found", { status: 404 });
}

beforeEach(() => {
  calls.length = 0;
  process.env.JWT_SECRET = JWT_SECRET;
  delete process.env.BI_SERVICE_JWT_SECRET;
  delete process.env.AGENT_SERVICE_JWT_SECRET;
  process.env.BI_SERVER_URL = "https://bi.test.local";
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
    const auth = String(init?.headers?.authorization ?? "");
    calls.push({ url, token: auth.replace(/^Bearer\s+/i, "") });
    return respond(url);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BI_SERVICE_JWT_SECRET;
  delete process.env.AGENT_SERVICE_JWT_SECRET;
});

function tokenFor(fragment: string): string {
  const hit = calls.find((c) => c.url.includes(fragment));
  expect(hit, `no call to ${fragment}`).toBeTruthy();
  return hit!.token;
}



describe("outbound agent token (X-Maya-Context)", () => {
  it("is iss bf-server / aud agent, keeps kind maya_context, and ignores BI_SERVICE_JWT_SECRET", async () => {
    process.env.BI_SERVICE_JWT_SECRET = BI_SECRET;
    const { signMayaContext } = await import("../services/mayaContext.js");
    const token = signMayaContext({ audience: "client", phone: "+15555550100", silo: "BF" });
    const claims = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"], issuer: "bf-server", audience: "agent" }) as any;
    expect(claims).toMatchObject({ kind: "maya_context", audience: "client", phone: "+15555550100", silo: "BF" });
  });
});

describe("verifyMayaService (inbound agent token)", () => {
  function req(token: string): Request {
    return { header: (n: string) => (n.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined) } as unknown as Request;
  }

  it("accepts maya-service and agent sources signed with JWT_SECRET", async () => {
    const { verifyMayaService } = await import("../routes/mayaStaff.js");
    expect(verifyMayaService(req(jwt.sign({ kind: "service", source: "maya-service" }, JWT_SECRET)))).toEqual({ source: "maya-service" });
    expect(verifyMayaService(req(jwt.sign({ kind: "service", source: "agent" }, JWT_SECRET, { audience: "bf-server" })))).toEqual({ source: "agent" });
  });

  it("keeps the kind and source checks", async () => {
    const { verifyMayaService } = await import("../routes/mayaStaff.js");
    expect(verifyMayaService(req(jwt.sign({ kind: "staff", source: "maya-service" }, JWT_SECRET)))).toBeNull();
    expect(verifyMayaService(req(jwt.sign({ kind: "service", source: "bf-server" }, JWT_SECRET)))).toBeNull();
  });

  it("rejects a wrong audience, a non-HS256 algorithm and a bad signature", async () => {
    const { verifyMayaService } = await import("../routes/mayaStaff.js");
    expect(verifyMayaService(req(jwt.sign({ kind: "service", source: "maya-service" }, JWT_SECRET, { audience: "bi-server" })))).toBeNull();
    expect(verifyMayaService(req(jwt.sign({ kind: "service", source: "maya-service" }, JWT_SECRET, { algorithm: "HS512" })))).toBeNull();
    expect(verifyMayaService(req(jwt.sign({ kind: "service", source: "maya-service" }, "some-other-secret")))).toBeNull();
  });

  it("uses AGENT_SERVICE_JWT_SECRET when set", async () => {
    process.env.AGENT_SERVICE_JWT_SECRET = "agent-secret-v789";
    const { verifyMayaService } = await import("../routes/mayaStaff.js");
    expect(verifyMayaService(req(jwt.sign({ kind: "service", source: "maya-service" }, "agent-secret-v789")))).toEqual({ source: "maya-service" });
    expect(verifyMayaService(req(jwt.sign({ kind: "service", source: "maya-service" }, JWT_SECRET)))).toBeNull();
  });
});
