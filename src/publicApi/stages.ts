// KS_SERVER_SSO_API_KEYS - the stages an API client may move an application to: every working pipeline stage. The
// parking stages (Fraud, Hold) have their own staff-only flow and are not offered here.
import { PARKED_STATES, PIPELINE_STATES } from "../modules/applications/pipelineState.js";

export const API_STAGES: string[] = PIPELINE_STATES.filter((s) => !PARKED_STATES.includes(s));

export function isApiStage(v: unknown): v is string {
  return typeof v === "string" && API_STAGES.includes(v);
}
