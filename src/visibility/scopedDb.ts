// KS_SERVER_v20_TEAMS - reports, the dashboard and the assistant's staff tools see only the records the user may see,
// without rewriting their SQL.
//
// For a restricted user, scopedRequest() checks out one connection and creates TEMP views named applications,
// contacts and companies on it that select only that user's visible rows from public.*. PostgreSQL searches the
// session's temp schema before public, so every unqualified table name in the SQL reads the filtered view. While the
// request runs, pool.query (the shared pool every module imports) is routed to that connection through
// AsyncLocalStorage, so nested services (report data, contact briefs, the pipeline query) are covered too. When the
// response ends the views are dropped and the connection goes back to the pool; if dropping fails the connection is
// destroyed instead, so a view can never reach another request. Work still running after the response (fire-and-forget
// automations) falls back to the shared pool. Users who see everything (the default) never take this path.
//
// No transaction is opened: each query autocommits exactly as it does on the shared pool, so a failed optional query
// does not poison the rest and the assistant's writes (notes, tasks) are kept.
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import type { Q } from "../plans/state.js";
import { narrowToOwners, scopeForActingUser, scopeForRequest, teamOwnerIds, teamsInPlan, type RecordScope } from "./scope.js";

type Store = { client: PoolClient; queue: Promise<unknown>; closed: boolean };
const als = new AsyncLocalStorage<Store>();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function runOn(store: Store, args: unknown[]): Promise<any> {
  const run = store.queue.then(() => (store.client.query as any)(...args));
  store.queue = run.catch(() => undefined);
  return run;
}

let installed = false;
/** Routes pool.query to the request's scoped connection while one is open. Idempotent. Callback-style calls pass through. */
export function installScopedRouting(): void {
  if (installed) return;
  installed = true;
  const original = pool.query.bind(pool) as (...a: unknown[]) => unknown;
  (pool as any).query = (...args: unknown[]) => {
    const store = als.getStore();
    if (!store || store.closed || typeof args[args.length - 1] === "function") return original(...args);
    return runOn(store, args);
  };
}
installScopedRouting();

/** The scoped request's connection (for code that streams with a client of its own), or null. */
export function currentScopedClient(): PoolClient | null {
  const store = als.getStore();
  return store && !store.closed ? store.client : null;
}

/** pool.query, scoped while a scoped request is running (kept for modules that import it by name). */
export const scopedPool = {
  query(text: string, params?: unknown[]) {
    return (pool as any).query(text, params) as Promise<any>;
  },
};

export function viewSql(ownerIds: string[]): string[] {
  const ids = ownerIds.filter((id) => UUID_RE.test(id));
  const lit = ids.length ? `ARRAY[${ids.map((id) => `'${id.toLowerCase()}'`).join(",")}]::uuid[]` : `ARRAY[]::uuid[]`;
  return [
    `CREATE OR REPLACE TEMP VIEW applications AS SELECT * FROM public.applications WHERE owner_user_id = ANY(${lit})`,
    `CREATE OR REPLACE TEMP VIEW contacts AS SELECT * FROM public.contacts WHERE owner_id = ANY(${lit})`,
    `CREATE OR REPLACE TEMP VIEW companies AS SELECT * FROM public.companies WHERE owner_id = ANY(${lit})`,
  ];
}
export const DROP_VIEWS_SQL = `DROP VIEW IF EXISTS pg_temp.applications, pg_temp.contacts, pg_temp.companies`;

async function open(scope: RecordScope): Promise<Store> {
  const client = await pool.connect();
  try {
    for (const sql of viewSql(scope.mode === "all" ? [] : scope.ownerIds)) await client.query(sql);
  } catch (err) {
    client.release(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
  return { client, queue: Promise.resolve(), closed: false };
}

function close(store: Store): Promise<void> {
  if (store.closed) return Promise.resolve();
  store.closed = true;
  const { client } = store;
  return store.queue
    .then(() => client.query(DROP_VIEWS_SQL))
    .then(() => client.release(), (err) => {
      console.warn("[visibility] dropping scoped views failed; discarding the connection", (err as Error)?.message);
      client.release(err instanceof Error ? err : new Error(String(err)));
    });
}

/** Runs fn with pool.query limited to the scope (for code that is not a request handler, and tests). */
export async function runScoped<T>(scope: RecordScope, fn: () => Promise<T>): Promise<T> {
  if (scope.mode === "all") return fn();
  const store = await open(scope);
  try {
    return await als.run(store, fn);
  } finally {
    await close(store);
  }
}

/** The request's scope, narrowed to ?team_id= when given (a filter; growth and up; an unknown team matches nothing). */
export async function scopeWithTeamFilter(req: Request, db: Q = pool as unknown as Q): Promise<RecordScope> {
  const scope = await scopeForRequest(req, db);
  const teamId = String((req.query as any)?.team_id ?? "").trim();
  if (!teamId) return scope;
  if (!(await teamsInPlan(db))) return scope;
  return narrowToOwners(scope, await teamOwnerIds(db, teamId));
}

function scopedMiddleware(resolve: (req: Request) => Promise<RecordScope>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const scope = await resolve(req);
      if (scope.mode === "all") { next(); return; }
      const store = await open(scope);
      res.once("finish", () => void close(store));
      res.once("close", () => void close(store));
      als.run(store, () => next());
    })().catch(next);
  };
}

/** After requireAuth: the rest of the request reads only the user's records (and ?team_id= narrows further). */
export const scopedRequest: RequestHandler = scopedMiddleware((req) => scopeWithTeamFilter(req));

/** For the assistant's staff routes (service token): the acting staff member comes from the body (staff_user_id). */
export const scopedAssistantRequest: RequestHandler = scopedMiddleware((req) => scopeForActingUser(pool as unknown as Q, (req as any).body ?? {}));
