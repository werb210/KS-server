// KS_SERVER_TEST_SIGNING_SKIP_v1 - SignNow's test stub (the application is marked signed a moment later, no real
// signature) runs when SIGNNOW_STUB_MODE is on, or - temporarily, until SignNow is confirmed working (Todd, Nov 9) -
// for Keystone's own test brokerages: shared server, the brokerage's settings say KS_TEST_BROKERAGE=true (KS-Ops sets
// it only for licensees staff marked as a test brokerage; a real licensee never has it). Setting
// KS_TEST_SKIP_SIGNING=false on the server turns the test-brokerage skip off again.
import { isMultiBrokerage } from "../tenancy/mode.js";

const on = (v: string | undefined) => ["1", "true", "yes", "on"].includes(String(v ?? "").trim().toLowerCase());

export function isTestBrokerage(env: NodeJS.ProcessEnv = process.env): boolean {
  return isMultiBrokerage() && String(env.KS_TEST_BROKERAGE ?? "").trim().toLowerCase() === "true";
}

export function signnowStubMode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (on(env.SIGNNOW_STUB_MODE)) return true;
  if (String(env.KS_TEST_SKIP_SIGNING ?? "").trim().toLowerCase() === "false") return false;
  return isTestBrokerage(env);
}
