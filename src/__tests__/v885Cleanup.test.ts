// BF_SERVER_v885 - small wording fixes: durations in words, Alberta's zone name shown to staff.
import { describe, expect, it } from "vitest";
import { humanDuration } from "../lib/humanDuration.js";
import { readableReasons } from "../fraud/store.js";

describe("v885 durations", () => {
  it("reads a gap in sensible units", () => {
    expect(humanDuration(5 * 60_000)).toBe("5 minutes");
    expect(humanDuration(60_000)).toBe("1 minute");
    expect(humanDuration(3 * 3600_000)).toBe("3 hours");
    expect(humanDuration(5 * 86_400_000)).toBe("5 days");
    expect(humanDuration(3791521 * 60_000)).toBe("about 7 years");
  });
  it("old stored tamper reasons read in words", () => {
    const [r] = readableReasons([{ code: "modified_after_create", severity: "info", text: "The file was changed 3791521 minute(s) after it was created." }]);
    expect(r.text).toBe("The file was last changed about 7 years after it was created (dates stored in the PDF).");
  });
});
