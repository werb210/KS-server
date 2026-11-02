// KS_BROKER_TOOLS - the after-funded steps the broker tools add (read by hooks.ts). Each step checks its own plan
// feature.
import type { FundedStep } from "./hooks.js";
import { db } from "./common.js";
import { featureOn } from "./platform.js";

export const FUNDED_STEPS: FundedStep[] = [
  // KS_BROKER_TOOLS_CREDIT_LINES - a file linked to an approved credit line draws its funded amount from the line.
  { name: "credit_line_draw", run: async (applicationId) => {
    if (!(await featureOn("credit_lines"))) return;
    const { drawOnFunded } = await import("./creditLines.js");
    await drawOnFunded(db(), applicationId);
  } },
];
