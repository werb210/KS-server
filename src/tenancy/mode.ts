// KS_SHARED_HOSTING_v1 - multi-brokerage mode switch.
//
// One shared KS-server can serve many brokerages, each with its own database (see docs/SHARED_HOSTING.md). The mode
// is on only when KS_CONTROL_DATABASE_URL is set. Without it the server is exactly the single-brokerage server it
// has always been: DATABASE_URL plus its own App Service settings (the development copy, the demo server, CI and
// every test run this way).
//
// The original process.env object is captured here, before the env overlay replaces process.env, so the switch is
// never answered by a brokerage's own values.
const baseEnv: NodeJS.ProcessEnv = process.env;

/** The real process environment (the shared App Service settings), never a brokerage's overlay. */
export function sharedEnv(): NodeJS.ProcessEnv {
  return baseEnv;
}

export function isMultiBrokerage(): boolean {
  return String(baseEnv.KS_CONTROL_DATABASE_URL ?? "").trim().length > 0;
}
