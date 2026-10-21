import { describe, expect, it } from "vitest";
import { siloMiddleware } from "../../src/middleware/silo.js";

function run(req: any) {
  const res: any = { locals: {} };
  let called = false;
  siloMiddleware(req, res, () => {
    called = true;
  });
  return { res, called };
}

// KS_SERVER_v1_NO_BI - Keystone has one silo (BF); any other value falls back to it.
describe("siloMiddleware", () => {
  it("single-silo user ignores X-Silo", () => {
    const { res, called } = run({ headers: { "x-silo": "BI" }, query: {}, user: { role: "Staff", silo: "BF", silos: ["BF"] } });
    expect(res.locals.silo).toBe("BF");
    expect(called).toBe(true);
  });

  it("admin asking for a removed silo gets BF", () => {
    const { res } = run({ headers: { "x-silo": "SLF" }, query: {}, user: { role: "Admin", silo: "BF", silos: ["BF"] } });
    expect(res.locals.silo).toBe("BF");
  });

  it("accepts an explicit BF", () => {
    const { res } = run({ headers: { "x-silo": "BF" }, query: {}, user: { role: "Admin", silo: "BF", silos: ["BF"] } });
    expect(res.locals.silo).toBe("BF");
  });

  it("defaults to BF when no user", () => {
    const { res } = run({ headers: {}, query: {} });
    expect(res.locals.silo).toBe("BF");
  });

  it("a user stored with an old silo still gets BF", () => {
    const { res } = run({ headers: { "x-silo": "ZZ" }, query: {}, user: { role: "Staff", silo: "BI", silos: ["BI"] } });
    expect(res.locals.silo).toBe("BF");
  });
});
