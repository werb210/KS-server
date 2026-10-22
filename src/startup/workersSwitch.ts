// BF_SERVER_BLOCK_v479_BF_WORKERS_SWITCH
// Every background worker (sequences, SMS cascade, send queue, lender packages,
// SignNow poller, Google Ads uploads, scheduled email, ...) starts from one block
// in src/index.ts. The Azure staging slot runs the same code; if it points at the
// live database it sends real texts and emails twice. Set the slot setting
// BF_WORKERS_ENABLED=false on staging. Unset or anything else = on, so
// production never stops by accident.
export function bfWorkersEnabled(env: Record<string, string | undefined> = process.env): boolean {
  // KS_SERVER_v10_DEMO - the shared demo server never runs the real workers (it starts its own two demo jobs).
  if (String(env.DEMO_MODE ?? "").trim().toLowerCase() === "true") return false;
  return String(env.BF_WORKERS_ENABLED ?? "true").trim().toLowerCase() !== "false";
}
