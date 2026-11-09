// KS_SERVER_TEST_SIGNING_SKIP_v1
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.resetModules(); vi.doUnmock("../../tenancy/mode.js"); });

async function load(multi: boolean) {
  vi.doMock("../../tenancy/mode.js", () => ({ isMultiBrokerage: () => multi, sharedEnv: () => process.env }));
  return import("../stubMode.js");
}
const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;

describe("SignNow test stub for test brokerages", () => {
  it("skips real signing for a test brokerage on the shared server", async () => {
    const m = await load(true);
    expect(m.signnowStubMode(env({ KS_TEST_BROKERAGE: "true" }))).toBe(true);
  });

  it("never skips for a real brokerage", async () => {
    const m = await load(true);
    expect(m.signnowStubMode(env({}))).toBe(false);
    expect(m.signnowStubMode(env({ KS_TEST_BROKERAGE: "false" }))).toBe(false);
  });

  it("never skips on a single-brokerage server", async () => {
    const m = await load(false);
    expect(m.signnowStubMode(env({ KS_TEST_BROKERAGE: "true" }))).toBe(false);
  });

  it("KS_TEST_SKIP_SIGNING=false turns the skip off; SIGNNOW_STUB_MODE still forces the stub", async () => {
    const m = await load(true);
    expect(m.signnowStubMode(env({ KS_TEST_BROKERAGE: "true", KS_TEST_SKIP_SIGNING: "false" }))).toBe(false);
    expect(m.signnowStubMode(env({ SIGNNOW_STUB_MODE: "1" }))).toBe(true);
  });
});
