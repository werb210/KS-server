// KS_SERVER_v10_DEMO - wiring for DEMO_MODE: the gate that closes every non-demo route, the /api/demo mount and the
// two demo jobs (progress flusher every 15 s, expired-session wipe every 30 min).
import type { Express, NextFunction, Request, Response } from "express";
import type pg from "pg";
import type { Q } from "../plans/state.js";
import { demoAllowedPath, demoMode } from "./config.js";
import { demoRouter } from "./routes.js";
import { flushCompletions, flushEvents } from "./progress.js";
import { deleteExpiredSessions } from "./repo.js";

/** In DEMO_MODE, everything except /api/demo/* and health answers 404, so no real feature can run on the demo server. */
export function demoGate(req: Request, res: Response, next: NextFunction) {
  if (req.method === "OPTIONS" || demoAllowedPath(req.path)) return next();
  return res.status(404).json({ error: "not_available_in_demo", message: "This is the Keystone demo server." });
}

let flushSoon: (() => void) | null = null;

/** Mounts the demo when DEMO_MODE=true. Returns whether it did. */
export function mountDemo(app: Express, db: () => Q): boolean {
  if (!demoMode()) return false;
  app.use("/api/demo", demoRouter({ db, onEvent: () => flushSoon?.() }));
  return true;
}

export function startDemoWorkers(pool: pg.Pool): () => void {
  let busy = false;
  const flush = async () => {
    if (busy) return;
    busy = true;
    try {
      await flushEvents(pool);
      await flushCompletions(pool);
    } catch (err) {
      console.warn("[demo] progress flush failed", err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
    }
  };
  let pending: NodeJS.Timeout | null = null;
  flushSoon = () => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; void flush(); }, 1_000);
    pending.unref();
  };
  const wipe = async () => {
    try {
      await flush();
      const n = await deleteExpiredSessions(pool as unknown as Q);
      if (n) console.log(`[demo] wiped ${n} expired demo session(s)`);
    } catch (err) {
      console.warn("[demo] expired-session wipe failed", err instanceof Error ? err.message : String(err));
    }
  };
  const timers = [setInterval(flush, 15_000), setInterval(wipe, 30 * 60_000), setTimeout(wipe, 60_000)];
  timers.forEach((t) => t.unref());
  console.log("[startup] demo mode: progress flusher and expired-session wipe started; all other workers are off");
  return () => { timers.forEach((t) => clearInterval(t as NodeJS.Timeout)); flushSoon = null; };
}
