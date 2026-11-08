import { describe, expect, it } from "vitest";
import { stripInstalledExtensions } from "../runMigrations.js";

// KS_SERVER_SKIP_INSTALLED_EXTENSIONS_v1
describe("stripInstalledExtensions", () => {
  const sql = [
    "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;",
    'create extension if not exists "pgcrypto";',
    "CREATE EXTENSION hstore;",
    "CREATE TABLE t (id int);",
  ].join("\n");

  it("leaves out IF NOT EXISTS statements for installed extensions only", () => {
    const out = stripInstalledExtensions(sql, new Set(["vector"]));
    expect(out).toContain("-- skipped (already installed): vector");
    expect(out).not.toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(out).toContain('create extension if not exists "pgcrypto";');
    expect(out).toContain("CREATE EXTENSION hstore;");
    expect(out).toContain("CREATE TABLE t (id int);");
  });

  it("changes nothing when no extension is installed", () => {
    expect(stripInstalledExtensions(sql, new Set())).toBe(sql);
  });
});
