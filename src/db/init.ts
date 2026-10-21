// BF_SERVER_ONE_POOL_v45
import { pool as sharedPool } from "../db.prod.js";

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

  // KS_SERVER_v2_FRESH_START - on a brand-new database this ran before the migrations, so live_chat_requests already
  // existed when the schema baseline loaded and the baseline stopped the server ("relation already exists"). On an
  // empty database the baseline creates the table; an empty copy left behind by an earlier failed start is removed.
  let hasSchema = true;
  if (connected) {
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

  if (connected && hasSchema) {
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

  deps.db.ready = connected;
  deps.db.client = connected ? pool : null;
}
