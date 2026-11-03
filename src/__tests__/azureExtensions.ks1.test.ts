// KS_SHARED_HOSTING_v1 - every brokerage database runs migrations as a non-superuser on Azure, where only `vector`
// is allow-listed. A bare CREATE EXTENSION of anything else stops that brokerage's migrations.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("migrations only create allowed extensions", () => {
  it("no unguarded CREATE EXTENSION other than vector", () => {
    const dir = join(process.cwd(), "migrations");
    const bad: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
      const sql = readFileSync(join(dir, f), "utf8");
      if (/EXCEPTION\s+WHEN\s+OTHERS/i.test(sql)) continue; // guarded block (falls back when unavailable)
      for (const m of sql.matchAll(/^\s*CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gim)) if (m[1]!.toLowerCase() !== "vector") bad.push(`${f}: ${m[1]}`);
    }
    expect(bad).toEqual([]);
  });
});
