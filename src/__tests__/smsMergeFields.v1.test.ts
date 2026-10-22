import { describe, expect, it } from "vitest";
import { mergeSmsFields, renderMarketingSms } from "../services/marketingSms.js";
import { websiteHost } from "../licensee/brand.js"; // KS_SERVER_v4_BRANDING

describe("marketing SMS merge fields", () => {
  const vars = { first_name: "Ada", name: "Ada Lovelace", email: "ada@example.com", company: "Boreal" };

  it("merges supported fields case-insensitively and removes missing values", () => {
    expect(mergeSmsFields("Hi {{ FIRST_NAME }}, {{company}} {{missing}}", vars))
      .toBe("Hi Ada, Boreal ");
  });

  it("renders merge fields, link, and CASL footer in order", () => {
    expect(renderMarketingSms({ body: "Hi {{first_name}}", vars, link: "https://example.test/r/1" }))
      .toBe(`Hi Ada https://example.test/r/1 Reply STOP to opt out. Info: ${websiteHost()}`);
  });

  it("still appends the CASL footer when no link is supplied", () => {
    expect(renderMarketingSms({ body: "Hi {{name}}", vars, link: null }))
      .toBe(`Hi Ada Lovelace Reply STOP to opt out. Info: ${websiteHost()}`);
  });
});
