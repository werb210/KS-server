// BF_SERVER_MAIN_LINE_866_v693
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("public numbers and personal numbers", () => {
  // KS_SERVER_v4_BRANDING - the licensee's support phone, never Boreal's 866 line or a staff cell.
  it("rejection emails give the licensee's support phone", () => {
    const s = readFileSync("src/services/rejectionNotice.ts", "utf8");
    expect(s).not.toContain("451-1768");
    expect(s).not.toContain("631-8939");
    expect(s.split("supportPhone()").length - 1).toBeGreaterThanOrEqual(2);
  });
});
