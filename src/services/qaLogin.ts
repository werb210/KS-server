// KS_SERVER_QA_LOGIN_v1 - sign-in for Keystone's own test brokerages, so the end-to-end test can sign in to a new
// brokerage's portal and client app and push applications through without a real phone.
//
// It works only when ALL of these hold:
//   - the server is the shared (multi-brokerage) server,
//   - the brokerage's settings say KS_TEST_BROKERAGE=true (KS-Ops sets it only for licensees staff marked as a test
//     brokerage; a real licensee never has it),
//   - the brokerage has a KS_QA_LOGIN_CODE of 6-12 digits (a random code KS-Ops makes for that brokerage), and
//   - the phone number is in the reserved fictional range NXX-555-0100..0199, which can never belong to a real person.
// Such a number gets no text message, and accepts only that brokerage's code.
import { timingSafeEqual } from "node:crypto";
import { isMultiBrokerage } from "../tenancy/mode.js";

const QA_PHONE = /^\+1[2-9]\d{2}55501\d{2}$/;

function qaCode(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isMultiBrokerage()) return null;
  if (String(env.KS_TEST_BROKERAGE ?? "").trim().toLowerCase() !== "true") return null;
  const code = String(env.KS_QA_LOGIN_CODE ?? "").trim();
  return /^[0-9]{6,12}$/.test(code) ? code : null;
}

export function isQaPhone(phone: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(phone && QA_PHONE.test(phone) && qaCode(env));
}

export function qaCodeMatches(phone: string, code: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const want = qaCode(env);
  if (!want || !QA_PHONE.test(phone)) return false;
  const a = Buffer.from(String(code ?? "").trim());
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** KS_SERVER_STORE_REVIEW_SEED_v1 - whether this brokerage is a test brokerage with QA sign-in switched on. */
export function qaLoginEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return qaCode(env) !== null;
}
