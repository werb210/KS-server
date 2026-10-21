// KS_SERVER_v2_FRESH_START - initDb must not create live_chat_requests on an empty database (the schema baseline does),
// or the baseline stops the server with "relation already exists".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ hasSchema: false, sql: [] as string[] }));
vi.mock("../../db.prod.js", () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      h.sql.push(sql);
      if (/to_regclass\('public\.applications'\)/.test(sql)) return { rows: [{ has_schema: h.hasSchema }] };
      return { rows: [{ "?column?": 1 }] };
    }),
  },
}));

const env = { ...process.env };
beforeEach(() => { h.sql = []; process.env.NODE_ENV = "production"; process.env.DATABASE_URL = "postgres://x/y"; vi.resetModules(); });
afterEach(() => { process.env = { ...env }; });

describe("initDb on a fresh database", () => {
  it("leaves live_chat_requests to the baseline and clears an empty leftover copy", async () => {
    h.hasSchema = false;
    const { initDb } = await import("../init.js");
    await initDb();
    expect(h.sql.some((s) => /CREATE TABLE IF NOT EXISTS live_chat_requests/.test(s))).toBe(false);
    expect(h.sql.some((s) => /DROP TABLE public\.live_chat_requests/.test(s) && /NOT EXISTS \(SELECT 1 FROM public\.live_chat_requests\)/.test(s))).toBe(true);
  });

  it("still creates the table on an existing database", async () => {
    h.hasSchema = true;
    const { initDb } = await import("../init.js");
    await initDb();
    expect(h.sql.some((s) => /CREATE TABLE IF NOT EXISTS live_chat_requests/.test(s))).toBe(true);
    expect(h.sql.some((s) => /DROP TABLE/.test(s))).toBe(false);
  });
});
