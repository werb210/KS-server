// BF_SERVER_ONE_POOL_v45
import { pool as sharedPool } from "../db.prod.js";

import type { QueryResult, QueryResultRow } from "pg";
import { deps } from "../system/deps.js";

export async function initDb() {
  if (process.env.NODE_ENV === "test") {
    deps.db.ready = true;
    deps.db.client = {
      query: async () => ({ rows: [], rowCount: 1 }),
    };
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL missing");
  }

  const pool = sharedPool;

  let connected = false;

  for (let i = 0; i < 3; i++) {
    try {
      await pool.query("SELECT 1");
      connected = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  if (connected) await prepareDatabase(pool);

  deps.db.ready = connected;
  deps.db.client = connected ? pool : null;
}

/**
 * KS_SHARED_HOSTING_v1 - the schema preparation initDb does on a reachable database, as a function of the pool so
 * every brokerage database gets the same (src/tenancy/migrations.ts). With no option it is exactly what initDb did:
 * the empty-database clean-up, then live_chat_requests. beforeMigrations true runs only the clean-up, false only
 * the table.
 */
export async function prepareDatabase(
  pool: { query: <R extends QueryResultRow = any>(sql: string) => Promise<QueryResult<R>> },
  opts: { beforeMigrations?: boolean } = {},
): Promise<void> {
  const phase = opts.beforeMigrations === undefined ? "both" : opts.beforeMigrations ? "before" : "after";
  // KS_SERVER_v2_FRESH_START - on a brand-new database this ran before the migrations, so live_chat_requests already
  // existed when the schema baseline loaded and the baseline stopped the server ("relation already exists"). On an
  // empty database the baseline creates the table; an empty copy left behind by an earlier failed start is removed.
  let hasSchema = true;
  if (phase !== "after") {
    const probe = await pool.query<{ has_schema: boolean }>(
      "SELECT to_regclass('public.applications') IS NOT NULL AS has_schema",
    );
    hasSchema = Boolean(probe.rows?.[0]?.has_schema);
    if (!hasSchema) {
      await pool.query(`
        DO $$
        BEGIN
          -- Keep the existence check separate so PostgreSQL does not resolve a missing table in the SELECT.
          IF to_regclass('public.live_chat_requests') IS NOT NULL THEN
            IF NOT EXISTS (SELECT 1 FROM public.live_chat_requests) THEN
              DROP TABLE public.live_chat_requests;
            END IF;
          END IF;
        END $$;
      `);
    }
  }

  if (phase !== "before" && hasSchema) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS live_chat_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT,
        email TEXT,
        message TEXT,
        status TEXT DEFAULT 'open',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
  }

}
