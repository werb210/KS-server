// KS_SERVER_v10_DEMO - settings for the self-serve sales demo.
//
// One shared demo server runs this code with DEMO_MODE=true. In that mode only /api/demo/* (and health) answers,
// every background worker is off, and nothing reaches a real person: no texts, calls, lender emails, Office or Google
// sync, ad conversions. The two emails a prospect triggers (their lender package, the note to sales) are sent by
// KS-Ops, which this server tells about progress (src/demo/progress.ts).
//
//   DEMO_MODE=true          turns the demo on (and every other route off)
//   KS_OPS_KEY              the key KS-Ops sends (X-KS-Ops-Key) to create and wipe sessions; also sent back with events
//   KS_OPS_URL              KS-Ops base URL (progress events go to {KS_OPS_URL}/api/demo/sessions/{id}/events)
//   KS_DEMO_CLIENT_URL      the client web app that serves /demo/<code> (the borrower's phone link)
//   DEMO_SESSION_DAYS       how long a session lives before it is wiped (default 7)
//   DEMO_ASSISTANT_LIMIT    questions a borrower may ask the assistant per session (default 12)
//   OPENAI_API_KEY          optional: the assistant answers with the model; without it, scripted answers
import { createHash } from "node:crypto";

export function demoMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.DEMO_MODE ?? "").trim().toLowerCase() === "true";
}

export function demoSessionDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DEMO_SESSION_DAYS ?? 7);
  return Number.isFinite(n) && n >= 1 && n <= 30 ? Math.floor(n) : 7;
}

export function demoAssistantLimit(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DEMO_ASSISTANT_LIMIT ?? 12);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.floor(n) : 12;
}

export function demoClientUrl(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.KS_DEMO_CLIENT_URL ?? "").trim().replace(/\/+$/, "");
}

export function demoOpsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.KS_OPS_URL ?? "").trim().replace(/\/+$/, "");
}

export function demoOpsKey(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.KS_OPS_KEY ?? "").trim();
}

/**
 * The key demo tokens are signed with. Derived from JWT_SECRET but different from it, so a demo token can never pass
 * the real staff or client sign-in checks (they verify with JWT_SECRET itself), and a real token never passes here.
 */
export function demoTokenKey(env: NodeJS.ProcessEnv = process.env): string {
  const base = String(env.JWT_SECRET ?? "");
  return createHash("sha256").update(`ks-demo-token-v1:${base}`).digest("hex");
}

/** Paths that answer in DEMO_MODE. Everything else under /api is closed. */
export function demoAllowedPath(path: string): boolean {
  return path === "/" || path === "/health" || path.startsWith("/api/demo/") || path === "/api/demo"
    || path === "/api/health" || path.startsWith("/api/health/") || path === "/api/_int/health";
}
