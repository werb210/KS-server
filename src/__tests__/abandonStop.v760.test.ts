// BF_SERVER_ABANDON_STOP_v760
// KS_SERVER_v4_BRANDING - the text names the licensee, not Boreal.
import { describe, it, expect } from "vitest";
import { abandonSmsBody } from "../workers/abandonedApplicationWorker.js";
import { brandName } from "../licensee/brand.js";

describe("finish-your-application text", () => {
  it("names the licensee and tells the client how to opt out", () => {
    expect(abandonSmsBody()).toContain(brandName());
    expect(abandonSmsBody()).not.toMatch(/boreal/i);
    expect(abandonSmsBody().endsWith("Reply STOP to opt out.")).toBe(true);
    expect(abandonSmsBody().length).toBeLessThanOrEqual(320);
  });
});
