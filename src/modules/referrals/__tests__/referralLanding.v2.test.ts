// BF_SERVER_REFERRAL_LANDING_v2
// KS_SERVER_v1_NO_BI - Keystone has no insurance silo: every referral lands on the licensee's funding page.
import { describe, it, expect, beforeEach } from "vitest";
import { referralLandingUrl, normalizeReferralSilos } from "../referralInvite.js";

describe("referral landing routing", () => {
  beforeEach(() => {
    delete process.env.BF_WEBSITE_URL; delete process.env.BI_WEBSITE_URL; delete process.env.WEBSITE_URL;
    delete process.env.KS_WEBSITE_URL; delete process.env.KS_CLIENT_URL; delete process.env.CLIENT_URL;
  });
  it("lands on the licensee website /r/f/<code>", () => {
    expect(referralLandingUrl(["BF"], "BF-ABCD")).toBe("https://wonderful-island-0b68ae310.5.azurestaticapps.net/r/f/BF-ABCD");
  });
  it("follows the licensee's website setting", () => {
    process.env.KS_WEBSITE_URL = "https://www.example-broker.ca/";
    expect(referralLandingUrl(["BF"], "BF-ABCD")).toBe("https://www.example-broker.ca/r/f/BF-ABCD");
  });
  it("only the funding silo is a referral silo", () => {
    expect(normalizeReferralSilos(["BF", "SLF", "BI"])).toEqual(["BF"]);
  });
});
