// KS_SERVER_INTUIT_TID
import { describe, expect, it } from "vitest";
import { intuitTid } from "../services/quickbooks/qboAuth.js";

describe("intuit_tid", () => {
  it("reads the header when present and is null otherwise", () => {
    expect(intuitTid({ headers: new Headers({ intuit_tid: "1-abc" }) })).toBe("1-abc");
    expect(intuitTid({ headers: new Headers() })).toBeNull();
    expect(intuitTid({})).toBeNull();
  });
});
