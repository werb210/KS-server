// BF_SERVER_v826_TASK_SILO - the abandoned-application call task always gets a silo tasks.silo accepts.
// KS_SERVER_v1_NO_BI - Keystone has one silo, so every task is BF.
import { describe, expect, it } from "vitest";
import { taskSilo } from "../abandonedApplicationWorker.js";

describe("taskSilo", () => {
  it("maps any application silo to BF", () => {
    for (const v of ["BF", "bi", " slf ", "bf", null, "", "boreal"]) expect(taskSilo(v as any)).toBe("BF");
  });
});
