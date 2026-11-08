// KS_SERVER_QA_LOGIN_v1
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.resetModules(); vi.doUnmock("../../tenancy/mode.js"); });

async function load(multi: boolean) {
  vi.doMock("../../tenancy/mode.js", () => ({ isMultiBrokerage: () => multi, sharedEnv: () => process.env }));
  return import("../qaLogin.js");
}
const TEST = { KS_TEST_BROKERAGE: "true", KS_QA_LOGIN_CODE: "48213977" } as NodeJS.ProcessEnv;

describe("QA sign-in for test brokerages", () => {
  it("accepts only the brokerage's code on a fictional 555-01xx number", async () => {
    const m = await load(true);
    expect(m.isQaPhone("+14035550101", TEST)).toBe(true);
    expect(m.qaCodeMatches("+14035550101", "48213977", TEST)).toBe(true);
    expect(m.qaCodeMatches("+14035550101", "48213978", TEST)).toBe(false);
    expect(m.qaCodeMatches("+14035550101", "", TEST)).toBe(false);
  });

  it("never applies to a real-looking number", async () => {
    const m = await load(true);
    for (const p of ["+14035550200", "+14035551234", "+15878042761", "+14031550101", ""]) {
      expect(m.isQaPhone(p, TEST)).toBe(false);
      expect(m.qaCodeMatches(p, "48213977", TEST)).toBe(false);
    }
  });

  it("is off for a brokerage that is not a test brokerage, or has no code", async () => {
    const m = await load(true);
    expect(m.isQaPhone("+14035550101", { KS_QA_LOGIN_CODE: "48213977" })).toBe(false);
    expect(m.isQaPhone("+14035550101", { KS_TEST_BROKERAGE: "false", KS_QA_LOGIN_CODE: "48213977" })).toBe(false);
    expect(m.isQaPhone("+14035550101", { KS_TEST_BROKERAGE: "true" })).toBe(false);
    expect(m.isQaPhone("+14035550101", { KS_TEST_BROKERAGE: "true", KS_QA_LOGIN_CODE: "123" })).toBe(false);
  });

  it("is off on a single-brokerage server", async () => {
    const m = await load(false);
    expect(m.isQaPhone("+14035550101", TEST)).toBe(false);
    expect(m.qaCodeMatches("+14035550101", "48213977", TEST)).toBe(false);
  });
});
